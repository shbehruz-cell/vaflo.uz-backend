import { Injectable } from '@nestjs/common';
import { IsDateString, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { PaginationQuery, paginated, skipOf } from '../common/pagination.dto.js';
import type { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';

export class AuditQuery extends PaginationQuery {
  @IsOptional() @IsUUID() actorId?: string;
  /** Prefiks: masalan `product.` */
  @IsOptional() @IsString() @MaxLength(100) action?: string;
  @IsOptional() @IsString() @MaxLength(100) entityType?: string;
  @IsOptional() @IsString() @MaxLength(100) entityId?: string;
  @IsOptional() @IsDateString() dateFrom?: string;
  @IsOptional() @IsDateString() dateTo?: string;
}

@Injectable()
export class AuditLogService {
  constructor(private readonly prisma: PrismaService) {}

  async list(storeId: string, q: AuditQuery) {
    const where: Prisma.AuditLogWhereInput = { storeId };
    if (q.actorId) where.actorId = q.actorId;
    if (q.action) where.action = { startsWith: q.action };
    if (q.entityType) where.entityType = q.entityType;
    if (q.entityId) where.entityId = q.entityId;
    if (q.dateFrom || q.dateTo) {
      const range: { gte?: Date; lt?: Date } = {};
      if (q.dateFrom) range.gte = new Date(q.dateFrom);
      if (q.dateTo) {
        const to = new Date(q.dateTo);
        if (!q.dateTo.includes('T')) to.setUTCDate(to.getUTCDate() + 1); // sana ko‘rinishida — kun oxirigacha
        range.lt = to;
      }
      where.createdAt = range;
    }
    const [rows, total] = await Promise.all([
      this.prisma.auditLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: skipOf(q),
        take: q.pageSize,
      }),
      this.prisma.auditLog.count({ where }),
    ]);
    const ids = [...new Set(rows.map((r) => r.actorId).filter((x): x is string => !!x))];
    const users = ids.length
      ? await this.prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } })
      : [];
    const names = new Map(users.map((u) => [u.id, u.name]));
    const items = rows.map((r) => ({ ...r, actorName: r.actorId ? (names.get(r.actorId) ?? null) : null }));
    return paginated(items, total, q);
  }
}
