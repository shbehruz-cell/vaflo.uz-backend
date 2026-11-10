# Email orqali ro‘yxatdan o‘tish (yangi do‘kon)

Hammasi `@Public`, prefiks `/api/v1/auth`. Tokenlar/kodlar hech qachon logga yozilmaydi (dev rejimida kod faqat konsolga chiqadi).

| Endpoint | Body | 200 javob | Xatolar |
|---|---|---|---|
| `POST /signup/start` (5/min) | `{ email }` | `{ challengeId, retryAfter: 45 }` | 403 `SIGNUP_ENABLED=false`; 429 (email uchun 5/soat); 503 SMTP yo‘q (prod) |
| `POST /signup/verify` (10/min) | `{ challengeId, code }` (6 raqam) | `{ signupToken }` | 401 "Kod noto‘g‘ri yoki muddati tugagan" (5 urinishdan so‘ng bloklanadi) |
| `POST /signup/complete` (5/min) | `{ signupToken, name 2–80, storeName 2–80, password 8–200 }` | login bilan bir xil: `{ accessToken, user }` + refresh cookie (mobil: `X-Client: mobile` → `refreshToken` bodyda) | 400 token muddati tugagan; 409 email band; 422 parol = email |
| `POST /code/resend` (5/min) | `{ challengeId }` | `{ ok: true, retryAfter: 45 }` | 429 cooldown (45 s) / 5 ta yuborishdan ko‘p |

- Email band bo‘lsa `start` bo‘sh email bilan **bir xil** javob qaytaradi (kodsiz "hisob mavjud" xati yuboriladi); `verify` doim 401.
- `signupToken` 30 daqiqa amal qiladi va bir marta ishlatiladi.
- Yangi do‘kon bitta tranzaksiyada yaratiladi (`src/stores/tenant-bootstrap.ts`): do‘kon, ombor `MAIN`, kassa `K1`, rollar (owner/deputy/worker; `demo_requests.read`siz), Owner.
- `demo_requests.read` faqat platforma do‘koniga (`PLATFORM_STORE_ID`, bo‘sh bo‘lsa eng birinchi do‘kon) tegishli: `GET /demo-requests` boshqa do‘konlarga 403.
