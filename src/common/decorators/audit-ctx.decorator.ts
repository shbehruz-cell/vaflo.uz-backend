import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { AuditContext } from '../../audit/audit.service.js';

/** Controllerda: `@AuditCtx() ctx: AuditContext` — user, requestId va IP ni bir joyda oladi. */
export const AuditCtx = createParamDecorator((_: unknown, ctx: ExecutionContext): AuditContext => {
  const req = ctx.switchToHttp().getRequest();
  return { user: req.user ?? null, requestId: req.id, ip: req.ip };
});
