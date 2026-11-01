import { Controller, Headers, HttpCode, HttpStatus, Post, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { PaymentsService } from './payments.service';

interface RequestWithRawBody extends Request {
  rawBody?: Buffer;
}

@ApiTags('webhooks')
@Controller('webhooks/payments')
export class WebhooksController {
  constructor(private readonly payments: PaymentsService) {}

  @Post('razorpay')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Receive and process Razorpay webhook callbacks' })
  async razorpayWebhook(
    @Req() req: RequestWithRawBody,
    @Headers('x-razorpay-signature') signature?: string,
  ) {
    const raw = req.rawBody || JSON.stringify(req.body);
    return this.payments.handleRazorpayWebhook(raw, signature);
  }

  @Post('stripe')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Receive and process Stripe webhook callbacks' })
  async stripeWebhook(
    @Req() req: RequestWithRawBody,
    @Headers('stripe-signature') signature?: string,
  ) {
    const raw = req.rawBody || JSON.stringify(req.body);
    return this.payments.handleStripeWebhook(raw, signature);
  }
}
