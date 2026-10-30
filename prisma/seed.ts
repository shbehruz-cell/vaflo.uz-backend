import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import * as argon2 from 'argon2';
import { PrismaClient } from '../src/generated/prisma/client.js';
import { normalizeLogin } from '../src/common/normalize.js';
import { ALL_PERMISSIONS, DEFAULT_ROLES, PERMISSIONS } from '../src/common/permissions.js';

if (process.env.NODE_ENV === 'production') {
  console.error('Seed production muhitida ishlamaydi.');
  process.exit(1);
}

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });

const DEMO_PRODUCTS = [
  { name: 'Non (tandir)', sku: 'NON-001', barcode: '4780000000011', salePrice: '4000.00', costPrice: '2800.00', qty: '100.000', unit: 'PIECE' },
  { name: 'Sut 1 litr', sku: 'SUT-001', barcode: '4780000000028', salePrice: '12500.00', costPrice: '9800.00', qty: '60.000', unit: 'PIECE' },
  { name: 'Guruch (lazer)', sku: 'GUR-001', barcode: '4780000000035', salePrice: '16000.00', costPrice: '12500.00', qty: '250.000', unit: 'KG' },
  { name: 'Choy qora 100 g', sku: 'CHO-001', barcode: '4780000000042', salePrice: '14000.00', costPrice: '10500.00', qty: '80.000', unit: 'PIECE' },
  { name: 'Shakar', sku: 'SHA-001', barcode: '4780000000059', salePrice: '13500.00', costPrice: '11000.00', qty: '150.000', unit: 'KG' },
] as const;

async function main() {
  // 1. Permissionlar (idempotent)
  for (const code of ALL_PERMISSIONS) {
    await prisma.permission.upsert({
      where: { code },
      update: { description: PERMISSIONS[code] },
      create: { code, description: PERMISSIONS[code] },
    });
  }

  // 2. Do‘kon mavjud bo‘lsa — hech narsa yaratilmaydi
  const existing = await prisma.store.findFirst({ orderBy: { createdAt: 'asc' } });
  if (existing) {
    // Yangi qo‘shilgan permissionlar Owner roliga ham beriladi (Owner hamma narsaga ega)
    const ownerRoles = await prisma.role.findMany({ where: { key: 'owner' }, select: { id: true } });
    await prisma.rolePermission.createMany({
      data: ownerRoles.flatMap((r) => ALL_PERMISSIONS.map((permissionCode) => ({ roleId: r.id, permissionCode }))),
      skipDuplicates: true,
    });
    console.log(`Do‘kon allaqachon mavjud (id: ${existing.id}). Permissionlar yangilandi, boshqa o‘zgarish yo‘q.`);
    return;
  }

  const storeName = process.env.SEED_STORE_NAME || 'VAFLO Demo Do‘kon';
  const ownerLogin = process.env.SEED_OWNER_LOGIN;
  const ownerPassword = process.env.SEED_OWNER_PASSWORD;
  if (!ownerLogin || !ownerPassword) {
    throw new Error('SEED_OWNER_LOGIN va SEED_OWNER_PASSWORD .env da ko‘rsatilishi kerak');
  }
  // normalizeLogin bilan bir xil qoida (src/common/normalize.ts)
  const login = normalizeLogin(ownerLogin);
  const passwordHash = await argon2.hash(ownerPassword, { type: argon2.argon2id });

  const result = await prisma.$transaction(async (tx) => {
    const store = await tx.store.create({ data: { name: storeName } });
    const warehouse = await tx.warehouse.create({
      data: { storeId: store.id, name: 'Asosiy ombor', code: 'MAIN' },
    });
    await tx.register.create({
      data: { storeId: store.id, warehouseId: warehouse.id, name: 'Kassa 1', code: 'K1' },
    });

    const roleIds: Record<string, string> = {};
    for (const [key, def] of Object.entries(DEFAULT_ROLES)) {
      const role = await tx.role.create({
        data: {
          storeId: store.id,
          key,
          name: def.name,
          isSystem: true,
          permissions: { create: def.permissions.map((permissionCode) => ({ permissionCode })) },
        },
      });
      roleIds[key] = role.id;
    }

    const owner = await tx.user.create({
      data: { storeId: store.id, roleId: roleIds.owner!, name: 'Owner', login, passwordHash },
    });

    const category = await tx.category.create({ data: { storeId: store.id, name: 'Oziq-ovqat' } });

    for (const p of DEMO_PRODUCTS) {
      const product = await tx.product.create({
        data: {
          storeId: store.id,
          categoryId: category.id,
          name: p.name,
          normalizedName: p.name.toLowerCase(),
          sku: p.sku,
          unit: p.unit,
          salePrice: p.salePrice,
          costPrice: p.costPrice,
          minStock: '5.000',
          barcodes: { create: [{ storeId: store.id, value: p.barcode }] },
        },
      });
      await tx.stockBalance.create({
        data: { warehouseId: warehouse.id, productId: product.id, qty: p.qty, version: 1 },
      });
      await tx.stockMovement.create({
        data: {
          warehouseId: warehouse.id,
          productId: product.id,
          type: 'ADJUSTMENT',
          qty: p.qty,
          balanceAfter: p.qty,
          reason: 'Boshlang‘ich qoldiq (seed)',
          referenceType: 'Seed',
          actorId: owner.id,
        },
      });
    }
    return { storeId: store.id };
  });

  console.log(`Seed tayyor. Store id: ${result.storeId}`);
  console.log(`Owner login: ${login}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
