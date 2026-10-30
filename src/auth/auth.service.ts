import { Injectable, NotFoundException, UnauthorizedException, UnprocessableEntityException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as argon2 from 'argon2';
import { createHash, randomBytes } from 'node:crypto';
import type { Response } from 'express';
import { PrismaService, type Tx } from '../prisma/prisma.service.js';
import { AuditService, type AuditContext } from '../audit/audit.service.js';
import { normalizeLogin } from '../common/normalize.js';
import type { AuthUser } from '../common/auth/auth-user.js';
import type { ChangePasswordDto, LoginDto } from './dto/auth.dto.js';

export const REFRESH_COOKIE = 'vaflo_rt';
const BAD_CREDENTIALS = 'Login yoki parol noto‘g‘ri';
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const refreshDays = () => Number(process.env.REFRESH_TTL_DAYS ?? 30) || 30;

interface ClientInfo {
  userAgent?: string;
  ip?: string;
}

@Injectable()
export class AuthService {
  private dummyHash?: Promise<string>;

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly audit: AuditService,
  ) {}

  private getDummyHash() {
    this.dummyHash ??= argon2.hash('dummy-password-for-timing', { type: argon2.argon2id });
    return this.dummyHash;
  }

  private cookieOpts() {
    return {
      httpOnly: true,
      // HTTPS bo‘lmagan (faqat IP) serverda COOKIE_SECURE=false; domen+HTTPS ulanganda olib tashlang
      secure: process.env.COOKIE_SECURE ? process.env.COOKIE_SECURE === 'true' : process.env.NODE_ENV === 'production',
      sameSite: 'lax' as const,
      path: '/api/v1/auth',
    };
  }

  private setCookie(res: Response, token: string) {
    res.cookie(REFRESH_COOKIE, token, { ...this.cookieOpts(), maxAge: refreshDays() * 86_400_000 });
  }

  private clearCookie(res: Response) {
    res.clearCookie(REFRESH_COOKIE, this.cookieOpts());
  }

  private async createSession(userId: string, client: ClientInfo, db: PrismaService | Tx = this.prisma) {
    const token = randomBytes(48).toString('base64url');
    const session = await db.session.create({
      data: {
        userId,
        tokenHash: sha256(token),
        userAgent: client.userAgent?.slice(0, 500),
        ip: client.ip,
        expiresAt: new Date(Date.now() + refreshDays() * 86_400_000),
      },
    });
    return { token, session };
  }

  private async profile(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { role: { include: { permissions: true } } },
    });
    if (!user) throw new NotFoundException('Foydalanuvchi topilmadi');
    return {
      id: user.id,
      name: user.name,
      login: user.login,
      role: { key: user.role.key, name: user.role.name },
      storeId: user.storeId,
      permissions: user.role.permissions.map((p) => p.permissionCode).sort(),
    };
  }

  async login(dto: LoginDto, client: ClientInfo, res: Response, ctx: AuditContext) {
    const login = normalizeLogin(dto.login);
    const user = await this.prisma.user.findUnique({ where: { login } });

    let ok = false;
    if (user) {
      ok = await argon2.verify(user.passwordHash, dto.password).catch(() => false);
    } else {
      await argon2.verify(await this.getDummyHash(), dto.password).catch(() => false);
    }
    if (!user || !ok || user.status !== 'ACTIVE') {
      await this.audit.log(
        { ...ctx, storeId: user?.storeId },
        { action: 'auth.login_failed', entityType: 'User', entityId: user?.id, metadata: { login } },
      );
      throw new UnauthorizedException(BAD_CREDENTIALS);
    }

    const { token, session } = await this.createSession(user.id, client);
    const accessToken = await this.jwt.signAsync({ sub: user.id, sid: session.id });
    this.setCookie(res, token);
    await this.audit.log(
      { ...ctx, user: null, storeId: user.storeId },
      { action: 'auth.login', entityType: 'User', entityId: user.id, metadata: { login, sessionId: session.id, actorId: user.id } },
    );
    return { accessToken, user: await this.profile(user.id) };
  }

  async refresh(token: string | undefined, client: ClientInfo, res: Response) {
    if (!token) throw new UnauthorizedException('Sessiya topilmadi');
    const old = await this.prisma.session.findUnique({ where: { tokenHash: sha256(token) }, include: { user: true } });
    if (!old || old.revokedAt || old.expiresAt < new Date() || old.user.status !== 'ACTIVE') {
      this.clearCookie(res);
      throw new UnauthorizedException('Sessiya tugagan');
    }
    // Rotatsiya: eski sessiyani faqat bir marta "egallash" mumkin (parallel so‘rovlardan himoya).
    const rotated = await this.prisma.$transaction(async (tx) => {
      const claimed = await tx.session.updateMany({
        where: { id: old.id, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      if (claimed.count !== 1) return null;
      return this.createSession(old.userId, client, tx);
    });
    if (!rotated) {
      this.clearCookie(res);
      throw new UnauthorizedException('Sessiya tugagan');
    }
    const accessToken = await this.jwt.signAsync({ sub: old.userId, sid: rotated.session.id });
    this.setCookie(res, rotated.token);
    return { accessToken };
  }

  async logout(user: AuthUser, res: Response, ctx: AuditContext) {
    await this.prisma.session.updateMany({
      where: { id: user.sessionId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    this.clearCookie(res);
    await this.audit.log(ctx, { action: 'auth.logout', entityType: 'User', entityId: user.id });
    return { ok: true };
  }

  me(userId: string) {
    return this.profile(userId);
  }

  async changePassword(user: AuthUser, dto: ChangePasswordDto, ctx: AuditContext) {
    const row = await this.prisma.user.findUnique({ where: { id: user.id } });
    if (!row) throw new NotFoundException('Foydalanuvchi topilmadi');
    const ok = await argon2.verify(row.passwordHash, dto.currentPassword).catch(() => false);
    if (!ok) throw new UnprocessableEntityException('Joriy parol noto‘g‘ri');
    if (dto.currentPassword === dto.newPassword) {
      throw new UnprocessableEntityException('Yangi parol joriy paroldan farq qilishi kerak');
    }

    const passwordHash = await argon2.hash(dto.newPassword, { type: argon2.argon2id });
    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({ where: { id: user.id }, data: { passwordHash } });
      await tx.session.updateMany({
        where: { userId: user.id, id: { not: user.sessionId }, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      await this.audit.log(ctx, { action: 'auth.password_changed', entityType: 'User', entityId: user.id }, tx);
    });
    return { ok: true };
  }
}
