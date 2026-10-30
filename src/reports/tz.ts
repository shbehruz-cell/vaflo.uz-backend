/**
 * Do‘kon vaqt zonasi bo‘yicha sana chegaralari.
 *
 * Yondashuv: DB'da createdAt UTC `timestamp` (zonasiz) sifatida saqlanadi. Hisobot davri
 * do‘kon zonasidagi kunlar (YYYY-MM-DD) bilan beriladi; JS'da Intl orqali har bir mahalliy
 * yarim tun UTC lahzasiga o‘giriladi (DST'ni hisobga olgan holda) va SQL'ga parametr sifatida
 * `[from, to)` oralig‘i uzatiladi. Kunlar bo‘yicha guruhlash SQL'da
 * `(createdAt AT TIME ZONE 'UTC') AT TIME ZONE <tz>` orqali bajariladi.
 */
export const DEFAULT_TZ = 'Asia/Tashkent';

export interface YMD {
  y: number;
  m: number; // 1..12
  d: number;
}

export function isValidTimezone(tz: string) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function parts(ms: number, tz: string) {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const o: Record<string, number> = {};
  for (const p of f.formatToParts(new Date(ms))) if (p.type !== 'literal') o[p.type] = Number(p.value);
  return o;
}

/** Berilgan lahzadagi zona offseti (ms): local - UTC. */
function offsetMs(ms: number, tz: string) {
  const o = parts(ms, tz);
  const asUtc = Date.UTC(o.year!, o.month! - 1, o.day!, o.hour!, o.minute!, o.second!);
  return asUtc - Math.floor(ms / 1000) * 1000;
}

/** Mahalliy kunning 00:00 lahzasi (UTC Date). */
export function localMidnightUtc({ y, m, d }: YMD, tz: string): Date {
  const guess = Date.UTC(y, m - 1, d);
  let t = guess - offsetMs(guess, tz);
  t = guess - offsetMs(t, tz); // DST chegarasi uchun ikkinchi yaqinlashuv
  return new Date(t);
}

export function todayIn(tz: string, now = new Date()): YMD {
  const o = parts(now.getTime(), tz);
  return { y: o.year!, m: o.month!, d: o.day! };
}

export function addDays(v: YMD, n: number): YMD {
  const dt = new Date(Date.UTC(v.y, v.m - 1, v.d + n));
  return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() };
}

export function parseYmd(s: string): YMD {
  const [y, m, d] = s.slice(0, 10).split('-').map(Number);
  return { y: y!, m: m!, d: d! };
}

export const ymdKey = (v: YMD) => `${v.y}-${String(v.m).padStart(2, '0')}-${String(v.d).padStart(2, '0')}`;
export const dayDiff = (a: YMD, b: YMD) => Math.round((Date.UTC(b.y, b.m - 1, b.d) - Date.UTC(a.y, a.m - 1, a.d)) / 86_400_000);

/** SQL `::timestamp` uchun zonasiz UTC matn. */
export const sqlTs = (d: Date) => d.toISOString().slice(0, 19).replace('T', ' ');
