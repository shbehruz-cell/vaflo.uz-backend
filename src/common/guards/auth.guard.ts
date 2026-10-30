import { CanActivate, ExecutionContext, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../../prisma/prisma.service.js';
import { IS_PUBLIC, REQUIRED_PERMISSIONS } from '../decorators/auth.decorators.js';
import type { PermissionCode } from '../permissions.js';
import type { AuthUser } from '../auth/auth-user.js';

export interface AccessPayload {
  sub: string;
  sid: string;
}

/**
 * Global guard: Bearer access tokenni tekshiradi, foydalanuvchi va sessiya holatini
 * bazadan qayta o‘qiydi (bloklangan xodim darhol chiqariladi) va permissionlarni tekshiradi.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly jwt: JwtService,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const targets = [ctx.getHandler(), ctx.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets)) return true;

    const req = ctx.switchToHttp().getRequest();
    const header: string | undefined = req.headers.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
    if (!token) throw new UnauthorizedException('Avtorizatsiya talab qilinadi');

    let payload: AccessPayload;
    try {
      payload = await this.jwt.verifyAsync<AccessPayload>(token);
    } catch {
      throw new UnauthorizedException('Token yaroqsiz yoki muddati tugagan');
    }

    const session = await this.prisma.session.findUnique({
      where: { id: payload.sid },
      include: { user: { include: { role: { include: { permissions: true } } } } },
    });
    if (!session || session.revokedAt || session.expiresAt < new Date() || session.userId !== payload.sub) {
      throw new UnauthorizedException('Sessiya tugagan');
    }
    const { user } = session;
    if (user.status !== 'ACTIVE') throw new UnauthorizedException('Foydalanuvchi bloklangan');

    const authUser: AuthUser = {
      id: user.id,
      storeId: user.storeId,
      sessionId: session.id,
      roleKey: user.role.key,
      name: user.name,
      permissions: new Set(user.role.permissions.map((p) => p.permissionCode as PermissionCode)),
    };
    req.user = authUser;

    const required = this.reflector.getAllAndOverride<PermissionCode[]>(REQUIRED_PERMISSIONS, targets);
    if (required?.length && !required.some((p) => authUser.permissions.has(p))) {
      throw new ForbiddenException('Bu amal uchun ruxsat yo‘q');
    }
    return true;
  }
}
