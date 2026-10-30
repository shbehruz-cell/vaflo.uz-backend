import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize, ArrayMinSize, IsArray, IsDateString, IsDecimal, IsEnum, IsIn, IsOptional, IsString, IsUUID,
  Matches, MaxLength, MinLength, ValidateNested,
} from 'class-validator';
import { CardType, PaymentMethod, RefundDisposition, SaleStatus } from '../../generated/prisma/client.js';
import { PaginationQuery } from '../../common/pagination.dto.js';

const numToStr = ({ value }: { value: unknown }) => (typeof value === 'number' ? String(value) : value);

export class SaleItemDto {
  @ApiProperty() @IsUUID() productId!: string;

  @ApiProperty({ example: '2' })
  @Transform(numToStr)
  @IsDecimal({ decimal_digits: '0,3' }, { message: 'Miqdor noto‘g‘ri' })
  qty!: string;

  @ApiPropertyOptional({ example: '1000.00', description: 'Satr chegirmasi (summa)' })
  @IsOptional()
  @Transform(numToStr)
  @IsDecimal({ decimal_digits: '0,2' }, { message: 'Chegirma noto‘g‘ri' })
  discount?: string;
}

export class SalePaymentDto {
  @ApiProperty({ enum: PaymentMethod }) @IsEnum(PaymentMethod) method!: PaymentMethod;

  @ApiProperty({ example: '25000.00' })
  @Transform(numToStr)
  @IsDecimal({ decimal_digits: '0,2' }, { message: 'To‘lov summasi noto‘g‘ri' })
  amount!: string;

  @ApiPropertyOptional({ description: 'Naqd: qabul qilingan summa' })
  @IsOptional()
  @Transform(numToStr)
  @IsDecimal({ decimal_digits: '0,2' }, { message: 'Qabul qilingan summa noto‘g‘ri' })
  tendered?: string;

  @ApiPropertyOptional({ enum: CardType, description: 'Karta: Uzcard, Humo, Visa... (faqat qayd)' })
  @IsOptional() @IsEnum(CardType, { message: 'Karta turi noto‘g‘ri' })
  cardType?: CardType;

  @ApiPropertyOptional({ description: 'Karta: terminal chek raqami (ixtiyoriy). Karta raqami YUBORILMAYDI.' })
  @IsOptional() @IsString() @MaxLength(32) @Matches(/^[\w-]+$/, { message: 'Terminal chek raqamida faqat harf, raqam va "-" bo‘lsin' })
  externalReference?: string;
}

export class CreateSaleDto {
  @ApiProperty({ description: 'Klient generatsiya qilgan UUID (qayta yuborishdan himoya)' })
  @IsUUID() idempotencyKey!: string;

  @ApiPropertyOptional() @IsOptional() @IsUUID() customerId?: string;

  @ApiProperty({ type: [SaleItemDto] })
  @IsArray() @ArrayMinSize(1, { message: 'Kamida bitta mahsulot kerak' }) @ArrayMaxSize(500)
  @ValidateNested({ each: true }) @Type(() => SaleItemDto)
  items!: SaleItemDto[];

  @ApiProperty({ type: [SalePaymentDto] })
  @IsArray() @ArrayMinSize(1, { message: 'Kamida bitta to‘lov kerak' }) @ArrayMaxSize(10)
  @ValidateNested({ each: true }) @Type(() => SalePaymentDto)
  payments!: SalePaymentDto[];
}

export class RefundItemDto {
  @ApiProperty() @IsUUID() saleItemId!: string;

  @ApiProperty({ example: '1' })
  @Transform(numToStr)
  @IsDecimal({ decimal_digits: '0,3' }, { message: 'Miqdor noto‘g‘ri' })
  qty!: string;
}

export class CreateRefundDto {
  @ApiProperty() @IsString() @MinLength(3, { message: 'Sabab kamida 3 belgi' }) @MaxLength(300) reason!: string;
  @ApiProperty({ enum: RefundDisposition }) @IsEnum(RefundDisposition) disposition!: RefundDisposition;
  @ApiProperty({ enum: PaymentMethod }) @IsEnum(PaymentMethod) method!: PaymentMethod;

  @ApiProperty({ type: [RefundItemDto] })
  @IsArray() @ArrayMinSize(1, { message: 'Kamida bitta satr kerak' }) @ArrayMaxSize(500)
  @ValidateNested({ each: true }) @Type(() => RefundItemDto)
  items!: RefundItemDto[];
}

export class VoidSaleDto {
  @ApiProperty() @IsString() @MinLength(3, { message: 'Sabab kamida 3 belgi' }) @MaxLength(300) reason!: string;
}

export class ListSalesQuery extends PaginationQuery {
  @ApiPropertyOptional() @IsOptional() @IsDateString() dateFrom?: string;
  @ApiPropertyOptional() @IsOptional() @IsDateString() dateTo?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(50) receiptNo?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() cashierId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() customerId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() productId?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(100) barcode?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() registerId?: string;
  @ApiPropertyOptional({ enum: PaymentMethod }) @IsOptional() @IsEnum(PaymentMethod) paymentMethod?: PaymentMethod;
  @ApiPropertyOptional({ enum: SaleStatus }) @IsOptional() @IsEnum(SaleStatus) status?: SaleStatus;
  @ApiPropertyOptional({ enum: ['createdAt', 'total'] }) @IsOptional() @IsIn(['createdAt', 'total']) sortBy?: 'createdAt' | 'total';
  @ApiPropertyOptional({ enum: ['asc', 'desc'] }) @IsOptional() @IsIn(['asc', 'desc']) sortDir?: 'asc' | 'desc';
}
