import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentUser, RequirePermissions } from '../common/decorators/auth.decorators.js';
import type { AuthUser } from '../common/auth/auth-user.js';
import { AuditLogService, AuditQuery } from './audit-log.service.js';

/** Faqat o‘qish (TZ 14.2): update/delete endpointlari yo‘q. */
@ApiTags('audit')
@ApiBearerAuth()
@Controller('audit')
export class AuditLogController {
  constructor(private readonly service: AuditLogService) {}

  @RequirePermissions('audit.read')
  @Get()
  list(@CurrentUser() user: AuthUser, @Query() q: AuditQuery) {
    return this.service.list(user.storeId, q);
  }
}
