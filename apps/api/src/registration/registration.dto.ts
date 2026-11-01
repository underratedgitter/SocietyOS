import {
  IsIn,
  IsInt,
  IsEmail,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

export class RegisterUserDto {
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  name!: string;

  @IsEmail()
  @MaxLength(254)
  email!: string;

  @IsString()
  @MinLength(8)
  @MaxLength(128)
  password!: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  phone?: string;

  @IsUUID()
  societyId!: string;

  @IsOptional()
  @IsUUID()
  flatId?: string;

  @IsOptional()
  @IsIn(['OWNER', 'TENANT', 'FAMILY'])
  relationship?: 'OWNER' | 'TENANT' | 'FAMILY';
}

export class SelfRegisterVisitorDto {
  @IsUUID()
  societyId!: string;

  @IsUUID()
  flatId!: string;

  @IsString()
  @MinLength(2)
  @MaxLength(120)
  visitorName!: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  visitorPhone?: string;

  @IsIn(['RELATIVE', 'FRIEND', 'DELIVERY', 'CAB', 'MAINTENANCE', 'OTHER'])
  category!: 'RELATIVE' | 'FRIEND' | 'DELIVERY' | 'CAB' | 'MAINTENANCE' | 'OTHER';

  @IsOptional()
  @IsString()
  @MaxLength(20)
  vehicle?: string;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  purpose?: string;

  @IsOptional()
  @IsInt()
  @Min(15)
  @Max(4320)
  expectedDurationMinutes?: number;
}
