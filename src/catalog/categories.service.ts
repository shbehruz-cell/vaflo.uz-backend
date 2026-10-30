import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { AuditService, type AuditContext } from '../audit/audit.service.js';
import type { AuthUser } from '../common/auth/auth-user.js';

@Injectable()
export class CategoriesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  list(user: AuthUser) {
    return this.prisma.category.findMany({
      where: { storeId: user.storeId },
      orderBy: { name: 'asc' },
      include: { _count: { select: { products: true } } },
    });
  }

  async create(ctx: AuditContext, user: AuthUser, name: string) {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const c = await tx.category.create({ data: { storeId: user.storeId, name: name.trim() } });
        await this.audit.log(ctx, { action: 'category.created', entityType: 'Category', entityId: c.id, metadata: { name: c.name } }, tx);
        return c;
      });
    } catch (e) {
      this.rethrow(e);
    }
  }

  async update(ctx: AuditContext, user: AuthUser, id: string, name: string) {
    const existing = await this.prisma.category.findFirst({ where: { id, storeId: user.storeId } });
    if (!existing) throw new NotFoundException('Kategoriya topilmadi');
    try {
      return await this.prisma.$transaction(async (tx) => {
        const c = await tx.category.update({ where: { id }, data: { name: name.trim() } });
        await this.audit.log(ctx, { action: 'category.updated', entityType: 'Category', entityId: id, metadata: { old: existing.name, new: c.name } }, tx);
        return c;
      });
    } catch (e) {
      this.rethrow(e);
    }
  }

  private rethrow(e: unknown): never {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
      throw new ConflictException('Bunday nomli kategoriya allaqachon mavjud');
    }
    throw e;
  }
}
