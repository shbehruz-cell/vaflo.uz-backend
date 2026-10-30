import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentUser, RequirePermissions } from '../common/decorators/auth.decorators.js';
import { AuditCtx } from '../common/decorators/audit-ctx.decorator.js';
import type { AuthUser } from '../common/auth/auth-user.js';
import type { AuditContext } from '../audit/audit.service.js';
import { ShiftsService } from './shifts.service.js';
import { CashMovementDto, CloseShiftDto, ListShiftsQuery, OpenShiftDto } from './dto/shifts.dto.js';

@ApiTags('shifts')
@ApiBearerAuth()
@Controller('shifts')
export class ShiftsController {
  constructor(private readonly shifts: ShiftsService) {}

  @Post('open')
  @RequirePermissions('shifts.manage')
  open(@CurrentUser() user: AuthUser, @Body() dto: OpenShiftDto, @AuditCtx() ctx: AuditContext) {
    return this.shifts.open(user, dto, ctx);
  }

  @Get('current')
  @RequirePermissions('shifts.manage')
  current(@CurrentUser() user: AuthUser) {
    return this.shifts.current(user);
  }

  @Get()
  @RequirePermissions('shifts.manage', 'shifts.read.all')
  list(@CurrentUser() user: AuthUser, @Query() q: ListShiftsQuery) {
    return this.shifts.list(user, q);
  }

  @Get(':id')
  @RequirePermissions('shifts.manage', 'shifts.read.all')
  get(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.shifts.detail(id, user);
  }

  @Post(':id/cash-movements')
  @RequirePermissions('shifts.manage')
  cashMovement(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CashMovementDto,
    @AuditCtx() ctx: AuditContext,
  ) {
    return this.shifts.addCashMovement(id, user, dto, ctx);
  }

  @Post(':id/close')
  @HttpCode(200)
  @RequirePermissions('shifts.manage')
  close(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CloseShiftDto,
    @AuditCtx() ctx: AuditContext,
  ) {
    return this.shifts.close(id, user, dto, ctx);
  }
}
