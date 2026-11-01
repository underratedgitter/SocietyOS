import { Body, Controller, Param, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard, JwtUser } from '../auth/jwt-auth.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import { PaymentsService } from './payments.service';
import {
  CreateRazorpayOrderDto,
  VerifyRazorpayPaymentDto,
  CreateStripePaymentDto,
  VerifyStripePaymentDto,
} from './payments.dto';

@ApiTags('payments')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('societies/:societyId/invoices/:invoiceId/payment')
export class PaymentsController {
  constructor(private readonly payments: PaymentsService) {}

  @Post('razorpay/order')
  @ApiOperation({ summary: 'Create Razorpay order for online invoice settlement' })
  async createRazorpayOrder(
    @CurrentUser() user: JwtUser,
    @Param('societyId') societyId: string,
    @Param('invoiceId') invoiceId: string,
    @Body() dto: CreateRazorpayOrderDto,
  ) {
    return this.payments.createRazorpayOrder(user, societyId, invoiceId, dto);
  }

  @Post('razorpay/verify')
  @ApiOperation({ summary: 'Verify Razorpay payment signature and settle maintenance invoice' })
  async verifyRazorpayPayment(
    @CurrentUser() user: JwtUser,
    @Param('societyId') societyId: string,
    @Param('invoiceId') invoiceId: string,
    @Body() dto: VerifyRazorpayPaymentDto,
  ) {
    return this.payments.verifyRazorpayPayment(user, societyId, invoiceId, dto);
  }

  @Post('stripe/intent')
  @ApiOperation({ summary: 'Create Stripe PaymentIntent for online invoice settlement' })
  async createStripeIntent(
    @CurrentUser() user: JwtUser,
    @Param('societyId') societyId: string,
    @Param('invoiceId') invoiceId: string,
    @Body() dto: CreateStripePaymentDto,
  ) {
    return this.payments.createStripePaymentIntent(user, societyId, invoiceId, dto);
  }

  @Post('stripe/verify')
  @ApiOperation({ summary: 'Verify Stripe PaymentIntent status and settle maintenance invoice' })
  async verifyStripePayment(
    @CurrentUser() user: JwtUser,
    @Param('societyId') societyId: string,
    @Param('invoiceId') invoiceId: string,
    @Body() dto: VerifyStripePaymentDto,
  ) {
    return this.payments.verifyStripePayment(user, societyId, invoiceId, dto);
  }
}
