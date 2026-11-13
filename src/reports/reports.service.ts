import { BadRequestException, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { AuditService, type AuditContext } from '../audit/audit.service.js';
import type { AuthUser } from '../common/auth/auth-user.js';
import { Prisma } from '../generated/prisma/client.js';
import type { ReportQuery } from './dto.js';
import {
  DEFAULT_TZ,
  addDays,
  dayDiff,
  isValidTimezone,
  localMidnightUtc,
  parseYmd,
  sqlTs,
  todayIn,
  ymdKey,
} from './tz.js';

export const CSV_MAX_ROWS = 50_000;

interface Range {
  tz: string;
  from: Date; // UTC, inclusive
  to: Date; // UTC, exclusive
  days: string[]; // do‘kon vaqtidagi kunlar YYYY-MM-DD
}

const m2 = (v: unknown) => (v == null ? '0.00' : new Prisma.Decimal(v as string | number | Prisma.Decimal).toFixed(2));
const num = (v: unknown) => Number(v ?? 0);
const q3 = (v: unknown) => (v == null ? '0.000' : new Prisma.Decimal(v as string | number | Prisma.Decimal).toFixed(3));

export const METHODOLOGY = {
  grossSales: 'Yalpi savdo = bekor qilinmagan (VOIDED bo‘lmagan) cheklar jami summasi (chegirmalar ayirilgan).',
  refunds: 'Qaytarishlar = tanlangan davrda amalga oshirilgan qaytarishlar summasi (qaytarish sanasi bo‘yicha).',
  netRevenue: 'Sof tushum = yalpi savdo − qaytarishlar.',
  receiptCount: 'Cheklar soni = bekor qilinmagan cheklar soni.',
  averageReceipt: 'O‘rtacha chek = yalpi savdo / cheklar soni (2 xona; chek bo‘lmasa 0).',
  grossProfit:
    'Yalpi foyda = Σ(qator summasi − sotuv paytidagi tannarx × miqdor) − qaytarilgan miqdorga to‘g‘ri keladigan foyda.',
  inventoryValue: 'Ombor qiymati = Σ(qoldiq × joriy tannarx).',
};

@Injectable()
export class ReportsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  // ───── davr ─────

  async range(storeId: string, q: ReportQuery): Promise<Range> {
    const store = await this.prisma.store.findFirst({ where: { id: storeId }, select: { timezone: true } });
    const tz = store?.timezone && isValidTimezone(store.timezone) ? store.timezone : DEFAULT_TZ;
    const today = todayIn(tz);
    let first = today;
    let last = today; // inclusive
    switch (q.preset) {
      case 'yesterday':
        first = last = addDays(today, -1);
        break;
      case 'week':
        first = addDays(today, -6);
        break;
      case 'month':
        first = { y: today.y, m: today.m, d: 1 };
        break;
      case 'year':
        first = { y: today.y, m: 1, d: 1 };
        break;
      case 'custom': {
        if (!q.dateFrom || !q.dateTo) throw new BadRequestException('dateFrom va dateTo kerak');
        first = parseYmd(q.dateFrom);
        last = parseYmd(q.dateTo);
        if (dayDiff(first, last) < 0) throw new BadRequestException('Boshlanish sanasi tugash sanasidan keyin');
        if (dayDiff(first, last) + 1 > 366) throw new BadRequestException('Davr 366 kundan oshmasligi kerak');
        break;
      }
      default:
        break;
    }
    const n = dayDiff(first, last) + 1;
    const days = Array.from({ length: n }, (_, i) => ymdKey(addDays(first, i)));
    return { tz, from: localMidnightUtc(first, tz), to: localMidnightUtc(addDays(last, 1), tz), days };
  }

  /** Sotuv (alias `s`) bo‘yicha umumiy filtrlar. Hammasi parametrlangan. */
  private saleConds(storeId: string, r: Range, q: ReportQuery, opts: { dated: boolean; voided: boolean }) {
    const c: Prisma.Sql[] = [Prisma.sql`s."storeId" = ${storeId}::uuid`];
    if (opts.dated) {
      c.push(Prisma.sql`s."createdAt" >= ${sqlTs(r.from)}::timestamp`);
      c.push(Prisma.sql`s."createdAt" < ${sqlTs(r.to)}::timestamp`);
    }
    if (!opts.voided) c.push(Prisma.sql`s.status <> 'VOIDED'`);
    if (q.cashierId) c.push(Prisma.sql`s."cashierId" = ${q.cashierId}::uuid`);
    if (q.registerId) c.push(Prisma.sql`s."registerId" = ${q.registerId}::uuid`);
    if (q.categoryId)
      c.push(Prisma.sql`EXISTS (SELECT 1 FROM "SaleItem" fi JOIN "Product" fp ON fp.id = fi."productId"
        WHERE fi."saleId" = s.id AND fp."categoryId" = ${q.categoryId}::uuid)`);
    if (q.paymentMethod)
      c.push(Prisma.sql`EXISTS (SELECT 1 FROM "Payment" fy WHERE fy."saleId" = s.id AND fy.method = ${q.paymentMethod}::"PaymentMethod")`);
    return Prisma.join(c, ' AND ');
  }

  private refundTimeCond(r: Range) {
    return Prisma.sql`rf."createdAt" >= ${sqlTs(r.from)}::timestamp AND rf."createdAt" < ${sqlTs(r.to)}::timestamp`;
  }

  // ───── summary ─────

  async summary(user: AuthUser, q: ReportQuery) {
    const r = await this.range(user.storeId, q);
    const sc = this.saleConds(user.storeId, r, q, { dated: true, voided: false });
    const rc = this.saleConds(user.storeId, r, q, { dated: false, voided: true });
    const canProfit = user.permissions.has('reports.profit.read');

    const [sales, refunds] = await Promise.all([
      this.prisma.$queryRaw<{ gross: Prisma.Decimal; cnt: bigint }[]>`
        SELECT COALESCE(SUM(s.total), 0) AS gross, COUNT(*) AS cnt FROM "Sale" s WHERE ${sc}`,
      this.prisma.$queryRaw<{ amount: Prisma.Decimal }[]>`
        SELECT COALESCE(SUM(rf.amount), 0) AS amount FROM "Refund" rf JOIN "Sale" s ON s.id = rf."saleId"
        WHERE ${rc} AND ${this.refundTimeCond(r)}`,
    ]);
    const gross = new Prisma.Decimal(sales[0]?.gross ?? 0);
    const count = num(sales[0]?.cnt);
    const ref = new Prisma.Decimal(refunds[0]?.amount ?? 0);
    const out: Record<string, unknown> = {
      period: { preset: q.preset, timezone: r.tz, from: r.days[0], to: r.days[r.days.length - 1] },
      grossSales: gross.toFixed(2),
      refunds: ref.toFixed(2),
      netRevenue: gross.minus(ref).toFixed(2),
      receiptCount: count,
      averageReceipt: count ? gross.div(count).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP).toFixed(2) : '0.00',
      methodology: {
        grossSales: METHODOLOGY.grossSales,
        refunds: METHODOLOGY.refunds,
        netRevenue: METHODOLOGY.netRevenue,
        receiptCount: METHODOLOGY.receiptCount,
        averageReceipt: METHODOLOGY.averageReceipt,
        ...(canProfit ? { grossProfit: METHODOLOGY.grossProfit, inventoryValue: METHODOLOGY.inventoryValue } : {}),
      },
    };

    if (canProfit) {
      const [profit, refProfit, inv] = await Promise.all([
        this.prisma.$queryRaw<{ p: Prisma.Decimal }[]>`
          SELECT COALESCE(SUM(si."lineTotal" - si."costSnapshot" * si.qty), 0) AS p
          FROM "SaleItem" si JOIN "Sale" s ON s.id = si."saleId" WHERE ${sc}`,
        this.prisma.$queryRaw<{ p: Prisma.Decimal }[]>`
          SELECT COALESCE(SUM(ri.amount - si."costSnapshot" * ri.qty), 0) AS p
          FROM "RefundItem" ri
          JOIN "Refund" rf ON rf.id = ri."refundId"
          JOIN "SaleItem" si ON si.id = ri."saleItemId"
          JOIN "Sale" s ON s.id = rf."saleId"
          WHERE ${rc} AND s.status <> 'VOIDED' AND ${this.refundTimeCond(r)}`,
        this.prisma.$queryRaw<{ v: Prisma.Decimal }[]>`
          SELECT COALESCE(SUM(sb.qty * p."costPrice"), 0) AS v
          FROM "StockBalance" sb JOIN "Product" p ON p.id = sb."productId"
          WHERE p."storeId" = ${user.storeId}::uuid AND p."isActive" = true AND sb.qty > 0`,
      ]);
      out.grossProfit = new Prisma.Decimal(profit[0]?.p ?? 0).minus(new Prisma.Decimal(refProfit[0]?.p ?? 0)).toFixed(2);
      out.profitNote =
        'Bu yalpi foyda. Xarajatlar (ijara, maosh va h.k.) hisobga olinmagani uchun sof foyda ko‘rsatilmaydi.';
      out.inventoryValue = m2(inv[0]?.v);
    }
    return out;
  }

  // ───── sales by day ─────

  async salesByDay(user: AuthUser, q: ReportQuery) {
    const r = await this.range(user.storeId, q);
    const sc = this.saleConds(user.storeId, r, q, { dated: true, voided: false });
    const rc = this.saleConds(user.storeId, r, q, { dated: false, voided: true });
    const [sales, refunds] = await Promise.all([
      this.prisma.$queryRaw<{ day: string; gross: Prisma.Decimal; cnt: bigint }[]>`
        SELECT to_char((s."createdAt" AT TIME ZONE 'UTC') AT TIME ZONE ${r.tz}, 'YYYY-MM-DD') AS day,
               SUM(s.total) AS gross, COUNT(*) AS cnt
        FROM "Sale" s WHERE ${sc} GROUP BY 1`,
      this.prisma.$queryRaw<{ day: string; amount: Prisma.Decimal }[]>`
        SELECT to_char((rf."createdAt" AT TIME ZONE 'UTC') AT TIME ZONE ${r.tz}, 'YYYY-MM-DD') AS day,
               SUM(rf.amount) AS amount
        FROM "Refund" rf JOIN "Sale" s ON s.id = rf."saleId"
        WHERE ${rc} AND ${this.refundTimeCond(r)} GROUP BY 1`,
    ]);
    const sm = new Map(sales.map((x) => [x.day, x]));
    const rm = new Map(refunds.map((x) => [x.day, x]));
    return {
      timezone: r.tz,
      series: r.days.map((date) => ({
        date,
        gross: m2(sm.get(date)?.gross),
        receipts: num(sm.get(date)?.cnt),
        refunds: m2(rm.get(date)?.amount),
      })),
    };
  }

  // ───── top products ─────

  async topProducts(user: AuthUser, q: ReportQuery, limit: number) {
    const r = await this.range(user.storeId, q);
    const sc = this.saleConds(user.storeId, r, q, { dated: true, voided: false });
    const run = (byRevenue: boolean) => this.prisma.$queryRaw<
      { productId: string; name: string; category: string | null; qty: Prisma.Decimal; refundedQty: Prisma.Decimal; revenue: Prisma.Decimal }[]
    >`
      SELECT p.id AS "productId", p.name AS name, c.name AS category,
             SUM(si.qty) AS qty, SUM(si."refundedQty") AS "refundedQty", SUM(si."lineTotal") AS revenue
      FROM "SaleItem" si
      JOIN "Sale" s ON s.id = si."saleId"
      JOIN "Product" p ON p.id = si."productId"
      LEFT JOIN "Category" c ON c.id = p."categoryId"
      WHERE ${sc}
      GROUP BY p.id, p.name, c.name
      ORDER BY ${byRevenue ? Prisma.sql`SUM(si."lineTotal")` : Prisma.sql`SUM(si.qty)`} DESC, p.name ASC
      LIMIT ${limit}`;
    const [byQty, byRevenue] = await Promise.all([run(false), run(true)]);
    const map = (rows: Awaited<ReturnType<typeof run>>) =>
      rows.map((x) => ({
        productId: x.productId,
        name: x.name,
        category: x.category,
        qty: q3(x.qty),
        refundedQty: q3(x.refundedQty),
        revenue: m2(x.revenue),
      }));
    return { byQty: map(byQty), byRevenue: map(byRevenue) };
  }

  // ───── by cashier ─────

  async byCashier(user: AuthUser, q: ReportQuery) {
    const r = await this.range(user.storeId, q);
    const sc = this.saleConds(user.storeId, r, q, { dated: true, voided: false });
    const rows = await this.prisma.$queryRaw<
      { cashierId: string; name: string | null; gross: Prisma.Decimal; cnt: bigint; refunded: Prisma.Decimal }[]
    >`
      SELECT s."cashierId" AS "cashierId", u.name AS name, SUM(s.total) AS gross, COUNT(*) AS cnt,
             SUM(s."refundedTotal") AS refunded
      FROM "Sale" s LEFT JOIN "User" u ON u.id = s."cashierId"
      WHERE ${sc}
      GROUP BY s."cashierId", u.name
      ORDER BY SUM(s.total) DESC`;
    return rows.map((x) => {
      const gross = new Prisma.Decimal(x.gross);
      const cnt = num(x.cnt);
      return {
        cashierId: x.cashierId,
        name: x.name,
        grossSales: gross.toFixed(2),
        receiptCount: cnt,
        refundedTotal: m2(x.refunded),
        averageReceipt: cnt ? gross.div(cnt).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP).toFixed(2) : '0.00',
      };
    });
  }

  // ───── low stock ─────

  async lowStock(user: AuthUser, warehouseId?: string) {
    const wh = warehouseId
      ? await this.prisma.warehouse.findFirst({ where: { id: warehouseId, storeId: user.storeId }, select: { id: true, name: true } })
      : await this.prisma.warehouse.findFirst({
          where: { storeId: user.storeId, status: 'ACTIVE' },
          orderBy: { createdAt: 'asc' },
          select: { id: true, name: true },
        });
    if (!wh) throw new NotFoundException('Ombor topilmadi');
    const rows = await this.prisma.$queryRaw<
      { id: string; name: string; sku: string | null; unit: string; qty: Prisma.Decimal; minStock: Prisma.Decimal; category: string | null }[]
    >`
      SELECT p.id, p.name, p.sku, p.unit::text AS unit, COALESCE(sb.qty, 0) AS qty, p."minStock" AS "minStock", c.name AS category
      FROM "Product" p
      LEFT JOIN "StockBalance" sb ON sb."productId" = p.id AND sb."warehouseId" = ${wh.id}::uuid
      LEFT JOIN "Category" c ON c.id = p."categoryId"
      WHERE p."storeId" = ${user.storeId}::uuid AND p."isActive" = true AND COALESCE(sb.qty, 0) <= p."minStock"
      ORDER BY COALESCE(sb.qty, 0) ASC, p.name ASC
      LIMIT 500`;
    return {
      warehouse: wh,
      items: rows.map((x) => ({ ...x, qty: q3(x.qty), minStock: q3(x.minStock) })),
    };
  }

  // ───── CSV ─────

  async salesCsv(user: AuthUser, q: ReportQuery, ctx: AuditContext) {
    const r = await this.range(user.storeId, q);
    const sc = this.saleConds(user.storeId, r, q, { dated: true, voided: true });
    const rows = await this.prisma.$queryRaw<
      {
        receiptNo: string;
        at: string;
        cashier: string | null;
        customer: string | null;
        total: Prisma.Decimal;
        refunded: Prisma.Decimal;
        status: string;
        methods: string | null;
      }[]
    >`
      SELECT s."receiptNo" AS "receiptNo",
             to_char((s."createdAt" AT TIME ZONE 'UTC') AT TIME ZONE ${r.tz}, 'YYYY-MM-DD HH24:MI:SS') AS at,
             u.name AS cashier, s."customerName" AS customer, s.total AS total, s."refundedTotal" AS refunded,
             s.status::text AS status,
             (SELECT string_agg(DISTINCT py.method::text, '+') FROM "Payment" py WHERE py."saleId" = s.id) AS methods
      FROM "Sale" s LEFT JOIN "User" u ON u.id = s."cashierId"
      WHERE ${sc}
      ORDER BY s."createdAt" ASC
      LIMIT ${CSV_MAX_ROWS + 1}`;
    if (rows.length > CSV_MAX_ROWS)
      throw new UnprocessableEntityException(`Qatorlar soni ${CSV_MAX_ROWS} dan oshdi. Davrni qisqartiring`);

    const header = ['receiptNo', 'date', 'cashier', 'customer', 'total', 'refunded', 'status', 'paymentMethods'];
    const lines = [header.join(',')];
    for (const x of rows) {
      lines.push(
        [x.receiptNo, x.at, x.cashier, x.customer, m2(x.total), m2(x.refunded), x.status, x.methods].map(csvCell).join(','),
      );
    }
    await this.audit.log(ctx, {
      action: 'report.exported',
      entityType: 'Report',
      metadata: { report: 'sales.csv', preset: q.preset, from: r.days[0], to: r.days[r.days.length - 1], rows: rows.length },
    });
    return {
      csv: '﻿' + lines.join('\r\n') + '\r\n',
      filename: `sales_${r.days[0]}_${r.days[r.days.length - 1]}.csv`,
    };
  }
}

/** CSV katak: formula injection (= + - @ tab CR) ga qarshi `'` prefiksi, qo‘shtirnoq bilan escape. */
export function csvCell(v: unknown): string {
  let s = v == null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
