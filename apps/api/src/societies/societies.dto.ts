import { IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength, IsEmail } from 'class-validator';

export class CreateSocietyDto {
  @IsString()
  @MinLength(3)
  @MaxLength(120)
  name!: string;

  @IsString()
  @MinLength(3)
  @MaxLength(60)
  slug!: string;

  @IsOptional()
  @IsString()
  timezone?: string;

  @IsString()
  @MinLength(2)
  adminName!: string;

  @IsEmail()
  adminEmail!: string;

  @IsString()
  @MinLength(8)
  adminPassword!: string;
}

export class UpdateSocietyDto {
  @IsOptional()
  @IsString()
  @MinLength(3)
  name?: string;

  @IsOptional()
  @IsString()
  timezone?: string;
}

export class CreateBuildingDto {
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name!: string;
}

export class CreateFlatDto {
  @IsString()
  @MinLength(1)
  @MaxLength(20)
  flatNumber!: string;
}

export class InviteResidentDto {
  @IsString()
  @MinLength(2)
  name!: string;

  @IsEmail()
  email!: string;

  @IsString()
  @MinLength(8)
  password!: string;

  @IsOptional()
  @IsString()
  phone?: string;

  @IsString()
  flatId!: string;

  @IsIn(['OWNER', 'TENANT', 'FAMILY'])
  relationship!: 'OWNER' | 'TENANT' | 'FAMILY';
}

export class AddFlatMemberDto {
  @IsString()
  @MinLength(2)
  name!: string;

  @IsEmail()
  email!: string;

  @IsString()
  @MinLength(8)
  password!: string;

  @IsOptional()
  @IsString()
  phone?: string;

  @IsIn(['OWNER', 'TENANT', 'FAMILY'])
  relationship!: 'OWNER' | 'TENANT' | 'FAMILY';
}
