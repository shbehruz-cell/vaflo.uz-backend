import { Module } from '@nestjs/common';
import { ShiftsController } from './shifts.controller.js';
import { ShiftsService } from './shifts.service.js';

@Module({
  controllers: [ShiftsController],
  providers: [ShiftsService],
  exports: [ShiftsService],
})
export class ShiftsModule {}
