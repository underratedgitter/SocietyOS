import { IsArray, IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class CreateAccessPointDto {
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  name!: string;

  @IsIn(['BOOM_BARRIER', 'SLIDING_GATE', 'DOOR_LOCK'])
  type!: 'BOOM_BARRIER' | 'SLIDING_GATE' | 'DOOR_LOCK';

  @IsOptional()
  @IsString()
  @MaxLength(200)
  location?: string;
}

export class ProvisionDeviceDto {
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  name!: string;

  @IsString()
  @MinLength(3)
  @MaxLength(80)
  deviceUid!: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  firmware?: string;

  @IsArray()
  @IsString({ each: true })
  accessPointIds!: string[];
}
