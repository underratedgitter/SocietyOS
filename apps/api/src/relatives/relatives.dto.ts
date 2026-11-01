import {
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

export class RegisterRelativeDto {
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  phone?: string;

  @IsString()
  @MinLength(2)
  @MaxLength(50)
  relation!: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  defaultVehicle?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  notes?: string;
}

export class QuickPassDto {
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(168)
  validHours?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(20)
  maxUses?: number;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  vehicle?: string;
}
