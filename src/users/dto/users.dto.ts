import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';
import { PaginationQuery } from '../../common/pagination.dto.js';
import { IsStrongPassword } from '../../common/password.js';

export const USER_STATUSES = ['ACTIVE', 'BLOCKED'] as const;
export type UserStatusValue = (typeof USER_STATUSES)[number];

export class ListUsersQuery extends PaginationQuery {
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(100) search?: string;
  @ApiPropertyOptional({ enum: USER_STATUSES }) @IsOptional() @IsEnum(USER_STATUSES) status?: UserStatusValue;
}

export class CreateUserDto {
  @ApiProperty() @IsString() @MinLength(2) @MaxLength(100) name!: string;
  @ApiProperty({ description: 'Email yoki telefon' }) @IsString() @MinLength(3) @MaxLength(120) login!: string;
  @ApiProperty() @IsString() @MinLength(8) @MaxLength(200) @IsStrongPassword() password!: string;
  @ApiProperty() @IsUUID() roleId!: string;
}

export class UpdateUserDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MinLength(2) @MaxLength(100) name?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() roleId?: string;
  @ApiPropertyOptional({ enum: USER_STATUSES }) @IsOptional() @IsEnum(USER_STATUSES) status?: UserStatusValue;
}

export class ResetPasswordDto {
  @ApiProperty() @IsString() @MinLength(8) @MaxLength(200) @IsStrongPassword() newPassword!: string;
}
