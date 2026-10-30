/** Telefonni +998XXXXXXXXX ko‘rinishiga keltiradi; yaroqsiz bo‘lsa null. */
export function normalizePhone(input: string): string | null {
  const digits = input.replace(/\D/g, '');
  const local = digits.startsWith('998') ? digits.slice(3) : digits;
  return local.length === 9 ? `+998${local}` : null;
}

/** Qidiruv uchun nomni normalizatsiya qilish. */
export function normalizeName(input: string) {
  return input.trim().toLowerCase().replace(/[‘’`ʻʼ]/g, "'").replace(/\s+/g, ' ');
}

/** Login: email bo‘lsa lower-case, telefon bo‘lsa +998... */
export function normalizeLogin(input: string) {
  const v = input.trim();
  return v.includes('@') ? v.toLowerCase() : (normalizePhone(v) ?? v);
}
