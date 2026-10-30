import { ConflictException, Injectable } from '@nestjs/common';
import { Prisma, type StockMovementType } from '../generated/prisma/client.js';
import type { Tx } from '../prisma/prisma.service.js';

export interface StockChange {
  warehouseId: string;
  productId: string;
  /** Ishorali miqdor: + kirim, - chiqim. */
  delta: Prisma.Decimal;
  type: StockMovementType;
  actorId: string;
  reason?: string;
  referenceType?: string;
  referenceId?: string;
  /** false bo‘lsa qoldiq manfiyga tushsa 409 (default: true — oversell bloklanadi, TZ 7.2). */
  blockNegative?: boolean;
}

/**
 * Qoldiqni o‘zgartiruvchi YAGONA yo‘l. Har doim tranzaksiya ichida chaqiriladi.
 * Atomik shartli UPDATE ishlatiladi, shuning uchun ikki kassir oxirgi birlikni bir vaqtda
 * sotsa, faqat bittasi muvaffaqiyatli bo‘ladi (TZ AC-03).
 */
@Injectable()
export class StockService {
  async apply(tx: Tx, change: StockChange) {
    const { warehouseId, productId, delta } = change;
    const blockNegative = change.blockNegative ?? true;

    await tx.$executeRaw`
      INSERT INTO "StockBalance" ("warehouseId", "productId", "qty", "version", "updatedAt")
      VALUES (${warehouseId}::uuid, ${productId}::uuid, 0, 0, now())
      ON CONFLICT ("warehouseId", "productId") DO NOTHING`;

    const rows = await tx.$queryRaw<{ qty: Prisma.Decimal }[]>`
      UPDATE "StockBalance"
      SET "qty" = "qty" + ${delta}::numeric, "version" = "version" + 1, "updatedAt" = now()
      WHERE "warehouseId" = ${warehouseId}::uuid AND "productId" = ${productId}::uuid
        AND (${!blockNegative} OR "qty" + ${delta}::numeric >= 0)
      RETURNING "qty"`;

    if (rows.length === 0) {
      throw new ConflictException({ message: 'Qoldiq yetarli emas', productId });
    }
    const balanceAfter = new Prisma.Decimal(rows[0].qty);

    await tx.stockMovement.create({
      data: {
        warehouseId,
        productId,
        type: change.type,
        qty: delta,
        balanceAfter,
        reason: change.reason,
        referenceType: change.referenceType,
        referenceId: change.referenceId,
        actorId: change.actorId,
      },
    });
    return balanceAfter;
  }
}
