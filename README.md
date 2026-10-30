# VAFLO.UZ — backend

NestJS 12 + Prisma 7 + PostgreSQL REST API (TZ 15–18-bo‘limlar).

## Ishga tushirish

```bash
npm install
# .env faylida DATABASE_URL ichidagi YOUR_PASSWORD ni o‘z Postgres parolingizga almashtiring,
# SEED_OWNER_PASSWORD ga kuchli parol yozing.
createdb -U postgres vaflo          # yoki pgAdmin orqali "vaflo" bazasini yarating
npm run db:migrate -- --name init   # jadvallarni yaratish
npm run db:seed                     # do‘kon, ombor, kassa, 3 ta rol, Owner va demo mahsulotlar
npm run start:dev
```

- API: `http://localhost:4000/api/v1`
- Swagger: `http://localhost:4000/api/docs` (production’da o‘chiq)
- Health: `GET /api/v1/health`, `GET /api/v1/health/ready`

## Modullar

| Modul | Asosiy endpointlar |
|---|---|
| Auth | `POST auth/login`, `auth/refresh` (httpOnly cookie, rotatsiya), `auth/logout`, `GET auth/me`, `POST auth/change-password` |
| Users / Roles | `users` CRUD + bloklash (sessiyalar bekor qilinadi), `roles` + permission matritsasi |
| Stores | `stores/current`, `warehouses`, `registers` |
| Catalog | `categories`, `products` (filtr, `lookup?barcode=`, arxivlash, narx o‘zgarishi audit), `products/import/preview|commit` |
| Inventory | `inventory/balances`, `inventory/movements`, `inventory/adjustments` |
| Shifts | `shifts/open`, `shifts/current`, `shifts/:id/cash-movements`, `shifts/:id/close` |
| Sales | `POST sales` (idempotency, tranzaksiya, oversell bloklanadi), `GET sales` filtrlar, `sales/:id`, `sales/:id/refunds`, `sales/:id/void` |
| Customers | `customers` CRUD (takroriy telefon ogohlantirishi) |
| Reports | `reports/summary`, `sales-by-day`, `top-products`, `by-cashier`, `low-stock`, `sales.csv` |
| Audit | `GET audit` (faqat o‘qish) |
| Demo requests | `POST demo-requests` (landing formasi, public, throttled) |

## Muhim qoidalar

- Har bir endpoint global `AuthGuard` orqali himoyalangan; `@Public()` bo‘lmasa token talab qilinadi. Ruxsat — `@RequirePermissions(...)`, store scope — servis qatlamida.
- Pul/miqdor — `Decimal`; qoldiq faqat `StockService.apply()` orqali atomik o‘zgaradi.
- Xato formati: `{ statusCode, error, message, requestId }` — stack trace clientga chiqmaydi.
- Parollar argon2id; refresh token bazada faqat SHA-256 xesh ko‘rinishida.
- `npm run db:seed` production’da ishlamaydi.

## Hali qilinmagan (TZ keyingi bosqichlari)

Yetkazib beruvchilar/xaridlar/xarajatlar, inventarizatsiya sessiyalari, ko‘p filial UI, fiskal/bank integratsiyalari, e2e testlar.
