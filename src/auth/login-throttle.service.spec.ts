import { describe, expect, it } from 'vitest';
import { HttpException } from '@nestjs/common';
import { LoginThrottleService } from './login-throttle.service.js';

function make() {
  let t = 1_000_000;
  const svc = new LoginThrottleService({ windowMs: 60_000, maxPerLogin: 3, maxPerIp: 5 }, () => t);
  return { svc, tick: (ms: number) => (t += ms) };
}

describe('LoginThrottleService', () => {
  it('limitgacha ruxsat beradi, keyin 429', () => {
    const { svc } = make();
    for (let i = 0; i < 3; i++) {
      svc.assertAllowed('a@x.uz', '1.1.1.1');
      svc.recordFailure('a@x.uz', '1.1.1.1');
    }
    expect(() => svc.assertAllowed('a@x.uz', '9.9.9.9')).toThrow(HttpException);
    // boshqa login shu IP’dan hali ruxsat etiladi (IP limiti 5)
    expect(() => svc.assertAllowed('b@x.uz', '1.1.1.1')).not.toThrow();
  });

  it('oyna tugagach qayta ruxsat beradi', () => {
    const { svc, tick } = make();
    for (let i = 0; i < 3; i++) svc.recordFailure('a@x.uz', '1.1.1.1');
    expect(() => svc.assertAllowed('a@x.uz')).toThrow();
    tick(60_001);
    expect(() => svc.assertAllowed('a@x.uz')).not.toThrow();
  });

  it('muvaffaqiyatli kirish login hisoblagichini tozalaydi', () => {
    const { svc } = make();
    for (let i = 0; i < 3; i++) svc.recordFailure('a@x.uz', '1.1.1.1');
    svc.recordSuccess('a@x.uz');
    expect(() => svc.assertAllowed('a@x.uz')).not.toThrow();
  });

  it('IP bo‘yicha ko‘p loginlarni bloklaydi', () => {
    const { svc } = make();
    for (let i = 0; i < 5; i++) svc.recordFailure(`u${i}@x.uz`, '2.2.2.2');
    expect(() => svc.assertAllowed('new@x.uz', '2.2.2.2')).toThrow(HttpException);
  });
});
