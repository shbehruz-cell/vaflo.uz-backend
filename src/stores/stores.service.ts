import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { AuditService, type AuditContext } from '../audit/audit.service.js';
import type { AuthUser } from '../common/auth/auth-user.js';
import type { Prisma } from '../generated/prisma/client.js';
import type { CreateRegisterDto, CreateWarehouseDto, UpdateRegisterDto, UpdateStoreDto } from './dto.js';

function assertOwner(user: AuthUser) {
  if (user.roleKey !== 'owner') throw new ForbiddenException('Bu amal faqat egasi uchun');
}

function isUniqueViolation(e: unknown) {
  return typeof e === 'object' && e !== null && (e as { code?: string }).code === 'P2002';
}

@Injectable()
export class StoresService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async current(user: AuthUser) {
    const store = await this.prisma.store.findFirst({
      where: { id: user.storeId },
      select: { id: true, name: true, timezone: true, status: true, settings: true, createdAt: true },
    });
    if (!store) throw new NotFoundException('Do‘kon topilmadi');
    return store;
  }

  async update(user: AuthUser, dto: UpdateStoreDto, ctx: AuditContext) {
    assertOwner(user);
    if (dto.timezone) {
      try {
        new Intl.DateTimeFormat('en-US', { timeZone: dto.timezone });
      } catch {
        throw new BadRequestException('Vaqt zonasi noto‘g‘ri');
      }
    }
    const data: Prisma.StoreUpdateInput = {};
    if (dto.name !== undefined) data.name = dto.name;
    if (dto.timezone !== undefined) data.timezone = dto.timezone;
    if (dto.settings !== undefined) data.settings = dto.settings as Prisma.InputJsonValue;
    const changed = Object.keys(data);
    return this.prisma.$transaction(async (tx) => {
      const store = await tx.store.update({
        where: { id: user.storeId },
        data,
        select: { id: true, name: true, timezone: true, status: true, settings: true, createdAt: true },
      });
      await this.audit.log(ctx, { action: 'store.updated', entityType: 'Store', entityId: store.id, metadata: { changed } }, tx);
      return store;
    });
  }

  warehouses(user: AuthUser) {
    return this.prisma.warehouse.findMany({
      where: { storeId: user.storeId, status: 'ACTIVE' },
      orderBy: { createdAt: 'asc' },
    });
  }

  /**
   * Kassalar: biriktirilgan xodimlar, hozir ochiq smenalar (bandlik) va joriy foydalanuvchi
   * shu kassada smena ocha olishi (`canOpen` / `blockedReason`).
   */
  async registers(user: AuthUser) {
    const rows = await this.prisma.register.findMany({
      where: { storeId: user.storeId, status: 'ACTIVE' },
      orderBy: { createdAt: 'asc' },
      include: {
        assignments: { include: { user: { select: { id: true, name: true, status: true } } } },
        shifts: { where: { status: 'OPEN' }, select: { id: true, cashierId: true, openedAt: true } },
      },
    });
    const cashierIds = [...new Set(rows.flatMap((r) => r.shifts.map((s) => s.cashierId)))];
    const names = new Map(
      (await this.prisma.user.findMany({ where: { id: { in: cashierIds } }, select: { id: true, name: true } })).map((u) => [u.id, u.name]),
    );

    return rows.map(({ assignments, shifts, ...r }) => {
      const assignedUsers = assignments.map((a) => a.user);
      const openShifts = shifts.map((s) => ({ ...s, cashierName: names.get(s.cashierId) ?? null }));
      let blockedReason: string | null = null;
      if (assignedUsers.length > 0 && !assignedUsers.some((u) => u.id === user.id)) blockedReason = 'Siz bu kassaga biriktirilmagansiz';
      else if (openShifts.length >= r.maxCashiers) blockedReason = `Kassa band (${openShifts.length}/${r.maxCashiers})`;
      return { ...r, assignedUsers, openShifts, openCount: openShifts.length, canOpen: blockedReason === null, blockedReason };
    });
  }

  /** Kassaga biriktirish uchun faol xodimlar (faqat ism va rol — maxfiy ma’lumotsiz). */
  registerStaff(user: AuthUser) {
    return this.prisma.user.findMany({
      where: { storeId: user.storeId, status: 'ACTIVE' },
      select: { id: true, name: true, role: { select: { key: true, name: true } } },
      orderBy: { name: 'asc' },
    });
  }

  async updateRegister(user: AuthUser, id: string, dto: UpdateRegisterDto, ctx: AuditContext) {
    const reg = await this.prisma.register.findFirst({
      where: { id, storeId: user.storeId },
      include: { assignments: { select: { userId: true } } },
    });
    if (!reg) throw new NotFoundException('Kassa topilmadi');

    if (dto.userIds) {
      const uniq = [...new Set(dto.userIds)];
      const found = await this.prisma.user.count({ where: { id: { in: uniq }, storeId: user.storeId } });
      if (found !== uniq.length) throw new BadRequestException('Xodimlar ro‘yxatida noto‘g‘ri foydalanuvchi bor');
      dto.userIds = uniq;
    }

    const before = { name: reg.name, maxCashiers: reg.maxCashiers, userIds: reg.assignments.map((a) => a.userId) };
    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.register.update({
        where: { id: reg.id },
        data: { name: dto.name, maxCashiers: dto.maxCashiers },
      });
      if (dto.userIds) {
        await tx.registerAssignment.deleteMany({ where: { registerId: reg.id } });
        if (dto.userIds.length) {
          await tx.registerAssignment.createMany({ data: dto.userIds.map((userId) => ({ registerId: reg.id, userId })) });
        }
      }
      await this.audit.log(
        ctx,
        {
          action: 'register.updated',
          entityType: 'Register',
          entityId: reg.id,
          metadata: { before, after: { name: updated.name, maxCashiers: updated.maxCashiers, userIds: dto.userIds ?? before.userIds } },
        },
        tx,
      );
      return updated;
    });
  }

  async createWarehouse(user: AuthUser, dto: CreateWarehouseDto, ctx: AuditContext) {
    assertOwner(user);
    try {
      return await this.prisma.$transaction(async (tx) => {
        const w = await tx.warehouse.create({ data: { storeId: user.storeId, name: dto.name, code: dto.code } });
        await this.audit.log(ctx, { action: 'warehouse.created', entityType: 'Warehouse', entityId: w.id, metadata: { name: w.name, code: w.code } }, tx);
        return w;
      });
    } catch (e) {
      if (isUniqueViolation(e)) throw new ConflictException('Bu kodli ombor allaqachon mavjud');
      throw e;
    }
  }

  async createRegister(user: AuthUser, dto: CreateRegisterDto, ctx: AuditContext) {
    const wh = await this.prisma.warehouse.findFirst({
      where: { id: dto.warehouseId, storeId: user.storeId, status: 'ACTIVE' },
      select: { id: true },
    });
    if (!wh) throw new NotFoundException('Ombor topilmadi');
    try {
      return await this.prisma.$transaction(async (tx) => {
        const r = await tx.register.create({
          data: { storeId: user.storeId, warehouseId: wh.id, name: dto.name, code: dto.code, maxCashiers: dto.maxCashiers ?? 1 },
        });
        await this.audit.log(ctx, { action: 'register.created', entityType: 'Register', entityId: r.id, metadata: { name: r.name, code: r.code, warehouseId: wh.id } }, tx);
        return r;
      });
    } catch (e) {
      if (isUniqueViolation(e)) throw new ConflictException('Bu kodli kassa allaqachon mavjud');
      throw e;
    }
  }
}
