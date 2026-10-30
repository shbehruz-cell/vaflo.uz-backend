import {
  ConflictException, ForbiddenException, Injectable, NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Prisma } from '../generated/prisma/client.js';
import { PrismaService, type Tx } from '../prisma/prisma.service.js';
import { AuditContext, AuditService } from '../audit/audit.service.js';
import { StockService } from '../inventory/stock.service.js';
import { ShiftsService } from '../shifts/shifts.service.js';
import type { AuthUser } from '../common/auth/auth-user.js';
import { DISCOUNT_LIMIT_PERCENT } from '../common/permissions.js';
import { D, ZERO, isValidQty, money } from '../common/money.js';
import { paginated, skipOf } from '../common/pagination.dto.js';
import type { CreateRefundDto, CreateSaleDto, ListSalesQuery, VoidSaleDto } from './dto/sales.dto.js';
import { calcRefundAmount, calcTotals, discountExceedsLimit, isDiscountValid } from './sales.math.js';

const RECEIPT_RETRIES = 3;

/** Do‘kon vaqt zonasidagi YYMMDD. */
function datePrefix(timezone: string, now = new Date()) {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone, year: '2-digit', month: '2-digit', day: '2-digit',
    }).formatToParts(now);
  } catch {
    parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Tashkent', year: '2-digit', month: '2-digit', day: '2-digit',
    }).formatToParts(now);
  }
  const g = (t: string) => parts.find((p) => p.type === t)?.value ?? '00';
  return `${g('year')}${g('month')}${g('day')}`;
}

function endOfRange(v: string) {
  const d = new Date(v);
  if (v.length <= 10) d.setUTCDate(d.getUTCDate() + 1);
  return d;
}

const isUniqueViolation = (e: unknown) =>
  e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002';

