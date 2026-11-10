import { DEFAULT_ROLES, PLATFORM_ONLY, type PermissionCode } from '../common/permissions.js';
import type { PrismaService, Tx } from '../prisma/prisma.service.js';

export interface NewTenantInput {
  storeName: string;
  ownerName: string;
  /** Normalizatsiya qilingan email (User.login). */
  email: string;
  passwordHash: string;
}

/**
 * Yangi do‘kon (tenant) uchun boshlang‘ich ma’lumotlar: do‘kon, ombor, kassa, tizim rollari va Owner.
 * Faqat tashqi tranzaksiya ichida chaqiriladi (atomik). Demo ma’lumot YARATILMAYDI.
 * Platforma-ichki ruxsatlar (PLATFORM_ONLY) yangi do‘kon rollariga berilmaydi.
 */
export async function createTenant(tx: Tx, input: NewTenantInput): Promise<{ storeId: string; userId: string }> {
  const store = await tx.store.create({ data: { name: input.storeName.trim(), timezone: 'Asia/Tashkent' } });
  const warehouse = await tx.warehouse.create({ data: { storeId: store.id, name: 'Asosiy ombor', code: 'MAIN' } });
  await tx.register.create({ data: { storeId: store.id, warehouseId: warehouse.id, name: 'Kassa 1', code: 'K1' } });

  const roleIds: Record<string, string> = {};
  for (const [key, def] of Object.entries(DEFAULT_ROLES)) {
    const permissions = def.permissions.filter((p: PermissionCode) => !PLATFORM_ONLY.includes(p));
    const role = await tx.role.create({
      data: {
        storeId: store.id,
        key,
        name: def.name,
        isSystem: true,
        permissions: { create: permissions.map((permissionCode) => ({ permissionCode })) },
      },
    });
    roleIds[key] = role.id;
  }

  const owner = await tx.user.create({
    data: { storeId: store.id, roleId: roleIds.owner!, name: input.ownerName.trim(), login: input.email, passwordHash: input.passwordHash },
  });
  return { storeId: store.id, userId: owner.id };
}

let platformStoreCache: string | undefined;

/** Platforma do‘koni: env PLATFORM_STORE_ID, bo‘lmasa eng birinchi yaratilgan do‘kon (landing so‘rovlari shu do‘konga tegishli). */
export async function getPlatformStoreId(prisma: PrismaService): Promise<string | null> {
  const fromEnv = process.env.PLATFORM_STORE_ID?.trim();
  if (fromEnv) return fromEnv;
  if (!platformStoreCache) {
    platformStoreCache = (await prisma.store.findFirst({ orderBy: { createdAt: 'asc' }, select: { id: true } }))?.id;
  }
  return platformStoreCache ?? null;
}

export async function isPlatformStore(prisma: PrismaService, storeId: string) {
  return (await getPlatformStoreId(prisma)) === storeId;
}
