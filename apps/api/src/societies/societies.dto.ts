import { Type } from 'class-transformer';
import {
  IsArray,
  IsEmail,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

const VISITOR_CATEGORIES = ['RELATIVE', 'FRIEND', 'DELIVERY', 'CAB', 'MAINTENANCE', 'OTHER'] as const;

export class CreateSocietyDto {
  @IsString()
  @MinLength(3)
  @MaxLength(120)
  name!: string;

  @IsString()
  @MinLength(3)
  @MaxLength(60)
  @Matches(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, {
    message: 'slug must be lowercase letters, numbers and single hyphens',
  })
  slug!: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  timezone?: string;

  @IsString()
  @MinLength(2)
  @MaxLength(120)
  adminName!: string;

  @IsEmail()
  @MaxLength(254)
  adminEmail!: string;
}

export class VisitorPolicyDto {
  @IsOptional()
  @IsArray()
  @IsIn(VISITOR_CATEGORIES, { each: true })
  approvalCategories?: (typeof VISITOR_CATEGORIES)[number][];

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(720)
  maxPassDurationHours?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(10)
  maxUsesPerPass?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  maxPassesPerFlatPerDay?: number;
}

export class UpdateSocietyDto {
  @IsOptional()
  @IsString()
  @MinLength(3)
  @MaxLength(120)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  timezone?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => VisitorPolicyDto)
  policy?: VisitorPolicyDto;
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
  @Matches(/^[A-Za-z0-9][A-Za-z0-9./-]*$/, {
    message: 'flatNumber contains unsupported characters',
  })
  flatNumber!: string;
}

export class InviteResidentDto {
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  name!: string;

  @IsEmail()
  @MaxLength(254)
  email!: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  phone?: string;

  @IsString()
  flatId!: string;

  @IsIn(['OWNER', 'TENANT', 'FAMILY'])
  relationship!: 'OWNER' | 'TENANT' | 'FAMILY';
}

export class AddFlatMemberDto {
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  name!: string;

  @IsEmail()
  @MaxLength(254)
  email!: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  phone?: string;

  @IsIn(['OWNER', 'TENANT', 'FAMILY'])
  relationship!: 'OWNER' | 'TENANT' | 'FAMILY';
}

export class CreateGuardDto {
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  name!: string;

  @IsEmail()
  @MaxLength(254)
  email!: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  phone?: string;
}
