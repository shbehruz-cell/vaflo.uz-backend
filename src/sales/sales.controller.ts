import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { CurrentUser, RequirePermissions } from '../common/decorators/auth.decorators.js';
import { AuditCtx } from '../common/decorators/audit-ctx.decorator.js';
import type { AuthUser } from '../common/auth/auth-user.js';
import type { AuditContext } from '../audit/audit.service.js';
import { SalesService } from './sales.service.js';
import { CreateRefundDto, CreateSaleDto, ListSalesQuery, VoidSaleDto } from './dto/sales.dto.js';

@ApiTags('sales')
@ApiBearerAuth()
@Controller('sales')
export class SalesController {
  constructor(private readonly sales: SalesService) {}

  /** Yangi sotuv: 201; shu idempotencyKey bilan oldin yaratilgan bo‘lsa 200 va o‘sha chek. */
  @Post()
  @RequirePermissions('sales.create')
  async create(
    @CurrentUser() user: AuthUser,
    @Body() dto: CreateSaleDto,
    @AuditCtx() ctx: AuditContext,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { created, receipt } = await this.sales.create(user, dto, ctx);
    res.status(created ? 201 : 200);
    return receipt;
  }

  @Get()
  @RequirePermissions('sales.read.all', 'sales.read.own')
  list(@CurrentUser() user: AuthUser, @Query() q: ListSalesQuery) {
    return this.sales.list(user, q);
  }

  @Get(':id')
  @RequirePermissions('sales.read.all', 'sales.read.own')
  get(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.sales.receipt(id, user);
  }

  @Post(':id/refunds')
  @RequirePermissions('sales.refund')
  refund(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateRefundDto,
    @AuditCtx() ctx: AuditContext,
  ) {
    return this.sales.refund(id, user, dto, ctx);
  }

  @Post(':id/void')
  @HttpCode(200)
  @RequirePermissions('sales.void')
  voidSale(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: VoidSaleDto,
    @AuditCtx() ctx: AuditContext,
  ) {
    return this.sales.voidSale(id, user, dto, ctx);
  }
}
