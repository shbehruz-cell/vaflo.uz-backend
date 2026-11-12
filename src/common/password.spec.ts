import { describe, expect, it } from 'vitest';
import { passwordProblem } from './password.js';

describe('passwordProblem', () => {
  it('kuchli parolni qabul qiladi', () => {
    expect(passwordProblem('Qishloq2026')).toBeNull();
    expect(passwordProblem('do‘kon-kassa-77')).toBeNull();
  });
  it('qisqa parolni rad etadi', () => {
    expect(passwordProblem('abc1234')).toMatch(/kamida 8/);
  });
  it('faqat harf yoki faqat raqamni rad etadi', () => {
    expect(passwordProblem('abcdefgh')).toMatch(/harf va bitta raqam/);
    expect(passwordProblem('12345678')).not.toBeNull();
  });
  it('takror va keng tarqalgan parollarni rad etadi', () => {
    expect(passwordProblem('aaaaaaaa')).not.toBeNull();
    expect(passwordProblem('Password123')).toMatch(/keng tarqalgan/);
  });
  it('login bilan bir xil parolni rad etadi', () => {
    expect(passwordProblem('owner@vaflo.uz1', 'owner@vaflo.uz')).toMatch(/login yoki email/);
    expect(passwordProblem('bekzod2026x', 'bekzod@mail.uz')).toMatch(/login yoki email/);
    expect(passwordProblem('Qishloq2026', 'bekzod@mail.uz')).toBeNull();
  });
});
