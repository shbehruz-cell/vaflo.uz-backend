import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import nodemailer, { type Transporter } from 'nodemailer';

export type CodePurpose = 'login' | 'reset' | 'signup';

const COPY: Record<CodePurpose, { subject: string; title: string; lead: string }> = {
  login: {
    subject: 'Vaflo: kirish tasdiqlash kodi',
    title: 'Kirishni tasdiqlang',
    lead: 'Hisobingizga kirish uchun quyidagi koddan foydalaning.',
  },
  reset: {
    subject: 'Vaflo: parolni tiklash kodi',
    title: 'Parolni tiklash',
    lead: 'Parolni tiklash uchun quyidagi koddan foydalaning.',
  },
  signup: {
    subject: 'Vaflo: Ro‘yxatdan o‘tishni tasdiqlang',
    title: 'Ro‘yxatdan o‘tishni tasdiqlang',
    lead: 'Vaflo’da do‘kon ochish uchun emailingizni quyidagi kod bilan tasdiqlang.',
  },
};

/** Email allaqachon ro‘yxatdan o‘tgan bo‘lsa yuboriladi (kodsiz): ro‘yxatdan o‘tish formasi bu holatni oshkor qilmaydi. */
const EXISTS_COPY = {
  subject: 'Vaflo: hisobingiz allaqachon mavjud',
  title: 'Hisobingiz allaqachon mavjud',
  lead: 'Bu email bilan Vaflo’da hisob ochilgan, shuning uchun qayta ro‘yxatdan o‘tish shart emas: tizimga kiring. Parolni unutgan bo‘lsangiz, kirish sahifasidagi “Parolni unutdingizmi?” orqali tiklang. Buni siz so‘ramagan bo‘lsangiz, xatni e’tiborsiz qoldiring.',
};

/**
 * Email yuborish (SMTP). Sozlamalar `.env` da: SMTP_HOST, SMTP_PORT, SMTP_SECURE, SMTP_USER, SMTP_PASS, MAIL_FROM.
 * SMTP sozlanmagan bo‘lsa: development'da kod logga chiqadi, production'da xizmat 503 qaytaradi.
 */
@Injectable()
export class MailService {
  private readonly log = new Logger(MailService.name);
  private transporter?: Transporter;

  private get configured() {
    return Boolean(process.env.SMTP_HOST);
  }

  private getTransporter() {
    this.transporter ??= nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT ?? 587),
      secure: process.env.SMTP_SECURE === 'true',
      auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
    });
    return this.transporter;
  }

  async sendCode(to: string, code: string, purpose: CodePurpose, ttlMinutes: number) {
    const copy = COPY[purpose];
    if (!this.configured) {
      if (process.env.NODE_ENV === 'production') {
        this.log.error('SMTP sozlanmagan (SMTP_HOST yo‘q): kod yuborilmadi');
        throw new ServiceUnavailableException('Email xizmati hozircha sozlanmagan');
      }
      this.log.warn(`[DEV] ${purpose} kodi → ${to}: ${code}`);
      return;
    }
    try {
      await this.getTransporter().sendMail({
        from: process.env.MAIL_FROM ?? process.env.SMTP_USER,
        to,
        subject: copy.subject,
        text: `${copy.title}\n\n${copy.lead}\n\nKod: ${code}\n\nKod ${ttlMinutes} daqiqa amal qiladi. Buni siz so‘ramagan bo‘lsangiz, xatni e’tiborsiz qoldiring.`,
        html: this.html(copy, code, ttlMinutes),
      });
    } catch (err) {
      this.log.error(`Email yuborilmadi: ${(err as Error).message}`);
      throw new ServiceUnavailableException('Emailni yuborib bo‘lmadi. Birozdan so‘ng qayta urinib ko‘ring');
    }
  }

  async sendExists(to: string) {
    if (!this.configured) {
      if (process.env.NODE_ENV === 'production') {
        this.log.error('SMTP sozlanmagan (SMTP_HOST yo‘q): xat yuborilmadi');
        throw new ServiceUnavailableException('Email xizmati hozircha sozlanmagan');
      }
      this.log.warn(`[DEV] signup: ${to} uchun hisob allaqachon mavjud (kod yuborilmadi)`);
      return;
    }
    try {
      await this.getTransporter().sendMail({
        from: process.env.MAIL_FROM ?? process.env.SMTP_USER,
        to,
        subject: EXISTS_COPY.subject,
        text: `${EXISTS_COPY.title}\n\n${EXISTS_COPY.lead}`,
        html: this.html(EXISTS_COPY, null, 0),
      });
    } catch (err) {
      this.log.error(`Email yuborilmadi: ${(err as Error).message}`);
      throw new ServiceUnavailableException('Emailni yuborib bo‘lmadi. Birozdan so‘ng qayta urinib ko‘ring');
    }
  }

  private html(copy: { title: string; lead: string }, code: string | null, ttl: number) {
    const digits = (code ?? '')
      .split('')
      .map(
        (d) =>
          `<td style="width:46px;height:56px;text-align:center;font:700 26px -apple-system,Segoe UI,Roboto,sans-serif;color:#16131C;background:#F1EAFF;border-radius:12px">${d}</td><td style="width:8px"></td>`,
      )
      .join('');
    return `<!doctype html><html><body style="margin:0;background:#F5F3F8;padding:32px 16px;font-family:-apple-system,Segoe UI,Roboto,sans-serif">
<table role="presentation" align="center" width="100%" style="max-width:460px;background:#fff;border-radius:24px;padding:32px">
<tr><td style="font:800 22px -apple-system,Segoe UI,sans-serif;color:#6D28E8;padding-bottom:20px">vaflo</td></tr>
<tr><td style="font:700 24px -apple-system,Segoe UI,sans-serif;color:#16131C;padding-bottom:8px">${copy.title}</td></tr>
<tr><td style="font:400 15px/22px -apple-system,Segoe UI,sans-serif;color:#7A7483;padding-bottom:24px">${copy.lead}</td></tr>
${code ? `<tr><td><table role="presentation"><tr>${digits}</tr></table></td></tr>
<tr><td style="font:400 13px/20px -apple-system,Segoe UI,sans-serif;color:#7A7483;padding-top:24px">Kod ${ttl} daqiqa amal qiladi. Buni siz so‘ramagan bo‘lsangiz, xatni e’tiborsiz qoldiring va hech kimga kodni aytmang.</td></tr>` : ''}
</table></body></html>`;
  }
}
