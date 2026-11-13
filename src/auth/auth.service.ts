import { BadRequestException, ConflictException, ForbiddenException, HttpException, HttpStatus, Injectable, NotFoundException, UnauthorizedException, UnprocessableEntityException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as argon2 from 'argon2';
import { createHash, randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Response } from 'express';
import { Prisma } from '../generated/prisma/client.js';
import { PrismaService, type Tx } from '../prisma/prisma.service.js';
import { AuditService, type AuditContext } from '../audit/audit.service.js';
import { MailService, type CodePurpose } from '../mail/mail.service.js';
import { GeoService } from './geo.service.js';
import { LoginThrottleService } from './login-throttle.service.js';
import { passwordProblem } from '../common/password.js';
import { normalizeLogin } from '../common/normalize.js';
import { createTenant } from '../stores/tenant-bootstrap.js';
import type { AuthUser } from '../common/auth/auth-user.js';
import type { ChangePasswordDto, LoginDto, SignupCompleteDto, TwoFactorDto } from './dto/auth.dto.js';

export const REFRESH_COOKIE = 'vaflo_rt';
const BAD_CREDENTIALS = 'Login yoki parol noto‘g‘ri';
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const CODE_TTL_MIN = 10;
const MAX_ATTEMPTS = 5;
const RESEND_COOLDOWN_MS = 45_000;
const MAX_SENDS = 5;
const codeHash = (id: string, code: string) => sha256(`${id}:${code}`);
const maskEmail = (email: string) => {
  const [name = '', domain = ''] = email.split('@');
  return `${name.slice(0, 2)}${'•'.repeat(Math.max(1, name.length - 2))}@${domain}`;
};
const BAD_CODE = 'Kod noto‘g‘ri yoki muddati tugagan';
const SIGNUP_TOKEN_TTL_MIN = 30;
const SIGNUP_STARTS_PER_HOUR = 5;
/** Band email uchun signup urinishi: kod yo‘q, hech qachon tasdiqlanmaydi (codeHash shu qiymat). */
const EXISTS_MARK = 'EXISTS';
/** Sessiya umri: oxirgi faollikdan keyin shuncha kun ichida qayta kirish talab qilinmaydi (har yangilashda uzayadi). */
const refreshDays = () => Number(process.env.REFRESH_TTL_DAYS ?? 10) || 10;
/** Sessiyaning mutlaq umri (kun): refresh rotatsiyasi bilan ham shundan uzoq yashamaydi. */
const absoluteDays = () => Number(process.env.REFRESH_ABSOLUTE_DAYS ?? 180) || 180;
/** Bekor qilingan refresh token shu muddat ichida qayta kelsa — parallel so‘rov (poyga) deb hisoblanadi, undan keyin — o‘g‘irlik. */
/** Rotatsiyadan keyin eski token qisqa vaqt yaroqli: yangi cookie brauzerga yetib bormagan holatlar (Safari so‘rovni uzsa, parallel refresh). */
const REUSE_GRACE_MS = 30_000;

interface ClientInfo {
  userAgent?: string;
  device?: string;
  ip?: string;
  /** Cookie asosidagi refresh uchun CSRF tekshiruvi: brauzer yuboradigan Sec-Fetch-Site sarlavhasi. */
  secFetchSite?: string;
}

@Injectable()
export class AuthService {
  private dummyHash?: Promise<string>;

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly audit: AuditService,
    private readonly mail: MailService,
    private readonly geo: GeoService,
    private readonly loginThrottle: LoginThrottleService,
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

  private async createSession(
    userId: string,
    client: ClientInfo,
    db: PrismaService | Tx = this.prisma,
    inherit?: { firstSeenAt: Date; deviceName: string | null; platform: string | null; ip: string | null; city: string | null; country: string | null; latitude: number | null; longitude: number | null },
  ) {
    // X-Device: "iPhone 15 Pro|iOS 26.1"
    const [deviceName, platform] = (client.device ?? '').split('|').map((x) => x.trim().slice(0, 80));
    const token = randomBytes(48).toString('base64url');
    const session = await db.session.create({
      data: {
        userId,
        tokenHash: sha256(token),
        userAgent: client.userAgent?.slice(0, 500),
        deviceName: deviceName || inherit?.deviceName || null,
        platform: platform || inherit?.platform || null,
        ...(inherit ? { firstSeenAt: inherit.firstSeenAt } : {}),
        // IP o‘zgarmagan bo‘lsa avvalgi joylashuv ko‘chiriladi (har rotatsiyada qayta so‘ralmaydi)
        ...(inherit && inherit.ip === (client.ip ?? null) ? { city: inherit.city, country: inherit.country, latitude: inherit.latitude, longitude: inherit.longitude } : {}),
        ip: client.ip,
        expiresAt: new Date(Date.now() + refreshDays() * 86_400_000),
      },
    });
    // Joylashuvni kutmaymiz: fon rejimida aniqlanadi (login sekinlashmasin).
    if (session.latitude === null && client.ip) {
      void this.geo.locate(client.ip).then((g) => g && this.prisma.session.update({ where: { id: session.id }, data: { city: g.city, country: g.country, latitude: g.latitude, longitude: g.longitude } })).catch(() => undefined);
    }
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
      twoFactorEnabled: user.twoFactorEnabled,
      permissions: user.role.permissions.map((p) => p.permissionCode).sort(),
    };
  }

  async login(dto: LoginDto, client: ClientInfo, res: Response, ctx: AuditContext, mobile = false) {
    const login = normalizeLogin(dto.login);
    // Hisob/IP bo‘yicha brute-force limiti (parol tekshirilmasdan oldin).
    this.loginThrottle.assertAllowed(login, client.ip);
    const user = await this.prisma.user.findUnique({ where: { login } });

    let ok = false;
    if (user) {
      ok = await argon2.verify(user.passwordHash, dto.password).catch(() => false);
    } else {
      await argon2.verify(await this.getDummyHash(), dto.password).catch(() => false);
    }
    if (!user || !ok || user.status !== 'ACTIVE') {
      this.loginThrottle.recordFailure(login, client.ip);
      await this.audit.log(
        { ...ctx, storeId: user?.storeId },
        { action: 'auth.login_failed', entityType: 'User', entityId: user?.id, metadata: { login } },
      );
      throw new UnauthorizedException(BAD_CREDENTIALS);
    }
    this.loginThrottle.recordSuccess(login);

    if (user.twoFactorEnabled && user.login.includes('@')) {
      const challenge = await this.startChallenge(user.id, user.login, 'LOGIN_2FA');
      return { twoFactorRequired: true as const, challengeId: challenge.id, email: maskEmail(user.login) };
    }
    return this.signIn(user.id, user.login, client, res, ctx, mobile, user.storeId);
  }

  private async signIn(userId: string, login: string, client: ClientInfo, res: Response, ctx: AuditContext, mobile: boolean, storeId: string) {
    const { token, session } = await this.createSession(userId, client);
    const accessToken = await this.jwt.signAsync({ sub: userId, sid: session.id });
    if (!mobile) this.setCookie(res, token);
    await this.audit.log(
      { ...ctx, user: null, storeId },
      { action: 'auth.login', entityType: 'User', entityId: userId, metadata: { login, sessionId: session.id, actorId: userId } },
    );
    return { accessToken, ...(mobile ? { refreshToken: token } : {}), user: await this.profile(userId) };
  }

  // ───────────── Emailga kod yuborish (2 bosqichli kirish va parolni tiklash) ─────────────

  private async startChallenge(userId: string, email: string, purpose: 'LOGIN_2FA' | 'PASSWORD_RESET') {
    const id = randomUUID();
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    // Eski tugallanmagan kodlarni bekor qilamiz: bir vaqtda faqat bitta faol kod.
    await this.prisma.authChallenge.updateMany({ where: { userId, purpose, consumedAt: null }, data: { consumedAt: new Date() } });
    const challenge = await this.prisma.authChallenge.create({
      data: { id, userId, purpose, codeHash: codeHash(id, code), expiresAt: new Date(Date.now() + CODE_TTL_MIN * 60_000) },
    });
    await this.mail.sendCode(email, code, purpose === 'LOGIN_2FA' ? 'login' : 'reset', CODE_TTL_MIN);
    return challenge;
  }

  private async checkCode(challengeId: string, code: string, purpose: 'LOGIN_2FA' | 'PASSWORD_RESET' | 'SIGNUP') {
    const ch = await this.prisma.authChallenge.findUnique({ where: { id: challengeId }, include: { user: true } });
    if (!ch || ch.purpose !== purpose || ch.consumedAt || ch.expiresAt < new Date() || ch.attempts >= MAX_ATTEMPTS || (ch.user && ch.user.status !== 'ACTIVE')) {
      throw new UnauthorizedException(BAD_CODE);
    }
    // Urinish hisoblagichi atomik oshiriladi (parallel so‘rovlar limitni chetlab o‘ta olmaydi):
    // tekshiruvdan OLDIN sarflanadi, to‘g‘ri kod bo‘lsa challenge baribir keyin iste‘mol qilinadi.
    const claimed = await this.prisma.authChallenge.updateMany({
      where: { id: ch.id, attempts: { lt: MAX_ATTEMPTS }, consumedAt: null },
      data: { attempts: { increment: 1 } },
    });
    if (claimed.count !== 1) throw new UnauthorizedException(BAD_CODE);
    const expected = Buffer.from(ch.codeHash, 'utf8');
    const actual = Buffer.from(codeHash(ch.id, code), 'utf8');
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
      throw new UnauthorizedException(BAD_CODE);
    }
    return ch;
  }

  async verifyLogin(dto: { challengeId: string; code: string }, client: ClientInfo, res: Response, ctx: AuditContext, mobile: boolean) {
    const ch = await this.checkCode(dto.challengeId, dto.code, 'LOGIN_2FA');
    const claimed = await this.prisma.authChallenge.updateMany({ where: { id: ch.id, consumedAt: null }, data: { consumedAt: new Date() } });
    if (claimed.count !== 1) throw new UnauthorizedException(BAD_CODE);
    if (!ch.userId || !ch.user) throw new UnauthorizedException(BAD_CODE);
    return this.signIn(ch.userId, ch.user.login, client, res, ctx, mobile, ch.user.storeId);
  }

  async resend(challengeId: string) {
    const ch = await this.prisma.authChallenge.findUnique({ where: { id: challengeId }, include: { user: true } });
    const ack = { ok: true, retryAfter: RESEND_COOLDOWN_MS / 1000 };
    // Mavjud bo‘lmasa ham bir xil javob (foydalanuvchini aniqlashga yo‘l qo‘ymaslik uchun).
    if (!ch || ch.verifiedAt || (ch.user && ch.user.status !== 'ACTIVE')) return ack;
    const existsMark = ch.purpose === 'SIGNUP' && ch.codeHash === EXISTS_MARK;
    if (ch.consumedAt && !existsMark) return ack;
    // Band email uchun ham cooldown va limitlar bir xil (javoblar farq qilmasligi uchun).
    const wait = ch.lastSentAt.getTime() + RESEND_COOLDOWN_MS - Date.now();
    if (wait > 0) throw new HttpException(`Kodni ${Math.ceil(wait / 1000)} soniyadan so‘ng qayta so‘rang`, HttpStatus.TOO_MANY_REQUESTS);
    if (ch.sendCount >= MAX_SENDS) throw new HttpException('Juda ko‘p urinish. Keyinroq qayta boshlang', HttpStatus.TOO_MANY_REQUESTS);

    if (ch.purpose === 'SIGNUP') {
      if (!ch.email) return ack;
      const taken = existsMark || (await this.prisma.user.findUnique({ where: { login: ch.email }, select: { id: true } }));
      if (taken) {
        await this.prisma.authChallenge.update({ where: { id: ch.id }, data: { sendCount: { increment: 1 }, lastSentAt: new Date() } });
        await this.mail.sendExists(ch.email);
      } else {
        const code = this.newCode();
        await this.prisma.authChallenge.update({
          where: { id: ch.id },
          data: { codeHash: codeHash(ch.id, code), attempts: 0, sendCount: { increment: 1 }, lastSentAt: new Date(), expiresAt: new Date(Date.now() + CODE_TTL_MIN * 60_000) },
        });
        await this.mail.sendCode(ch.email, code, 'signup', CODE_TTL_MIN);
      }
      return ack;
    }

    if (!ch.user) return ack;
    const code = this.newCode();
    await this.prisma.authChallenge.update({
      where: { id: ch.id },
      data: { codeHash: codeHash(ch.id, code), attempts: 0, sendCount: { increment: 1 }, lastSentAt: new Date(), expiresAt: new Date(Date.now() + CODE_TTL_MIN * 60_000) },
    });
    const purpose: CodePurpose = ch.purpose === 'LOGIN_2FA' ? 'login' : 'reset';
    await this.mail.sendCode(ch.user.login, code, purpose, CODE_TTL_MIN);
    return ack;
  }

  private newCode() {
    return String(randomInt(0, 1_000_000)).padStart(6, '0');
  }

  // ───────────── Email orqali ro‘yxatdan o‘tish (yangi do‘kon) ─────────────

  async signupStart(emailRaw: string) {
    if (process.env.SIGNUP_ENABLED === 'false') throw new ForbiddenException('Ro‘yxatdan o‘tish hozircha yopiq');
    const email = normalizeLogin(emailRaw);
    // Email bo‘yicha soatiga cheklov (band va bo‘sh emaillar uchun bir xil — foydalanuvchini aniqlab bo‘lmasin).
    const recent = await this.prisma.authChallenge.count({
      where: { email, purpose: 'SIGNUP', createdAt: { gt: new Date(Date.now() - 3_600_000) } },
    });
    if (recent >= SIGNUP_STARTS_PER_HOUR) throw new HttpException('Bu email uchun urinishlar ko‘p. Keyinroq qayta urinib ko‘ring', HttpStatus.TOO_MANY_REQUESTS);

    const taken = await this.prisma.user.findUnique({ where: { login: email }, select: { id: true } });
    const id = randomUUID();
    const expiresAt = new Date(Date.now() + CODE_TTL_MIN * 60_000);
    if (taken) {
      // Hech qachon tasdiqlanmaydigan (iste‘mol qilingan) qator + "hisob bor" xati. Javob bo‘sh email bilan bir xil.
      await this.prisma.authChallenge.create({
        data: { id, email, purpose: 'SIGNUP', codeHash: EXISTS_MARK, expiresAt, consumedAt: new Date() },
      });
      await this.mail.sendExists(email);
    } else {
      const code = this.newCode();
      await this.prisma.authChallenge.updateMany({ where: { email, purpose: 'SIGNUP', consumedAt: null }, data: { consumedAt: new Date() } });
      await this.prisma.authChallenge.create({ data: { id, email, purpose: 'SIGNUP', codeHash: codeHash(id, code), expiresAt } });
      await this.mail.sendCode(email, code, 'signup', CODE_TTL_MIN);
    }
    return { challengeId: id, retryAfter: RESEND_COOLDOWN_MS / 1000 };
  }

  async signupVerify(dto: { challengeId: string; code: string }) {
    const ch = await this.checkCode(dto.challengeId, dto.code, 'SIGNUP');
    if (ch.verifiedAt || !ch.email) throw new UnauthorizedException(BAD_CODE);
    const signupToken = randomBytes(32).toString('base64url');
    const r = await this.prisma.authChallenge.updateMany({
      where: { id: ch.id, verifiedAt: null, consumedAt: null },
      data: { verifiedAt: new Date(), resetTokenHash: sha256(signupToken), expiresAt: new Date(Date.now() + SIGNUP_TOKEN_TTL_MIN * 60_000) },
    });
    if (r.count !== 1) throw new UnauthorizedException(BAD_CODE);
    return { signupToken };
  }

  async signupComplete(dto: SignupCompleteDto, client: ClientInfo, res: Response, ctx: AuditContext, mobile: boolean) {
    const EXPIRED = 'Ro‘yxatdan o‘tish muddati tugagan. Qaytadan boshlang';
    const ch = await this.prisma.authChallenge.findUnique({ where: { resetTokenHash: sha256(dto.signupToken) } });
    if (!ch || ch.purpose !== 'SIGNUP' || !ch.verifiedAt || ch.consumedAt || ch.expiresAt < new Date() || !ch.email) {
      throw new BadRequestException(EXPIRED);
    }
    const email = ch.email;
    const problem = passwordProblem(dto.password, email);
    if (problem) throw new UnprocessableEntityException(problem);
    const passwordHash = await argon2.hash(dto.password, { type: argon2.argon2id });

    let created: { storeId: string; userId: string };
    try {
      created = await this.prisma.$transaction(async (tx) => {
        const claimed = await tx.authChallenge.updateMany({ where: { id: ch.id, consumedAt: null }, data: { consumedAt: new Date() } });
        if (claimed.count !== 1) throw new BadRequestException(EXPIRED);
        const t = await createTenant(tx, { storeName: dto.storeName, ownerName: dto.name, email, passwordHash });
        await this.audit.log(
          { ...ctx, user: null, storeId: t.storeId },
          { action: 'auth.signup', entityType: 'Store', entityId: t.storeId, metadata: { actorId: t.userId, storeName: dto.storeName } },
          tx,
        );
        return t;
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new ConflictException('Bu email bilan hisob bor. Kiring yoki parolni tiklang');
      }
      throw e;
    }
    return this.signIn(created.userId, email, client, res, ctx, mobile, created.storeId);
  }

  async forgotPassword(loginRaw: string) {
    const login = normalizeLogin(loginRaw);
    const user = login.includes('@') ? await this.prisma.user.findUnique({ where: { login } }) : null;
    if (user && user.status === 'ACTIVE') {
      const ch = await this.startChallenge(user.id, user.login, 'PASSWORD_RESET');
      return { challengeId: ch.id, retryAfter: RESEND_COOLDOWN_MS / 1000 };
    }
    // Foydalanuvchi bor-yo‘qligi sezilmasligi uchun xuddi shunday javob.
    return { challengeId: randomUUID(), retryAfter: RESEND_COOLDOWN_MS / 1000 };
  }

  async verifyResetCode(dto: { challengeId: string; code: string }) {
    const ch = await this.checkCode(dto.challengeId, dto.code, 'PASSWORD_RESET');
    // Kod faqat bir marta tasdiqlanadi: qayta yuborilsa yangi resetToken berilmaydi.
    if (ch.verifiedAt) throw new UnauthorizedException(BAD_CODE);
    const resetToken = randomBytes(32).toString('base64url');
    const r = await this.prisma.authChallenge.updateMany({
      where: { id: ch.id, verifiedAt: null, consumedAt: null },
      data: { verifiedAt: new Date(), resetTokenHash: sha256(resetToken), expiresAt: new Date(Date.now() + 15 * 60_000) },
    });
    if (r.count !== 1) throw new UnauthorizedException(BAD_CODE);
    return { resetToken };
  }

  async resetPassword(resetToken: string, newPassword: string, ctx: AuditContext) {
    const ch = await this.prisma.authChallenge.findUnique({ where: { resetTokenHash: sha256(resetToken) }, include: { user: true } });
    if (!ch || ch.purpose !== 'PASSWORD_RESET' || !ch.verifiedAt || ch.consumedAt || ch.expiresAt < new Date() || !ch.user || !ch.userId || ch.user.status !== 'ACTIVE') {
      throw new BadRequestException('Tiklash muddati tugagan. Qaytadan boshlang');
    }
    const { userId, user: owner } = ch;
    const problem = passwordProblem(newPassword, owner.login);
    if (problem) throw new UnprocessableEntityException(problem);
    const passwordHash = await argon2.hash(newPassword, { type: argon2.argon2id });
    await this.prisma.$transaction(async (tx) => {
      const claimed = await tx.authChallenge.updateMany({ where: { id: ch.id, consumedAt: null }, data: { consumedAt: new Date() } });
      if (claimed.count !== 1) throw new BadRequestException('Tiklash muddati tugagan. Qaytadan boshlang');
      await tx.user.update({ where: { id: userId }, data: { passwordHash } });
      // Parol o‘zgargach barcha sessiyalar tugatiladi.
      await tx.session.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } });
      await this.audit.log({ ...ctx, user: null, storeId: owner.storeId }, { action: 'auth.password_reset', entityType: 'User', entityId: userId, metadata: { actorId: userId } }, tx);
    });
    return { ok: true };
  }

  async setTwoFactor(user: AuthUser, dto: TwoFactorDto, ctx: AuditContext) {
    const row = await this.prisma.user.findUnique({ where: { id: user.id } });
    if (!row) throw new NotFoundException('Foydalanuvchi topilmadi');
    if (!(await argon2.verify(row.passwordHash, dto.password).catch(() => false))) throw new UnprocessableEntityException('Parol noto‘g‘ri');
    if (dto.enabled && !row.login.includes('@')) throw new UnprocessableEntityException('2 bosqichli kirish uchun login email bo‘lishi kerak');
    await this.prisma.user.update({ where: { id: user.id }, data: { twoFactorEnabled: dto.enabled } });
    await this.audit.log(ctx, { action: dto.enabled ? 'auth.2fa_enabled' : 'auth.2fa_disabled', entityType: 'User', entityId: user.id });
    return { twoFactorEnabled: dto.enabled };
  }

  /**
   * Cookie asosidagi refresh uchun CSRF himoyasi (SameSite=Lax ga qo‘shimcha): brauzer boshqa saytdan
   * yuborgan so‘rov (Sec-Fetch-Site: cross-site) rad etiladi. Same-origin (Next rewrite) va mobil
   * ilova (cookie ishlatmaydi) ta’sirlanmaydi.
   */
  private assertSameSite(client: ClientInfo) {
    if (client.secFetchSite === 'cross-site') throw new ForbiddenException('So‘rov boshqa saytdan yuborilgan');
  }

  async refresh(token: string | undefined, client: ClientInfo, res: Response, mobile = false) {
    if (!token) throw new UnauthorizedException('Sessiya topilmadi');
    if (!mobile) this.assertSameSite(client);
    const old = await this.prisma.session.findUnique({ where: { tokenHash: sha256(token) }, include: { user: true } });
    if (!old || old.expiresAt < new Date() || old.user.status !== 'ACTIVE') {
      this.clearCookie(res);
      throw new UnauthorizedException('Sessiya tugagan');
    }
    if (old.revokedAt) {
      // Bekor qilingan token qayta ishlatildi. Qisqa oyna ichida — parallel yangilanish yoki yangi cookie brauzerga
      // yetib bormagan (iOS Safari sahifa yangilanganda so‘rovni uzadi). Bu holatda foydalanuvchi chiqarib yuborilmaydi:
      // shu zanjirda yangi sessiya beriladi.
      if (Date.now() - old.revokedAt.getTime() <= REUSE_GRACE_MS) {
        const sibling = await this.createSession(old.userId, client, this.prisma, { firstSeenAt: old.firstSeenAt, deviceName: old.deviceName, platform: old.platform, ip: old.ip, city: old.city, country: old.country, latitude: old.latitude, longitude: old.longitude });
        const accessToken = await this.jwt.signAsync({ sub: old.userId, sid: sibling.session.id });
        if (!mobile) this.setCookie(res, sibling.token);
        return { accessToken, ...(mobile ? { refreshToken: sibling.token } : {}) };
      }
      // Undan keyin — token o‘g‘irlangan deb hisoblanadi: shu qurilma zanjiridagi (firstSeenAt) barcha sessiyalar yopiladi.
      {
        const r = await this.prisma.session.updateMany({
          where: { userId: old.userId, firstSeenAt: old.firstSeenAt, revokedAt: null },
          data: { revokedAt: new Date() },
        });
        await this.audit.log(
          { user: null, storeId: old.user.storeId, ip: client.ip },
          { action: 'auth.refresh_reuse_detected', entityType: 'User', entityId: old.userId, metadata: { sessionId: old.id, revoked: r.count } },
        );
      }
      this.clearCookie(res);
      throw new UnauthorizedException('Sessiya tugagan');
    }
    // Mutlaq umr: rotatsiya cheksiz davom etmaydi — qayta kirish talab qilinadi.
    if (old.firstSeenAt.getTime() + absoluteDays() * 86_400_000 < Date.now()) {
      await this.prisma.session.updateMany({ where: { id: old.id, revokedAt: null }, data: { revokedAt: new Date() } });
      this.clearCookie(res);
      throw new UnauthorizedException('Sessiya muddati tugadi. Qaytadan kiring');
    }
    // Rotatsiya: eski sessiyani faqat bir marta "egallash" mumkin (parallel so‘rovlardan himoya).
    const rotated = await this.prisma.$transaction(async (tx) => {
      const claimed = await tx.session.updateMany({
        where: { id: old.id, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      if (claimed.count !== 1) return null;
      return this.createSession(old.userId, client, tx, { firstSeenAt: old.firstSeenAt, deviceName: old.deviceName, platform: old.platform, ip: old.ip, city: old.city, country: old.country, latitude: old.latitude, longitude: old.longitude });
    });
    if (!rotated) {
      // Parallel refresh boshqa so‘rovda yutgan (eski token hozirgina bekor qilindi) — chiqarib yubormasdan
      // shu zanjirda alohida sessiya beriladi.
      const sibling = await this.createSession(old.userId, client, this.prisma, { firstSeenAt: old.firstSeenAt, deviceName: old.deviceName, platform: old.platform, ip: old.ip, city: old.city, country: old.country, latitude: old.latitude, longitude: old.longitude });
      const accessToken = await this.jwt.signAsync({ sub: old.userId, sid: sibling.session.id });
      if (!mobile) this.setCookie(res, sibling.token);
      return { accessToken, ...(mobile ? { refreshToken: sibling.token } : {}) };
    }
    const accessToken = await this.jwt.signAsync({ sub: old.userId, sid: rotated.session.id });
    if (!mobile) this.setCookie(res, rotated.token);
    return { accessToken, ...(mobile ? { refreshToken: rotated.token } : {}) };
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

  // ───────────── Faol sessiyalar (qurilmalar) ─────────────

  /** Boshqa sessiyani tugatish uchun joriy qurilma kamida shuncha vaqtdan beri kirgan bo‘lishi kerak. */
  private static readonly TERMINATE_AFTER_MS = 24 * 60 * 60 * 1000;

  async listSessions(user: AuthUser) {
    const rows = await this.prisma.session.findMany({
      where: { userId: user.id, revokedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: 'desc' },
    });
    const current = rows.find((s) => s.id === user.sessionId);
    const availableAt = current ? new Date(current.firstSeenAt.getTime() + AuthService.TERMINATE_AFTER_MS) : null;
    return {
      canTerminateOthers: !!availableAt && availableAt <= new Date(),
      terminateAvailableAt: availableAt,
      items: rows
        .map((s) => ({
          id: s.id,
          current: s.id === user.sessionId,
          deviceName: s.deviceName,
          platform: s.platform,
          userAgent: s.userAgent,
          ip: s.ip,
          city: s.city,
          country: s.country,
          latitude: s.latitude,
          longitude: s.longitude,
          firstSeenAt: s.firstSeenAt,
          lastActiveAt: s.createdAt,
        }))
        .sort((a, b) => Number(b.current) - Number(a.current) || b.lastActiveAt.getTime() - a.lastActiveAt.getTime()),
    };
  }

  private async assertCanTerminate(user: AuthUser) {
    const current = await this.prisma.session.findUnique({ where: { id: user.sessionId } });
    if (!current || current.firstSeenAt.getTime() + AuthService.TERMINATE_AFTER_MS > Date.now()) {
      throw new ForbiddenException('Yangi kirilgan qurilmadan boshqa sessiyalarni tugatish 24 soatdan keyin mumkin bo‘ladi');
    }
  }

  async revokeSession(user: AuthUser, sessionId: string, ctx: AuditContext) {
    if (sessionId !== user.sessionId) await this.assertCanTerminate(user);
    const r = await this.prisma.session.updateMany({ where: { id: sessionId, userId: user.id, revokedAt: null }, data: { revokedAt: new Date() } });
    if (r.count !== 1) throw new NotFoundException('Sessiya topilmadi');
    await this.audit.log(ctx, { action: 'auth.session_revoked', entityType: 'Session', entityId: sessionId });
    return { ok: true };
  }

  async revokeOtherSessions(user: AuthUser, ctx: AuditContext) {
    await this.assertCanTerminate(user);
    const r = await this.prisma.session.updateMany({
      where: { userId: user.id, id: { not: user.sessionId }, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    await this.audit.log(ctx, { action: 'auth.sessions_revoked_others', entityType: 'User', entityId: user.id, metadata: { count: r.count } });
    return { ok: true, revoked: r.count };
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
    const problem = passwordProblem(dto.newPassword, row.login);
    if (problem) throw new UnprocessableEntityException(problem);

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
