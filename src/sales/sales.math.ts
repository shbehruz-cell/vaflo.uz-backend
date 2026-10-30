import type { Prisma } from '../generated/prisma/client.js';
import { D, ZERO, money } from '../common/money.js';

export interface LineInput {
  qty: Prisma.Decimal;
  unitPrice: Prisma.Decimal;
  /** Satr chegirmasi (summa). */
  discount: Prisma.Decimal;
}

export interface LineResult {
  gross: Prisma.Decimal;
  discount: Prisma.Decimal;
  lineTotal: Prisma.Decimal;
}

/** Chegirma 0 dan kichik emas va satr summasidan oshmasligi kerak. */
export function isDiscountValid(l: LineInput) {
  return l.discount.gte(0) && l.discount.lte(money(l.qty.mul(l.unitPrice)));
}

/** Chek summalari — faqat Decimal. lineTotal = money(qty × unitPrice − discount). */
export function calcTotals(items: LineInput[]) {
  let subtotal = ZERO;
  let discountTotal = ZERO;
  let total = ZERO;
  const lines: LineResult[] = items.map((i) => {
    const gross = money(i.qty.mul(i.unitPrice));
    const discount = money(i.discount);
    const lineTotal = money(i.qty.mul(i.unitPrice).minus(discount));
    subtotal = subtotal.plus(gross);
    discountTotal = discountTotal.plus(discount);
    total = total.plus(lineTotal);
    return { gross, discount, lineTotal };
  });
  return { lines, subtotal, discountTotal, total };
}

/** Umumiy chegirma limitdan (foiz) oshadimi? Qat'iy ">" — limitning o‘zi ruxsat etiladi. */
export function discountExceedsLimit(subtotal: Prisma.Decimal, discountTotal: Prisma.Decimal, limitPercent: number) {
  return discountTotal.mul(100).gt(subtotal.mul(limitPercent));
}

/**
 * Qaytarish summasi. Satrning oxirgi qismi qaytarilganda qoldiq (lineTotal − avval qaytarilgan)
 * olinadi — shunda tiyin yo‘qolmaydi va jami lineTotal dan oshmaydi.
 */
export function calcRefundAmount(
  lineTotal: Prisma.Decimal,
  itemQty: Prisma.Decimal,
  qty: Prisma.Decimal,
  refundedQty: Prisma.Decimal = ZERO,
  refundedAmount: Prisma.Decimal = ZERO,
) {
  if (D(refundedQty).plus(qty).gte(itemQty)) return money(lineTotal.minus(refundedAmount));
  return money(lineTotal.mul(qty).div(itemQty));
}
