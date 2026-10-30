import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '../generated/prisma/client.js';
import { PrismaService, type Tx } from '../prisma/prisma.service.js';
import { AuditService, type AuditContext } from '../audit/audit.service.js';
import { StockService } from '../inventory/stock.service.js';
import type { AuthUser } from '../common/auth/auth-user.js';
import { D, ZERO, isValidQty } from '../common/money.js';
import { normalizeName } from '../common/normalize.js';
import { paginated, skipOf } from '../common/pagination.dto.js';
import type { CreateProductDto, ListProductsQuery, UpdateProductDto } from './dto/product.dto.js';

const PRODUCT_INCLUDE = {
  barcodes: { select: { id: true, value: true } },
  category: { select: { id: true, name: true } },
} satisfies Prisma.ProductInclude;

@Injectable()
export class ProductsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly stock: StockService,
  ) {}

  /** costPrice faqat costs.read ruxsati bilan ko‘rinadi. */
  view<T extends { costPrice?: unknown }>(user: AuthUser, p: T, qty?: Prisma.Decimal | null) {
    const { costPrice, ...rest } = p;
    const out: Record<string, unknown> = user.permissions.has('costs.read') ? { ...rest, costPrice } : { ...rest };
    if (qty !== undefined) out.qty = qty;
    return out;
  }

  /** Berilgan yoki do‘konning birinchi faol ombori. */
  async resolveWarehouseId(storeId: string, warehouseId?: string, tx?: Tx): Promise<string | null> {
    const db = tx ?? this.prisma;
    if (warehouseId) {
      const w = await db.warehouse.findFirst({ where: { id: warehouseId, storeId }, select: { id: true } });
      if (!w) throw new NotFoundException('Ombor topilmadi');
      return w.id;
    }
    const w = await db.warehouse.findFirst({
      where: { storeId, status: 'ACTIVE' },
      orderBy: { createdAt: 'asc' },
      select: { id: true },
    });
    return w?.id ?? null;
  }

  async list(user: AuthUser, q: ListProductsQuery) {
    const storeId = user.storeId;
    const warehouseId = await this.resolveWarehouseId(storeId, q.warehouseId);
    const where: Prisma.ProductWhereInput = { storeId };
    if (q.q?.trim()) {
      const term = q.q.trim();
      where.OR = [
        { normalizedName: { contains: normalizeName(term) } },
        { sku: { contains: term, mode: 'insensitive' } },
        { barcodes: { some: { value: term } } },
      ];
    }
    if (q.categoryId) where.categoryId = q.categoryId;
    if (q.isActive !== undefined) where.isActive = q.isActive;
    if (q.lowStock) {
      const rows = await this.prisma.$queryRaw<{ id: string }[]>`
        SELECT p.id FROM "Product" p
        LEFT JOIN "StockBalance" b ON b."productId" = p.id AND b."warehouseId" = ${warehouseId}::uuid
        WHERE p."storeId" = ${storeId}::uuid AND COALESCE(b.qty, 0) <= p."minStock"`;
      where.id = { in: rows.map((r) => r.id) };
    }
    const orderBy: Prisma.ProductOrderByWithRelationInput =
      q.sortBy === 'salePrice' ? { salePrice: q.sortDir } : q.sortBy === 'createdAt' ? { createdAt: q.sortDir } : { normalizedName: q.sortDir };

    const [total, items] = await Promise.all([
      this.prisma.product.count({ where }),
      this.prisma.product.findMany({ where, orderBy: [orderBy, { id: 'asc' }], skip: skipOf(q), take: q.pageSize, include: PRODUCT_INCLUDE }),
    ]);
    const qtyMap = await this.qtyMap(warehouseId, items.map((i) => i.id));
    return {
      ...paginated(items.map((p) => this.view(user, p, qtyMap.get(p.id) ?? ZERO)), total, q),
      warehouseId,
    };
  }

  private async qtyMap(warehouseId: string | null, productIds: string[]) {
    const map = new Map<string, Prisma.Decimal>();
    if (!warehouseId || productIds.length === 0) return map;
    const rows = await this.prisma.stockBalance.findMany({ where: { warehouseId, productId: { in: productIds } } });
    for (const r of rows) map.set(r.productId, r.qty);
    return map;
  }

  /** POS skaner uchun tez yo‘l: aniq barcode, faqat ACTIVE. */
  async lookup(user: AuthUser, barcode: string, warehouseIdParam?: string) {
    const code = barcode.trim();
    const b = await this.prisma.barcode.findUnique({
      where: { storeId_value: { storeId: user.storeId, value: code } },
      include: { product: { include: PRODUCT_INCLUDE } },
    });
    if (!b || !b.product.isActive) throw new NotFoundException('Mahsulot topilmadi');
    const warehouseId = await this.resolveWarehouseId(user.storeId, warehouseIdParam);
    const qty = (await this.qtyMap(warehouseId, [b.productId])).get(b.productId) ?? ZERO;
    return { ...this.view(user, b.product, qty), warehouseId };
  }

  async get(user: AuthUser, id: string) {
    const p = await this.prisma.product.findFirst({ where: { id, storeId: user.storeId }, include: PRODUCT_INCLUDE });
    if (!p) throw new NotFoundException('Mahsulot topilmadi');
    const warehouseId = await this.resolveWarehouseId(user.storeId);
    const qty = (await this.qtyMap(warehouseId, [id])).get(id) ?? ZERO;
    return { ...this.view(user, p, qty), warehouseId };
  }

  private cleanBarcodes(values: string[] | undefined): string[] | undefined {
    if (!values) return undefined;
    const cleaned = values.map((v) => v.trim()).filter(Boolean);
    const dup = cleaned.find((v, i) => cleaned.indexOf(v) !== i);
    if (dup) throw new BadRequestException(`Shtrix-kod takrorlangan: ${dup}`);
    return cleaned;
  }

  private nonNegative(label: string, v: Prisma.Decimal) {
    if (v.lt(0)) throw new BadRequestException(`${label} manfiy bo‘lishi mumkin emas`);
  }

  private async assertUnique(tx: Tx, storeId: string, barcodes: string[] | undefined, sku: string | null | undefined, exceptId?: string) {
    if (barcodes?.length) {
      const hit = await tx.barcode.findFirst({
        where: { storeId, value: { in: barcodes }, ...(exceptId ? { productId: { not: exceptId } } : {}) },
      });
      if (hit) throw new ConflictException(`Shtrix-kod allaqachon band: ${hit.value}`);
    }
    if (sku) {
      const hit = await tx.product.findFirst({ where: { storeId, sku, ...(exceptId ? { id: { not: exceptId } } : {}) } });
      if (hit) throw new ConflictException(`SKU allaqachon band: ${sku}`);
    }
  }

  private async assertCategory(tx: Tx, storeId: string, categoryId: string | null | undefined) {
    if (!categoryId) return;
    const c = await tx.category.findFirst({ where: { id: categoryId, storeId }, select: { id: true } });
    if (!c) throw new NotFoundException('Kategoriya topilmadi');
  }

  private wrapP2002(e: unknown): never {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
      throw new ConflictException('SKU yoki shtrix-kod allaqachon band');
    }
    throw e;
  }

  async create(ctx: AuditContext, user: AuthUser, dto: CreateProductDto) {
    const storeId = user.storeId;
    const salePrice = D(dto.salePrice);
    const costPrice = dto.costPrice !== undefined ? D(dto.costPrice) : ZERO;
    const minStock = dto.minStock !== undefined ? D(dto.minStock) : ZERO;
    this.nonNegative('Sotuv narxi', salePrice);
    this.nonNegative('Tannarx', costPrice);
    this.nonNegative('Minimal qoldiq', minStock);
    const barcodes = this.cleanBarcodes(dto.barcodes) ?? [];
    const sku = dto.sku?.trim() || null;
    const initialQty = dto.initialQty !== undefined ? D(dto.initialQty) : null;
    if (initialQty && initialQty.gt(0) && !isValidQty(initialQty, dto.unit)) {
      throw new BadRequestException('Boshlang‘ich qoldiq aniqligi o‘lchov birligiga mos emas');
    }
    if (initialQty?.lt(0)) throw new BadRequestException('Boshlang‘ich qoldiq manfiy bo‘lishi mumkin emas');

    try {
      const id = await this.prisma.$transaction(async (tx) => {
        await this.assertCategory(tx, storeId, dto.categoryId);
        await this.assertUnique(tx, storeId, barcodes, sku);
        const p = await tx.product.create({
          data: {
            storeId,
            categoryId: dto.categoryId ?? null,
            name: dto.name.trim(),
            normalizedName: normalizeName(dto.name),
            sku,
            unit: dto.unit,
            salePrice,
            costPrice,
            minStock,
            barcodes: { create: barcodes.map((value) => ({ storeId, value })) },
          },
        });
        if (initialQty && initialQty.gt(0)) {
          const warehouseId = await this.resolveWarehouseId(storeId, dto.warehouseId, tx);
          if (!warehouseId) throw new BadRequestException('Faol ombor topilmadi');
          await this.stock.apply(tx, {
            warehouseId,
            productId: p.id,
            delta: initialQty,
            type: 'ADJUSTMENT',
            actorId: user.id,
            reason: 'Boshlang‘ich qoldiq',
            referenceType: 'ProductCreate',
            referenceId: p.id,
          });
        }
        await this.audit.log(
          ctx,
          { action: 'product.created', entityType: 'Product', entityId: p.id, metadata: { name: p.name, sku, salePrice, initialQty } },
          tx,
        );
        return p.id;
      });
      return await this.get(user, id);
    } catch (e) {
      this.wrapP2002(e);
    }
  }

  async update(ctx: AuditContext, user: AuthUser, id: string, dto: UpdateProductDto) {
    const storeId = user.storeId;
    const existing = await this.prisma.product.findFirst({ where: { id, storeId } });
    if (!existing) throw new NotFoundException('Mahsulot topilmadi');

    const data: Prisma.ProductUncheckedUpdateInput = {};
    const changed: string[] = [];
    let priceChange: { old: Prisma.Decimal; new: Prisma.Decimal } | null = null;

    if (dto.salePrice !== undefined) {
      const v = D(dto.salePrice);
      this.nonNegative('Sotuv narxi', v);
      if (!v.eq(existing.salePrice)) {
        if (!user.permissions.has('pricing.change')) throw new ForbiddenException('Narxni o‘zgartirish huquqi yo‘q');
        data.salePrice = v;
        priceChange = { old: existing.salePrice, new: v };
        changed.push('salePrice');
      }
    }
    if (dto.costPrice !== undefined) {
      const v = D(dto.costPrice);
      this.nonNegative('Tannarx', v);
      if (!v.eq(existing.costPrice)) {
        if (!user.permissions.has('costs.read')) throw new ForbiddenException('Tannarxni o‘zgartirish huquqi yo‘q');
        data.costPrice = v;
        changed.push('costPrice');
      }
    }
    if (dto.minStock !== undefined) {
      const v = D(dto.minStock);
      this.nonNegative('Minimal qoldiq', v);
      data.minStock = v;
      changed.push('minStock');
    }
    if (dto.name !== undefined) {
      data.name = dto.name.trim();
      data.normalizedName = normalizeName(dto.name);
      changed.push('name');
    }
    let sku: string | null | undefined;
    if (dto.sku !== undefined) {
      sku = dto.sku === null ? null : dto.sku.trim() || null;
      data.sku = sku;
      changed.push('sku');
    }
    if (dto.categoryId !== undefined) {
      data.categoryId = dto.categoryId;
      changed.push('categoryId');
    }
    const barcodes = this.cleanBarcodes(dto.barcodes);
    if (barcodes) changed.push('barcodes');

    try {
      await this.prisma.$transaction(async (tx) => {
        await this.assertCategory(tx, storeId, dto.categoryId);
        await this.assertUnique(tx, storeId, barcodes, sku, id);
        if (barcodes) {
          await tx.barcode.deleteMany({ where: { productId: id, storeId } });
          if (barcodes.length) await tx.barcode.createMany({ data: barcodes.map((value) => ({ storeId, productId: id, value })) });
        }
        if (Object.keys(data).length) await tx.product.update({ where: { id }, data });
        if (priceChange) {
          await this.audit.log(ctx, { action: 'product.price_changed', entityType: 'Product', entityId: id, metadata: priceChange }, tx);
        }
        if (changed.length) {
          await this.audit.log(ctx, { action: 'product.updated', entityType: 'Product', entityId: id, metadata: { fields: changed } }, tx);
        }
      });
    } catch (e) {
      this.wrapP2002(e);
    }
    return this.get(user, id);
  }

  archive(ctx: AuditContext, user: AuthUser, id: string) {
    return this.setActive(ctx, user, id, false);
  }

  restore(ctx: AuditContext, user: AuthUser, id: string) {
    return this.setActive(ctx, user, id, true);
  }

  private async setActive(ctx: AuditContext, user: AuthUser, id: string, isActive: boolean) {
    const existing = await this.prisma.product.findFirst({ where: { id, storeId: user.storeId }, select: { id: true } });
    if (!existing) throw new NotFoundException('Mahsulot topilmadi');
    await this.prisma.$transaction(async (tx) => {
      await tx.product.update({ where: { id }, data: { isActive } });
      await this.audit.log(ctx, { action: isActive ? 'product.restored' : 'product.archived', entityType: 'Product', entityId: id }, tx);
    });
    return this.get(user, id);
  }
}
