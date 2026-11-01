import { IsIn, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';

export class RegisterPushTokenDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  token!: string;

  @IsOptional()
  @IsString()
  @IsIn(['expo', 'web', 'ios', 'android'])
  platform?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  deviceName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  endpoint?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  p256dh?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  auth?: string;
}

export class UnregisterPushTokenDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  token!: string;
}
