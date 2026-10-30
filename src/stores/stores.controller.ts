import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AuditCtx } from '../common/decorators/audit-ctx.decorator.js';
import { CurrentUser, RequirePermissions } from '../common/decorators/auth.decorators.js';
import type { AuthUser } from '../common/auth/auth-user.js';
import type { AuditContext } from '../audit/audit.service.js';
import { StoresService } from './stores.service.js';
import { CreateRegisterDto, CreateWarehouseDto, UpdateRegisterDto, UpdateStoreDto } from './dto.js';

@ApiTags('stores')
@ApiBearerAuth()
@Controller()
export class StoresController {
  constructor(private readonly service: StoresService) {}

  @Get('stores/current')
  current(@CurrentUser() user: AuthUser) {
    return this.service.current(user);
  }

  @Patch('stores/current')
  update(@CurrentUser() user: AuthUser, @Body() dto: UpdateStoreDto, @AuditCtx() ctx: AuditContext) {
    return this.service.update(user, dto, ctx);
  }

  @Get('warehouses')
  warehouses(@CurrentUser() user: AuthUser) {
    return this.service.warehouses(user);
  }

  @Post('warehouses')
  createWarehouse(@CurrentUser() user: AuthUser, @Body() dto: CreateWarehouseDto, @AuditCtx() ctx: AuditContext) {
    return this.service.createWarehouse(user, dto, ctx);
  }

  @Get('registers')
  registers(@CurrentUser() user: AuthUser) {
    return this.service.registers(user);
  }

  @Post('registers')
  @RequirePermissions('registers.manage')
  createRegister(@CurrentUser() user: AuthUser, @Body() dto: CreateRegisterDto, @AuditCtx() ctx: AuditContext) {
    return this.service.createRegister(user, dto, ctx);
  }

  @Get('registers/staff')
  @RequirePermissions('registers.manage')
  registerStaff(@CurrentUser() user: AuthUser) {
    return this.service.registerStaff(user);
  }

  @Patch('registers/:id')
  @RequirePermissions('registers.manage')
  updateRegister(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateRegisterDto,
    @AuditCtx() ctx: AuditContext,
  ) {
    return this.service.updateRegister(user, id, dto, ctx);
  }
}
