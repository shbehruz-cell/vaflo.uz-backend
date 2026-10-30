import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { AuditService, type AuditContext } from '../audit/audit.service.js';
import type { AuthUser } from '../common/auth/auth-user.js';
import { normalizePhone } from '../common/normalize.js';
import { paginated, skipOf, type PaginationQuery } from '../common/pagination.dto.js';
import type { Prisma } from '../generated/prisma/client.js';
import type { CreateCustomerDto, CustomerListQuery, UpdateCustomerDto } from './dto.js';

const BAD_PHONE = 'Telefon raqam noto‘g‘ri';

@Injectable()
export class CustomersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(user: AuthUser, q: CustomerListQuery) {
    const where: Prisma.CustomerWhereInput = { storeId: user.storeId };
    const term = q.q?.trim();
    if (term) {
      const or: Prisma.CustomerWhereInput[] = [{ name: { contains: term, mode: 'insensitive' } }];
      const digits = term.replace(/\D/g, '');
      if (digits.length >= 3) or.push({ normalizedPhone: { contains: digits } });
      where.OR = or;
    }
    const [items, total] = await Promise.all([
      this.prisma.customer.findMany({ where, orderBy: { name: 'asc' }, skip: skipOf(q), take: q.pageSize }),
      this.prisma.customer.count({ where }),
    ]);
    return paginated(items, total, q);
  }

  async get(user: AuthUser, id: string, q: PaginationQuery) {
    const customer = await this.prisma.customer.findFirst({ where: { id, storeId: user.storeId } });
    if (!customer) throw new NotFoundException('Xaridor topilmadi');
    const salesWhere: Prisma.SaleWhereInput = { storeId: user.storeId, customerId: id };
    const [agg, recent, recentTotal] = await Promise.all([
      this.prisma.sale.aggregate({
        where: { ...salesWhere, status: { not: 'VOIDED' } },
        _count: { _all: true },
        _sum: { total: true, refundedTotal: true },
        _max: { createdAt: true },
      }),
      this.prisma.sale.findMany({
        where: salesWhere,
        orderBy: { createdAt: 'desc' },
        skip: skipOf(q),
        take: q.pageSize,
        select: { id: true, receiptNo: true, createdAt: true, total: true, status: true },
      }),
      this.prisma.sale.count({ where: salesWhere }),
    ]);
    return {
      customer,
      stats: {
        salesCount: agg._count._all,
        totalSpent: fmt(agg._sum.total),
        totalRefunded: fmt(agg._sum.refundedTotal),
        lastPurchaseAt: agg._max.createdAt,
      },
      recentSales: paginated(
        recent.map((s) => ({ ...s, total: fmt(s.total) })),
        recentTotal,
        q,
      ),
    };
  }

  private async findDuplicate(storeId: string, normalizedPhone: string | null, excludeId?: string) {
    if (!normalizedPhone) return null;
    const dup = await this.prisma.customer.findFirst({
      where: { storeId, normalizedPhone, ...(excludeId ? { id: { not: excludeId } } : {}) },
      select: { id: true, name: true },
    });
    return dup ?? null;
  }

  async create(user: AuthUser, dto: CreateCustomerDto, ctx: AuditContext) {
    let normalizedPhone: string | null = null;
    if (dto.phone) {
      normalizedPhone = normalizePhone(dto.phone);
      if (!normalizedPhone) throw new BadRequestException(BAD_PHONE);
    }
    const duplicateWarning = await this.findDuplicate(user.storeId, normalizedPhone);
    const customer = await this.prisma.$transaction(async (tx) => {
      const c = await tx.customer.create({
        data: {
          storeId: user.storeId,
          name: dto.name,
          phone: normalizedPhone,
          normalizedPhone,
          address: dto.address || null,
          notes: dto.notes || null,
          createdById: user.id,
        },
      });
      const fields = ['name', ...(normalizedPhone ? ['phone'] : []), ...(dto.address ? ['address'] : []), ...(dto.notes ? ['notes'] : [])];
      await this.audit.log(ctx, { action: 'customer.created', entityType: 'Customer', entityId: c.id, metadata: { fields } }, tx);
      return c;
    });
    return { customer, duplicateWarning };
  }

  async update(user: AuthUser, id: string, dto: UpdateCustomerDto, ctx: AuditContext) {
    const existing = await this.prisma.customer.findFirst({ where: { id, storeId: user.storeId } });
    if (!existing) throw new NotFoundException('Xaridor topilmadi');
    const data: Prisma.CustomerUpdateInput = {};
    const fields: string[] = [];
    let duplicateWarning: { id: string; name: string } | null = null;

    if (dto.name !== undefined && dto.name !== existing.name) {
      data.name = dto.name;
      fields.push('name');
    }
    if (dto.phone !== undefined) {
      let np: string | null = null;
      if (dto.phone !== '') {
        np = normalizePhone(dto.phone);
        if (!np) throw new BadRequestException(BAD_PHONE);
      }
      if (np !== existing.normalizedPhone) {
        data.phone = np;
        data.normalizedPhone = np;
        fields.push('phone');
        duplicateWarning = await this.findDuplicate(user.storeId, np, id);
      }
    }
    if (dto.address !== undefined && (dto.address || null) !== existing.address) {
      data.address = dto.address || null;
      fields.push('address');
    }
    if (dto.notes !== undefined && (dto.notes || null) !== existing.notes) {
      data.notes = dto.notes || null;
      fields.push('notes');
    }
    if (!fields.length) return { customer: existing, duplicateWarning: null };

    const customer = await this.prisma.$transaction(async (tx) => {
      const c = await tx.customer.update({ where: { id }, data });
      await this.audit.log(ctx, { action: 'customer.updated', entityType: 'Customer', entityId: id, metadata: { fields } }, tx);
      return c;
    });
    return { customer, duplicateWarning };
  }
}

function fmt(v: Prisma.Decimal | null | undefined) {
  return v ? v.toFixed(2) : '0.00';
}
