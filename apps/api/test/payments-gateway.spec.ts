import { createHmac } from 'crypto';
import { PaymentsService } from '../src/payments/payments.service';
import { PaymentsController } from '../src/payments/payments.controller';
import { WebhooksController } from '../src/payments/webhooks.controller';
import { AppException } from '../src/common/app.exception';
import { JwtUser } from '../src/auth/jwt-auth.guard';

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
      $transaction: jest.fn(async (cb) => {
        const tx = {
          $executeRawUnsafe: jest.fn().mockResolvedValue(undefined),
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

    test('rejects Razorpay payment with invalid signature', async () => {
      const invoiceWithOrder = { ...pendingInvoice, gatewayOrderId: 'order_mock_123' };
      mockPrisma.maintenanceInvoice.findUnique.mockResolvedValue(invoiceWithOrder);

      await expect(
        service.verifyRazorpayPayment(residentUser, SOCIETY_ID, INVOICE_ID, {
          razorpayOrderId: 'order_mock_123',
          razorpayPaymentId: 'pay_rzp_999',
          razorpaySignature: 'bad',
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

    test('rejects Razorpay webhook if amount is less than invoice amount', async () => {
      const payload = {
        event: 'payment.captured',
        payload: {
          payment: {
            entity: {
              id: 'pay_underpaid',
              order_id: 'order_rzp_expected_111',
              amount: 1000, // 10 INR (invoice is 5000 INR = 500000 paise)
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
  });
});
