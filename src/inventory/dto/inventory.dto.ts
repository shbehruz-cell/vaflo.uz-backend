import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsDecimal,
  IsEnum,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { StockMovementType } from '../../generated/prisma/client.js';
import { PaginationQuery } from '../../common/pagination.dto.js';

export class BalancesQuery extends PaginationQuery {
  @ApiPropertyOptional() @IsOptional() @IsUUID() warehouseId?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(100) q?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @Transform(({ value }) => (value === 'true' || value === true ? true : value === 'false' || value === false ? false : value))
  @IsBoolean()
  lowStock?: boolean;
}

export class MovementsQuery extends PaginationQuery {
  @ApiPropertyOptional() @IsOptional() @IsUUID() warehouseId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() productId?: string;
  @ApiPropertyOptional({ enum: StockMovementType }) @IsOptional() @IsEnum(StockMovementType) type?: StockMovementType;
  @ApiPropertyOptional() @IsOptional() @IsDateString() dateFrom?: string;
  @ApiPropertyOptional() @IsOptional() @IsDateString() dateTo?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(50) referenceType?: string;
}

export class AdjustmentItemDto {
  @ApiProperty() @IsUUID() productId!: string;
  @ApiProperty({ example: '12.500', description: 'Sanab chiqilgan haqiqiy qoldiq (0 bo‘lishi mumkin)' })
  @IsDecimal({ decimal_digits: '0,3' })
  countedQty!: string;
}

export class CreateAdjustmentDto {
  @ApiProperty() @IsUUID() warehouseId!: string;
  @ApiProperty() @IsString() @MinLength(3) @MaxLength(300) reason!: string;
  @ApiProperty({ type: [AdjustmentItemDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => AdjustmentItemDto)
  items!: AdjustmentItemDto[];
}
