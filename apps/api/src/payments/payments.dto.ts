import { IsIn, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';

export class CreateRazorpayOrderDto {
  @IsOptional()
  @IsString()
  @MaxLength(100)
  notes?: string;
}

export class VerifyRazorpayPaymentDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  razorpayOrderId!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  razorpayPaymentId!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  razorpaySignature!: string;
}

export class CreateStripePaymentDto {
  @IsOptional()
  @IsString()
  @IsIn(['inr', 'usd', 'eur', 'gbp'])
  currency?: string;
}

export class VerifyStripePaymentDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(150)
  paymentIntentId!: string;
}
