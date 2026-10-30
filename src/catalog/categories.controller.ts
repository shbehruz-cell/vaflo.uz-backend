import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentUser, RequirePermissions } from '../common/decorators/auth.decorators.js';
import { AuditCtx } from '../common/decorators/audit-ctx.decorator.js';
import type { AuthUser } from '../common/auth/auth-user.js';
import type { AuditContext } from '../audit/audit.service.js';
import { CategoriesService } from './categories.service.js';
import { CategoryDto } from './dto/category.dto.js';

@ApiTags('categories')
@ApiBearerAuth()
@Controller('categories')
export class CategoriesController {
  constructor(private readonly service: CategoriesService) {}

  @Get()
  @RequirePermissions('products.read')
  list(@CurrentUser() user: AuthUser) {
    return this.service.list(user);
  }

  @Post()
  @RequirePermissions('products.manage')
  create(@CurrentUser() user: AuthUser, @AuditCtx() ctx: AuditContext, @Body() dto: CategoryDto) {
    return this.service.create(ctx, user, dto.name);
  }

  @Patch(':id')
  @RequirePermissions('products.manage')
  update(
    @CurrentUser() user: AuthUser,
    @AuditCtx() ctx: AuditContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CategoryDto,
  ) {
    return this.service.update(ctx, user, id, dto.name);
  }
}
