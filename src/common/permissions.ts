/** TZ 3.4 — permission kodlari. Backend har bir endpointda shu kodlarni tekshiradi. */
export const PERMISSIONS = {
  'products.read': 'Mahsulotlarni ko‘rish',
  'products.manage': 'Mahsulot yaratish/tahrirlash/arxivlash',
  'inventory.read': 'Qoldiq va ombor harakatlarini ko‘rish',
  'inventory.adjust': 'Qoldiqni tuzatish',
  'sales.create': 'POS orqali sotuv qilish',
  'sales.read.all': 'Barcha sotuvlarni ko‘rish',
  'sales.read.own': 'Faqat o‘z sotuvlarini ko‘rish',
  'sales.refund': 'Qaytarish',
  'sales.void': 'Sotuvni bekor qilish',
  'pricing.change': 'Narxni o‘zgartirish',
  'discount.apply': 'Oddiy chegirma',
  'discount.override': 'Limitdan yuqori chegirma',
  'costs.read': 'Tannarxni ko‘rish',
  'reports.read': 'Sotuv hisobotlari',
  'reports.profit.read': 'Tannarx, foyda va xarajat hisobotlari',
  'customers.read': 'Xaridorlarni ko‘rish',
  'customers.manage': 'Xaridorlarni yaratish/tahrirlash',
  'shifts.manage': 'O‘z smenasini ochish/yopish, kassa harakatlari',
  'shifts.read.all': 'Barcha smenalarni ko‘rish',
  'registers.manage': 'Kassalarni sozlash: kassir soni va biriktirilgan xodimlar',
  'users.manage': 'Xodimlarni boshqarish',
  'roles.manage': 'Rollarni boshqarish',
  'audit.read': 'Audit tarixini ko‘rish',
  'demo_requests.read': 'Landing demo so‘rovlarini ko‘rish',
} as const;

export type PermissionCode = keyof typeof PERMISSIONS;
export const ALL_PERMISSIONS = Object.keys(PERMISSIONS) as PermissionCode[];

/** Tizim rollari uchun default to‘plamlar (TZ 3.1–3.3). Owner hammasiga ega. */
export const DEFAULT_ROLES: Record<'owner' | 'deputy' | 'worker', { name: string; permissions: PermissionCode[] }> = {
  owner: { name: 'Owner', permissions: ALL_PERMISSIONS },
  deputy: {
    name: 'O‘rinbosar',
    permissions: [
      'products.read', 'products.manage', 'inventory.read', 'inventory.adjust',
      'sales.create', 'sales.read.all', 'discount.apply', 'customers.read', 'customers.manage',
      'shifts.manage', 'shifts.read.all', 'reports.read',
    ],
  },
  worker: {
    name: 'Ishchi',
    permissions: ['products.read', 'inventory.read', 'sales.create', 'sales.read.own', 'customers.read', 'shifts.manage'],
  },
};

/** Chegirma limiti (foiz) — undan yuqorisi uchun discount.override kerak. */
export const DISCOUNT_LIMIT_PERCENT = 10;
