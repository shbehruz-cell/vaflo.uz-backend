import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentUser, RequirePermissions } from '../common/decorators/auth.decorators.js';
import { AuditCtx } from '../common/decorators/audit-ctx.decorator.js';
import type { AuditContext } from '../audit/audit.service.js';
import type { AuthUser } from '../common/auth/auth-user.js';
import { CreateUserDto, ListUsersQuery, ResetPasswordDto, UpdateUserDto } from './dto/users.dto.js';
import { UsersService } from './users.service.js';

@ApiTags('users')
@ApiBearerAuth()
@RequirePermissions('users.manage')
@Controller('users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get()
  list(@CurrentUser() user: AuthUser, @Query() q: ListUsersQuery) {
    return this.users.list(user, q);
  }

  @Get(':id')
  get(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.users.get(user, id);
  }

  @Post()
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateUserDto, @AuditCtx() ctx: AuditContext) {
    return this.users.create(user, dto, ctx);
  }

  @Patch(':id')
  update(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateUserDto,
    @AuditCtx() ctx: AuditContext,
  ) {
    return this.users.update(user, id, dto, ctx);
  }

  @Post(':id/reset-password')
  @HttpCode(200)
  resetPassword(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ResetPasswordDto,
    @AuditCtx() ctx: AuditContext,
  ) {
    return this.users.resetPassword(user, id, dto, ctx);
  }
}
