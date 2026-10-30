import { IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { Transform } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export const STORE_TYPES = ['oziq-ovqat', 'kiyim', 'qurilish', 'dorixona', 'boshqa'] as const;
const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export class CreateDemoRequestDto {
  @ApiProperty() @Transform(trim) @IsString() @MinLength(2) @MaxLength(80) name!: string;
  @ApiProperty() @Transform(trim) @IsString() @MaxLength(30) phone!: string;
  @ApiProperty() @Transform(trim) @IsString() @MinLength(2) @MaxLength(100) storeName!: string;
  @ApiPropertyOptional({ enum: STORE_TYPES }) @IsOptional() @IsIn(STORE_TYPES) storeType?: (typeof STORE_TYPES)[number];
  @ApiPropertyOptional() @IsOptional() @Transform(trim) @IsString() @MaxLength(1000) message?: string;
  /** Honeypot: oddiy foydalanuvchi bo‘sh qoldiradi. */
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(500) website?: string;
}
