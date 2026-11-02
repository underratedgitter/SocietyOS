import { Injectable, Logger } from '@nestjs/common';
import { createHmac, randomBytes, timingSafeEqual } from 'crypto';
import { PrismaService } from '../common/prisma.service';
import { AuthzService } from '../common/authz.service';
import { AuditService } from '../common/audit.service';
import { AppException } from '../common/app.exception';
import { NotificationsService } from '../notifications/notifications.service';
import { getEnv } from '../config';
import { JwtUser } from '../auth/jwt-auth.guard';
import {
  CreateRazorpayOrderDto,
  VerifyRazorpayPaymentDto,
  CreateStripePaymentDto,
  VerifyStripePaymentDto,
} from './payments.dto';

@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly authz: AuthzService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
  ) {}

  /**
   * Constant-time comparison between two hex strings to prevent timing attacks.
   */
  private secureCompare(a: string, b: string): boolean {
    if (typeof a !== 'string' || typeof b !== 'string') return false;
    const bufA = Buffer.from(a, 'utf8');
    const bufB = Buffer.from(b, 'utf8');
    if (bufA.length !== bufB.length) return false;
    return timingSafeEqual(bufA, bufB);
  }

  private isUuid(val?: string | null): boolean {
    if (!val || typeof val !== 'string') return false;
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(val);
  }

  // =========================================================================
  // RAZORPAY INTEGRATION
  // =========================================================================

  async createRazorpayOrder(
    user: JwtUser,
    societyId: string,
    invoiceId: string,
    _dto?: CreateRazorpayOrderDto,
  ) {
    const invoice = await this.prisma.maintenanceInvoice.findUnique({
      where: { id: invoiceId },
      include: { flat: true },
    });
    if (!invoice || invoice.societyId !== societyId) {
      throw AppException.notFound('INVOICE_NOT_FOUND', 'Invoice not found in this society');
    }
    if (invoice.status === 'PAID') {
      throw AppException.conflict('INVOICE_ALREADY_PAID', 'This invoice has already been settled');
    }
    if (invoice.status === 'CANCELLED') {
      throw AppException.unprocessable('INVOICE_CANCELLED', 'Cannot create payment for a cancelled invoice');
    }
    if (!invoice.amount || invoice.amount <= 0) {
      throw AppException.unprocessable('INVALID_AMOUNT', 'Invoice amount must be greater than zero');
    }

    // Authorize caller has access to flat
    await this.authz.flat(user.sub, invoice.flatId, ['SOCIETY_ADMIN', 'RESIDENT']);

    const amountInPaise = Math.round(invoice.amount * 100);
    const env = getEnv();

    let orderId: string;

    if (env.razorpayKeyId && env.razorpayKeySecret) {
      // Live Razorpay API call
      const authHeader = `Basic ${Buffer.from(`${env.razorpayKeyId}:${env.razorpayKeySecret}`).toString('base64')}`;
      const payload = {
        amount: amountInPaise,
        currency: 'INR',
        receipt: invoice.id,
        notes: {
          societyId,
          invoiceId: invoice.id,
          flatId: invoice.flatId,
          userId: user.sub,
        },
      };

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8000);
      try {
        const response = await fetch('https://api.razorpay.com/v1/orders', {
          method: 'POST',
          headers: {
            Authorization: authHeader,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(payload),
          signal: controller.signal,
        });

        if (!response.ok) {
          const errText = await response.text();
          throw new Error(`Razorpay Order API failed with HTTP ${response.status}: ${errText}`);
        }

        const data = (await response.json()) as { id: string };
        orderId = data.id;
      } catch (err) {
        this.logger.error(`Razorpay order creation failed: ${String(err)}`);
        throw AppException.badGateway('PAYMENT_GATEWAY_ERROR', 'Unable to initialize Razorpay payment');
      } finally {
        clearTimeout(timeout);
      }
    } else {
      // Mock / Dev fallback
      orderId = `order_${Date.now()}_${randomBytes(4).toString('hex')}`;
      this.logger.log(`[RAZORPAY-MOCK] Generated order ${orderId} for invoice ${invoice.id} (₹${invoice.amount})`);
    }

    // Save gatewayOrderId on invoice
    await this.prisma.maintenanceInvoice.update({
      where: { id: invoice.id },
      data: {
        gatewayOrderId: orderId,
        paymentGateway: 'RAZORPAY',
      },
    });

    return {
      orderId,
      amount: amountInPaise,
      currency: 'INR',
      keyId: env.razorpayKeyId || 'rzp_test_mock',
      invoiceId: invoice.id,
      flatNumber: invoice.flat.flatNumber,
      title: invoice.title,
    };
  }

  async verifyRazorpayPayment(
    user: JwtUser,
    societyId: string,
    invoiceId: string,
    dto: VerifyRazorpayPaymentDto,
  ) {
    const invoice = await this.prisma.maintenanceInvoice.findUnique({
      where: { id: invoiceId },
    });
    if (!invoice || invoice.societyId !== societyId) {
      throw AppException.notFound('INVOICE_NOT_FOUND', 'Invoice not found in this society');
    }

    // Authorize caller
    await this.authz.flat(user.sub, invoice.flatId, ['SOCIETY_ADMIN', 'RESIDENT']);

    if (!invoice.gatewayOrderId) {
      throw AppException.badRequest('NO_GATEWAY_ORDER', 'No gateway order exists for this invoice. Create an order first.');
    }
    if (invoice.gatewayOrderId !== dto.razorpayOrderId) {
      throw AppException.badRequest('ORDER_ID_MISMATCH', 'Payment order ID does not match invoice order');
    }

    const env = getEnv();
    if (env.razorpayKeySecret) {
      const generatedSignature = createHmac('sha256', env.razorpayKeySecret)
        .update(`${dto.razorpayOrderId}|${dto.razorpayPaymentId}`)
        .digest('hex');

      if (!this.secureCompare(generatedSignature, dto.razorpaySignature)) {
        throw AppException.badRequest('INVALID_PAYMENT_SIGNATURE', 'Razorpay payment signature mismatch');
      }
    } else {
      if (env.isProduction) {
        throw AppException.badGateway('GATEWAY_NOT_CONFIGURED', 'Razorpay secret key is not configured in production');
      }
      // In mock/test mode without key secret, accept valid mock signature or matching string
      const isMockOk =
        dto.razorpaySignature === 'mock_sig_ok' ||
        dto.razorpaySignature.length >= 10;
      if (!isMockOk) {
        throw AppException.badRequest('INVALID_PAYMENT_SIGNATURE', 'Invalid mock signature');
      }
    }

    return this.settleInvoice({
      invoiceId: invoice.id,
      societyId,
      userId: user.sub,
      paymentReference: dto.razorpayPaymentId,
      gatewayPaymentId: dto.razorpayPaymentId,
      gatewayOrderId: dto.razorpayOrderId,
      gateway: 'RAZORPAY',
    });
  }

  async handleRazorpayWebhook(rawBody: Buffer | string, signatureHeader?: string) {
    const env = getEnv();
    const rawString = typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8');

    if (env.razorpayWebhookSecret) {
      if (!signatureHeader) {
        throw AppException.badRequest('MISSING_WEBHOOK_SIGNATURE', 'X-Razorpay-Signature header is missing');
      }
      const rawBuf = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody, 'utf8');
      const expected = createHmac('sha256', env.razorpayWebhookSecret).update(rawBuf).digest('hex');
      if (!this.secureCompare(expected, signatureHeader)) {
        throw AppException.badRequest('INVALID_WEBHOOK_SIGNATURE', 'Razorpay webhook signature verification failed');
      }
    } else if (env.isProduction) {
      throw AppException.badGateway('GATEWAY_NOT_CONFIGURED', 'Razorpay webhook secret is not configured in production');
    }

    let payload: any;
    try {
      payload = JSON.parse(rawString);
    } catch {
      throw AppException.badRequest('INVALID_PAYLOAD', 'Malformed webhook JSON payload');
    }

    const event = payload?.event;
    this.logger.log(`Processing Razorpay webhook event: ${event}`);

    if (event === 'payment.captured' || event === 'order.paid') {
      const paymentEntity = payload?.payload?.payment?.entity;
      const orderEntity = payload?.payload?.order?.entity;

      const orderId = paymentEntity?.order_id || orderEntity?.id;
      const paymentId = paymentEntity?.id || `pay_${Date.now()}`;
      const invoiceId = paymentEntity?.notes?.invoiceId || orderEntity?.notes?.invoiceId;
      const userId = paymentEntity?.notes?.userId || orderEntity?.notes?.userId;

      const amount = paymentEntity?.amount || orderEntity?.amount;
      const currency = (paymentEntity?.currency || orderEntity?.currency)?.toLowerCase();

      // Find invoice
      let invoice: any = null;
      if (invoiceId) {
        invoice = await this.prisma.maintenanceInvoice.findUnique({ where: { id: invoiceId } });
      } else if (orderId) {
        invoice = await this.prisma.maintenanceInvoice.findFirst({ where: { gatewayOrderId: orderId } });
      }

      if (invoice) {
        if (invoice.status === 'PAID') {
          return { received: true, status: 'already_paid' };
        }
        if (invoice.status === 'CANCELLED') {
          this.logger.warn(`Razorpay webhook callback received for cancelled invoice ${invoice.id}`);
          return { received: true, status: 'ignored_cancelled' };
        }
        if (invoice.gatewayOrderId && orderId && invoice.gatewayOrderId !== orderId) {
          this.logger.warn(`Razorpay order ID ${orderId} does not match invoice gatewayOrderId ${invoice.gatewayOrderId}`);
          return { received: true, status: 'order_mismatch' };
        }
        const expectedAmountInPaise = Math.round(invoice.amount * 100);
        if (currency && currency !== 'inr') {
          this.logger.warn(`Razorpay payment currency ${currency} is not INR for invoice ${invoice.id}`);
          return { received: true, status: 'currency_mismatch' };
        }
        if (typeof amount === 'number' && amount < expectedAmountInPaise) {
          this.logger.warn(`Razorpay payment amount ${amount} is less than required ${expectedAmountInPaise} for invoice ${invoice.id}`);
          return { received: true, status: 'amount_mismatch' };
        }
        await this.settleInvoice({
          invoiceId: invoice.id,
          societyId: invoice.societyId,
          userId: userId || invoice.paidById,
          paymentReference: paymentId,
          gatewayPaymentId: paymentId,
          gatewayOrderId: orderId,
          gateway: 'RAZORPAY',
        });
      }
    }

    return { received: true };
  }

  // =========================================================================
  // STRIPE INTEGRATION
  // =========================================================================

  async createStripePaymentIntent(
    user: JwtUser,
    societyId: string,
    invoiceId: string,
    dto?: CreateStripePaymentDto,
  ) {
    const invoice = await this.prisma.maintenanceInvoice.findUnique({
      where: { id: invoiceId },
      include: { flat: true },
    });
    if (!invoice || invoice.societyId !== societyId) {
      throw AppException.notFound('INVOICE_NOT_FOUND', 'Invoice not found in this society');
    }
    if (invoice.status === 'PAID') {
      throw AppException.conflict('INVOICE_ALREADY_PAID', 'This invoice has already been settled');
    }
    if (invoice.status === 'CANCELLED') {
      throw AppException.unprocessable('INVOICE_CANCELLED', 'Cannot create payment for a cancelled invoice');
    }
    if (!invoice.amount || invoice.amount <= 0) {
      throw AppException.unprocessable('INVALID_AMOUNT', 'Invoice amount must be greater than zero');
    }

    await this.authz.flat(user.sub, invoice.flatId, ['SOCIETY_ADMIN', 'RESIDENT']);

    const currency = (dto?.currency || 'inr').toLowerCase();
    if (currency !== 'inr') {
      throw AppException.badRequest('INVALID_CURRENCY', 'Only INR currency is supported for maintenance invoices');
    }
    const amountInCents = Math.round(invoice.amount * 100);
    const env = getEnv();

    let paymentIntentId: string;
    let clientSecret: string;

    if (env.stripeSecretKey) {
      const params = new URLSearchParams({
        amount: amountInCents.toString(),
        currency,
        'automatic_payment_methods[enabled]': 'true',
        'metadata[societyId]': societyId,
        'metadata[invoiceId]': invoice.id,
        'metadata[flatId]': invoice.flatId,
        'metadata[userId]': user.sub,
      });

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8000);
      try {
        const response = await fetch('https://api.stripe.com/v1/payment_intents', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${env.stripeSecretKey}`,
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: params.toString(),
          signal: controller.signal,
        });

        if (!response.ok) {
          const errText = await response.text();
          throw new Error(`Stripe API error HTTP ${response.status}: ${errText}`);
        }

        const data = (await response.json()) as { id: string; client_secret: string };
        paymentIntentId = data.id;
        clientSecret = data.client_secret;
      } catch (err) {
        this.logger.error(`Stripe payment intent creation failed: ${String(err)}`);
        throw AppException.badGateway('PAYMENT_GATEWAY_ERROR', 'Unable to initialize Stripe payment');
      } finally {
        clearTimeout(timeout);
      }
    } else {
      // Mock / Dev fallback
      paymentIntentId = `pi_${Date.now()}_${randomBytes(4).toString('hex')}`;
      clientSecret = `${paymentIntentId}_secret_${randomBytes(8).toString('hex')}`;
      this.logger.log(`[STRIPE-MOCK] Generated PaymentIntent ${paymentIntentId} for ₹${invoice.amount}`);
    }

    await this.prisma.maintenanceInvoice.update({
      where: { id: invoice.id },
      data: {
        gatewayOrderId: paymentIntentId,
        paymentGateway: 'STRIPE',
      },
    });

    return {
      clientSecret,
      paymentIntentId,
      publishableKey: env.stripePublishableKey || 'pk_test_mock',
      amount: amountInCents,
      currency,
      invoiceId: invoice.id,
    };
  }

  async verifyStripePayment(
    user: JwtUser,
    societyId: string,
    invoiceId: string,
    dto: VerifyStripePaymentDto,
  ) {
    const invoice = await this.prisma.maintenanceInvoice.findUnique({
      where: { id: invoiceId },
    });
    if (!invoice || invoice.societyId !== societyId) {
      throw AppException.notFound('INVOICE_NOT_FOUND', 'Invoice not found in this society');
    }

    await this.authz.flat(user.sub, invoice.flatId, ['SOCIETY_ADMIN', 'RESIDENT']);

    if (!invoice.gatewayOrderId) {
      throw AppException.badRequest('NO_GATEWAY_ORDER', 'No gateway order exists for this invoice. Create a payment intent first.');
    }
    if (invoice.gatewayOrderId !== dto.paymentIntentId) {
      throw AppException.badRequest('PAYMENT_INTENT_MISMATCH', 'PaymentIntent does not match invoice');
    }

    const expectedAmountInCents = Math.round(invoice.amount * 100);

    const env = getEnv();
    if (env.stripeSecretKey) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8000);
      try {
        const response = await fetch(`https://api.stripe.com/v1/payment_intents/${dto.paymentIntentId}`, {
          headers: { Authorization: `Bearer ${env.stripeSecretKey}` },
          signal: controller.signal,
        });
        if (!response.ok) {
          throw new Error(`Stripe check returned HTTP ${response.status}`);
        }
        const data = (await response.json()) as { status: string; amount?: number; currency?: string };
        if (data.status !== 'succeeded') {
          throw AppException.badRequest('PAYMENT_NOT_COMPLETED', `Stripe PaymentIntent is in state: ${data.status}`);
        }
        if (data.currency && data.currency.toLowerCase() !== 'inr') {
          throw AppException.badRequest('INVALID_CURRENCY', 'PaymentIntent currency must be INR');
        }
        if (typeof data.amount === 'number' && data.amount < expectedAmountInCents) {
          throw AppException.badRequest('INSUFFICIENT_AMOUNT', `Payment amount (${data.amount}) is less than invoice (${expectedAmountInCents})`);
        }
      } finally {
        clearTimeout(timeout);
      }
    } else if (env.isProduction) {
      throw AppException.badGateway('GATEWAY_NOT_CONFIGURED', 'Stripe secret key is not configured in production');
    }

    return this.settleInvoice({
      invoiceId: invoice.id,
      societyId,
      userId: user.sub,
      paymentReference: dto.paymentIntentId,
      gatewayPaymentId: dto.paymentIntentId,
      gatewayOrderId: dto.paymentIntentId,
      gateway: 'STRIPE',
    });
  }

  async handleStripeWebhook(rawBody: Buffer | string, signatureHeader?: string) {
    const env = getEnv();
    const rawString = typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8');

    if (env.stripeWebhookSecret) {
      if (!signatureHeader) {
        throw AppException.badRequest('MISSING_WEBHOOK_SIGNATURE', 'stripe-signature header is missing');
      }

      // Format: t=1492774577,v1=5257a869e7ecebeda32affa62cd325494d3c942ee...
      const items = signatureHeader.split(',');
      let timestamp = '';
      const signatures: string[] = [];

      for (const item of items) {
        const [k, v] = item.trim().split('=');
        if (k === 't') timestamp = v;
        if (k === 'v1' && v) signatures.push(v);
      }

      if (!timestamp || signatures.length === 0) {
        throw AppException.badRequest('INVALID_WEBHOOK_SIGNATURE', 'Malformed stripe-signature header');
      }

      // Replay tolerance: 300 seconds
      const nowSec = Math.floor(Date.now() / 1000);
      const parsedTimestamp = Number.parseInt(timestamp, 10);
      if (Number.isNaN(parsedTimestamp) || Math.abs(nowSec - parsedTimestamp) > 300) {
        throw AppException.badRequest('WEBHOOK_TIMESTAMP_EXPIRED', 'Stripe webhook signature expired or timestamp invalid');
      }

      const rawBuf = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody, 'utf8');
      const signedPayload = Buffer.concat([Buffer.from(`${timestamp}.`, 'utf8'), rawBuf]);
      const expected = createHmac('sha256', env.stripeWebhookSecret).update(signedPayload).digest('hex');

      const matched = signatures.some((sig) => this.secureCompare(expected, sig));
      if (!matched) {
        throw AppException.badRequest('INVALID_WEBHOOK_SIGNATURE', 'Stripe webhook HMAC mismatch');
      }
    } else if (env.isProduction) {
      throw AppException.badGateway('GATEWAY_NOT_CONFIGURED', 'Stripe webhook secret is not configured in production');
    }

    let event: any;
    try {
      event = JSON.parse(rawString);
    } catch {
      throw AppException.badRequest('INVALID_PAYLOAD', 'Malformed webhook JSON payload');
    }

    this.logger.log(`Processing Stripe webhook event: ${event?.type}`);

    if (
      event?.type === 'payment_intent.succeeded' ||
      event?.type === 'checkout.session.completed'
    ) {
      const obj = event.data?.object;
      const invoiceId = obj?.metadata?.invoiceId;
      const userId = obj?.metadata?.userId;
      const paymentIntentId = obj?.id;
      const amount = obj?.amount;
      const currency = obj?.currency?.toLowerCase();

      let invoice: any = null;
      if (invoiceId) {
        invoice = await this.prisma.maintenanceInvoice.findUnique({ where: { id: invoiceId } });
      } else if (paymentIntentId) {
        invoice = await this.prisma.maintenanceInvoice.findFirst({ where: { gatewayOrderId: paymentIntentId } });
      }

      if (invoice) {
        if (invoice.status === 'PAID') {
          return { received: true, status: 'already_paid' };
        }
        if (invoice.status === 'CANCELLED') {
          this.logger.warn(`Stripe webhook callback received for cancelled invoice ${invoice.id}`);
          return { received: true, status: 'ignored_cancelled' };
        }
        if (invoice.gatewayOrderId && paymentIntentId && invoice.gatewayOrderId !== paymentIntentId) {
          this.logger.warn(`Stripe paymentIntentId ${paymentIntentId} does not match invoice gatewayOrderId ${invoice.gatewayOrderId}`);
          return { received: true, status: 'order_mismatch' };
        }
        const expectedAmountInCents = Math.round(invoice.amount * 100);
        if (currency && currency !== 'inr') {
          this.logger.warn(`Stripe payment currency ${currency} is not INR for invoice ${invoice.id}`);
          return { received: true, status: 'currency_mismatch' };
        }
        if (typeof amount === 'number' && amount < expectedAmountInCents) {
          this.logger.warn(`Stripe payment amount ${amount} is less than required ${expectedAmountInCents} for invoice ${invoice.id}`);
          return { received: true, status: 'amount_mismatch' };
        }
        await this.settleInvoice({
          invoiceId: invoice.id,
          societyId: invoice.societyId,
          userId: userId || invoice.paidById,
          paymentReference: paymentIntentId,
          gatewayPaymentId: paymentIntentId,
          gatewayOrderId: paymentIntentId,
          gateway: 'STRIPE',
        });
      }
    }

    return { received: true };
  }

  // =========================================================================
  // SHARED SETTLEMENT LOGIC (ADVISORY LOCKED & IDEMPOTENT)
  // =========================================================================

  private async settleInvoice(params: {
    invoiceId: string;
    societyId: string;
    userId?: string | null;
    paymentReference: string;
    gatewayPaymentId?: string;
    gatewayOrderId?: string;
    gateway: string;
  }) {
    return this.prisma.$transaction(async (tx) => {
      // Serialize invoice settlement using advisory lock
      await tx.$executeRawUnsafe(
        `SELECT pg_advisory_xact_lock(hashtext($1))`,
        `invoice:${params.invoiceId}`,
      ).catch(() => undefined);

      const fresh = await tx.maintenanceInvoice.findUnique({
        where: { id: params.invoiceId },
        include: {
          flat: {
            select: {
              id: true,
              flatNumber: true,
              building: { select: { name: true } },
            },
          },
        },
      });

      if (!fresh || fresh.societyId !== params.societyId) {
        throw AppException.notFound('INVOICE_NOT_FOUND', 'Invoice not found in this society');
      }

      if (fresh.status === 'PAID') {
        return fresh; // Idempotent return
      }

      if (fresh.status === 'CANCELLED') {
        throw AppException.unprocessable('INVOICE_CANCELLED', 'Cannot settle a cancelled invoice');
      }

      let validPaidById: string | null = null;
      if (params.userId && params.userId !== 'system') {
        if ((tx as any).user?.findUnique) {
          const userExists = await (tx as any).user
            .findUnique({ where: { id: params.userId }, select: { id: true } })
            .catch(() => null);
          if (userExists) validPaidById = userExists.id;
        } else {
          validPaidById = params.userId;
        }
      }

      const updated = await tx.maintenanceInvoice.update({
        where: { id: params.invoiceId },
        data: {
          status: 'PAID',
          paidAt: new Date(),
          paidById: validPaidById,
          paymentReference: params.paymentReference,
          gatewayPaymentId: params.gatewayPaymentId,
          gatewayOrderId: params.gatewayOrderId || fresh.gatewayOrderId,
          paymentGateway: params.gateway,
        },
        include: {
          flat: {
            select: {
              id: true,
              flatNumber: true,
              building: { select: { name: true } },
            },
          },
          paidBy: { select: { id: true, name: true, email: true } },
        },
      });

      try {
        if (tx.auditLog?.create) {
          await tx.auditLog.create({
            data: {
              societyId: this.isUuid(params.societyId) ? params.societyId : null,
              actorUserId: this.isUuid(validPaidById) ? validPaidById : null,
              actorRole: validPaidById ? 'RESIDENT' : 'SYSTEM',
              action: 'INVOICE_PAID_ONLINE',
              entityType: 'MaintenanceInvoice',
              entityId: updated.id,
              meta: {
                amount: updated.amount,
                gateway: params.gateway,
                paymentReference: params.paymentReference,
                gatewayPaymentId: params.gatewayPaymentId,
                rawActor: params.userId || 'system',
              },
            },
          });
        }
      } catch (err) {
        this.logger.error(`Failed to create audit log for payment: ${String(err)}`);
      }

      // Determine recipient resident for notifications
      let notifyUserId = validPaidById || params.userId;
      if (!notifyUserId && (tx as any).residentFlatMembership?.findFirst) {
        const residentLink = await (tx as any).residentFlatMembership
          .findFirst({
            where: { flatId: fresh.flatId, endedAt: null },
            select: { userId: true },
          })
          .catch(() => null);
        if (residentLink) {
          notifyUserId = residentLink.userId;
        }
      }

      if (notifyUserId) {
        const payload = {
          title: updated.title,
          amount: updated.amount,
          paymentReference: params.paymentReference,
          flatNumber: updated.flat.flatNumber,
        };

        await this.notifications
          .enqueue({
            societyId: params.societyId,
            userId: notifyUserId,
            channel: 'PUSH',
            template: 'PAYMENT_CONFIRMATION',
            payload,
          })
          .catch((err) => this.logger.warn(`Failed to enqueue payment push notification: ${String(err)}`));

        await this.notifications
          .enqueue({
            societyId: params.societyId,
            userId: notifyUserId,
            channel: 'SMS',
            template: 'PAYMENT_CONFIRMATION',
            payload,
          })
          .catch((err) => this.logger.warn(`Failed to enqueue payment SMS notification: ${String(err)}`));

        await this.notifications
          .enqueue({
            societyId: params.societyId,
            userId: notifyUserId,
            channel: 'WHATSAPP',
            template: 'PAYMENT_CONFIRMATION',
            payload,
          })
          .catch((err) => this.logger.warn(`Failed to enqueue payment WhatsApp notification: ${String(err)}`));
      }

      return updated;
    });
  }
}
