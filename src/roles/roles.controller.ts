import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentUser, RequirePermissions } from '../common/decorators/auth.decorators.js';
import { AuditCtx } from '../common/decorators/audit-ctx.decorator.js';
import type { AuditContext } from '../audit/audit.service.js';
import type { AuthUser } from '../common/auth/auth-user.js';
import { CreateRoleDto, UpdateRoleDto } from './dto/roles.dto.js';
import { RolesService } from './roles.service.js';

@ApiTags('roles')
@ApiBearerAuth()
@Controller('roles')
export class RolesController {
  constructor(private readonly roles: RolesService) {}

  @Get()
  @RequirePermissions('users.manage', 'roles.manage')
  list(@CurrentUser() user: AuthUser) {
    return this.roles.list(user);
  }

  @Get('permissions')
  @RequirePermissions('users.manage', 'roles.manage')
  permissions() {
    return this.roles.permissions();
  }

  @Post()
  @RequirePermissions('roles.manage')
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateRoleDto, @AuditCtx() ctx: AuditContext) {
    return this.roles.create(user, dto, ctx);
  }

  @Patch(':id')
  @RequirePermissions('roles.manage')
  update(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateRoleDto,
    @AuditCtx() ctx: AuditContext,
  ) {
    return this.roles.update(user, id, dto, ctx);
  }

  @Delete(':id')
  @RequirePermissions('roles.manage')
  remove(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @AuditCtx() ctx: AuditContext) {
    return this.roles.remove(user, id, ctx);
  }
}
