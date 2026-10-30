import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentUser, RequirePermissions } from '../common/decorators/auth.decorators.js';
import { AuditCtx } from '../common/decorators/audit-ctx.decorator.js';
import type { AuthUser } from '../common/auth/auth-user.js';
import type { AuditContext } from '../audit/audit.service.js';
import { InventoryService } from './inventory.service.js';
import { BalancesQuery, CreateAdjustmentDto, MovementsQuery } from './dto/inventory.dto.js';

@ApiTags('inventory')
@ApiBearerAuth()
@Controller('inventory')
export class InventoryController {
  constructor(private readonly service: InventoryService) {}

  @Get('balances')
  @RequirePermissions('inventory.read')
  balances(@CurrentUser() user: AuthUser, @Query() q: BalancesQuery) {
    return this.service.balances(user, q);
  }

  @Get('movements')
  @RequirePermissions('inventory.read')
  movements(@CurrentUser() user: AuthUser, @Query() q: MovementsQuery) {
    return this.service.movements(user, q);
  }

  @Post('adjustments')
  @RequirePermissions('inventory.adjust')
  adjust(@CurrentUser() user: AuthUser, @AuditCtx() ctx: AuditContext, @Body() dto: CreateAdjustmentDto) {
    return this.service.adjust(ctx, user, dto);
  }
}
