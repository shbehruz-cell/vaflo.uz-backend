import { Body, Controller, Get, HttpCode, Post, Req, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { CurrentUser, Public } from '../common/decorators/auth.decorators.js';
import { AuditCtx } from '../common/decorators/audit-ctx.decorator.js';
import type { AuditContext } from '../audit/audit.service.js';
import type { AuthUser } from '../common/auth/auth-user.js';
import { AuthService, REFRESH_COOKIE } from './auth.service.js';
import { ChangePasswordDto, LoginDto } from './dto/auth.dto.js';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('login')
  @HttpCode(200)
  login(
    @Body() dto: LoginDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @AuditCtx() ctx: AuditContext,
  ) {
    return this.auth.login(dto, { userAgent: req.headers['user-agent'], ip: req.ip }, res, ctx);
  }

  @Public()
  @Post('refresh')
  @HttpCode(200)
  refresh(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const token = (req.cookies as Record<string, string> | undefined)?.[REFRESH_COOKIE];
    return this.auth.refresh(token, { userAgent: req.headers['user-agent'], ip: req.ip }, res);
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
  @Post('change-password')
  @HttpCode(200)
  changePassword(@CurrentUser() user: AuthUser, @Body() dto: ChangePasswordDto, @AuditCtx() ctx: AuditContext) {
    return this.auth.changePassword(user, dto, ctx);
  }
}
