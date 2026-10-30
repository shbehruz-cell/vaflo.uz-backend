import { Prisma } from '../generated/prisma/client.js';
import { calcRefundAmount, calcTotals, discountExceedsLimit, isDiscountValid } from './sales.math.js';

const d = (v: string | number) => new Prisma.Decimal(v);

describe('calcTotals', () => {
  it('computes lines, subtotal, discount and total with rounding', () => {
    const r = calcTotals([
      { qty: d('0.333'), unitPrice: d('10000.00'), discount: d('0') }, // 3330.00
      { qty: d(3), unitPrice: d('1999.99'), discount: d('100.00') }, // 5999.97 - 100
      { qty: d('1.5'), unitPrice: d('3.33'), discount: d(0) }, // 4.995 -> 5.00 (half up)
    ]);
    expect(r.lines[0].lineTotal.toFixed(2)).toBe('3330.00');
    expect(r.lines[1].lineTotal.toFixed(2)).toBe('5899.97');
    expect(r.lines[2].gross.toFixed(2)).toBe('5.00');
    expect(r.subtotal.toFixed(2)).toBe('9334.97');
    expect(r.discountTotal.toFixed(2)).toBe('100.00');
    expect(r.total.toFixed(2)).toBe('9234.97');
    expect(r.subtotal.minus(r.discountTotal).equals(r.total)).toBe(true);
  });

  it('does not suffer from float errors', () => {
    const r = calcTotals([{ qty: d(3), unitPrice: d('0.10'), discount: d(0) }]);
    expect(r.total.toFixed(2)).toBe('0.30');
  });
});

describe('isDiscountValid', () => {
  it('rejects negative and over-gross discounts', () => {
    const base = { qty: d(2), unitPrice: d('50.00') };
    expect(isDiscountValid({ ...base, discount: d('100.00') })).toBe(true);
    expect(isDiscountValid({ ...base, discount: d('100.01') })).toBe(false);
    expect(isDiscountValid({ ...base, discount: d('-1') })).toBe(false);
  });
});

describe('discountExceedsLimit', () => {
  it('allows exactly the limit, blocks above it', () => {
    expect(discountExceedsLimit(d('1000.00'), d('100.00'), 10)).toBe(false);
    expect(discountExceedsLimit(d('1000.00'), d('100.01'), 10)).toBe(true);
    expect(discountExceedsLimit(d('1000.00'), d(0), 10)).toBe(false);
  });
});

describe('calcRefundAmount', () => {
  it('prorates a partial refund', () => {
    expect(calcRefundAmount(d('100.00'), d(3), d(1)).toFixed(2)).toBe('33.33');
  });

  it('refunds the exact remainder on the last part so nothing is lost', () => {
    const first = calcRefundAmount(d('100.00'), d(3), d(1), d(0), d(0));
    const second = calcRefundAmount(d('100.00'), d(3), d(1), d(1), first);
    const third = calcRefundAmount(d('100.00'), d(3), d(1), d(2), first.plus(second));
    expect(first.plus(second).plus(third).toFixed(2)).toBe('100.00');
    expect(third.toFixed(2)).toBe('33.34');
  });

  it('full refund equals line total', () => {
    expect(calcRefundAmount(d('5899.97'), d(3), d(3)).toFixed(2)).toBe('5899.97');
  });
});
