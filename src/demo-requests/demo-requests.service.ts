import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
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

  async list(q: PaginationQuery) {
    const [items, total] = await Promise.all([
      this.prisma.demoRequest.findMany({ orderBy: { createdAt: 'desc' }, skip: skipOf(q), take: q.pageSize }),
      this.prisma.demoRequest.count(),
    ]);
    return paginated(items, total, q);
  }
}
