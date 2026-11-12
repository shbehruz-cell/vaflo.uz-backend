import { Transform } from 'class-transformer';
import {
  ArrayMaxSize, IsArray, IsInt, IsObject, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min, MinLength,
  registerDecorator, type ValidationOptions,
} from 'class-validator';

/** JSON `settings` hajmi cheklangan (serializatsiya qilinganda, belgilar). */
function MaxJsonSize(max: number, options?: ValidationOptions) {
  return (object: object, propertyName: string) => {
    registerDecorator({
      name: 'maxJsonSize',
      target: object.constructor,
      propertyName,
      options: { message: `Sozlamalar hajmi ${max} belgidan oshmasligi kerak`, ...options },
      validator: {
        validate(value: unknown) {
          try {
            return JSON.stringify(value).length <= max;
          } catch {
            return false;
          }
        },
      },
    });
  };
}
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export class UpdateStoreDto {
  @ApiPropertyOptional() @IsOptional() @Transform(trim) @IsString() @MinLength(2) @MaxLength(100) name?: string;
  @ApiPropertyOptional({ example: 'Asia/Tashkent' })
  @IsOptional() @IsString() @MaxLength(64) @Matches(/^[A-Za-z_]+(\/[A-Za-z0-9_+-]+)*$/, { message: 'Vaqt zonasi noto‘g‘ri' })
  timezone?: string;
  @ApiPropertyOptional() @IsOptional() @IsObject() @MaxJsonSize(20_000) settings?: Record<string, unknown>;
}

export class CreateWarehouseDto {
  @ApiProperty() @Transform(trim) @IsString() @MinLength(1) @MaxLength(100) name!: string;
  @ApiProperty() @Transform(trim) @IsString() @MinLength(1) @MaxLength(30) code!: string;
}

export class CreateRegisterDto {
  @ApiProperty() @Transform(trim) @IsString() @MinLength(1) @MaxLength(100) name!: string;
  @ApiProperty() @Transform(trim) @IsString() @MinLength(1) @MaxLength(30) code!: string;
  @ApiProperty() @IsUUID() warehouseId!: string;
  @ApiPropertyOptional({ description: 'Bir vaqtda nechta kassir smena ocha oladi', default: 1 })
  @IsOptional() @IsInt() @Min(1) @Max(20)
  maxCashiers?: number;
}

export class UpdateRegisterDto {
  @ApiPropertyOptional() @IsOptional() @Transform(trim) @IsString() @MinLength(1) @MaxLength(100) name?: string;
  @ApiPropertyOptional({ description: 'Bir vaqtda nechta kassir smena ocha oladi (1–20)' })
  @IsOptional() @IsInt() @Min(1) @Max(20)
  maxCashiers?: number;
  @ApiPropertyOptional({ description: 'Kassaga biriktirilgan xodimlar. Bo‘sh ro‘yxat — istalgan kassir.', type: [String] })
  @IsOptional() @IsArray() @ArrayMaxSize(100) @IsUUID('all', { each: true })
  userIds?: string[];
}
