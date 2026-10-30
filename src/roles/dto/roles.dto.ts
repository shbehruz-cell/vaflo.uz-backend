import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ArrayMaxSize, IsArray, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class CreateRoleDto {
  @ApiProperty() @IsString() @MinLength(2) @MaxLength(60) name!: string;
  @ApiProperty({ type: [String] }) @IsArray() @ArrayMaxSize(100) @IsString({ each: true }) permissions!: string[];
}

export class UpdateRoleDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MinLength(2) @MaxLength(60) name?: string;
  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @IsString({ each: true })
  permissions?: string[];
}
