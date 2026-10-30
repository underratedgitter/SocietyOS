import { IsArray, IsIn, IsInt, IsISO8601, IsOptional, IsString, Max, MaxLength, Min, MinLength, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';

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
  @IsString()
  flatId!: string;

  @ValidateNested()
  @Type(() => VisitorDto)
  visitor!: VisitorDto;

  @IsIn(['RELATIVE', 'FRIEND', 'DELIVERY', 'CAB', 'MAINTENANCE', 'OTHER'])
  category!: 'RELATIVE' | 'FRIEND' | 'DELIVERY' | 'CAB' | 'MAINTENANCE' | 'OTHER';

  @IsISO8601()
  validFrom!: string;

  @IsISO8601()
  validUntil!: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(10)
  maxUses?: number;

  @IsArray()
  @IsString({ each: true })
  accessPointIds!: string[];
}

export class DecidePassDto {
  @IsIn(['APPROVED', 'REJECTED'])
  decision!: 'APPROVED' | 'REJECTED';

  @IsOptional()
  @IsString()
  @MaxLength(200)
  reason?: string;
}
