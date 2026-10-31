import {
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

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
  @Matches(/^[A-Za-z0-9._:-]+$/, { message: 'deviceUid contains unsupported characters' })
  deviceUid!: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  firmware?: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayUnique()
  @IsUUID(undefined, { each: true })
  accessPointIds!: string[];
}

export class EmergencyOverrideDto {
  @IsString()
  @MinLength(3)
  @MaxLength(250)
  reason!: string;
}

export class BiometricEnrollRequestDto {
  @IsUUID()
  userId!: string;

  @IsIn(['FINGERPRINT', 'FACE'])
  type!: 'FINGERPRINT' | 'FACE';

  @IsString()
  @MinLength(8)
  @MaxLength(128)
  templateHash!: string;

  @IsString()
  @MinLength(2)
  @MaxLength(64)
  algorithm!: string;
}

export class BiometricVerifyRequestDto {
  @IsUUID()
  accessPointId!: string;

  @IsIn(['FINGERPRINT', 'FACE'])
  type!: 'FINGERPRINT' | 'FACE';

  @IsString()
  @MinLength(8)
  @MaxLength(128)
  templateHash!: string;
}

