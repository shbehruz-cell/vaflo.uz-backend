import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import type { AuthUser } from '../common/auth/auth-user.js';
import { isPlatformStore } from '../stores/tenant-bootstrap.js';
import { normalizePhone } from '../common/normalize.js';
import { paginated, skipOf, type PaginationQuery } from '../common/pagination.dto.js';
import type { CreateDemoRequestDto } from './dto.js';

@Injectable()
export class DemoRequestsService {
  constructor(private readonly prisma: PrismaService) {}

  async create(dto: CreateDemoRequestDto, ip?: string) {
    if (dto.website && dto.website.trim() !== '') return { ok: true }; // honeypot — saqlanmaydi
    const phone = normalizePhone(dto.phone);
    if (!phone) throw new BadRequestException('Telefon raqam noto‘g‘ri');
    await this.prisma.demoRequest.create({
      data: {
        name: dto.name,
        phone,
        storeName: dto.storeName,
        storeType: dto.storeType,
        message: dto.message || null,
        ip,
      },
    });
    return { ok: true };
  }

  /** Landing so‘rovlari platformaga tegishli: faqat platforma do‘koni (PLATFORM_STORE_ID) xodimlari ko‘ra oladi. */
  async list(q: PaginationQuery, user: AuthUser) {
    if (!(await isPlatformStore(this.prisma, user.storeId))) throw new ForbiddenException('Ruxsat yo‘q');
    const [items, total] = await Promise.all([
      this.prisma.demoRequest.findMany({ orderBy: { createdAt: 'desc' }, skip: skipOf(q), take: q.pageSize }),
      this.prisma.demoRequest.count(),
    ]);
    return paginated(items, total, q);
  }
}
