import { createParamDecorator, ExecutionContext, SetMetadata } from '@nestjs/common';
import type { PermissionCode } from '../permissions.js';
import type { AuthUser } from '../auth/auth-user.js';

export const IS_PUBLIC = 'isPublic';
export const REQUIRED_PERMISSIONS = 'requiredPermissions';

/** Autentifikatsiyasiz ochiq endpoint. */
export const Public = () => SetMetadata(IS_PUBLIC, true);

/** Ko‘rsatilgan permissionlardan KAMIDA BITTASI talab qilinadi. */
export const RequirePermissions = (...codes: PermissionCode[]) => SetMetadata(REQUIRED_PERMISSIONS, codes);

export const CurrentUser = createParamDecorator((_: unknown, ctx: ExecutionContext): AuthUser => {
  return ctx.switchToHttp().getRequest().user;
});
