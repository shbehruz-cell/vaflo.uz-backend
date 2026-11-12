# VAFLO.UZ — xavfsizlik qo‘llanmasi

Bu hujjat ilovaning kiberhujumlarga qarshi himoya qatlamlarini va serverni sozlashda
**majburiy** bajariladigan ishlarni jamlaydi. Kodda qilingan himoyalar avtomatik ishlaydi;
«Server sozlamalari» bo‘limidagilarni esa deploy qiluvchi qo‘lda bajaradi.

## 1. Kodda o‘rnatilgan himoyalar

| Hujum turi | Himoya | Qayerda |
|---|---|---|
| Parol terib ko‘rish (brute force) | IP bo‘yicha 5/daqiqa va 30/soat; **hisob bo‘yicha** 15 daqiqada 10 ta xato → 429; IP bo‘yicha 50 ta xato → 429; argon2id + timing-safe «dummy» tekshiruv | `auth.controller.ts`, `login-throttle.service.ts` |
| Credential stuffing / lug‘at hujumi | Parol siyosati: ≥8 belgi, harf+raqam, keng tarqalgan parollar va login bilan bir xil parol rad etiladi | `common/password.ts` (DTO + servis) |
| Token o‘g‘irlash | Access token 15 daqiqa, faqat xotirada; refresh token httpOnly+SameSite=Lax cookie, bazada SHA-256; har yangilanishda rotatsiya | `auth.service.ts` |
| Refresh token qayta ishlatish (reuse) | Bekor qilingan token 10 s dan keyin qayta kelsa — shu qurilma zanjiridagi barcha sessiyalar yopiladi, audit `auth.refresh_reuse_detected` | `auth.service.ts → refresh()` |
| Cheksiz sessiya | Mutlaq umr `REFRESH_ABSOLUTE_DAYS` (180 kun), undan keyin qayta kirish | `auth.service.ts` |
| CSRF | SameSite=Lax cookie + `Sec-Fetch-Site: cross-site` so‘rovlar refresh’da rad etiladi; API javoblari `Cache-Control: no-store` | `auth.service.ts`, `main.ts` |
| JWT algoritm almashtirish | Faqat HS256 imzolanadi va qabul qilinadi; production’da sir ≥32 belgi, aks holda ilova ishga tushmaydi | `app.module.ts`, `config/env.ts` |
| 2FA / tiklash kodini terib ko‘rish | 6 xonali kod, challenge bo‘yicha 5 urinish (atomik hisoblagich), 10 daqiqa muddat, 45 s cooldown, 5 ta yuborish; kod faqat xesh ko‘rinishida; timing-safe solishtirish | `auth.service.ts → checkCode()` |
| Foydalanuvchini aniqlash (enumeration) | Login, signup, forgot — bor/yo‘q email uchun bir xil javob va bir xil vaqt | `auth.service.ts` |
| Ruxsat ko‘tarilishi (privilege escalation) | Owner bo‘lmagan xodim faqat o‘zida bor ruxsatlardan iborat rolni tayinlay oladi; owner roli o‘zgarmaydi/o‘chirilmaydi; kamida bitta faol owner | `users.service.ts`, `roles.service.ts` |
| IDOR (boshqa do‘kon ma’lumoti) | Har bir so‘rov `storeId` bilan cheklanadi (servis qatlamida), sotuv/smena uchun `read.own` tekshiruvi | barcha servislar |
| SQL injection | Faqat Prisma va `Prisma.sql` parametrli so‘rovlar; raw string birlashtirish yo‘q | `reports`, `inventory`, `sales` |
| XSS (frontend) | Nonce asosidagi CSP (`script-src 'nonce' 'strict-dynamic'`), `frame-ancestors 'none'`, React avtomatik escape | frontend `src/proxy.ts` |
| Clickjacking | `X-Frame-Options: DENY` + CSP `frame-ancestors 'none'` | frontend `next.config.ts`, backend helmet |
| CSV formula injection | Importda `= + - @` bilan boshlanuvchi kataklar rad etiladi; eksportda `'` prefiksi | `product-import.service.ts`, `reports.service.ts` |
| DoS / flood | Global 120/daqiqa va 6000/soat per IP; JSON 5 MB, rasm 5×5 MB; `headersTimeout` 30 s, `requestTimeout` 120 s; `settings` JSON ≤ 20 KB | `app.module.ts`, `main.ts`, `stores/dto.ts` |
| Ma’lumot sizib chiqishi | Stack trace clientga chiqmaydi; `passwordHash`, token, karta ma’lumoti auditga yozilmaydi; `X-Powered-By` o‘chiq; Swagger production’da yopiq | `all-exceptions.filter.ts`, `audit.service.ts` |
| Email orqali hujum | SMTP STARTTLS majburiy (`SMTP_REQUIRE_TLS`), ulanish muddatlari | `mail.service.ts` |
| Maxfiylik | `GEO_LOOKUP=false` bilan IP tashqi xizmatga yuborilmaydi; IP formati tekshiriladi | `geo.service.ts` |
| Bog‘liqliklar | `npm audit --omit=dev` — backend 0 zaiflik; frontend’da `shadcn` CLI devDependencies’ga ko‘chirildi | `package.json` |

