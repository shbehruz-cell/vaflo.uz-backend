import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query, UploadedFiles, UseInterceptors } from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import { Throttle } from '@nestjs/throttler';
import { ApiBearerAuth, ApiBody, ApiConsumes, ApiTags } from '@nestjs/swagger';
import { CurrentUser, RequirePermissions } from '../common/decorators/auth.decorators.js';
import { AuditCtx } from '../common/decorators/audit-ctx.decorator.js';
import type { AuthUser } from '../common/auth/auth-user.js';
import type { AuditContext } from '../audit/audit.service.js';
import { ProductsService } from './products.service.js';
import { ProductImportService } from './product-import.service.js';
import { AiDraftService } from './ai-draft.service.js';
import { AuditService } from '../audit/audit.service.js';
import { CreateProductDto, ImportBodyDto, ListProductsQuery, LookupQuery, UpdateProductDto } from './dto/product.dto.js';

@ApiTags('products')
@ApiBearerAuth()
@Controller('products')
export class ProductsController {
  constructor(
    private readonly service: ProductsService,
    private readonly importer: ProductImportService,
    private readonly aiDraft: AiDraftService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  @RequirePermissions('products.read')
  list(@CurrentUser() user: AuthUser, @Query() q: ListProductsQuery) {
    return this.service.list(user, q);
  }

  // Statik marshrutlar :id dan oldin turishi kerak.
  @Get('lookup')
  @RequirePermissions('products.read', 'sales.create')
  lookup(@CurrentUser() user: AuthUser, @Query() q: LookupQuery) {
    return this.service.lookup(user, q.barcode, q.warehouseId);
  }

  @Post('import/preview')
  @HttpCode(200)
  @RequirePermissions('products.manage')
  importPreview(@CurrentUser() user: AuthUser, @Body() body: ImportBodyDto) {
    return this.importer.preview(user, body);
  }

  @Post('import/commit')
  @RequirePermissions('products.manage')
  importCommit(@CurrentUser() user: AuthUser, @AuditCtx() ctx: AuditContext, @Body() body: ImportBodyDto) {
    return this.importer.commit(ctx, user, body);
  }

  // AI orqali qoralama: bazaga yozmaydi. Statik marshrut, :id dan oldin turadi.
  @Post('ai-draft')
  @HttpCode(200)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @RequirePermissions('products.manage')
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: { images: { type: 'array', items: { type: 'string', format: 'binary' }, maxItems: 5 } },
      required: ['images'],
    },
  })
  @UseInterceptors(FilesInterceptor('images', 5, { limits: { fileSize: 5 * 1024 * 1024 } }))
  async aiDraftEndpoint(
    @CurrentUser() user: AuthUser,
    @AuditCtx() ctx: AuditContext,
    @UploadedFiles() files: Express.Multer.File[] | undefined,
  ) {
    const result = await this.aiDraft.draft(user, files);
    await this.audit.log(ctx, {
      action: 'products.ai_draft',
      entityType: 'Product',
      metadata: { imageCount: files?.length ?? 0, draftCount: result.drafts.length },
    });
    return result;
  }

  @Get(':id')
  @RequirePermissions('products.read')
  get(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.get(user, id);
  }

  @Post()
  @RequirePermissions('products.manage')
  create(@CurrentUser() user: AuthUser, @AuditCtx() ctx: AuditContext, @Body() dto: CreateProductDto) {
    return this.service.create(ctx, user, dto);
  }

  @Patch(':id')
  @RequirePermissions('products.manage')
  update(
    @CurrentUser() user: AuthUser,
    @AuditCtx() ctx: AuditContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateProductDto,
  ) {
    return this.service.update(ctx, user, id, dto);
  }

  @Post(':id/archive')
  @HttpCode(200)
  @RequirePermissions('products.manage')
  archive(@CurrentUser() user: AuthUser, @AuditCtx() ctx: AuditContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.archive(ctx, user, id);
  }

  @Post(':id/restore')
  @HttpCode(200)
  @RequirePermissions('products.manage')
  restore(@CurrentUser() user: AuthUser, @AuditCtx() ctx: AuditContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.restore(ctx, user, id);
  }
}
