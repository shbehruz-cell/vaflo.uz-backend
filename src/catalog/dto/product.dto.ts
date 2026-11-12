import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsDecimal,
  IsEnum,
  IsIn,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { Unit } from '../../generated/prisma/client.js';
import { PaginationQuery } from '../../common/pagination.dto.js';

const toBool = ({ value }: { value: unknown }) =>
  value === 'true' || value === true ? true : value === 'false' || value === false ? false : value;

export class ListProductsQuery extends PaginationQuery {
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(100) q?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() categoryId?: string;
  @ApiPropertyOptional() @IsOptional() @Transform(toBool) @IsBoolean() isActive?: boolean;
  @ApiPropertyOptional() @IsOptional() @Transform(toBool) @IsBoolean() lowStock?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsUUID() warehouseId?: string;
  @ApiPropertyOptional({ enum: ['name', 'salePrice', 'createdAt'] })
  @IsOptional()
  @IsIn(['name', 'salePrice', 'createdAt'])
  sortBy: 'name' | 'salePrice' | 'createdAt' = 'name';
  @ApiPropertyOptional({ enum: ['asc', 'desc'] })
  @IsOptional()
  @IsIn(['asc', 'desc'])
  sortDir: 'asc' | 'desc' = 'asc';
}

export class LookupQuery {
  @ApiProperty() @IsString() @IsNotEmpty() @MaxLength(64) barcode!: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() warehouseId?: string;
}

export class CreateProductDto {
  @ApiProperty() @IsString() @IsNotEmpty() @MaxLength(200) name!: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(64) sku?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() categoryId?: string;
  @ApiProperty({ enum: Unit }) @IsEnum(Unit) unit!: Unit;
  @ApiProperty({ example: '12500.00' }) @IsDecimal({ decimal_digits: '0,2' }) salePrice!: string;
  @ApiPropertyOptional() @IsOptional() @IsDecimal({ decimal_digits: '0,2' }) costPrice?: string;
  @ApiPropertyOptional() @IsOptional() @IsDecimal({ decimal_digits: '0,3' }) minStock?: string;
  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @IsNotEmpty({ each: true })
  @MaxLength(64, { each: true })
  barcodes?: string[];
  @ApiPropertyOptional() @IsOptional() @IsDecimal({ decimal_digits: '0,3' }) initialQty?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() warehouseId?: string;
}

export class UpdateProductDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @IsNotEmpty() @MaxLength(200) name?: string;
  /** O‘lchov birligi. Butun sonli birlikka (dona/quti) o‘tishda qoldiq va minimal qoldiq butun bo‘lishi shart. */
  @ApiPropertyOptional({ enum: Unit }) @IsOptional() @IsEnum(Unit) unit?: Unit;
  /** null — SKU ni olib tashlash. */
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(64) sku?: string | null;
  /** null — kategoriyadan chiqarish. */
  @ApiPropertyOptional() @IsOptional() @IsUUID() categoryId?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsDecimal({ decimal_digits: '0,2' }) salePrice?: string;
  @ApiPropertyOptional() @IsOptional() @IsDecimal({ decimal_digits: '0,2' }) costPrice?: string;
  @ApiPropertyOptional() @IsOptional() @IsDecimal({ decimal_digits: '0,3' }) minStock?: string;
  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @IsNotEmpty({ each: true })
  @MaxLength(64, { each: true })
  barcodes?: string[];
}

export class ImportMappingDto {
  @ApiProperty() @IsString() @IsNotEmpty() name!: string;
  @ApiPropertyOptional() @IsOptional() @IsString() sku?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() barcode?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() category?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() unit?: string;
  @ApiProperty() @IsString() @IsNotEmpty() salePrice!: string;
  @ApiPropertyOptional() @IsOptional() @IsString() costPrice?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() qty?: string;
}

export class ImportBodyDto {
  @ApiProperty({ description: 'Frontend parse qilgan qatorlar (ustun nomi -> qiymat)' })
  @IsArray()
  @ArrayMaxSize(5000, { message: 'Bir faylda ko‘pi bilan 5000 qator bo‘lishi mumkin' })
  @IsObject({ each: true })
  rows!: Array<Record<string, unknown>>;

  @ApiProperty({ type: ImportMappingDto })
  @ValidateNested()
  @Type(() => ImportMappingDto)
  mapping!: ImportMappingDto;

  @ApiPropertyOptional({ description: 'Boshlang‘ich qoldiq kiritiladigan ombor (default: birinchi faol ombor)' })
  @IsOptional()
  @IsUUID()
  warehouseId?: string;
}
