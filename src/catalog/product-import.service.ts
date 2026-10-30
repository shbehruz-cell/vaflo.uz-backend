import { randomUUID } from 'node:crypto';
import { ConflictException, Injectable, UnprocessableEntityException } from '@nestjs/common';
import { Prisma, type Unit } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { AuditService, type AuditContext } from '../audit/audit.service.js';
import { StockService } from '../inventory/stock.service.js';
import type { AuthUser } from '../common/auth/auth-user.js';
import { D, isValidQty } from '../common/money.js';
import { normalizeName } from '../common/normalize.js';
import { ProductsService } from './products.service.js';
import type { ImportBodyDto } from './dto/product.dto.js';

export interface NormalizedImportRow {
  name: string;
  sku: string | null;
  barcodes: string[];
  category: string | null;
  unit: Unit;
  salePrice: string;
  costPrice: string;
  qty: string | null;
}

export interface ImportRowReport {
  index: number;
  ok: boolean;
  errors: string[];
  normalized: NormalizedImportRow | null;
}

export interface ImportReport {
  summary: { total: number; valid: number; invalid: number };
  rows: ImportRowReport[];
}

const UNIT_ALIASES: Record<string, Unit> = {
  piece: 'PIECE', dona: 'PIECE', pcs: 'PIECE', шт: 'PIECE',
  kg: 'KG', kilogram: 'KG', кг: 'KG',
  liter: 'LITER', litre: 'LITER', litr: 'LITER', l: 'LITER', л: 'LITER',
  box: 'BOX', quti: 'BOX',
  meter: 'METER', metr: 'METER', m: 'METER', м: 'METER',
};

// Formula injection (TZ 17.2): = + - @ (hamda tab / CR) bilan boshlanuvchi kataklar rad etiladi.
const FORMULA_START = /^[=+\-@\t\r]/;
const MONEY_RE = /^\d{1,12}(\.\d{1,2})?$/;
const QTY_RE = /^\d{1,11}(\.\d{1,3})?$/;

