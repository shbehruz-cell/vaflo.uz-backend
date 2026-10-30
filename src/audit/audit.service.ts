import { Injectable } from '@nestjs/common';
import { PrismaService, type Tx } from '../prisma/prisma.service.js';
import type { AuthUser } from '../common/auth/auth-user.js';

const SECRET_KEYS = /pass|token|secret|card|pan|cvv|hash/i;

/** Metadata ichidan maxfiy maydonlarni olib tashlaydi (TZ 14.2). */
function sanitize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitize);
  if (value && typeof value === 'object') {
    if (typeof (value as { toFixed?: unknown }).toFixed === 'function') return String(value); // Decimal
    if (value instanceof Date) return value.toISOString();
    return Object.fromEntries(
      Object.entries(value).filter(([k]) => !SECRET_KEYS.test(k)).map(([k, v]) => [k, sanitize(v)]),
    );
  }
  return value;
}

export interface AuditEntry {
  action: string;
  entityType?: string;
  entityId?: string;
  metadata?: Record<string, unknown>;
}

export interface AuditContext {
  user?: AuthUser | null;
  storeId?: string | null;
  requestId?: string;
  ip?: string;
}

/**
 * Faqat yozish (append-only). AuditLog uchun update/delete API berilmaydi.
 * Tranzaksiya ichida chaqirilsa `tx` uzating — amal bilan birga yoziladi.
 */
@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  async log(ctx: AuditContext, entry: AuditEntry, tx?: Tx) {
    const db = tx ?? this.prisma;
    await db.auditLog.create({
      data: {
        storeId: ctx.storeId ?? ctx.user?.storeId ?? null,
        actorId: ctx.user?.id ?? null,
        action: entry.action,
        entityType: entry.entityType,
        entityId: entry.entityId,
        metadata: (sanitize(entry.metadata ?? {}) ?? {}) as object,
        requestId: ctx.requestId,
        ip: ctx.ip,
      },
    });
  }
}
