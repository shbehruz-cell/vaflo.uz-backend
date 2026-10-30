import { Module } from '@nestjs/common';
import { InventoryController } from './inventory.controller.js';
import { InventoryService } from './inventory.service.js';

// StockService (global StockModule) va AuditService (global) shu yerda inject qilinadi.
@Module({
  controllers: [InventoryController],
  providers: [InventoryService],
})
export class InventoryModule {}
