import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsDateString, IsDecimal, IsEnum, IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';
import { CashMovementType, ShiftStatus } from '../../generated/prisma/client.js';
import { PaginationQuery } from '../../common/pagination.dto.js';

const numToStr = ({ value }: { value: unknown }) => (typeof value === 'number' ? String(value) : value);

export class OpenShiftDto {
  @ApiProperty() @IsUUID() registerId!: string;

  @ApiProperty({ example: '100000.00' })
  @Transform(numToStr)
  @IsDecimal({ decimal_digits: '0,2' }, { message: 'Boshlang‘ich naqd noto‘g‘ri' })
  openingCash!: string;
}

export class CashMovementDto {
  @ApiProperty({ enum: CashMovementType }) @IsEnum(CashMovementType) type!: CashMovementType;

  @ApiProperty({ example: '50000.00' })
  @Transform(numToStr)
  @IsDecimal({ decimal_digits: '0,2' }, { message: 'Summa noto‘g‘ri' })
  amount!: string;

  @ApiProperty() @IsString() @MinLength(3, { message: 'Sabab kamida 3 belgi' }) @MaxLength(300) reason!: string;
}

export class CloseShiftDto {
  @ApiProperty({ example: '1250000.00' })
  @Transform(numToStr)
  @IsDecimal({ decimal_digits: '0,2' }, { message: 'Sanalgan naqd noto‘g‘ri' })
  countedCash!: string;
}

export class ListShiftsQuery extends PaginationQuery {
  @ApiPropertyOptional() @IsOptional() @IsUUID() registerId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() cashierId?: string;
  @ApiPropertyOptional({ enum: ShiftStatus }) @IsOptional() @IsEnum(ShiftStatus) status?: ShiftStatus;
  @ApiPropertyOptional() @IsOptional() @IsDateString() dateFrom?: string;
  @ApiPropertyOptional() @IsOptional() @IsDateString() dateTo?: string;
}
