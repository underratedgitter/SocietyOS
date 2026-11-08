import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { createHmac } from 'crypto';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../common/prisma.service';
import { getEnv } from '../config';
import { SmsDispatcherService } from './sms-dispatcher.service';
import { WhatsappDispatcherService } from './whatsapp-dispatcher.service';
import { PushDispatcherService } from './push-dispatcher.service';

const MAX_ATTEMPTS = 5;

export type NotificationChannelType = 'PUSH' | 'SMS' | 'EMAIL' | 'WHATSAPP';


/**
 * Link to the visitor's pass page. The QR token goes in the URL fragment, which browsers never
 * send to a server, so it stays out of access logs; the page renders the QR client-side.
 */
export function passQrUrl(passId: string, qrToken: string): string {
  return `${getEnv().webUrl}/p/${encodeURIComponent(passId)}#qr=${encodeURIComponent(qrToken)}`;
}
@Injectable()
export class NotificationsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(NotificationsService.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly smsDispatcher: SmsDispatcherService,
    private readonly whatsappDispatcher: WhatsappDispatcherService,
    private readonly pushDispatcher: PushDispatcherService,
  ) {}

  onModuleInit(): void {
    this.timer = setInterval(() => void this.drain(), 5000);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async enqueue(input: {
    societyId?: string;
    userId?: string;
    channel: NotificationChannelType;
    template: string;
    payload: Record<string, unknown>;
  }): Promise<void> {
    await this.prisma.notification.create({
      data: {
        societyId: input.societyId,
        userId: input.userId,
        channel: input.channel as any,
        template: input.template,
        payload: input.payload as never,
        nextAttemptAt: new Date(),
      },
    });
  }

  /**
   * High-level automation: Notify visitor and host upon pass creation.
   */
  async notifyPassCreated(params: {
    societyId: string;
    flatId: string;
    flatNumber?: string;
    visitorName: string;
    visitorPhone?: string | null;
    hostUserId: string;
    pin?: string;
    qrToken?: string;
    validFrom: Date;
    validUntil: Date;
    passId: string;
  }): Promise<void> {
    const validWindow = `${params.validFrom.toLocaleDateString()} ${params.validFrom.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} - ${params.validUntil.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
    const commonPayload = {
      passId: params.passId,
      flatId: params.flatId,
      flatNumber: params.flatNumber,
      visitorName: params.visitorName,
      validWindow,
    };
    // Credentials go only to the visitor's own phone, never into push payloads (a third-party
    // relay); the host already has them in the create response.
    const visitorCredentials = {
      pin: params.pin,
      // The /p page renders the QR from the link fragment; without a token it has nothing to show.
      ...(params.qrToken ? { passUrl: passQrUrl(params.passId, params.qrToken) } : {}),
    };

    // 1. Notify visitor via SMS if phone is present
    if (params.visitorPhone) {
      await this.enqueue({
        societyId: params.societyId,
        channel: 'SMS',
        template: 'VISITOR_PASS_ISSUED',
        payload: {
          ...commonPayload,
          ...visitorCredentials,
          phone: params.visitorPhone,
        },
      });

      // 2. Notify visitor via WhatsApp
      await this.enqueue({
        societyId: params.societyId,
        channel: 'WHATSAPP',
        template: 'VISITOR_PASS_ISSUED',
        payload: {
          ...commonPayload,
          ...visitorCredentials,
          phone: params.visitorPhone,
        },
      });
    }

    // 3. Notify host resident via Mobile Push
    await this.enqueue({
      societyId: params.societyId,
      userId: params.hostUserId,
      channel: 'PUSH',
      template: 'VISITOR_PASS_ISSUED',
      payload: commonPayload,
    });
  }

  /**
   * High-level automation: Notify visitor and host when pass is approved.
   */
  async notifyPassApproved(params: {
    societyId: string;
    flatNumber?: string;
    visitorName: string;
    visitorPhone?: string | null;
    hostUserId: string;
    pin?: string;
    qrToken?: string;
    validFrom: Date;
    validUntil: Date;
    passId: string;
  }): Promise<void> {
    const validWindow = `${params.validFrom.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} - ${params.validUntil.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
    const commonPayload = {
      passId: params.passId,
      flatNumber: params.flatNumber,
      visitorName: params.visitorName,
      validWindow,
    };

    if (params.visitorPhone) {
      // Credentials only to the visitor's phone; the approver gets them in the API response.
      const visitorPayload = {
        ...commonPayload,
        pin: params.pin,
        phone: params.visitorPhone,
        ...(params.qrToken ? { passUrl: passQrUrl(params.passId, params.qrToken) } : {}),
      };
      await this.enqueue({
        societyId: params.societyId,
        channel: 'SMS',
        template: 'VISITOR_PASS_APPROVED',
        payload: visitorPayload,
      });
      await this.enqueue({
        societyId: params.societyId,
        channel: 'WHATSAPP',
        template: 'VISITOR_PASS_APPROVED',
        payload: visitorPayload,
      });
    }

    await this.enqueue({
      societyId: params.societyId,
      userId: params.hostUserId,
      channel: 'PUSH',
      template: 'VISITOR_PASS_APPROVED',
      payload: commonPayload,
    });
  }

  /**
   * High-level automation: Notify visitor and host when pass is revoked.
   */
  async notifyPassRevoked(params: {
    societyId: string;
    flatNumber?: string;
    visitorName: string;
    visitorPhone?: string | null;
    hostUserId: string;
    passId: string;
  }): Promise<void> {
    const commonPayload = {
      passId: params.passId,
      flatNumber: params.flatNumber,
      visitorName: params.visitorName,
    };

    if (params.visitorPhone) {
      await this.enqueue({
        societyId: params.societyId,
        channel: 'SMS',
        template: 'VISITOR_PASS_REVOKED',
        payload: { ...commonPayload, phone: params.visitorPhone },
      });
    }

    await this.enqueue({
      societyId: params.societyId,
      userId: params.hostUserId,
      channel: 'PUSH',
      template: 'VISITOR_PASS_REVOKED',
      payload: commonPayload,
    });
  }

  /**
   * High-level automation: Gate arrival alerts (Push + SMS + WhatsApp).
   */
  async notifyGateArrival(params: {
    societyId: string;
    hostUserId: string;
    visitorName: string;
    accessPointName?: string;
    flatNumber?: string;
  }): Promise<void> {
    const payload = {
      visitorName: params.visitorName,
      accessPointName: params.accessPointName,
      flatNumber: params.flatNumber,
      at: new Date().toISOString(),
    };

    // 1. Mobile Push
    await this.enqueue({
      societyId: params.societyId,
      userId: params.hostUserId,
      channel: 'PUSH',
      template: 'VISITOR_ARRIVED',
      payload,
    });

    // 2. Fetch host resident's phone number to send SMS / WhatsApp arrival alert
    const hostUser = await this.prisma.user.findUnique({
      where: { id: params.hostUserId },
      select: { phone: true },
    });

    if (hostUser?.phone) {
      await this.enqueue({
        societyId: params.societyId,
        userId: params.hostUserId,
        channel: 'SMS',
        template: 'VISITOR_ARRIVED',
        payload: { ...payload, phone: hostUser.phone },
      });

      await this.enqueue({
        societyId: params.societyId,
        userId: params.hostUserId,
        channel: 'WHATSAPP',
        template: 'VISITOR_ARRIVED',
        payload: { ...payload, phone: hostUser.phone },
      });
    }
  }

  async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const now = new Date();
      const pending = await this.prisma.notification.findMany({
        where: {
          status: 'PENDING',
          attempts: { lt: MAX_ATTEMPTS },
          OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }],
        },
        orderBy: { createdAt: 'asc' },
        take: 20,
      });

      for (const notification of pending) {
        const claimed = await this.prisma.notification.updateMany({
          where: {
            id: notification.id,
            status: 'PENDING',
            attempts: notification.attempts,
          },
          data: {
            attempts: { increment: 1 },
            nextAttemptAt: new Date(Date.now() + 60_000),
          },
        });
        if (claimed.count !== 1) continue;

        try {
          await this.deliver(
            notification.channel as NotificationChannelType,
            notification.template,
            notification.payload as Record<string, any>,
            notification.userId,
          );
          const sanitizedPayload = this.stripCredentials(notification.payload);
          await this.prisma.notification.update({
            where: { id: notification.id },
            data: {
              status: 'SENT',
              sentAt: new Date(),
              lastError: null,
              nextAttemptAt: null,
              payload: sanitizedPayload as Prisma.InputJsonValue,
            },
          });
        } catch (error) {
          const attempts = notification.attempts + 1;
          const isFailed = attempts >= MAX_ATTEMPTS;
          const sanitizedPayload = isFailed ? this.stripCredentials(notification.payload) : undefined;
          await this.prisma.notification.update({
            where: { id: notification.id },
            data: {
              status: isFailed ? 'FAILED' : 'PENDING',
              lastError: String(error).slice(0, 500),
              nextAttemptAt: isFailed ? null : new Date(Date.now() + 60_000 * attempts),
              ...(sanitizedPayload !== undefined ? { payload: sanitizedPayload as Prisma.InputJsonValue } : {}),
            },
          });
          this.logger.warn(`Notification ${notification.id} delivery failed (attempt ${attempts}): ${String(error)}`);
        }
      }
    } catch (error) {
      this.logger.warn(`Outbox drain failed: ${String(error)}`);
    } finally {
      this.running = false;
    }
  }

  /** Removes plaintext credentials (PIN, and the pass link that carries the QR token). */
  private stripCredentials(payload: unknown): unknown {
    if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
      const copy = { ...(payload as Record<string, unknown>) };
      delete copy.pin;
      delete copy.passUrl;
      return copy;
    }
    return payload;
  }

  private async deliver(
    channel: NotificationChannelType,
    template: string,
    payload: Record<string, any>,
    userId?: string | null,
  ): Promise<void> {
    const targetUser = userId || (payload.targetUserId as string | undefined);

    // 1. Channel Dispatching
    switch (channel) {
      case 'SMS': {
        const phone = payload.phone || (targetUser ? await this.getUserPhone(targetUser) : null);
        if (phone) {
          await this.smsDispatcher.sendSms(phone, template, payload);
        } else {
          this.logger.warn(`Cannot deliver SMS for template ${template}: no recipient phone found`);
        }
        break;
      }
      case 'WHATSAPP': {
        const phone = payload.phone || (targetUser ? await this.getUserPhone(targetUser) : null);
        if (phone) {
          await this.whatsappDispatcher.sendWhatsapp(phone, template, payload);
        } else {
          this.logger.warn(`Cannot deliver WhatsApp for template ${template}: no recipient phone found`);
        }
        break;
      }
      case 'PUSH': {
        if (targetUser) {
          const res = await this.pushDispatcher.sendToUser(targetUser, template, payload);
          if (res.sentCount === 0 && res.failedCount > 0) {
            throw new Error(`Push notification delivery failed for user ${targetUser} (${res.failedCount} devices failed)`);
          }
        } else if (payload.token) {
          const res = await this.pushDispatcher.sendExpoPushBatch([
            {
              to: payload.token,
              ...this.pushDispatcher.formatPushPayload(template, payload),
              data: payload,
            },
          ]);
          if (res.sent === 0 && res.failed > 0) {
            throw new Error(`Push notification delivery failed for token ${payload.token}`);
          }
        }
        break;
      }
      case 'EMAIL': {
        this.logger.log(`Email notification queued (${template})`);
        break;
      }
    }

    // 2. Webhook Dispatching (if configured)
    const env = getEnv();
    if (env.notificationWebhookUrl) {
      await this.fireWebhook(env.notificationWebhookUrl, env.notificationWebhookSecret, {
        channel,
        template,
        payload,
        userId,
      });
    }
  }

  private async getUserPhone(userId: string): Promise<string | null> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { phone: true },
    });
    return user?.phone ?? null;
  }

  private async fireWebhook(
    url: string,
    secret: string | undefined,
    data: Record<string, any>,
  ): Promise<void> {
    const body = JSON.stringify(data);
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (secret) {
      headers['x-societyos-signature'] = createHmac('sha256', secret).update(body).digest('hex');
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers,
        body,
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`Notification webhook returned HTTP ${response.status}`);
    } finally {
      clearTimeout(timeout);
    }
  }
}
