import {
  BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Prisma } from '../generated/prisma/client.js';
import { PrismaService, type Tx } from '../prisma/prisma.service.js';
import { AuditContext, AuditService } from '../audit/audit.service.js';
import type { AuthUser } from '../common/auth/auth-user.js';
import { D, ZERO, money } from '../common/money.js';
import { paginated, skipOf } from '../common/pagination.dto.js';
import type { CashMovementDto, CloseShiftDto, ListShiftsQuery, OpenShiftDto } from './dto/shifts.dto.js';

const COUNTED_STATUSES = ['COMPLETED', 'PARTIALLY_REFUNDED', 'REFUNDED'] as const;

/** Faqat sana ("2026-01-31") berilsa — shu kun oxirigacha. */
function endOfRange(v: string) {
  const d = new Date(v);
  if (v.length <= 10) d.setUTCDate(d.getUTCDate() + 1);
  return d;
}

@Injectable()
export class ShiftsService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}

  /** Sotuv uchun: kassirning ochiq smenasi (kassa bilan). */
  async requireOpenShift(db: Tx, user: AuthUser) {
    const shift = await db.shift.findFirst({
      where: { storeId: user.storeId, cashierId: user.id, status: 'OPEN' },
      include: { register: true },
    });
    if (!shift) throw new ConflictException('Avval smenani oching');
    return shift;
  }

  async findOpenShift(db: Tx, user: AuthUser) {
    return db.shift.findFirst({ where: { storeId: user.storeId, cashierId: user.id, status: 'OPEN' } });
  }

  async open(user: AuthUser, dto: OpenShiftDto, ctx: AuditContext) {
    const openingCash = money(D(dto.openingCash));
    if (openingCash.lt(0)) throw new BadRequestException('Boshlang‘ich naqd manfiy bo‘lmasligi kerak');
    const shift = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'shift:' + dto.registerId}))`;
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'shift-user:' + user.id}))`;
      const register = await tx.register.findFirst({
        where: { id: dto.registerId, storeId: user.storeId },
        include: { assignments: { select: { userId: true } } },
      });
      if (!register) throw new NotFoundException('Kassa topilmadi');
      if (register.status !== 'ACTIVE') throw new UnprocessableEntityException('Kassa faol emas');
      // Biriktirilgan xodimlar ro‘yxati bo‘lsa — faqat ular ishlay oladi
      if (register.assignments.length > 0 && !register.assignments.some((a) => a.userId === user.id)) {
        throw new ForbiddenException('Siz bu kassaga biriktirilmagansiz');
      }
      // Bir kassada bir vaqtda maxCashiers tagacha kassir (advisory lock poyga holatini oldini oladi)
      const openCount = await tx.shift.count({ where: { registerId: register.id, status: 'OPEN' } });
      if (openCount >= register.maxCashiers) {
        throw new ConflictException(`Kassa band: ${openCount}/${register.maxCashiers} kassir ishlayapti`);
      }
      const mine = await tx.shift.findFirst({ where: { cashierId: user.id, status: 'OPEN' } });
      if (mine) throw new ConflictException('Sizda allaqachon ochiq smena bor');
      const created = await tx.shift.create({
        data: { storeId: user.storeId, registerId: register.id, cashierId: user.id, openingCash },
      });
      await this.audit.log(ctx, {
        action: 'shift.opened', entityType: 'Shift', entityId: created.id,
        metadata: { registerId: register.id, openingCash },
      }, tx);
      return created;
    });
    return this.detail(shift.id, user);
  }

  async current(user: AuthUser) {
    const shift = await this.prisma.shift.findFirst({
      where: { storeId: user.storeId, cashierId: user.id, status: 'OPEN' },
    });
    if (!shift) return null;
    return this.detail(shift.id, user);
  }

  private async loadAccessible(db: Tx, id: string, user: AuthUser) {
    const shift = await db.shift.findFirst({ where: { id, storeId: user.storeId } });
    if (!shift) throw new NotFoundException('Smena topilmadi');
    if (shift.cashierId !== user.id && !user.permissions.has('shifts.read.all')) {
      throw new ForbiddenException('Bu smenaga ruxsat yo‘q');
    }
    return shift;
  }

  async addCashMovement(id: string, user: AuthUser, dto: CashMovementDto, ctx: AuditContext) {
    const amount = money(D(dto.amount));
    if (amount.lte(0)) throw new BadRequestException('Summa 0 dan katta bo‘lishi kerak');
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Shift" WHERE id = ${id}::uuid FOR UPDATE`;
      const shift = await this.loadAccessible(tx, id, user);
      if (shift.status !== 'OPEN') throw new ConflictException('Smena yopilgan');
      const m = await tx.cashMovement.create({
        data: { shiftId: id, type: dto.type, amount, reason: dto.reason.trim(), actorId: user.id },
      });
      await this.audit.log(ctx, {
        action: 'cash.movement', entityType: 'Shift', entityId: id,
        metadata: { movementId: m.id, type: dto.type, amount, reason: m.reason },
      }, tx);
      return m;
    });
  }

  async close(id: string, user: AuthUser, dto: CloseShiftDto, ctx: AuditContext) {
    const counted = money(D(dto.countedCash));
    if (counted.lt(0)) throw new BadRequestException('Sanalgan naqd manfiy bo‘lmasligi kerak');
    await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Shift" WHERE id = ${id}::uuid FOR UPDATE`;
      const shift = await this.loadAccessible(tx, id, user);
      if (shift.status !== 'OPEN') throw new ConflictException('Smena allaqachon yopilgan');
      const summary = await this.summarize(tx, shift);
      const expected = summary.expectedCash;
      const difference = money(counted.minus(expected));
      await tx.shift.update({
        where: { id },
        data: { status: 'CLOSED', closedAt: new Date(), expectedCash: expected, countedCash: counted, difference },
      });
      await this.audit.log(ctx, {
        action: 'shift.closed', entityType: 'Shift', entityId: id,
        metadata: {
          openingCash: shift.openingCash, expectedCash: expected, countedCash: counted, difference,
          cashSales: summary.cashSalesTotal, cashRefunds: summary.cashRefundsTotal,
          cashIn: summary.cashIn, cashOut: summary.cashOut, closedByOther: shift.cashierId !== user.id,
        },
      }, tx);
    });
    return this.detail(id, user);
  }

  /** Smena bo‘yicha jonli hisob (TZ 13): naqd faqat CASH to‘lovlarning `amount` qismi. */
  async summarize(db: Tx, shift: { id: string; openingCash: Prisma.Decimal }) {
    const saleWhere = { shiftId: shift.id, status: { in: [...COUNTED_STATUSES] } };
    const [pay, refunds, moves, saleCount, voidedCount] = await Promise.all([
      db.payment.groupBy({ by: ['method'], where: { sale: saleWhere }, _sum: { amount: true } }),
      db.refund.groupBy({ by: ['method'], where: { shiftId: shift.id }, _sum: { amount: true } }),
      db.cashMovement.groupBy({ by: ['type'], where: { shiftId: shift.id }, _sum: { amount: true } }),
      db.sale.count({ where: saleWhere }),
      db.sale.count({ where: { shiftId: shift.id, status: 'VOIDED' } }),
    ]);
    const sum = (v: Prisma.Decimal | null | undefined) => (v ? D(v) : ZERO);
    const cashSalesTotal = sum(pay.find((r) => r.method === 'CASH')?._sum.amount);
    const cardSalesTotal = sum(pay.find((r) => r.method === 'CARD')?._sum.amount);
    const cashRefundsTotal = sum(refunds.find((r) => r.method === 'CASH')?._sum.amount);
    const cardRefundsTotal = sum(refunds.find((r) => r.method === 'CARD')?._sum.amount);
    const cashIn = sum(moves.find((r) => r.type === 'CASH_IN')?._sum.amount);
    const cashOut = sum(moves.find((r) => r.type === 'CASH_OUT')?._sum.amount);
    const expectedCash = money(
      D(shift.openingCash).plus(cashSalesTotal).minus(cashRefundsTotal).plus(cashIn).minus(cashOut),
    );
    return {
      cashSalesTotal, cardSalesTotal, cashRefundsTotal, cardRefundsTotal, cashIn, cashOut,
      saleCount, voidedCount, expectedCash,
    };
  }

  async detail(id: string, user: AuthUser) {
    const shift = await this.loadAccessible(this.prisma, id, user);
    const [summary, movements, cashier, register] = await Promise.all([
      this.summarize(this.prisma, shift),
      this.prisma.cashMovement.findMany({ where: { shiftId: id }, orderBy: { createdAt: 'asc' } }),
      this.prisma.user.findUnique({ where: { id: shift.cashierId }, select: { name: true } }),
      this.prisma.register.findUnique({ where: { id: shift.registerId }, select: { name: true, code: true } }),
    ]);
    return { ...shift, cashierName: cashier?.name ?? null, register, summary, cashMovements: movements };
  }

  async list(user: AuthUser, q: ListShiftsQuery) {
    const all = user.permissions.has('shifts.read.all');
    const where: Prisma.ShiftWhereInput = { storeId: user.storeId };
    where.cashierId = all ? q.cashierId : user.id;
    if (q.registerId) where.registerId = q.registerId;
    if (q.status) where.status = q.status;
    if (q.dateFrom || q.dateTo) {
      where.openedAt = {
        ...(q.dateFrom ? { gte: new Date(q.dateFrom) } : {}),
        ...(q.dateTo ? { lt: endOfRange(q.dateTo) } : {}),
      };
    }
    const [rows, total] = await Promise.all([
      this.prisma.shift.findMany({ where, orderBy: { openedAt: 'desc' }, skip: skipOf(q), take: q.pageSize }),
      this.prisma.shift.count({ where }),
    ]);
    const users = await this.prisma.user.findMany({
      where: { id: { in: [...new Set(rows.map((r) => r.cashierId))] } },
      select: { id: true, name: true },
    });
    const names = new Map(users.map((u) => [u.id, u.name]));
    return paginated(rows.map((r) => ({ ...r, cashierName: names.get(r.cashierId) ?? null })), total, q);
  }
}
