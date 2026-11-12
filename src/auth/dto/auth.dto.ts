import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsEmail, IsOptional, IsString, IsUUID, Length, Matches, MaxLength, MinLength } from 'class-validator';
import { IsStrongPassword } from '../../common/password.js';

export class LoginDto {
  @ApiProperty() @IsString() @MinLength(1) @MaxLength(120) login!: string;
  @ApiProperty() @IsString() @MinLength(1) @MaxLength(200) password!: string;
}

export class ChangePasswordDto {
  @ApiProperty() @IsString() @MaxLength(200) currentPassword!: string;
  @ApiProperty() @IsString() @MinLength(8) @MaxLength(200) @IsStrongPassword() newPassword!: string;
}

export class RefreshDto {
  /** Mobil ilova uchun: cookie o‘rniga body orqali. */
  @ApiProperty({ required: false }) @IsOptional() @IsString() @MaxLength(200) refreshToken?: string;
}

export class VerifyCodeDto {
  @ApiProperty() @IsUUID() challengeId!: string;
  @ApiProperty() @IsString() @Length(6, 6) @Matches(/^\d{6}$/) code!: string;
}

export class ChallengeDto {
  @ApiProperty() @IsUUID() challengeId!: string;
}

export class ForgotPasswordDto {
  @ApiProperty() @IsString() @MinLength(1) @MaxLength(120) login!: string;
}

export class ResetPasswordDto {
  @ApiProperty() @IsString() @MinLength(20) @MaxLength(200) resetToken!: string;
  @ApiProperty() @IsString() @MinLength(8) @MaxLength(200) @IsStrongPassword() newPassword!: string;
}

export class TwoFactorDto {
  @ApiProperty() @IsBoolean() enabled!: boolean;
  @ApiProperty() @IsString() @MaxLength(200) password!: string;
}

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export class SignupStartDto {
  @ApiProperty() @Transform(trim) @IsEmail() @MaxLength(120) email!: string;
}

export class SignupCompleteDto {
  @ApiProperty() @IsString() @MinLength(20) @MaxLength(200) signupToken!: string;
  @ApiProperty() @Transform(trim) @IsString() @MinLength(2) @MaxLength(80) name!: string;
  @ApiProperty() @Transform(trim) @IsString() @MinLength(2) @MaxLength(80) storeName!: string;
  @ApiProperty() @IsString() @MinLength(8) @MaxLength(200) @IsStrongPassword() password!: string;
}