## 2. Server sozlamalari (deploy qiluvchi bajaradi)

1. **`.env`** (backend):
   - `NODE_ENV=production`
   - `JWT_ACCESS_SECRET` — kamida 32 belgi, tasodifiy:
     `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`
   - `HOST=127.0.0.1` — API faqat nginx orqali ochiq bo‘lsin.
   - `DATABASE_URL` — alohida DB foydalanuvchisi, `postgres` superuser emas; kuchli parol.
   - `COOKIE_SECURE` qatorini **olib tashlang** (HTTPS bo‘lsa cookie avtomatik `Secure`).
   - `CORS_ORIGINS` — faqat haqiqiy frontend domeni (same-origin rewrite ishlatilsa bo‘sh qoldirsa ham bo‘ladi).
   - `SMTP_*` — to‘ldiring, aks holda 2FA/tiklash/ro‘yxatdan o‘tish ishlamaydi.
   - Kerak bo‘lmasa `SIGNUP_ENABLED=false`.
2. **HTTPS** (Let’s Encrypt) va nginx’da:
   ```nginx
   add_header Strict-Transport-Security "max-age=15552000; includeSubDomains" always;
   client_max_body_size 30m;          # AI rasm yuklash (5×5 MB) uchun
   proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
   proxy_set_header X-Forwarded-Proto $scheme;
   limit_req_zone $binary_remote_addr zone=api:10m rate=30r/s;   # qo‘shimcha IP limiti
   location /api/ { limit_req zone=api burst=60 nodelay; proxy_pass http://127.0.0.1:4000; }
   ```
   `trust proxy` 1 ga sozlangan — nginx bitta hop bo‘lishi kerak (Cloudflare bo‘lsa `real_ip` moduli).
3. **Firewall**: faqat 22, 80, 443 ochiq; PostgreSQL (5432) va API (4000) tashqaridan yopiq. SSH — faqat kalit bilan, `PasswordAuthentication no`, `fail2ban`.
4. **Zaxira nusxa**: `pg_dump` har kecha, boshqa serverga/obyekt saqlashga shifrlangan holda; tiklashni har chorakda sinab ko‘ring.
5. **Yangilanishlar**: `npm audit` har oy; `apt upgrade` avtomatik; Node LTS.
6. **CI/CD**: GitHub Secrets (`SSH_PRIVATE_KEY`) faqat deploy uchun alohida kalit; `appleboy/ssh-action` ni commit SHA’ga qotiring (tag’lar o‘zgarishi mumkin).
7. **Monitoring**: audit jurnalida `auth.login_failed`, `auth.refresh_reuse_detected`, `user.role_changed`, `sale.voided` hodisalarini kuzating; `/api/v1/health/ready` uchun uptime tekshiruvi.

## 3. Operatsion qoidalar

- Owner hisobida **2 bosqichli kirish**ni yoqing (Hisob → Xavfsizlik).
- Xodim ketganda darhol bloklang: barcha sessiyalari avtomatik bekor qilinadi.
- Standart seed paroli (`SEED_OWNER_PASSWORD`) bilan ishlab turmang — birinchi kirishdan keyin almashtiring.
- `.env` faylini git’ga qo‘ymang (`.gitignore` da `.env*`), chat/Telegram orqali yubormang.

## 4. Hali qilinmagan / tavsiya

- Ko‘p instansli deploy bo‘lsa throttler va login-throttle uchun Redis storage.
- Audit jurnalini tashqi (o‘zgarmas) saqlashga ko‘chirish (WORM).
- Parolni «sizib chiqqan parollar» bazasi (HIBP k-anonymity) bilan tekshirish.
- Sessiya qurilmasi/IP keskin o‘zgarganda email ogohlantirish.
