import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AuditCtx } from '../common/decorators/audit-ctx.decorator.js';
import { CurrentUser, RequirePermissions } from '../common/decorators/auth.decorators.js';
import type { AuthUser } from '../common/auth/auth-user.js';
import type { AuditContext } from '../audit/audit.service.js';
import { PaginationQuery } from '../common/pagination.dto.js';
import { CustomersService } from './customers.service.js';
import { CreateCustomerDto, CustomerListQuery, UpdateCustomerDto } from './dto.js';

@ApiTags('customers')
@ApiBearerAuth()
@Controller('customers')
export class CustomersController {
  constructor(private readonly service: CustomersService) {}

  @RequirePermissions('customers.read')
  @Get()
  list(@CurrentUser() user: AuthUser, @Query() q: CustomerListQuery) {
    return this.service.list(user, q);
  }

  @RequirePermissions('customers.read')
  @Get(':id')
  get(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Query() q: PaginationQuery) {
    return this.service.get(user, id, q);
  }

  @RequirePermissions('customers.manage')
  @Post()
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateCustomerDto, @AuditCtx() ctx: AuditContext) {
    return this.service.create(user, dto, ctx);
  }

  @RequirePermissions('customers.manage')
  @Patch(':id')
  update(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateCustomerDto,
    @AuditCtx() ctx: AuditContext,
  ) {
    return this.service.update(user, id, dto, ctx);
  }
}
