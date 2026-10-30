import { Module } from '@nestjs/common';
import { ShiftsModule } from '../shifts/shifts.module.js';
import { SalesController } from './sales.controller.js';
import { SalesService } from './sales.service.js';

@Module({
  imports: [ShiftsModule],
  controllers: [SalesController],
  providers: [SalesService],
})
export class SalesModule {}
