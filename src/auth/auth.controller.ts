import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Req, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { CurrentUser, Public } from '../common/decorators/auth.decorators.js';
import { AuditCtx } from '../common/decorators/audit-ctx.decorator.js';
import type { AuditContext } from '../audit/audit.service.js';
import type { AuthUser } from '../common/auth/auth-user.js';
import { AuthService, REFRESH_COOKIE } from './auth.service.js';
import { ChallengeDto, ChangePasswordDto, ForgotPasswordDto, LoginDto, RefreshDto, ResetPasswordDto, SignupCompleteDto, SignupStartDto, TwoFactorDto, VerifyCodeDto } from './dto/auth.dto.js';

/** Mobil ilova `X-Client: mobile` yuboradi: refresh token cookie o‘rniga javob/so‘rov tanasida. */
const isMobile = (req: Request) => req.headers['x-client'] === 'mobile';
const clientInfo = (req: Request) => ({
  userAgent: req.headers['user-agent'],
  ip: req.ip,
  device: req.headers['x-device'] as string | undefined,
  secFetchSite: req.headers['sec-fetch-site'] as string | undefined,
});

/** Ochiq auth endpointlari uchun ikki darajali limit: daqiqasiga va soatiga (IP bo‘yicha). */
const limits = (perMinute: number, perHour: number) => ({ default: { limit: perMinute, ttl: 60_000 }, hourly: { limit: perHour, ttl: 3_600_000 } });

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Throttle(limits(5, 30))
  @Post('login')
  @HttpCode(200)
  login(
    @Body() dto: LoginDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @AuditCtx() ctx: AuditContext,
  ) {
    return this.auth.login(dto, clientInfo(req), res, ctx, isMobile(req));
  }

  @Public()
  @Throttle(limits(30, 300))
  @Post('refresh')
  @HttpCode(200)
  refresh(@Req() req: Request, @Res({ passthrough: true }) res: Response, @Body() dto: RefreshDto) {
    const mobile = isMobile(req);
    const token = mobile ? dto.refreshToken : (req.cookies as Record<string, string> | undefined)?.[REFRESH_COOKIE];
    return this.auth.refresh(token, clientInfo(req), res, mobile);
  }

  @Public()
  @Throttle(limits(10, 40))
  @Post('2fa/verify')
  @HttpCode(200)
  verifyTwoFactor(@Body() dto: VerifyCodeDto, @Req() req: Request, @Res({ passthrough: true }) res: Response, @AuditCtx() ctx: AuditContext) {
    return this.auth.verifyLogin(dto, clientInfo(req), res, ctx, isMobile(req));
  }

  @Public()
  @Throttle(limits(5, 20))
  @Post('code/resend')
  @HttpCode(200)
  resend(@Body() dto: ChallengeDto) {
    return this.auth.resend(dto.challengeId);
  }

  @Public()
  @Throttle(limits(5, 10))
  @Post('signup/start')
  @HttpCode(200)
  signupStart(@Body() dto: SignupStartDto) {
    return this.auth.signupStart(dto.email);
  }

  @Public()
  @Throttle(limits(10, 40))
  @Post('signup/verify')
  @HttpCode(200)
  signupVerify(@Body() dto: VerifyCodeDto) {
    return this.auth.signupVerify(dto);
  }

  @Public()
  @Throttle(limits(5, 10))
  @Post('signup/complete')
  @HttpCode(200)
  signupComplete(@Body() dto: SignupCompleteDto, @Req() req: Request, @Res({ passthrough: true }) res: Response, @AuditCtx() ctx: AuditContext) {
    return this.auth.signupComplete(dto, clientInfo(req), res, ctx, isMobile(req));
  }

  @Public()
  @Throttle(limits(5, 10))
  @Post('password/forgot')
  @HttpCode(200)
  forgot(@Body() dto: ForgotPasswordDto) {
    return this.auth.forgotPassword(dto.login);
  }

  @Public()
  @Throttle(limits(10, 40))
  @Post('password/verify')
  @HttpCode(200)
  verifyReset(@Body() dto: VerifyCodeDto) {
    return this.auth.verifyResetCode(dto);
  }

  @Public()
  @Throttle(limits(5, 10))
  @Post('password/reset')
  @HttpCode(200)
  reset(@Body() dto: ResetPasswordDto, @AuditCtx() ctx: AuditContext) {
    return this.auth.resetPassword(dto.resetToken, dto.newPassword, ctx);
  }

  @ApiBearerAuth()
  @Get('sessions')
  sessions(@CurrentUser() user: AuthUser) {
    return this.auth.listSessions(user);
  }

  @ApiBearerAuth()
  @Post('sessions/revoke-others')
  @HttpCode(200)
  revokeOthers(@CurrentUser() user: AuthUser, @AuditCtx() ctx: AuditContext) {
    return this.auth.revokeOtherSessions(user, ctx);
  }

  @ApiBearerAuth()
  @Delete('sessions/:id')
  revokeSession(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @AuditCtx() ctx: AuditContext) {
    return this.auth.revokeSession(user, id, ctx);
  }

  @ApiBearerAuth()
  @Throttle(limits(10, 60))
  @Post('two-factor')
  @HttpCode(200)
  twoFactor(@CurrentUser() user: AuthUser, @Body() dto: TwoFactorDto, @AuditCtx() ctx: AuditContext) {
    return this.auth.setTwoFactor(user, dto, ctx);
  }

  @ApiBearerAuth()
  @Post('logout')
  @HttpCode(200)
  logout(@CurrentUser() user: AuthUser, @Res({ passthrough: true }) res: Response, @AuditCtx() ctx: AuditContext) {
    return this.auth.logout(user, res, ctx);
  }

  @ApiBearerAuth()
  @Get('me')
  me(@CurrentUser() user: AuthUser) {
    return this.auth.me(user.id);
  }

  @ApiBearerAuth()
  @Throttle(limits(10, 60))
  @Post('change-password')
  @HttpCode(200)
  changePassword(@CurrentUser() user: AuthUser, @Body() dto: ChangePasswordDto, @AuditCtx() ctx: AuditContext) {
    return this.auth.changePassword(user, dto, ctx);
  }
}
