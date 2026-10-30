import { Prisma } from '../generated/prisma/client.js';

/** Pul va miqdor hisoblari faqat Decimal bilan (TZ 9.3, 16.1). */
export const D = (v: string | number | Prisma.Decimal) => new Prisma.Decimal(v);
export const ZERO = new Prisma.Decimal(0);
/** Pulni 2 xonagacha yaxlitlash (ROUND_HALF_UP). */
export const money = (v: Prisma.Decimal) => v.toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);

/** O‘lchov birligi aniqligi: dona/quti — butun son, qolganlari — 3 xona. */
export const UNIT_SCALE: Record<string, number> = { PIECE: 0, BOX: 0, KG: 3, LITER: 3, METER: 3 };
export function isValidQty(qty: Prisma.Decimal, unit: string) {
  return qty.gt(0) && qty.decimalPlaces() <= (UNIT_SCALE[unit] ?? 3);
}
