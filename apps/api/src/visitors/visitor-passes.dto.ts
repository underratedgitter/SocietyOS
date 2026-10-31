import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

const CATEGORIES = ['RELATIVE', 'FRIEND', 'DELIVERY', 'CAB', 'MAINTENANCE', 'OTHER'] as const;
const PASS_STATUSES = ['DRAFT', 'PENDING_APPROVAL', 'ACTIVE', 'REVOKED', 'EXPIRED', 'EXHAUSTED'] as const;

export class VisitorDto {
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  phone?: string;
}

export class CreateVisitorPassDto {
  @IsUUID()
  flatId!: string;

  @ValidateNested()
  @Type(() => VisitorDto)
  visitor!: VisitorDto;

  @IsIn(CATEGORIES)
  category!: (typeof CATEGORIES)[number];

  @IsISO8601({ strict: true, strictSeparator: true })
  validFrom!: string;

  @IsISO8601({ strict: true, strictSeparator: true })
  validUntil!: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(10)
  maxUses?: number;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayUnique()
  @IsUUID(undefined, { each: true })
  accessPointIds!: string[];
}

export class ListPassesQueryDto {
  @IsOptional()
  @IsUUID()
  societyId?: string;

  @IsOptional()
  @IsIn(PASS_STATUSES)
  status?: (typeof PASS_STATUSES)[number];

  @IsOptional()
  @IsUUID()
  flatId?: string;

  @IsOptional()
  @IsUUID()
  cursor?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}

export class DecidePassDto {
  @IsIn(['APPROVED', 'REJECTED'])
  decision!: 'APPROVED' | 'REJECTED';

  @IsOptional()
  @IsString()
  @MaxLength(200)
  reason?: string;
}

export class RevokePassDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  reason?: string;
}
