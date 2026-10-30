import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength, MinLength } from 'class-validator';

export class LoginDto {
  @ApiProperty() @IsString() @MinLength(1) @MaxLength(120) login!: string;
  @ApiProperty() @IsString() @MinLength(1) @MaxLength(200) password!: string;
}

export class ChangePasswordDto {
  @ApiProperty() @IsString() @MaxLength(200) currentPassword!: string;
  @ApiProperty() @IsString() @MinLength(8) @MaxLength(200) newPassword!: string;
}
