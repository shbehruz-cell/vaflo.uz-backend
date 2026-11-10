import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { PrismaModule } from './prisma/prisma.module.js';
import { AuditModule } from './audit/audit.module.js';
import { StockModule } from './inventory/stock.module.js';
import { AuthGuard } from './common/guards/auth.guard.js';
import { MailModule } from './mail/mail.module.js';
import { AuthModule } from './auth/auth.module.js';
import { UsersModule } from './users/users.module.js';
import { RolesModule } from './roles/roles.module.js';
import { StoresModule } from './stores/stores.module.js';
import { CatalogModule } from './catalog/catalog.module.js';
import { InventoryModule } from './inventory/inventory.module.js';
import { ShiftsModule } from './shifts/shifts.module.js';
import { SalesModule } from './sales/sales.module.js';
import { CustomersModule } from './customers/customers.module.js';
import { ReportsModule } from './reports/reports.module.js';
import { AuditLogModule } from './audit/audit-log.module.js';
import { DemoRequestsModule } from './demo-requests/demo-requests.module.js';
import { HealthModule } from './health/health.module.js';

@Module({
  imports: [
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 120 }]),
    JwtModule.register({
      global: true,
      secret: process.env.JWT_ACCESS_SECRET,
      signOptions: { expiresIn: Number(process.env.JWT_ACCESS_TTL ?? 900) },
    }),
    PrismaModule,
    AuditModule,
    MailModule,
    StockModule,
    AuthModule,
    UsersModule,
    RolesModule,
    StoresModule,
    CatalogModule,
    InventoryModule,
    ShiftsModule,
    SalesModule,
    CustomersModule,
    ReportsModule,
    AuditLogModule,
    DemoRequestsModule,
    HealthModule,
  ],
  providers: [
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
})
export class AppModule {}
