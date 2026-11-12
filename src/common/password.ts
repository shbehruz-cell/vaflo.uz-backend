import { registerDecorator, type ValidationArguments, type ValidationOptions } from 'class-validator';

export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 200;

/** Eng ko‘p uchraydigan parollar (kichik ro‘yxat; lug‘at hujumining birinchi urinishlari). */
const COMMON = new Set([
  'password', 'password1', 'password123', 'passw0rd', '12345678', '123456789', '1234567890', '123123123',
  'qwerty123', 'qwertyuiop', 'qwerty12345', '11111111', '00000000', 'iloveyou', 'admin123', 'admin1234',
  'welcome1', 'letmein1', 'abc12345', 'football', 'baseball', 'sunshine', 'princess', 'superman',
  'parol123', 'parol1234', 'toshkent1', 'uzbekistan', 'samarkand', 'vaflo123', 'vaflo1234', 'owner123',
]);

/**
 * Parol siyosati (TZ 15): kamida 8 belgi, harf VA raqam, oddiy lug‘at parollari emas,
 * bitta belgi takrori emas, login/email bilan bir xil emas.
 * Xato bo‘lsa sabab matni, to‘g‘ri bo‘lsa null qaytadi.
 */
export function passwordProblem(password: string, login?: string | null): string | null {
  if (typeof password !== 'string') return 'Parol matn bo‘lishi kerak';
  if (password.length < PASSWORD_MIN) return `Parol kamida ${PASSWORD_MIN} ta belgidan iborat bo‘lishi kerak`;
  if (password.length > PASSWORD_MAX) return `Parol ${PASSWORD_MAX} belgidan oshmasligi kerak`;
  if (!/\p{L}/u.test(password) || !/\d/.test(password)) return 'Parolda kamida bitta harf va bitta raqam bo‘lishi kerak';
  if (/^(.)\1+$/.test(password)) return 'Parol bitta belgining takroridan iborat bo‘lmasligi kerak';
  const lower = password.toLowerCase();
  if (COMMON.has(lower)) return 'Bu parol juda keng tarqalgan. Boshqasini tanlang';
  if (login) {
    const l = login.trim().toLowerCase();
    const local = l.includes('@') ? l.split('@')[0]! : l;
    if (lower === l || (local.length >= 4 && lower.includes(local))) return 'Parol login yoki email bilan bir xil bo‘lmasligi kerak';
  }
  return null;
}

/** DTO dekoratori: `@IsStrongPassword()` — passwordProblem() qoidalarini tekshiradi. */
export function IsStrongPassword(options?: ValidationOptions) {
  return (object: object, propertyName: string) => {
    registerDecorator({
      name: 'isStrongPassword',
      target: object.constructor,
      propertyName,
      options,
      validator: {
        validate(value: unknown) {
          return typeof value === 'string' && passwordProblem(value) === null;
        },
        defaultMessage(args: ValidationArguments) {
          const v = args.value;
          return (typeof v === 'string' ? passwordProblem(v) : null) ?? 'Parol talablarga javob bermaydi';
        },
      },
    });
  };
}
