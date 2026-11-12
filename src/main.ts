import 'dotenv/config';
import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { AppModule } from './app.module.js';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter.js';
import { requestId } from './common/request-id.middleware.js';
import { validateEnv } from './config/env.js';

async function bootstrap() {
  // Zaif/yo‘q sozlamalar bilan (masalan namunaviy JWT siri) production ko‘tarilmaydi.
  validateEnv();
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bodyParser: false });
  // Mahsulot importi (5000 qatorgacha) sig‘ishi uchun 5mb.
  app.useBodyParser('json', { limit: '5mb' });
  app.useBodyParser('urlencoded', { extended: false, limit: '1mb' });
  const isProd = process.env.NODE_ENV === 'production';

  app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use(requestId);
  app.use(
    helmet({
      // JSON API: brauzerga hech qanday skript/ifreym yuklash kerak emas
      contentSecurityPolicy: {
        useDefaults: false,
        directives: { 'default-src': ["'none'"], 'frame-ancestors': ["'none'"], 'base-uri': ["'none'"], 'form-action': ["'none'"] },
      },
      crossOriginResourcePolicy: { policy: 'same-site' },
      referrerPolicy: { policy: 'no-referrer' },
      hsts: isProd ? { maxAge: 15_552_000, includeSubDomains: true } : false,
    }),
  );
  // API javoblari keshlanmasin (token/shaxsiy ma’lumotlar brauzer yoki proksi keshida qolmasin)
  app.use((_req: unknown, res: { setHeader: (k: string, v: string) => void }, next: () => void) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  app.use(cookieParser());
  const corsOrigins = (process.env.CORS_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  app.enableCors({
    // Ro‘yxat bo‘sh bo‘lsa cross-origin so‘rovlar umuman ruxsat etilmaydi (`false`), '*' hech qachon ishlatilmaydi
    origin: corsOrigins.length ? corsOrigins : false,
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-Id', 'X-Client', 'X-Device'],
    maxAge: 600,
  });
  app.setGlobalPrefix('api/v1');
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
  );
  app.useGlobalFilters(new AllExceptionsFilter());
  app.enableShutdownHooks();

  if (!isProd) {
    const config = new DocumentBuilder()
      .setTitle('VAFLO.UZ API')
      .setDescription('POS + CRM + Ombor boshqaruv platformasi')
      .setVersion('1.0')
      .addBearerAuth()
      .build();
    SwaggerModule.setup('api/docs', app, SwaggerModule.createDocument(app, config));
  }

  const port = Number(process.env.PORT ?? 4000);
  // HOST=127.0.0.1 — API faqat server ichidan (nginx/frontend orqali) ochiladi
  await app.listen(port, process.env.HOST ?? '0.0.0.0');
  // Sekin so‘rovlar (slowloris) va ochiq qolgan ulanishlarga qarshi muddatlar
  const server = app.getHttpServer() as import('node:http').Server;
  server.headersTimeout = 30_000;
  server.requestTimeout = 120_000; // AI qoralama 90 s gacha ishlashi mumkin
  server.keepAliveTimeout = 65_000; // nginx keepalive (60 s) dan uzunroq bo‘lsin
  Logger.log(`API: http://localhost:${port}/api/v1${isProd ? '' : `  •  Docs: http://localhost:${port}/api/docs`}`, 'Bootstrap');
}
await bootstrap();
