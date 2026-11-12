import { Logger } from '@nestjs/common';

const PLACEHOLDER_SECRETS = new Set(['change-me-access', 'change-me', 'secret', 'jwt-secret', 'dev', 'test']);
const MIN_SECRET_LENGTH = 32;

/**
 * Muhit o‘zgaruvchilarini ishga tushishdan oldin tekshiradi (fail-fast).
 * Production’da zaif JWT siri, DATABASE_URL yo‘qligi kabi holatlarda ilova umuman ko‘tarilmaydi:
 * xato sozlangan server "ishlab turgandek" ko‘rinmasin.
 */
export function validateEnv(env: NodeJS.ProcessEnv = process.env) {
  const log = new Logger('Env');
  const isProd = env.NODE_ENV === 'production';
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!env.DATABASE_URL) errors.push('DATABASE_URL ko‘rsatilmagan');
  else if (isProd && /YOUR_PASSWORD|postgres:postgres@/.test(env.DATABASE_URL)) {
    errors.push('DATABASE_URL da standart/namuna parol ishlatilgan');
  }

  const secret = env.JWT_ACCESS_SECRET ?? '';
  if (!secret) errors.push('JWT_ACCESS_SECRET ko‘rsatilmagan');
  else if (PLACEHOLDER_SECRETS.has(secret) || secret.length < MIN_SECRET_LENGTH) {
    const msg = `JWT_ACCESS_SECRET juda qisqa yoki namunaviy (kamida ${MIN_SECRET_LENGTH} belgi, tasodifiy bo‘lsin: node -e "console.log(require('crypto').randomBytes(48).toString('hex'))")`;
    (isProd ? errors : warnings).push(msg);
  }

  const ttl = Number(env.JWT_ACCESS_TTL ?? 900);
  if (!Number.isFinite(ttl) || ttl <= 0 || ttl > 86_400) errors.push('JWT_ACCESS_TTL 1 dan 86400 soniyagacha bo‘lishi kerak');

  const refreshDays = Number(env.REFRESH_TTL_DAYS ?? 30);
  if (!Number.isFinite(refreshDays) || refreshDays <= 0 || refreshDays > 365) errors.push('REFRESH_TTL_DAYS 1 dan 365 kungacha bo‘lishi kerak');

  if (isProd) {
    if (env.COOKIE_SECURE === 'false') warnings.push('COOKIE_SECURE=false: refresh cookie HTTP orqali ham yuboriladi. HTTPS ulangach olib tashlang');
    if ((env.HOST ?? '0.0.0.0') === '0.0.0.0') warnings.push('HOST=0.0.0.0: API tashqaridan to‘g‘ridan-to‘g‘ri ochiq. Nginx orqasida HOST=127.0.0.1 tavsiya etiladi');
    if (!env.CORS_ORIGINS?.trim()) warnings.push('CORS_ORIGINS bo‘sh: brauzerdan cross-origin so‘rovlar bloklanadi (faqat same-origin rewrite ishlaydi)');
    if (!env.SMTP_HOST) warnings.push('SMTP_HOST bo‘sh: 2 bosqichli kirish, parolni tiklash va ro‘yxatdan o‘tish 503 qaytaradi');
    if (env.AI_PRODUCT_DRAFT_MOCK === '1') warnings.push('AI_PRODUCT_DRAFT_MOCK production’da e’tiborga olinmaydi');
  }

  for (const w of warnings) log.warn(w);
  if (errors.length) {
    for (const e of errors) log.error(e);
    throw new Error(`Muhit sozlamalari noto‘g‘ri: ${errors.join('; ')}`);
  }
}