@Injectable()
export class ProductImportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly stock: StockService,
    private readonly products: ProductsService,
  ) {}

  async preview(user: AuthUser, body: ImportBodyDto): Promise<ImportReport> {
    const warehouseId = await this.products.resolveWarehouseId(user.storeId, body.warehouseId);
    return this.validate(user.storeId, body, warehouseId);
  }

  async commit(ctx: AuditContext, user: AuthUser, body: ImportBodyDto) {
    const storeId = user.storeId;
    const warehouseId = await this.products.resolveWarehouseId(storeId, body.warehouseId);
    const report = await this.validate(storeId, body, warehouseId);
    if (report.summary.invalid > 0) {
      throw new UnprocessableEntityException({
        message: 'Importda xatolar bor, hech narsa saqlanmadi',
        ...report,
      });
    }
    const rows = report.rows.map((r) => r.normalized!);
    const importId = randomUUID();

    try {
      const result = await this.prisma.$transaction(
        async (tx) => {
          const names = [...new Set(rows.map((r) => r.category).filter((c): c is string => !!c))];
          const catIds = new Map<string, string>();
          if (names.length) {
            const existing = await tx.category.findMany({ where: { storeId, name: { in: names } } });
            for (const c of existing) catIds.set(c.name, c.id);
          }
          let categoriesCreated = 0;
          for (const name of names) {
            if (catIds.has(name)) continue;
            const c = await tx.category.create({ data: { storeId, name } });
            catIds.set(name, c.id);
            categoriesCreated++;
          }
          let stocked = 0;
          for (const r of rows) {
            const p = await tx.product.create({
              data: {
                storeId,
                categoryId: r.category ? catIds.get(r.category)! : null,
                name: r.name,
                normalizedName: normalizeName(r.name),
                sku: r.sku,
                unit: r.unit,
                salePrice: D(r.salePrice),
                costPrice: D(r.costPrice),
                barcodes: { create: r.barcodes.map((value) => ({ storeId, value })) },
              },
              select: { id: true },
            });
            if (r.qty && warehouseId && D(r.qty).gt(0)) {
              await this.stock.apply(tx, {
                warehouseId,
                productId: p.id,
                delta: D(r.qty),
                type: 'ADJUSTMENT',
                actorId: user.id,
                reason: 'Boshlang‘ich qoldiq (import)',
                referenceType: 'ProductImport',
                referenceId: importId,
              });
              stocked++;
            }
          }
          await this.audit.log(
            ctx,
            {
              action: 'product.import',
              entityType: 'ProductImport',
              entityId: importId,
              metadata: { products: rows.length, categoriesCreated, stockMovements: stocked, warehouseId },
            },
            tx,
          );
          return { products: rows.length, categoriesCreated, stockMovements: stocked };
        },
        { timeout: 120_000, maxWait: 10_000 },
      );
      return { importId, ...result };
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new ConflictException('SKU yoki shtrix-kod allaqachon band (parallel o‘zgarish)');
      }
      throw e;
    }
  }

  private cell(row: Record<string, unknown>, col: string | undefined, errors: string[], label: string): string {
    if (!col) return '';
    const raw = row[col];
    if (raw === undefined || raw === null) return '';
    const s = String(raw);
    if (FORMULA_START.test(s.trim()) || FORMULA_START.test(s)) {
      errors.push(`${label}: katak "=", "+", "-" yoki "@" bilan boshlanishi mumkin emas`);
      return '';
    }
    return s.trim();
  }

  private async validate(storeId: string, body: ImportBodyDto, warehouseId: string | null): Promise<ImportReport> {
    const m = body.mapping;
    const reports: ImportRowReport[] = [];
    const seenBarcodes = new Map<string, number>();
    const seenSkus = new Map<string, number>();

    body.rows.forEach((row, index) => {
      const errors: string[] = [];
      const name = this.cell(row, m.name, errors, 'Nomi');
      const sku = this.cell(row, m.sku, errors, 'SKU');
      const barcodeRaw = this.cell(row, m.barcode, errors, 'Shtrix-kod');
      const category = this.cell(row, m.category, errors, 'Kategoriya');
      const unitRaw = this.cell(row, m.unit, errors, 'Birlik');
      const sale = this.cell(row, m.salePrice, errors, 'Sotuv narxi').replace(/\s/g, '').replace(',', '.');
      const cost = this.cell(row, m.costPrice, errors, 'Tannarx').replace(/\s/g, '').replace(',', '.');
      const qty = this.cell(row, m.qty, errors, 'Qoldiq').replace(/\s/g, '').replace(',', '.');

      if (!name) errors.push('Nomi majburiy');
      else if (name.length > 200) errors.push('Nomi 200 belgidan oshmasligi kerak');

      let unit: Unit = 'PIECE';
      if (unitRaw) {
        const u = UNIT_ALIASES[unitRaw.toLowerCase()];
        if (u) unit = u;
        else errors.push(`Noma'lum o‘lchov birligi: ${unitRaw}`);
      }

      if (!sale) errors.push('Sotuv narxi majburiy');
      else if (!MONEY_RE.test(sale)) errors.push('Sotuv narxi noto‘g‘ri (musbat son, 2 xonagacha kasr)');
      if (cost && !MONEY_RE.test(cost)) errors.push('Tannarx noto‘g‘ri (musbat son, 2 xonagacha kasr)');
      if (qty) {
        if (!QTY_RE.test(qty)) errors.push('Qoldiq noto‘g‘ri');
        else if (D(qty).gt(0) && !isValidQty(D(qty), unit)) errors.push('Qoldiq aniqligi o‘lchov birligiga mos emas');
        else if (D(qty).gt(0) && !warehouseId) errors.push('Boshlang‘ich qoldiq uchun faol ombor topilmadi');
      }

      const barcodes = barcodeRaw ? barcodeRaw.split(/[;,]/).map((b) => b.trim()).filter(Boolean) : [];
      for (const b of barcodes) {
        if (b.length > 64) errors.push(`Shtrix-kod juda uzun: ${b}`);
        const first = seenBarcodes.get(b);
        if (first !== undefined) errors.push(`Shtrix-kod faylda takrorlangan (qator ${first + 1}): ${b}`);
        else seenBarcodes.set(b, index);
      }
      if (new Set(barcodes).size !== barcodes.length) errors.push('Bir qatorda shtrix-kod takrorlangan');
      if (sku) {
        const first = seenSkus.get(sku);
        if (first !== undefined) errors.push(`SKU faylda takrorlangan (qator ${first + 1}): ${sku}`);
        else seenSkus.set(sku, index);
      }

      reports.push({
        index,
        ok: errors.length === 0,
        errors,
        normalized: {
          name,
          sku: sku || null,
          barcodes,
          category: category || null,
          unit,
          salePrice: sale,
          costPrice: cost || '0',
          qty: qty || null,
        },
      });
    });

    // Bazadagi mavjud qiymatlar bilan to‘qnashuv
    const allBarcodes = [...seenBarcodes.keys()];
    const allSkus = [...seenSkus.keys()];
    const [dbBarcodes, dbSkus] = await Promise.all([
      allBarcodes.length
        ? this.prisma.barcode.findMany({ where: { storeId, value: { in: allBarcodes } }, select: { value: true } })
        : [],
      allSkus.length
        ? this.prisma.product.findMany({ where: { storeId, sku: { in: allSkus } }, select: { sku: true } })
        : [],
    ]);
    const takenB = new Set(dbBarcodes.map((b) => b.value));
    const takenS = new Set(dbSkus.map((p) => p.sku));
    for (const r of reports) {
      for (const b of r.normalized!.barcodes) if (takenB.has(b)) r.errors.push(`Shtrix-kod bazada mavjud: ${b}`);
      const s = r.normalized!.sku;
      if (s && takenS.has(s)) r.errors.push(`SKU bazada mavjud: ${s}`);
      r.ok = r.errors.length === 0;
    }

    const invalid = reports.filter((r) => !r.ok).length;
    return { summary: { total: reports.length, valid: reports.length - invalid, invalid }, rows: reports };
  }
}
