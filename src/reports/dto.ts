import { Type } from 'class-transformer';
import { IsDateString, IsIn, IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

export const PRESETS = ['today', 'yesterday', 'week', 'month', 'year', 'custom'] as const;
export type Preset = (typeof PRESETS)[number];

export class ReportQuery {
  @ApiPropertyOptional({ enum: PRESETS, default: 'today' }) @IsOptional() @IsIn(PRESETS) preset: Preset = 'today';
  /** custom uchun: YYYY-MM-DD (do‘kon vaqti bo‘yicha, ikkala chegara ham kiradi) */
  @ApiPropertyOptional() @IsOptional() @IsDateString() dateFrom?: string;
  @ApiPropertyOptional() @IsOptional() @IsDateString() dateTo?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() cashierId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() registerId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() categoryId?: string;
  @ApiPropertyOptional({ enum: ['CASH', 'CARD'] }) @IsOptional() @IsIn(['CASH', 'CARD']) paymentMethod?: 'CASH' | 'CARD';
}

export class TopProductsQuery extends ReportQuery {
  @ApiPropertyOptional({ default: 10 }) @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit: number = 10;
}

export class LowStockQuery {
  @ApiPropertyOptional() @IsOptional() @IsUUID() warehouseId?: string;
}
