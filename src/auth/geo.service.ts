import { Injectable, Logger } from '@nestjs/common';
import { isIP } from 'node:net';

export interface GeoResult {
  city: string | null;
  country: string | null;
  latitude: number;
  longitude: number;
}

const PRIVATE = /^(::1|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|fc|fd|::ffff:(127|10|192\.168)\.)/i;

/**
 * IP manzil bo‘yicha taxminiy joylashuv (shahar darajasida) — "Faol sessiyalar" xaritasi uchun.
 * Tashqi bepul xizmat (ipwho.is) ishlatiladi; xato bo‘lsa yoki IP ichki bo‘lsa null qaytadi va login to‘xtamaydi.
 */
@Injectable()
export class GeoService {
  private readonly log = new Logger(GeoService.name);

  async locate(ip?: string | null): Promise<GeoResult | null> {
    // GEO_LOOKUP=false — foydalanuvchi IP’lari tashqi xizmatga umuman yuborilmaydi
    if (process.env.GEO_LOOKUP === 'false') return null;
    if (!ip || !isIP(ip.replace(/^::ffff:/i, '')) || PRIVATE.test(ip.replace(/^::ffff:/i, ''))) return null;
    try {
      const res = await fetch(`https://ipwho.is/${encodeURIComponent(ip)}?fields=success,city,country,latitude,longitude`, {
        signal: AbortSignal.timeout(3000),
      });
      const d = (await res.json()) as { success?: boolean; city?: string; country?: string; latitude?: number; longitude?: number };
      if (!d.success || typeof d.latitude !== 'number' || typeof d.longitude !== 'number') return null;
      return { city: d.city ?? null, country: d.country ?? null, latitude: d.latitude, longitude: d.longitude };
    } catch (err) {
      this.log.warn(`Joylashuv aniqlanmadi: ${(err as Error).message}`);
      return null;
    }
  }
}
