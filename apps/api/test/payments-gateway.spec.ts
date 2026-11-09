import { createHmac } from 'crypto';
import { PaymentsService } from '../src/payments/payments.service';
import { PaymentsController } from '../src/payments/payments.controller';
import { WebhooksController } from '../src/payments/webhooks.controller';
import { AppException } from '../src/common/app.exception';
import { JwtUser } from '../src/auth/jwt-auth.guard';
import * as configModule from '../src/config';

// Mock gateway mode must be enabled explicitly; getEnv() is lazy so this is read on first use.
process.env.PAYMENTS_MOCK_MODE = 'true';

describe('Online Payment Gateway Integration Suite (Razorpay, Stripe & Webhooks)', () => {
  const SOCIETY_ID = 'soc-abc-123';
  const FLAT_ID = 'flat-101-xyz';
  const INVOICE_ID = 'inv-555';

  const residentUser: JwtUser = {
    sub: 'user-resident-1',
    email: 'resident@societyos.dev',
    name: 'Resident One',
    isPlatformAdmin: false,
    mustChangePassword: false,
  };

  let mockPrisma: any;
  let mockAuthz: any;
  let mockAudit: any;
  let mockNotifications: any;
  let service: PaymentsService;
  let paymentsController: PaymentsController;
  let webhooksController: WebhooksController;

  beforeEach(() => {
    mockPrisma = {
      maintenanceInvoice: {
        findUnique: jest.fn(),
        findFirst: jest.fn(),
        update: jest.fn(),
      },
      auditLog: {
        create: jest.fn(),
      },
      securityAlert: {
        create: jest.fn().mockResolvedValue(undefined),
      },
      $transaction: jest.fn(async (cb) => {
        const tx = {
          $executeRawUnsafe: jest.fn().mockResolvedValue(undefined),
          $executeRaw: jest.fn().mockResolvedValue(undefined),
          maintenanceInvoice: mockPrisma.maintenanceInvoice,
          auditLog: mockPrisma.auditLog,
        };
        return cb(tx);
      }),
    };

    mockAuthz = {
      flat: jest.fn().mockResolvedValue({ societyId: SOCIETY_ID, role: 'RESIDENT' }),
    };

    mockAudit = {
      record: jest.fn().mockResolvedValue(undefined),
    };

    mockNotifications = {
      enqueue: jest.fn().mockResolvedValue(undefined),
    };

    service = new PaymentsService(mockPrisma, mockAuthz, mockAudit, mockNotifications);
    paymentsController = new PaymentsController(service);
    webhooksController = new WebhooksController(service);
  });

  describe('Razorpay Order Creation & Verification', () => {
    const pendingInvoice = {
      id: INVOICE_ID,
      societyId: SOCIETY_ID,
      flatId: FLAT_ID,
      title: 'October Maintenance',
      amount: 3500.5,
      dueDate: new Date('2026-11-15'),
      status: 'PENDING',
      gatewayOrderId: null,
      flat: { id: FLAT_ID, flatNumber: '101', building: { name: 'Tower A' } },
    };

    test('creates Razorpay order with amount converted to paise (amount * 100)', async () => {
      mockPrisma.maintenanceInvoice.findUnique.mockResolvedValue(pendingInvoice);
      mockPrisma.maintenanceInvoice.update.mockResolvedValue({
        ...pendingInvoice,
        gatewayOrderId: 'order_mock_123',
      });

      const res = await service.createRazorpayOrder(residentUser, SOCIETY_ID, INVOICE_ID);

      expect(res.amount).toBe(350050); // 3500.5 * 100
      expect(res.currency).toBe('INR');
      expect(res.orderId).toBeDefined();
      expect(mockAuthz.flat).toHaveBeenCalledWith(residentUser.sub, FLAT_ID, ['SOCIETY_ADMIN', 'RESIDENT']);
      expect(mockPrisma.maintenanceInvoice.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: INVOICE_ID },
          data: expect.objectContaining({ paymentGateway: 'RAZORPAY' }),
        }),
      );
    });

    test('rejects Razorpay order creation if invoice is already paid', async () => {
      mockPrisma.maintenanceInvoice.findUnique.mockResolvedValue({
        ...pendingInvoice,
        status: 'PAID',
      });

      await expect(
        service.createRazorpayOrder(residentUser, SOCIETY_ID, INVOICE_ID),
      ).rejects.toThrow(AppException);
    });

    test('rejects Razorpay order creation for invoice belonging to a different society', async () => {
      mockPrisma.maintenanceInvoice.findUnique.mockResolvedValue({
        ...pendingInvoice,
        societyId: 'different-society',
      });

      await expect(
        service.createRazorpayOrder(residentUser, SOCIETY_ID, INVOICE_ID),
      ).rejects.toThrow(AppException);
    });

    test('verifies valid Razorpay payment signature and marks invoice PAID', async () => {
      const invoiceWithOrder = { ...pendingInvoice, gatewayOrderId: 'order_mock_123' };
      mockPrisma.maintenanceInvoice.findUnique
        .mockResolvedValueOnce(invoiceWithOrder) // for initial lookup
        .mockResolvedValueOnce(invoiceWithOrder); // inside transaction fresh lookup
      mockPrisma.maintenanceInvoice.update.mockResolvedValue({
        ...invoiceWithOrder,
        status: 'PAID',
        paidAt: new Date(),
        paidById: residentUser.sub,
        paymentReference: 'pay_rzp_999',
      });

      const res = await service.verifyRazorpayPayment(residentUser, SOCIETY_ID, INVOICE_ID, {
        razorpayOrderId: 'order_mock_123',
        razorpayPaymentId: 'pay_rzp_999',
        razorpaySignature: 'mock_sig_ok',
      });

      expect(res.status).toBe('PAID');
      expect(mockNotifications.enqueue).toHaveBeenCalled();
    });

    test('rejects Razorpay payment verification if invoice has no gateway order', async () => {
      mockPrisma.maintenanceInvoice.findUnique.mockResolvedValue(pendingInvoice);

      await expect(
        service.verifyRazorpayPayment(residentUser, SOCIETY_ID, INVOICE_ID, {
          razorpayOrderId: 'order_unrelated_123',
          razorpayPaymentId: 'pay_rzp_999',
          razorpaySignature: 'mock_sig_ok',
        }),
      ).rejects.toMatchObject({
        response: expect.objectContaining({ code: 'NO_GATEWAY_ORDER' }),
      });
    });

    test('rejects Razorpay payment verification if order ID does not match invoice order', async () => {
      mockPrisma.maintenanceInvoice.findUnique.mockResolvedValue({
        ...pendingInvoice,
        gatewayOrderId: 'order_expected_456',
      });

      await expect(
        service.verifyRazorpayPayment(residentUser, SOCIETY_ID, INVOICE_ID, {
          razorpayOrderId: 'order_different_789',
          razorpayPaymentId: 'pay_rzp_999',
          razorpaySignature: 'mock_sig_ok',
        }),
      ).rejects.toMatchObject({
        response: expect.objectContaining({ code: 'ORDER_ID_MISMATCH' }),
      });
    });

    test.each(['bad', 'arbitrary-signature-long-enough'])('rejects invalid mock signature %s', async (signature) => {
      const invoiceWithOrder = { ...pendingInvoice, gatewayOrderId: 'order_mock_123' };
      mockPrisma.maintenanceInvoice.findUnique.mockResolvedValue(invoiceWithOrder);

      await expect(
        service.verifyRazorpayPayment(residentUser, SOCIETY_ID, INVOICE_ID, {
          razorpayOrderId: 'order_mock_123',
          razorpayPaymentId: 'pay_rzp_999',
          razorpaySignature: signature,
        }),
      ).rejects.toThrow(AppException);
    });
  });

  describe('Stripe PaymentIntent Creation & Verification', () => {
    const pendingInvoice = {
      id: INVOICE_ID,
      societyId: SOCIETY_ID,
      flatId: FLAT_ID,
      title: 'Water Charges',
      amount: 1200,
      dueDate: new Date('2026-11-20'),
      status: 'PENDING',
      flat: { id: FLAT_ID, flatNumber: '202', building: { name: 'Tower B' } },
    };

    test('creates Stripe payment intent with amount in cents/paise', async () => {
      mockPrisma.maintenanceInvoice.findUnique.mockResolvedValue(pendingInvoice);
      mockPrisma.maintenanceInvoice.update.mockResolvedValue({
        ...pendingInvoice,
        gatewayOrderId: 'pi_test_123',
      });

      const res = await service.createStripePaymentIntent(residentUser, SOCIETY_ID, INVOICE_ID, {
        currency: 'inr',
      });

      expect(res.amount).toBe(120000);
      expect(res.clientSecret).toBeDefined();
      expect(res.paymentIntentId).toBeDefined();
    });

    test('rejects Stripe payment intent creation for non-INR currency', async () => {
      mockPrisma.maintenanceInvoice.findUnique.mockResolvedValue(pendingInvoice);

      await expect(
        service.createStripePaymentIntent(residentUser, SOCIETY_ID, INVOICE_ID, {
          currency: 'usd',
        }),
      ).rejects.toMatchObject({
        response: expect.objectContaining({ code: 'INVALID_CURRENCY' }),
      });
    });

    test('verifies Stripe payment and settles invoice idempotently', async () => {
      const invoiceWithIntent = { ...pendingInvoice, gatewayOrderId: 'pi_mock_complete' };
      mockPrisma.maintenanceInvoice.findUnique
        .mockResolvedValueOnce(invoiceWithIntent)
        .mockResolvedValueOnce(invoiceWithIntent);
      mockPrisma.maintenanceInvoice.update.mockResolvedValue({
        ...invoiceWithIntent,
        status: 'PAID',
      });

      const res = await service.verifyStripePayment(residentUser, SOCIETY_ID, INVOICE_ID, {
        paymentIntentId: 'pi_mock_complete',
      });

      expect(res.status).toBe('PAID');
    });

    test('rejects Stripe payment verification if invoice has no gateway order', async () => {
      mockPrisma.maintenanceInvoice.findUnique.mockResolvedValue(pendingInvoice);

      await expect(
        service.verifyStripePayment(residentUser, SOCIETY_ID, INVOICE_ID, {
          paymentIntentId: 'pi_unrelated_999',
        }),
      ).rejects.toMatchObject({
        response: expect.objectContaining({ code: 'NO_GATEWAY_ORDER' }),
      });
    });

    test('rejects Stripe payment verification if payment intent does not match invoice order', async () => {
      mockPrisma.maintenanceInvoice.findUnique.mockResolvedValue({
        ...pendingInvoice,
        gatewayOrderId: 'pi_expected_111',
      });

      await expect(
        service.verifyStripePayment(residentUser, SOCIETY_ID, INVOICE_ID, {
          paymentIntentId: 'pi_different_222',
        }),
      ).rejects.toMatchObject({
        response: expect.objectContaining({ code: 'PAYMENT_INTENT_MISMATCH' }),
      });
    });

    test('rejects Stripe payment intent creation in production when STRIPE_SECRET_KEY is missing', async () => {
      mockPrisma.maintenanceInvoice.findUnique.mockResolvedValue(pendingInvoice);
      const originalEnv = configModule.getEnv();
      const spy = jest.spyOn(configModule, 'getEnv').mockReturnValue({
        ...originalEnv,
        isProduction: true,
        stripeSecretKey: undefined,
      });

      try {
        await expect(
          service.createStripePaymentIntent(residentUser, SOCIETY_ID, INVOICE_ID, { currency: 'INR' }),
        ).rejects.toMatchObject({
          response: expect.objectContaining({ code: 'GATEWAY_NOT_CONFIGURED' }),
        });
      } finally {
        spy.mockRestore();
      }
    });

    test('verifyStripePayment wraps upstream fetch network errors as badGateway PAYMENT_GATEWAY_ERROR', async () => {
      const invoiceWithIntent = { ...pendingInvoice, gatewayOrderId: 'pi_test_123' };
      mockPrisma.maintenanceInvoice.findUnique.mockResolvedValue(invoiceWithIntent);

      const originalEnv = configModule.getEnv();
      const spyEnv = jest.spyOn(configModule, 'getEnv').mockReturnValue({
        ...originalEnv,
        stripeSecretKey: 'sk_test_mock_key',
      });
      const spyFetch = jest.spyOn(global, 'fetch').mockRejectedValue(new Error('Network connection reset'));

      try {
        await expect(
          service.verifyStripePayment(residentUser, SOCIETY_ID, INVOICE_ID, {
            paymentIntentId: 'pi_test_123',
          }),
        ).rejects.toMatchObject({
          response: expect.objectContaining({ code: 'PAYMENT_GATEWAY_ERROR' }),
        });
      } finally {
        spyEnv.mockRestore();
        spyFetch.mockRestore();
      }
    });

    test('verifyStripePayment wraps non-ok HTTP responses as badGateway PAYMENT_GATEWAY_ERROR', async () => {
      const invoiceWithIntent = { ...pendingInvoice, gatewayOrderId: 'pi_test_123' };
      mockPrisma.maintenanceInvoice.findUnique.mockResolvedValue(invoiceWithIntent);

      const originalEnv = configModule.getEnv();
      const spyEnv = jest.spyOn(configModule, 'getEnv').mockReturnValue({
        ...originalEnv,
        stripeSecretKey: 'sk_test_mock_key',
      });
      const spyFetch = jest.spyOn(global, 'fetch').mockResolvedValue({
        ok: false,
        status: 502,
        text: jest.fn().mockResolvedValue('Bad gateway from Stripe'),
      } as unknown as Response);

      try {
        await expect(
          service.verifyStripePayment(residentUser, SOCIETY_ID, INVOICE_ID, {
            paymentIntentId: 'pi_test_123',
          }),
        ).rejects.toMatchObject({
          response: expect.objectContaining({ code: 'PAYMENT_GATEWAY_ERROR' }),
        });
      } finally {
        spyEnv.mockRestore();
        spyFetch.mockRestore();
      }
    });

    test('verifyStripePayment preserves AppException when payment is not completed', async () => {
      const invoiceWithIntent = { ...pendingInvoice, gatewayOrderId: 'pi_test_123' };
      mockPrisma.maintenanceInvoice.findUnique.mockResolvedValue(invoiceWithIntent);

      const originalEnv = configModule.getEnv();
      const spyEnv = jest.spyOn(configModule, 'getEnv').mockReturnValue({
        ...originalEnv,
        stripeSecretKey: 'sk_test_mock_key',
      });
      const spyFetch = jest.spyOn(global, 'fetch').mockResolvedValue({
        ok: true,
        json: jest.fn().mockResolvedValue({ status: 'requires_payment_method' }),
      } as unknown as Response);

      try {
        await expect(
          service.verifyStripePayment(residentUser, SOCIETY_ID, INVOICE_ID, {
            paymentIntentId: 'pi_test_123',
          }),
        ).rejects.toMatchObject({
          response: expect.objectContaining({ code: 'PAYMENT_NOT_COMPLETED' }),
        });
      } finally {
        spyEnv.mockRestore();
        spyFetch.mockRestore();
      }
    });
  });

  describe('Webhooks: Razorpay & Stripe Callbacks', () => {
    const pendingInvoice = {
      id: INVOICE_ID,
      societyId: SOCIETY_ID,
      flatId: FLAT_ID,
      title: 'Annual Lift Maintenance',
      amount: 5000,
      status: 'PENDING',
      flat: { id: FLAT_ID, flatNumber: '303', building: { name: 'Tower C' } },
    };

    test('processes Razorpay order.paid webhook callback and settles invoice', async () => {
      const payload = {
        event: 'order.paid',
        payload: {
          order: {
            entity: {
              id: 'order_rzp_live_123',
              notes: {
                invoiceId: INVOICE_ID,
                societyId: SOCIETY_ID,
                userId: 'user-resident-1',
              },
            },
          },
          payment: {
            entity: {
              id: 'pay_rzp_live_456',
              amount: 500000,
            },
          },
        },
      };

      mockPrisma.maintenanceInvoice.findUnique
        .mockResolvedValueOnce(pendingInvoice) // for initial find
        .mockResolvedValueOnce(pendingInvoice); // inside transaction
      mockPrisma.maintenanceInvoice.update.mockResolvedValue({
        ...pendingInvoice,
        status: 'PAID',
      });

      const result = await service.handleRazorpayWebhook(JSON.stringify(payload));
      expect(result.received).toBe(true);
      expect(mockPrisma.maintenanceInvoice.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: 'PAID' }),
        }),
      );
    });

    test('processes Stripe payment_intent.succeeded webhook callback', async () => {
      const payload = {
        type: 'payment_intent.succeeded',
        data: {
          object: {
            id: 'pi_live_stripe_999',
            amount: 500000,
            metadata: {
              invoiceId: INVOICE_ID,
              societyId: SOCIETY_ID,
              userId: 'user-resident-1',
            },
          },
        },
      };

      mockPrisma.maintenanceInvoice.findUnique
        .mockResolvedValueOnce(pendingInvoice)
        .mockResolvedValueOnce(pendingInvoice);
      mockPrisma.maintenanceInvoice.update.mockResolvedValue({
        ...pendingInvoice,
        status: 'PAID',
      });

      const result = await service.handleStripeWebhook(JSON.stringify(payload));
      expect(result.received).toBe(true);
      expect(mockPrisma.maintenanceInvoice.update).toHaveBeenCalled();
    });

    test('idempotency: webhook safely returns if invoice was already paid', async () => {
      const payload = {
        type: 'payment_intent.succeeded',
        data: {
          object: {
            id: 'pi_live_stripe_999',
            metadata: { invoiceId: INVOICE_ID },
          },
        },
      };

      mockPrisma.maintenanceInvoice.findUnique.mockResolvedValue({
        ...pendingInvoice,
        status: 'PAID',
      });

      const result = await service.handleStripeWebhook(JSON.stringify(payload));
      expect(result.received).toBe(true);
      // update should not be called because status was already PAID
      expect(mockPrisma.maintenanceInvoice.update).not.toHaveBeenCalled();
    });

    test('supports Stripe webhook with multiple signatures during secret rotation', async () => {
      const payload = JSON.stringify({
        type: 'payment_intent.succeeded',
        data: {
          object: {
            id: 'pi_rot_123',
            amount: 500000,
            metadata: { invoiceId: INVOICE_ID },
          },
        },
      });

      mockPrisma.maintenanceInvoice.findUnique
        .mockResolvedValueOnce(pendingInvoice)
        .mockResolvedValueOnce(pendingInvoice);
      mockPrisma.maintenanceInvoice.update.mockResolvedValue({
        ...pendingInvoice,
        status: 'PAID',
      });

      // Signature header with multiple v1 signatures
      const nowSec = Math.floor(Date.now() / 1000);
      const secret = 'whsec_test_secret_12345';
      process.env.STRIPE_WEBHOOK_SECRET = secret;

      const validSig = createHmac('sha256', secret).update(`${nowSec}.${payload}`).digest('hex');
      const sigHeader = `t=${nowSec},v1=old_rolled_signature,v1=${validSig}`;

      const result = await service.handleStripeWebhook(payload, sigHeader);
      expect(result.received).toBe(true);
      expect(mockPrisma.maintenanceInvoice.update).toHaveBeenCalled();
      delete process.env.STRIPE_WEBHOOK_SECRET;
    });

    test('safely ignores webhook for cancelled invoice without failing', async () => {
      const payload = {
        type: 'payment_intent.succeeded',
        data: {
          object: {
            id: 'pi_canc_123',
            metadata: { invoiceId: INVOICE_ID },
          },
        },
      };

      mockPrisma.maintenanceInvoice.findUnique.mockResolvedValue({
        ...pendingInvoice,
        status: 'CANCELLED',
      });

      const result = await service.handleStripeWebhook(JSON.stringify(payload));
      expect(result.received).toBe(true);
      expect(result.status).toBe('ignored_cancelled');
      expect(mockPrisma.maintenanceInvoice.update).not.toHaveBeenCalled();
    });

    test('safely rejects webhook if order ID does not match invoice gatewayOrderId', async () => {
      const payload = {
        type: 'payment_intent.succeeded',
        data: {
          object: {
            id: 'pi_unrelated_order_999',
            metadata: { invoiceId: INVOICE_ID },
          },
        },
      };

      mockPrisma.maintenanceInvoice.findUnique.mockResolvedValue({
        ...pendingInvoice,
        gatewayOrderId: 'pi_original_order_111',
      });

      const result = await service.handleStripeWebhook(JSON.stringify(payload));
      expect(result.received).toBe(true);
      expect(result.status).toBe('order_mismatch');
      expect(mockPrisma.maintenanceInvoice.update).not.toHaveBeenCalled();
    });

    test('rejects Razorpay webhook if order ID does not match invoice gatewayOrderId', async () => {
      const payload = {
        event: 'order.paid',
        payload: {
          order: {
            entity: {
              id: 'order_rzp_wrong_999',
              notes: { invoiceId: INVOICE_ID },
            },
          },
          payment: {
            entity: { id: 'pay_rzp_wrong' },
          },
        },
      };

      mockPrisma.maintenanceInvoice.findUnique.mockResolvedValue({
        ...pendingInvoice,
        gatewayOrderId: 'order_rzp_expected_111',
      });

      const result = await service.handleRazorpayWebhook(JSON.stringify(payload));
      expect(result.received).toBe(true);
      expect(result.status).toBe('order_mismatch');
      expect(mockPrisma.maintenanceInvoice.update).not.toHaveBeenCalled();
    });

    test.each([1000, 500001])('flags mismatched Razorpay amount %i', async (amount) => {
      const payload = {
        event: 'payment.captured',
        payload: {
          payment: {
            entity: {
              id: 'pay_underpaid',
              order_id: 'order_rzp_expected_111',
              amount, // Invoice is 500000 paise; underpayment and overpayment both need reconciliation.
              currency: 'INR',
              notes: { invoiceId: INVOICE_ID },
            },
          },
        },
      };

      mockPrisma.maintenanceInvoice.findUnique.mockResolvedValue({
        ...pendingInvoice,
        amount: 5000,
        gatewayOrderId: 'order_rzp_expected_111',
      });

      const result = await service.handleRazorpayWebhook(JSON.stringify(payload));
      expect(result.received).toBe(true);
      expect(result.status).toBe('amount_mismatch');
      expect(mockPrisma.maintenanceInvoice.update).not.toHaveBeenCalled();
    });

    test('rejects Razorpay webhook if currency is not INR', async () => {
      const payload = {
        event: 'payment.captured',
        payload: {
          payment: {
            entity: {
              id: 'pay_foreign_currency',
              order_id: 'order_rzp_expected_111',
              amount: 500000,
              currency: 'USD',
              notes: { invoiceId: INVOICE_ID },
            },
          },
        },
      };

      mockPrisma.maintenanceInvoice.findUnique.mockResolvedValue({
        ...pendingInvoice,
        amount: 5000,
        gatewayOrderId: 'order_rzp_expected_111',
      });

      const result = await service.handleRazorpayWebhook(JSON.stringify(payload));
      expect(result.received).toBe(true);
      expect(result.status).toBe('currency_mismatch');
      expect(mockPrisma.maintenanceInvoice.update).not.toHaveBeenCalled();
    });
  });

  describe('Adversarial & Edge Cases (Amount & Order ID validation)', () => {
    const pendingInvoice = {
      id: INVOICE_ID,
      societyId: SOCIETY_ID,
      flatId: FLAT_ID,
      title: 'October Maintenance',
      amount: 3500.5,
      status: 'PENDING',
      gatewayOrderId: 'order_expected_123',
      flat: { id: FLAT_ID, flatNumber: '101', building: { name: 'Tower A' } },
    };

    test('rejects Razorpay order creation when invoice amount is zero or negative', async () => {
      mockPrisma.maintenanceInvoice.findUnique.mockResolvedValue({
        ...pendingInvoice,
        amount: 0,
      });

      await expect(
        service.createRazorpayOrder(residentUser, SOCIETY_ID, INVOICE_ID),
      ).rejects.toThrow(AppException);
    });

    test('rejects Razorpay payment verification when order ID does not match invoice', async () => {
      mockPrisma.maintenanceInvoice.findUnique.mockResolvedValue(pendingInvoice);

      await expect(
        service.verifyRazorpayPayment(residentUser, SOCIETY_ID, INVOICE_ID, {
          razorpayOrderId: 'order_mismatched_999',
          razorpayPaymentId: 'pay_rzp_999',
          razorpaySignature: 'mock_sig_ok',
        }),
      ).rejects.toThrow(AppException);
    });

    test('rejects Stripe payment verification when paymentIntentId does not match invoice', async () => {
      mockPrisma.maintenanceInvoice.findUnique.mockResolvedValue({
        ...pendingInvoice,
        gatewayOrderId: 'pi_expected_original',
      });

      await expect(
        service.verifyStripePayment(residentUser, SOCIETY_ID, INVOICE_ID, {
          paymentIntentId: 'pi_different_spoofed',
        }),
      ).rejects.toThrow(AppException);
    });
  });

  describe('Payments & Webhooks Controllers', () => {
    test('PaymentsController delegates to PaymentsService', async () => {
      const spy = jest.spyOn(service, 'createRazorpayOrder').mockResolvedValue({
        orderId: 'ord_1',
        amount: 1000,
        currency: 'INR',
        keyId: 'k1',
        invoiceId: INVOICE_ID,
        flatNumber: '101',
        title: 'Dues',
      });

      const res = await paymentsController.createRazorpayOrder(
        residentUser,
        SOCIETY_ID,
        INVOICE_ID,
        {},
      );
      expect(res.orderId).toBe('ord_1');
      expect(spy).toHaveBeenCalled();
    });

    test('WebhooksController extracts rawBody and forwards to service', async () => {
      const spy = jest.spyOn(service, 'handleRazorpayWebhook').mockResolvedValue({ received: true });
      const req: any = { rawBody: Buffer.from('{"event":"ping"}') };

      const res = await webhooksController.razorpayWebhook(req, 'sig_header');
      expect(res.received).toBe(true);
      expect(spy).toHaveBeenCalledWith(req.rawBody, 'sig_header');
    });

    test('settleInvoice propagates advisory lock errors instead of swallowing them', async () => {
      mockPrisma.maintenanceInvoice.findUnique.mockResolvedValueOnce({
        id: INVOICE_ID,
        societyId: SOCIETY_ID,
        flatId: FLAT_ID,
        status: 'PENDING',
        amount: 500,
        gatewayOrderId: 'order_rzp_123',
      });
      mockPrisma.$transaction.mockImplementationOnce(async (cb: (tx: unknown) => Promise<unknown>) => {
        const tx = {
          $executeRaw: jest.fn().mockRejectedValue(new Error('Deadlock detected')),
          $executeRawUnsafe: jest.fn().mockResolvedValue(undefined),
          maintenanceInvoice: mockPrisma.maintenanceInvoice,
          auditLog: mockPrisma.auditLog,
        };
        return cb(tx);
      });

      await expect(
        service.verifyRazorpayPayment(residentUser, SOCIETY_ID, INVOICE_ID, {
          razorpayOrderId: 'order_rzp_123',
          razorpayPaymentId: 'pay_rzp_123',
          razorpaySignature: 'mock_sig_ok',
        }),
      ).rejects.toThrow('Deadlock detected');
    });
  });

  describe('Payment regressions (order reuse, unsettled flagging, fail-closed guards)', () => {
    const invoice = {
      id: INVOICE_ID,
      societyId: SOCIETY_ID,
      flatId: FLAT_ID,
      title: 'October Maintenance',
      amount: 5000,
      status: 'PENDING',
      gatewayOrderId: null as string | null,
      paymentGateway: null as string | null,
      flat: { id: FLAT_ID, flatNumber: '101', building: { name: 'Tower A' } },
    };
    const withEnv = async (overrides: Partial<ReturnType<typeof configModule.getEnv>>, fn: () => Promise<void>) => {
      const spy = jest.spyOn(configModule, 'getEnv').mockReturnValue({ ...configModule.getEnv(), ...overrides });
      try {
        await fn();
      } finally {
        spy.mockRestore();
      }
    };
    const notConfigured = { response: expect.objectContaining({ code: 'GATEWAY_NOT_CONFIGURED' }) };

    test('createRazorpayOrder reuses the existing open order instead of overwriting it', async () => {
      mockPrisma.maintenanceInvoice.findUnique.mockResolvedValue({
        ...invoice,
        gatewayOrderId: 'order_first',
        paymentGateway: 'RAZORPAY',
      });

      const res = await service.createRazorpayOrder(residentUser, SOCIETY_ID, INVOICE_ID);

      expect(res.orderId).toBe('order_first');
      expect(mockPrisma.maintenanceInvoice.update).not.toHaveBeenCalled();
    });

    test('createStripePaymentIntent reuses the existing PaymentIntent in mock mode', async () => {
      mockPrisma.maintenanceInvoice.findUnique.mockResolvedValue({
        ...invoice,
        gatewayOrderId: 'pi_first',
        paymentGateway: 'STRIPE',
      });

      const res = await service.createStripePaymentIntent(residentUser, SOCIETY_ID, INVOICE_ID, { currency: 'INR' });

      expect(res.paymentIntentId).toBe('pi_first');
      expect(mockPrisma.maintenanceInvoice.update).not.toHaveBeenCalled();
    });

    test('createStripePaymentIntent reuses a live open PaymentIntent with matching amount', async () => {
      mockPrisma.maintenanceInvoice.findUnique.mockResolvedValue({
        ...invoice,
        gatewayOrderId: 'pi_first',
        paymentGateway: 'STRIPE',
      });
      const spyFetch = jest.spyOn(global, 'fetch').mockResolvedValue({
        ok: true,
        json: async () => ({
          id: 'pi_first',
          client_secret: 'pi_first_secret_x',
          status: 'requires_payment_method',
          amount: 500000,
          currency: 'inr',
        }),
      } as unknown as Response);
      try {
        await withEnv({ stripeSecretKey: 'sk_test_x' }, async () => {
          const res = await service.createStripePaymentIntent(residentUser, SOCIETY_ID, INVOICE_ID, { currency: 'INR' });
          expect(res.paymentIntentId).toBe('pi_first');
          expect(res.clientSecret).toBe('pi_first_secret_x');
          expect(spyFetch).toHaveBeenCalledTimes(1);
        });
      } finally {
        spyFetch.mockRestore();
      }
      expect(mockPrisma.maintenanceInvoice.update).not.toHaveBeenCalled();
    });

    test('createStripePaymentIntent starts a new PaymentIntent when Stripe no longer knows the stored one', async () => {
      // e.g. the stored id came from test-mode keys or mock mode before live keys were configured.
      mockPrisma.maintenanceInvoice.findUnique.mockResolvedValue({
        ...invoice,
        gatewayOrderId: 'pi_from_test_keys',
        paymentGateway: 'STRIPE',
      });
      const spyFetch = jest
        .spyOn(global, 'fetch')
        .mockResolvedValueOnce({ ok: false, status: 404, json: async () => ({}) } as unknown as Response)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ id: 'pi_new', client_secret: 'pi_new_secret_x' }),
        } as unknown as Response);
      try {
        await withEnv({ stripeSecretKey: 'sk_live_x' }, async () => {
          const res = await service.createStripePaymentIntent(residentUser, SOCIETY_ID, INVOICE_ID, { currency: 'INR' });
          expect(res.paymentIntentId).toBe('pi_new');
        });
      } finally {
        spyFetch.mockRestore();
      }
      expect(mockPrisma.maintenanceInvoice.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ gatewayOrderId: 'pi_new' }) }),
      );
    });

    test.each(['processing', 'succeeded'])(
      'createStripePaymentIntent refuses a second checkout while the stored PaymentIntent is %s',
      async (status) => {
        mockPrisma.maintenanceInvoice.findUnique.mockResolvedValue({
          ...invoice,
          gatewayOrderId: 'pi_first',
          paymentGateway: 'STRIPE',
        });
        const spyFetch = jest.spyOn(global, 'fetch').mockResolvedValue({
          ok: true,
          json: async () => ({ id: 'pi_first', client_secret: 'pi_first_secret_x', status, amount: 500000, currency: 'inr' }),
        } as unknown as Response);
        try {
          await withEnv({ stripeSecretKey: 'sk_live_x' }, async () => {
            await expect(
              service.createStripePaymentIntent(residentUser, SOCIETY_ID, INVOICE_ID, { currency: 'INR' }),
            ).rejects.toMatchObject({ response: expect.objectContaining({ code: 'PAYMENT_IN_PROGRESS' }) });
          });
          expect(spyFetch).toHaveBeenCalledTimes(1);
        } finally {
          spyFetch.mockRestore();
        }
        expect(mockPrisma.maintenanceInvoice.update).not.toHaveBeenCalled();
      },
    );

    test('captured payment on a mismatched order is flagged via SecurityAlert, not dropped silently', async () => {
      mockPrisma.maintenanceInvoice.findUnique.mockResolvedValue({ ...invoice, gatewayOrderId: 'order_second' });
      const payload = {
        event: 'payment.captured',
        payload: {
          payment: {
            entity: { id: 'pay_1', order_id: 'order_first', amount: 500000, currency: 'INR', notes: { invoiceId: INVOICE_ID } },
          },
        },
      };

      const result = await service.handleRazorpayWebhook(JSON.stringify(payload));

      expect(result.status).toBe('order_mismatch');
      expect(mockPrisma.securityAlert.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          type: 'PAYMENT_UNSETTLED',
          detail: expect.objectContaining({ reason: 'order_mismatch', paymentId: 'pay_1' }),
        }),
      });
    });

    test('payment captured for a cancelled invoice is flagged for refund (webhook and verify)', async () => {
      mockPrisma.maintenanceInvoice.findUnique.mockResolvedValue({
        ...invoice,
        status: 'CANCELLED',
        gatewayOrderId: 'order_first',
      });
      const payload = {
        event: 'payment.captured',
        payload: {
          payment: {
            entity: { id: 'pay_2', order_id: 'order_first', amount: 500000, currency: 'INR', notes: { invoiceId: INVOICE_ID } },
          },
        },
      };

      const result = await service.handleRazorpayWebhook(JSON.stringify(payload));
      expect(result.status).toBe('ignored_cancelled');
      expect(mockPrisma.securityAlert.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          detail: expect.objectContaining({ reason: 'invoice_cancelled', paymentId: 'pay_2' }),
        }),
      });

      mockPrisma.securityAlert.create.mockClear();
      await expect(
        service.verifyRazorpayPayment(residentUser, SOCIETY_ID, INVOICE_ID, {
          razorpayOrderId: 'order_first',
          razorpayPaymentId: 'pay_3',
          razorpaySignature: 'mock_sig_ok',
        }),
      ).rejects.toMatchObject({ response: expect.objectContaining({ code: 'INVOICE_CANCELLED' }) });
      expect(mockPrisma.securityAlert.create).toHaveBeenCalledTimes(1);
    });

    test('webhooks do not settle when the captured amount is missing', async () => {
      mockPrisma.maintenanceInvoice.findUnique.mockResolvedValue({ ...invoice, gatewayOrderId: 'order_first' });
      const rzp = await service.handleRazorpayWebhook(
        JSON.stringify({
          event: 'payment.captured',
          payload: { payment: { entity: { id: 'pay_4', order_id: 'order_first', notes: { invoiceId: INVOICE_ID } } } },
        }),
      );
      expect(rzp.status).toBe('amount_mismatch');

      mockPrisma.maintenanceInvoice.findUnique.mockResolvedValue({ ...invoice, gatewayOrderId: 'pi_first' });
      const stripe = await service.handleStripeWebhook(
        JSON.stringify({
          type: 'payment_intent.succeeded',
          data: { object: { id: 'pi_first', metadata: { invoiceId: INVOICE_ID } } },
        }),
      );
      expect(stripe.status).toBe('amount_mismatch');
      expect(mockPrisma.maintenanceInvoice.update).not.toHaveBeenCalled();
    });

    test('verifyStripePayment rejects a succeeded PaymentIntent with no amount', async () => {
      mockPrisma.maintenanceInvoice.findUnique.mockResolvedValue({ ...invoice, gatewayOrderId: 'pi_first' });
      const spyFetch = jest.spyOn(global, 'fetch').mockResolvedValue({
        ok: true,
        json: async () => ({ status: 'succeeded', currency: 'inr' }),
      } as unknown as Response);
      try {
        await withEnv({ stripeSecretKey: 'sk_test_x' }, async () => {
          await expect(
            service.verifyStripePayment(residentUser, SOCIETY_ID, INVOICE_ID, { paymentIntentId: 'pi_first' }),
          ).rejects.toMatchObject({ response: expect.objectContaining({ code: 'INSUFFICIENT_AMOUNT' }) });
        });
      } finally {
        spyFetch.mockRestore();
      }
      expect(mockPrisma.maintenanceInvoice.update).not.toHaveBeenCalled();
    });

    test('without PAYMENTS_MOCK_MODE, unconfigured gateways fail closed (no mock order, signature or webhook)', async () => {
      await withEnv({ paymentsMockMode: false }, async () => {
        mockPrisma.maintenanceInvoice.findUnique.mockResolvedValue({ ...invoice, gatewayOrderId: 'order_first' });

        await expect(service.createRazorpayOrder(residentUser, SOCIETY_ID, INVOICE_ID)).rejects.toMatchObject(notConfigured);
        await expect(
          service.createStripePaymentIntent(residentUser, SOCIETY_ID, INVOICE_ID, { currency: 'INR' }),
        ).rejects.toMatchObject(notConfigured);
        await expect(
          service.verifyRazorpayPayment(residentUser, SOCIETY_ID, INVOICE_ID, {
            razorpayOrderId: 'order_first',
            razorpayPaymentId: 'pay_5',
            razorpaySignature: 'mock_sig_ok',
          }),
        ).rejects.toMatchObject(notConfigured);
        await expect(
          service.verifyStripePayment(residentUser, SOCIETY_ID, INVOICE_ID, { paymentIntentId: 'order_first' }),
        ).rejects.toMatchObject(notConfigured);
        await expect(service.handleRazorpayWebhook('{}')).rejects.toMatchObject(notConfigured);
        await expect(service.handleStripeWebhook('{}')).rejects.toMatchObject(notConfigured);
      });
      expect(mockPrisma.maintenanceInvoice.update).not.toHaveBeenCalled();
    });

    test('mock mode is never honoured in production', async () => {
      await withEnv({ paymentsMockMode: true, isProduction: true }, async () => {
        await expect(service.handleStripeWebhook('{}')).rejects.toMatchObject(notConfigured);
      });
    });
  });
});
