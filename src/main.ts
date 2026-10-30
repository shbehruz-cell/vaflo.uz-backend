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

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bodyParser: false });
  // Mahsulot importi (5000 qatorgacha) sig‘ishi uchun 5mb.
  app.useBodyParser('json', { limit: '5mb' });
  app.useBodyParser('urlencoded', { extended: false, limit: '1mb' });
  const isProd = process.env.NODE_ENV === 'production';

  app.set('trust proxy', 1);
  app.use(requestId);
  app.use(helmet());
  app.use(cookieParser());
  app.enableCors({
    origin: (process.env.CORS_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    credentials: true,
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
  await app.listen(port);
  Logger.log(`API: http://localhost:${port}/api/v1${isProd ? '' : `  •  Docs: http://localhost:${port}/api/docs`}`, 'Bootstrap');
}
await bootstrap();