@Injectable()
export class SalesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly stock: StockService,
    private readonly shifts: ShiftsService,
  ) {}

  // ───────────── Sotuv yaratish ─────────────

  async create(user: AuthUser, dto: CreateSaleDto, ctx: AuditContext): Promise<{ created: boolean; receipt: unknown }> {
    let lastErr: unknown;
    for (let attempt = 0; attempt < RECEIPT_RETRIES; attempt++) {
      try {
        const r = await this.prisma.$transaction((tx) => this.createInTx(tx, user, dto, ctx), { timeout: 20000 });
        return { created: r.created, receipt: await this.receipt(r.id, user, true) };
      } catch (e) {
        if (!isUniqueViolation(e)) throw e;
        lastErr = e;
        // Parallel so‘rov shu idempotencyKey bilan yozib bo‘lgan bo‘lishi mumkin.
        const existing = await this.prisma.sale.findUnique({
          where: { storeId_idempotencyKey: { storeId: user.storeId, idempotencyKey: dto.idempotencyKey } },
          select: { id: true },
        });
        if (existing) return { created: false, receipt: await this.receipt(existing.id, user, true) };
        // aks holda receiptNo to‘qnashuvi — butun tranzaksiyani qayta urinamiz
      }
    }
    throw new ConflictException({ message: 'Chek raqamini yaratib bo‘lmadi, qayta urinib ko‘ring', cause: String(lastErr) });
  }

  private async createInTx(tx: Tx, user: AuthUser, dto: CreateSaleDto, ctx: AuditContext) {
    // a) idempotentlik
    const dup = await tx.sale.findUnique({
      where: { storeId_idempotencyKey: { storeId: user.storeId, idempotencyKey: dto.idempotencyKey } },
      select: { id: true },
    });
    if (dup) return { id: dup.id, created: false };

    // b) ochiq smena
    const shift = await this.shifts.requireOpenShift(tx, user);
    const warehouseId = shift.register.warehouseId;

    // c) mahsulotlar (narx serverdan)
    const merged = new Map<string, { qty: Prisma.Decimal; discount: Prisma.Decimal }>();
    for (const it of dto.items) {
      const cur = merged.get(it.productId) ?? { qty: ZERO, discount: ZERO };
      merged.set(it.productId, { qty: cur.qty.plus(D(it.qty)), discount: cur.discount.plus(D(it.discount ?? '0')) });
    }
    const productIds = [...merged.keys()].sort();
    const products = await tx.product.findMany({ where: { id: { in: productIds }, storeId: user.storeId } });
    const byId = new Map(products.map((p) => [p.id, p]));

    const lines = productIds.map((pid) => {
      const p = byId.get(pid);
      if (!p) throw new NotFoundException({ message: 'Mahsulot topilmadi', productId: pid });
      if (!p.isActive) throw new UnprocessableEntityException({ message: `"${p.name}" arxivlangan`, productId: pid });
      const m = merged.get(pid)!;
      if (!isValidQty(m.qty, p.unit)) {
        throw new UnprocessableEntityException({ message: `"${p.name}" uchun miqdor noto‘g‘ri`, productId: pid });
      }
      const input = { qty: m.qty, unitPrice: D(p.salePrice), discount: money(m.discount) };
      if (!isDiscountValid(input)) {
        throw new UnprocessableEntityException({ message: `"${p.name}" chegirmasi noto‘g‘ri`, productId: pid });
      }
      return { product: p, ...input };
    });

    // d, e) chegirma va jami
    const totals = calcTotals(lines);
    const hasDiscount = totals.discountTotal.gt(0);
    if (hasDiscount && !user.permissions.has('discount.apply')) {
      throw new ForbiddenException('Chegirma berishga ruxsat yo‘q');
    }
    let overrode = false;
    if (hasDiscount && discountExceedsLimit(totals.subtotal, totals.discountTotal, DISCOUNT_LIMIT_PERCENT)) {
      if (!user.permissions.has('discount.override')) {
        throw new ForbiddenException(`Chegirma ${DISCOUNT_LIMIT_PERCENT}% limitdan oshdi`);
      }
      overrode = true;
    }

    // f) to‘lovlar
    let paid = ZERO;
    const payments = dto.payments.map((p) => {
      const amount = money(D(p.amount));
      if (amount.lte(0)) throw new UnprocessableEntityException('To‘lov summasi 0 dan katta bo‘lishi kerak');
      paid = paid.plus(amount);
      if (p.method === 'CASH') {
        if (p.cardType || p.externalReference) throw new UnprocessableEntityException('Naqd to‘lovda karta ma’lumoti bo‘lmaydi');
        const tendered = p.tendered != null ? money(D(p.tendered)) : amount;
        if (tendered.lt(amount)) throw new UnprocessableEntityException('Qabul qilingan summa to‘lovdan kam');
        return { method: p.method, amount, tendered, change: money(tendered.minus(amount)) };
      }
      return {
        method: p.method, amount, tendered: null, change: null,
        cardType: p.cardType ?? null, externalReference: p.externalReference ?? null,
      };
    });
    if (!paid.equals(totals.total)) {
      throw new UnprocessableEntityException({
        message: 'To‘lovlar yig‘indisi chek summasiga teng emas',
        total: totals.total.toFixed(2), paid: paid.toFixed(2),
      });
    }

    // mijoz
    let customerName: string | null = null;
    if (dto.customerId) {
      const c = await tx.customer.findFirst({ where: { id: dto.customerId, storeId: user.storeId } });
      if (!c) throw new NotFoundException('Xaridor topilmadi');
      customerName = c.name;
    }

    // g) chek raqami
    const store = await tx.store.findUniqueOrThrow({ where: { id: user.storeId }, select: { timezone: true } });
    const prefix = datePrefix(store.timezone);
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'receipt:' + user.storeId + ':' + prefix}))`;
    const todayCount = await tx.sale.count({ where: { storeId: user.storeId, receiptNo: { startsWith: `${prefix}-` } } });
    const receiptNo = `${prefix}-${String(todayCount + 1).padStart(4, '0')}`;

    // h) yozish
    const sale = await tx.sale.create({
      data: {
        storeId: user.storeId, receiptNo, registerId: shift.registerId, shiftId: shift.id, cashierId: user.id,
        customerId: dto.customerId ?? null, customerName,
        subtotal: totals.subtotal, discountTotal: totals.discountTotal, total: totals.total,
        idempotencyKey: dto.idempotencyKey,
        items: {
          create: lines.map((l, i) => ({
            productId: l.product.id, nameSnapshot: l.product.name, skuSnapshot: l.product.sku,
            qty: l.qty, unitPrice: l.unitPrice, discount: totals.lines[i].discount,
            costSnapshot: l.product.costPrice, lineTotal: totals.lines[i].lineTotal,
          })),
        },
        payments: { create: payments },
      },
    });

    for (const l of lines) {
      await this.stock.apply(tx, {
        warehouseId, productId: l.product.id, delta: l.qty.neg(), type: 'SALE_OUT',
        actorId: user.id, referenceType: 'Sale', referenceId: sale.id, blockNegative: true,
      });
    }

    if (overrode) {
      await this.audit.log(ctx, {
        action: 'sale.discount_override', entityType: 'Sale', entityId: sale.id,
        metadata: {
          receiptNo, subtotal: totals.subtotal, discountTotal: totals.discountTotal, limitPercent: DISCOUNT_LIMIT_PERCENT,
        },
      }, tx);
    }
    return { id: sale.id, created: true };
  }

  // ───────────── Chek / tafsilot ─────────────

  /** To‘liq chek. `skipVisibility` — yaratgan/idempotent qaytarishda. */
  async receipt(id: string, user: AuthUser, skipVisibility = false) {
    const sale = await this.prisma.sale.findFirst({
      where: { id, storeId: user.storeId },
      include: {
        items: { orderBy: { nameSnapshot: 'asc' } },
        payments: { orderBy: { createdAt: 'asc' } },
        refunds: { include: { items: true }, orderBy: { createdAt: 'asc' } },
        register: { select: { name: true, code: true } },
        shift: { select: { id: true, status: true, openedAt: true } },
      },
    });
    if (!sale) throw new NotFoundException('Sotuv topilmadi');
    if (!skipVisibility) this.assertVisible(user, sale.cashierId);

    const actorIds = new Set<string>([sale.cashierId, ...sale.refunds.map((r) => r.actorId)]);
    if (sale.voidedById) actorIds.add(sale.voidedById);
    const [users, store] = await Promise.all([
      this.prisma.user.findMany({ where: { id: { in: [...actorIds] } }, select: { id: true, name: true } }),
      this.prisma.store.findUnique({ where: { id: user.storeId }, select: { name: true } }),
    ]);
    const names = new Map(users.map((u) => [u.id, u.name]));
    const nameOf = (uid: string | null) => (uid ? names.get(uid) ?? null : null);
    const canCost = user.permissions.has('costs.read');
    const itemById = new Map(sale.items.map((i) => [i.id, i]));

    const { cashierId, ...rest } = sale;
    return {
      ...rest,
      cashierId,
      storeName: store?.name ?? null,
      cashierName: nameOf(cashierId),
      voidedByName: nameOf(sale.voidedById),
      items: sale.items.map(({ costSnapshot, ...i }) => (canCost ? { ...i, costSnapshot } : i)),
      refunds: sale.refunds.map((r) => ({
        ...r,
        actorName: nameOf(r.actorId),
        items: r.items.map((ri) => ({ ...ri, nameSnapshot: itemById.get(ri.saleItemId)?.nameSnapshot ?? null })),
      })),
    };
  }

  private assertVisible(user: AuthUser, cashierId: string) {
    if (user.permissions.has('sales.read.all')) return;
    if (user.permissions.has('sales.read.own') && cashierId === user.id) return;
    throw new ForbiddenException('Bu sotuvni ko‘rishga ruxsat yo‘q');
  }

  // ───────────── Ro‘yxat ─────────────

  async list(user: AuthUser, q: ListSalesQuery) {
    const all = user.permissions.has('sales.read.all');
    if (!all && !user.permissions.has('sales.read.own')) throw new ForbiddenException('Sotuvlarni ko‘rishga ruxsat yo‘q');

    const where: Prisma.SaleWhereInput = { storeId: user.storeId };
    where.cashierId = all ? q.cashierId : user.id;
    if (q.customerId) where.customerId = q.customerId;
    if (q.registerId) where.registerId = q.registerId;
    if (q.status) where.status = q.status;
    if (q.receiptNo) where.receiptNo = { contains: q.receiptNo.trim(), mode: 'insensitive' };
    if (q.dateFrom || q.dateTo) {
      where.createdAt = {
        ...(q.dateFrom ? { gte: new Date(q.dateFrom) } : {}),
        ...(q.dateTo ? { lt: endOfRange(q.dateTo) } : {}),
      };
    }
    if (q.paymentMethod) where.payments = { some: { method: q.paymentMethod } };

    let productId = q.productId;
    if (q.barcode) {
      const bc = await this.prisma.barcode.findUnique({
        where: { storeId_value: { storeId: user.storeId, value: q.barcode.trim() } },
        select: { productId: true },
      });
      if (!bc || (productId && productId !== bc.productId)) {
        return paginated([], 0, q);
      }
      productId = bc.productId;
    }
    if (productId) where.items = { some: { productId } };

    const orderBy: Prisma.SaleOrderByWithRelationInput = { [q.sortBy ?? 'createdAt']: q.sortDir ?? 'desc' };
    const [rows, total] = await Promise.all([
      this.prisma.sale.findMany({
        where, orderBy, skip: skipOf(q), take: q.pageSize,
        include: { payments: { select: { method: true, amount: true } }, _count: { select: { items: true } } },
      }),
      this.prisma.sale.count({ where }),
    ]);
    const users = await this.prisma.user.findMany({
      where: { id: { in: [...new Set(rows.map((r) => r.cashierId))] } }, select: { id: true, name: true },
    });
    const names = new Map(users.map((u) => [u.id, u.name]));
    const items = rows.map(({ _count, ...r }) => ({
      ...r, cashierName: names.get(r.cashierId) ?? null, itemCount: _count.items,
    }));
    return paginated(items, total, q);
  }

  // ───────────── Qaytarish ─────────────

  async refund(id: string, user: AuthUser, dto: CreateRefundDto, ctx: AuditContext) {
    await this.prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM "Sale" WHERE id = ${id}::uuid AND "storeId" = ${user.storeId}::uuid FOR UPDATE`;
      if (locked.length === 0) throw new NotFoundException('Sotuv topilmadi');

      const sale = await tx.sale.findUniqueOrThrow({
        where: { id },
        include: { items: { include: { product: { select: { unit: true } } } }, register: true },
      });
      if (sale.status === 'VOIDED') throw new UnprocessableEntityException('Bekor qilingan sotuvni qaytarib bo‘lmaydi');

      const openShift = await this.shifts.findOpenShift(tx, user);
      if (dto.method === 'CASH' && !openShift) throw new ConflictException('Avval smenani oching');

      // takroriy satrlarni birlashtirish
      const wanted = new Map<string, Prisma.Decimal>();
      for (const it of dto.items) wanted.set(it.saleItemId, (wanted.get(it.saleItemId) ?? ZERO).plus(D(it.qty)));

      const prevAmounts = await tx.refundItem.groupBy({
        by: ['saleItemId'], where: { saleItem: { saleId: id } }, _sum: { amount: true },
      });
      const prevByItem = new Map(prevAmounts.map((p) => [p.saleItemId, D(p._sum.amount ?? 0)]));
      const itemMap = new Map(sale.items.map((i) => [i.id, i]));

      let total = ZERO;
      const refundLines: { saleItemId: string; productId: string; qty: Prisma.Decimal; amount: Prisma.Decimal }[] = [];
      for (const [saleItemId, qty] of wanted) {
        const item = itemMap.get(saleItemId);
        if (!item) throw new UnprocessableEntityException({ message: 'Satr bu sotuvga tegishli emas', saleItemId });
        if (!isValidQty(qty, item.product.unit)) {
          throw new UnprocessableEntityException({ message: `"${item.nameSnapshot}" uchun miqdor noto‘g‘ri`, saleItemId });
        }
        const remaining = item.qty.minus(item.refundedQty);
        if (qty.gt(remaining)) {
          throw new UnprocessableEntityException({
            message: `"${item.nameSnapshot}" uchun qaytariladigan miqdor ${remaining.toString()} dan oshmasligi kerak`,
            saleItemId,
          });
        }
        const amount = calcRefundAmount(item.lineTotal, item.qty, qty, item.refundedQty, prevByItem.get(saleItemId) ?? ZERO);
        total = total.plus(amount);
        refundLines.push({ saleItemId, productId: item.productId, qty, amount });
      }

      const refund = await tx.refund.create({
        data: {
          saleId: id, shiftId: openShift?.id ?? null, reason: dto.reason.trim(), disposition: dto.disposition,
          method: dto.method, amount: total, actorId: user.id,
          items: { create: refundLines.map((l) => ({ saleItemId: l.saleItemId, qty: l.qty, amount: l.amount })) },
        },
      });

      for (const l of refundLines) {
        await tx.saleItem.update({ where: { id: l.saleItemId }, data: { refundedQty: { increment: l.qty } } });
      }
      if (dto.disposition === 'RESTOCK') {
        for (const l of [...refundLines].sort((a, b) => a.productId.localeCompare(b.productId))) {
          await this.stock.apply(tx, {
            warehouseId: sale.register.warehouseId, productId: l.productId, delta: l.qty, type: 'REFUND_IN',
            actorId: user.id, reason: dto.reason.trim(), referenceType: 'Refund', referenceId: refund.id,
            blockNegative: false,
          });
        }
      }

      const fullyRefunded = sale.items.every((i) => {
        const add = wanted.get(i.id) ?? ZERO;
        return i.refundedQty.plus(add).gte(i.qty);
      });
      const newRefundedTotal = money(sale.refundedTotal.plus(total));
      await tx.sale.update({
        where: { id },
        data: { refundedTotal: newRefundedTotal, status: fullyRefunded ? 'REFUNDED' : 'PARTIALLY_REFUNDED' },
      });

      await this.audit.log(ctx, {
        action: 'sale.refunded', entityType: 'Sale', entityId: id,
        metadata: {
          refundId: refund.id, receiptNo: sale.receiptNo, amount: total, method: dto.method,
          disposition: dto.disposition, reason: dto.reason.trim(), shiftId: openShift?.id ?? null,
          items: refundLines.map((l) => ({ saleItemId: l.saleItemId, qty: l.qty, amount: l.amount })),
        },
      }, tx);
    }, { timeout: 20000 });

    return this.receipt(id, user, true);
  }

  // ───────────── Bekor qilish (void) ─────────────

  async voidSale(id: string, user: AuthUser, dto: VoidSaleDto, ctx: AuditContext) {
    await this.prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM "Sale" WHERE id = ${id}::uuid AND "storeId" = ${user.storeId}::uuid FOR UPDATE`;
      if (locked.length === 0) throw new NotFoundException('Sotuv topilmadi');

      const sale = await tx.sale.findUniqueOrThrow({
        where: { id },
        include: { items: true, register: true, shift: true, _count: { select: { refunds: true } } },
      });
      if (sale.status === 'VOIDED') throw new ConflictException('Sotuv allaqachon bekor qilingan');
      if (sale.status !== 'COMPLETED' || sale._count.refunds > 0) {
        throw new UnprocessableEntityException('Qaytarish bo‘lgan sotuvni bekor qilib bo‘lmaydi');
      }
      if (sale.shift.status !== 'OPEN') {
        throw new UnprocessableEntityException('Smena yopilgan — sotuvni bekor qilib bo‘lmaydi, qaytarishdan foydalaning');
      }

      for (const it of [...sale.items].sort((a, b) => a.productId.localeCompare(b.productId))) {
        await this.stock.apply(tx, {
          warehouseId: sale.register.warehouseId, productId: it.productId, delta: it.qty, type: 'REFUND_IN',
          actorId: user.id, reason: dto.reason.trim(), referenceType: 'SaleVoid', referenceId: sale.id,
          blockNegative: false,
        });
      }
      await tx.sale.update({
        where: { id },
        data: { status: 'VOIDED', voidReason: dto.reason.trim(), voidedById: user.id, voidedAt: new Date() },
      });
      await this.audit.log(ctx, {
        action: 'sale.voided', entityType: 'Sale', entityId: id,
        metadata: { receiptNo: sale.receiptNo, total: sale.total, reason: dto.reason.trim(), shiftId: sale.shiftId },
      }, tx);
    }, { timeout: 20000 });
    return this.receipt(id, user, true);
  }
}

