import { randomUUID } from 'node:crypto';
import { BadRequestException, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { AuditService, type AuditContext } from '../audit/audit.service.js';
import { StockService } from './stock.service.js';
import type { AuthUser } from '../common/auth/auth-user.js';
import { D, ZERO, isValidQty } from '../common/money.js';
import { normalizeName } from '../common/normalize.js';
import { paginated, skipOf } from '../common/pagination.dto.js';
import type { BalancesQuery, CreateAdjustmentDto, MovementsQuery } from './dto/inventory.dto.js';

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

interface BalanceRow {
  warehouseId: string;
  warehouseName: string;
  productId: string;
  name: string;
  sku: string | null;
  unit: string;
  minStock: Prisma.Decimal;
  qty: Prisma.Decimal;
  updatedAt: Date;
}

@Injectable()
export class InventoryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly stock: StockService,
    private readonly audit: AuditService,
  ) {}

  async balances(user: AuthUser, q: BalancesQuery) {
    const storeId = user.storeId;
    if (q.warehouseId) {
      const w = await this.prisma.warehouse.findFirst({ where: { id: q.warehouseId, storeId }, select: { id: true } });
      if (!w) throw new NotFoundException('Ombor topilmadi');
    }
    const conds: Prisma.Sql[] = [Prisma.sql`w."storeId" = ${storeId}::uuid`, Prisma.sql`p."storeId" = ${storeId}::uuid`];
    if (q.warehouseId) conds.push(Prisma.sql`b."warehouseId" = ${q.warehouseId}::uuid`);
    if (q.q?.trim()) {
      const term = q.q.trim();
      const nameLike = `%${escapeLike(normalizeName(term))}%`;
      const skuLike = `%${escapeLike(term)}%`;
      conds.push(Prisma.sql`(p."normalizedName" LIKE ${nameLike} OR p.sku ILIKE ${skuLike}
        OR EXISTS (SELECT 1 FROM "Barcode" bc WHERE bc."productId" = p.id AND bc.value = ${term}))`);
    }
    if (q.lowStock) conds.push(Prisma.sql`b.qty <= p."minStock"`);
    const whereSql = Prisma.join(conds, ' AND ');

    const [rows, count] = await Promise.all([
      this.prisma.$queryRaw<BalanceRow[]>`
        SELECT b."warehouseId", w.name AS "warehouseName", b."productId", p.name, p.sku, p.unit::text AS unit,
               p."minStock", b.qty, b."updatedAt"
        FROM "StockBalance" b
        JOIN "Product" p ON p.id = b."productId"
        JOIN "Warehouse" w ON w.id = b."warehouseId"
        WHERE ${whereSql}
        ORDER BY p."normalizedName" ASC, p.id ASC, w.name ASC
        LIMIT ${q.pageSize} OFFSET ${skipOf(q)}`,
      this.prisma.$queryRaw<{ n: bigint }[]>`
        SELECT count(*) AS n
        FROM "StockBalance" b
        JOIN "Product" p ON p.id = b."productId"
        JOIN "Warehouse" w ON w.id = b."warehouseId"
        WHERE ${whereSql}`,
    ]);
    const items = rows.map((r) => ({
      ...r,
      qty: new Prisma.Decimal(r.qty),
      minStock: new Prisma.Decimal(r.minStock),
      isLow: new Prisma.Decimal(r.qty).lte(r.minStock),
    }));
    return paginated(items, Number(count[0]?.n ?? 0), q);
  }

  async movements(user: AuthUser, q: MovementsQuery) {
    const storeId = user.storeId;
    const where: Prisma.StockMovementWhereInput = {
      warehouse: { storeId },
      product: { storeId },
    };
    if (q.warehouseId) where.warehouseId = q.warehouseId;
    if (q.productId) where.productId = q.productId;
    if (q.type) where.type = q.type;
    if (q.referenceType) where.referenceType = q.referenceType;
    if (q.dateFrom || q.dateTo) {
      where.createdAt = {
        ...(q.dateFrom ? { gte: new Date(q.dateFrom) } : {}),
        ...(q.dateTo ? { lte: new Date(q.dateTo) } : {}),
      };
    }
    const [total, items] = await Promise.all([
      this.prisma.stockMovement.count({ where }),
      this.prisma.stockMovement.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: skipOf(q),
        take: q.pageSize,
        include: {
          product: { select: { name: true, sku: true, unit: true } },
          warehouse: { select: { name: true } },
        },
      }),
    ]);
    return paginated(items, total, q);
  }

  async adjust(ctx: AuditContext, user: AuthUser, dto: CreateAdjustmentDto) {
    const storeId = user.storeId;
    const ids = dto.items.map((i) => i.productId);
    if (new Set(ids).size !== ids.length) throw new BadRequestException('Bir mahsulot ro‘yxatda ikki marta uchraydi');

    const warehouse = await this.prisma.warehouse.findFirst({ where: { id: dto.warehouseId, storeId } });
    if (!warehouse) throw new NotFoundException('Ombor topilmadi');
    if (warehouse.status !== 'ACTIVE') throw new UnprocessableEntityException('Ombor arxivlangan');

    const products = await this.prisma.product.findMany({ where: { id: { in: ids }, storeId } });
    if (products.length !== ids.length) throw new NotFoundException('Mahsulot topilmadi');
    const byId = new Map(products.map((p) => [p.id, p]));

    const counted = dto.items.map((i) => {
      const p = byId.get(i.productId)!;
      const c = D(i.countedQty);
      if (c.lt(0)) throw new BadRequestException(`Sanalgan miqdor manfiy bo‘lishi mumkin emas: ${p.name}`);
      if (!c.isZero() && !isValidQty(c, p.unit)) {
        throw new BadRequestException(`Miqdor aniqligi o‘lchov birligiga mos emas: ${p.name}`);
      }
      return { product: p, counted: c };
    });

    const referenceId = randomUUID();
    return this.prisma.$transaction(
      async (tx) => {
        const changes: { productId: string; name: string; before: Prisma.Decimal; after: Prisma.Decimal; delta: Prisma.Decimal }[] = [];
        for (const { product, counted: c } of counted) {
          // Qatorni qulflaymiz: hisoblangan delta parallel o‘zgarish tufayli eskirmasin.
          const cur = await tx.$queryRaw<{ qty: Prisma.Decimal }[]>`
            SELECT qty FROM "StockBalance"
            WHERE "warehouseId" = ${warehouse.id}::uuid AND "productId" = ${product.id}::uuid FOR UPDATE`;
          const before = cur[0] ? new Prisma.Decimal(cur[0].qty) : ZERO;
          const delta = c.minus(before);
          if (delta.isZero()) continue;
          const after = await this.stock.apply(tx, {
            warehouseId: warehouse.id,
            productId: product.id,
            delta,
            type: 'ADJUSTMENT',
            actorId: user.id,
            reason: dto.reason.trim(),
            referenceType: 'Adjustment',
            referenceId,
            blockNegative: false,
          });
          changes.push({ productId: product.id, name: product.name, before, after, delta });
        }
        if (changes.length) {
          await this.audit.log(
            ctx,
            {
              action: 'inventory.adjusted',
              entityType: 'Adjustment',
              entityId: referenceId,
              metadata: {
                warehouseId: warehouse.id,
                reason: dto.reason.trim(),
                items: changes.map((c) => ({ productId: c.productId, name: c.name, before: c.before, after: c.after })),
              },
            },
            tx,
          );
        }
        const movements = await tx.stockMovement.findMany({
          where: { referenceType: 'Adjustment', referenceId, warehouseId: warehouse.id },
          orderBy: { createdAt: 'asc' },
        });
        return { referenceId, count: movements.length, movements };
      },
      { timeout: 30_000 },
    );
  }
}
