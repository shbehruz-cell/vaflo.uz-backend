import { HttpException, HttpStatus, Injectable } from '@nestjs/common';

/**
 * Hisob bo‘yicha brute-force himoyasi (IP bo‘yicha ThrottlerGuard’ga qo‘shimcha).
 * Bitta loginga ko‘p IP’dan parol terib ko‘rishni ham, bitta IP’dan ko‘p loginni ham cheklaydi.
 * Xotirada saqlanadi (bitta instans); qayta ishga tushganda tozalanadi — bu maqbul,
 * chunki asosiy maqsad lug‘at hujumini sekinlashtirish.
 */
export interface LoginThrottleOptions {
  windowMs: number;
  maxPerLogin: number;
  maxPerIp: number;
}

interface Bucket {
  count: number;
  firstAt: number;
}

export const DEFAULT_LOGIN_THROTTLE: LoginThrottleOptions = {
  windowMs: 15 * 60_000,
  maxPerLogin: 10,
  maxPerIp: 50,
};

@Injectable()
export class LoginThrottleService {
  private readonly buckets = new Map<string, Bucket>();
  private lastSweep = Date.now();
  // Konstruktor parametrsiz: Nest DI ixtiyoriy parametrlarni ham provider deb qidiradi.
  private opts: LoginThrottleOptions = DEFAULT_LOGIN_THROTTLE;
  private now: () => number = Date.now;

  /** Testlar uchun: boshqa limitlar va soat bilan nusxa. */
  static create(opts: LoginThrottleOptions, now: () => number = Date.now) {
    const s = new LoginThrottleService();
    s.opts = opts;
    s.now = now;
    s.lastSweep = now();
    return s;
  }

  /** Urinishdan OLDIN: limit oshgan bo‘lsa 429 (parol tekshirilmaydi, argon2 ham sarflanmaydi). */
  assertAllowed(login: string, ip?: string | null) {
    this.sweep();
    const l = this.get(`l:${login}`);
    const i = ip ? this.get(`i:${ip}`) : null;
    const blockedUntil = Math.max(
      l && l.count >= this.opts.maxPerLogin ? l.firstAt + this.opts.windowMs : 0,
      i && i.count >= this.opts.maxPerIp ? i.firstAt + this.opts.windowMs : 0,
    );
    if (blockedUntil > this.now()) {
      const sec = Math.ceil((blockedUntil - this.now()) / 1000);
      throw new HttpException(`Juda ko‘p muvaffaqiyatsiz urinish. ${Math.ceil(sec / 60)} daqiqadan so‘ng qayta urinib ko‘ring`, HttpStatus.TOO_MANY_REQUESTS);
    }
  }

  recordFailure(login: string, ip?: string | null) {
    this.bump(`l:${login}`);
    if (ip) this.bump(`i:${ip}`);
  }

  /** Muvaffaqiyatli kirishda shu login uchun hisoblagich tozalanadi (IP hisoblagichi qoladi). */
  recordSuccess(login: string) {
    this.buckets.delete(`l:${login}`);
  }

  private get(key: string): Bucket | null {
    const b = this.buckets.get(key);
    if (!b) return null;
    if (b.firstAt + this.opts.windowMs <= this.now()) {
      this.buckets.delete(key);
      return null;
    }
    return b;
  }

  private bump(key: string) {
    const b = this.get(key);
    if (b) b.count++;
    else this.buckets.set(key, { count: 1, firstAt: this.now() });
  }

  /** Eskirgan yozuvlarni vaqti-vaqti bilan tozalash (xotira o‘smasin). */
  private sweep() {
    const t = this.now();
    if (t - this.lastSweep < 60_000 && this.buckets.size < 50_000) return;
    this.lastSweep = t;
    for (const [k, b] of this.buckets) if (b.firstAt + this.opts.windowMs <= t) this.buckets.delete(k);
  }
}
