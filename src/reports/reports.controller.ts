import { Controller, Get, Query, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { AuditCtx } from '../common/decorators/audit-ctx.decorator.js';
import { CurrentUser, RequirePermissions } from '../common/decorators/auth.decorators.js';
import type { AuthUser } from '../common/auth/auth-user.js';
import type { AuditContext } from '../audit/audit.service.js';
import { LowStockQuery, ReportQuery, TopProductsQuery } from './dto.js';
import { ReportsService } from './reports.service.js';

@ApiTags('reports')
@ApiBearerAuth()
@RequirePermissions('reports.read')
@Controller('reports')
export class ReportsController {
  constructor(private readonly service: ReportsService) {}

  @Get('summary')
  summary(@CurrentUser() user: AuthUser, @Query() q: ReportQuery) {
    return this.service.summary(user, q);
  }

  @Get('sales-by-day')
  salesByDay(@CurrentUser() user: AuthUser, @Query() q: ReportQuery) {
    return this.service.salesByDay(user, q);
  }

  @Get('top-products')
  topProducts(@CurrentUser() user: AuthUser, @Query() q: TopProductsQuery) {
    return this.service.topProducts(user, q, q.limit);
  }

  @Get('by-cashier')
  byCashier(@CurrentUser() user: AuthUser, @Query() q: ReportQuery) {
    return this.service.byCashier(user, q);
  }

  @Get('low-stock')
  lowStock(@CurrentUser() user: AuthUser, @Query() q: LowStockQuery) {
    return this.service.lowStock(user, q.warehouseId);
  }

  @Get('sales.csv')
  async salesCsv(
    @CurrentUser() user: AuthUser,
    @Query() q: ReportQuery,
    @AuditCtx() ctx: AuditContext,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { csv, filename } = await this.service.salesCsv(user, q, ctx);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    return csv;
  }
}
