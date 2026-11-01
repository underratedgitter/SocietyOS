import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';
import { getEnv } from '../config';

export interface ExpoPushMessage {
  to: string;
  title: string;
  body: string;
  data?: Record<string, any>;
  sound?: 'default' | null;
  badge?: number;
  channelId?: string;
}

export interface SentPushRecord {
  token: string;
  title: string;
  body: string;
  data?: Record<string, any>;
  platform: string;
  timestamp: string;
  ticketId?: string;
}

@Injectable()
export class PushDispatcherService {
  private readonly logger = new Logger(PushDispatcherService.name);
  private readonly mockSentStore: SentPushRecord[] = [];

  constructor(private readonly prisma: PrismaService) {}

  formatPushPayload(template: string, payload: Record<string, any>): { title: string; body: string } {
    switch (template) {
      case 'VISITOR_ARRIVED': {
        const visitor = payload.visitorName || 'Visitor';
        const gate = payload.accessPointName ? ` at ${payload.accessPointName}` : '';
        return {
          title: 'Visitor Arrived',
          body: `${visitor} has arrived${gate}.`,
        };
      }
      case 'VISITOR_PASS_ISSUED': {
        const flat = payload.flatNumber ? `Flat ${payload.flatNumber}` : 'your flat';
        const visitor = payload.visitorName ? ` for ${payload.visitorName}` : '';
        return {
          title: 'Visitor Pass Issued',
          body: `Pass${visitor} created for ${flat}.`,
        };
      }
      case 'VISITOR_PASS_APPROVED': {
        const flat = payload.flatNumber ? `Flat ${payload.flatNumber}` : 'your flat';
        return {
          title: 'Pass Approved',
          body: `Visitor pass for ${flat} has been approved.`,
        };
      }
      case 'VISITOR_PASS_REVOKED': {
        const flat = payload.flatNumber ? `Flat ${payload.flatNumber}` : 'your flat';
        return {
          title: 'Pass Revoked',
          body: `Visitor pass for ${flat} has been revoked.`,
        };
      }
      case 'MAINTENANCE_INVOICE_GENERATED': {
        const title = payload.title || 'Dues';
        const amount = payload.amount !== undefined ? `₹${payload.amount.toLocaleString('en-IN')}` : '';
        return {
          title: 'New Maintenance Invoice',
          body: `Bill '${title}' of ${amount} has been issued.`,
        };
      }
      case 'PAYMENT_CONFIRMATION': {
        const title = payload.title || 'Bill';
        const amount = payload.amount !== undefined ? `₹${payload.amount.toLocaleString('en-IN')}` : '';
        return {
          title: 'Payment Confirmed',
          body: `Payment of ${amount} for '${title}' was successfully received.`,
        };
      }
      default:
        return {
          title: payload.title || 'SocietyOS Alert',
          body: payload.body || payload.message || `Notification: ${template}`,
        };
    }
  }

  isExpoPushToken(token: string): boolean {
    return (
      typeof token === 'string' &&
      (((token.startsWith('ExponentPushToken[') || token.startsWith('ExpoPushToken[')) &&
        token.endsWith(']')) ||
        /^[a-z0-9-_]{22}$/i.test(token))
    );
  }

  async sendToUser(
    userId: string,
    template: string,
    payload: Record<string, any>,
  ): Promise<{ sentCount: number; failedCount: number }> {
    const tokens = await this.prisma.pushDeviceToken.findMany({
      where: { userId },
    });

    if (tokens.length === 0) {
      this.logger.debug(`No registered push device tokens for user ${userId}`);
      return { sentCount: 0, failedCount: 0 };
    }

    const { title, body } = this.formatPushPayload(template, payload);

    let sentCount = 0;
    let failedCount = 0;

    const expoTokens = tokens.filter(
      (t) => ['expo', 'ios', 'android'].includes(t.platform) || this.isExpoPushToken(t.token),
    );
    const webTokens = tokens.filter((t) => t.platform === 'web' && !this.isExpoPushToken(t.token));

    if (expoTokens.length > 0) {
      const messages: ExpoPushMessage[] = expoTokens.map((t) => ({
        to: t.token,
        title,
        body,
        data: payload,
        sound: 'default',
      }));
      const res = await this.sendExpoPushBatch(messages);
      sentCount += res.sent;
      failedCount += res.failed;
    }

    if (webTokens.length > 0) {
      for (const token of webTokens) {
        try {
          await this.sendWebPush(token.token, token.endpoint, token.p256dh, token.auth, title, body, payload);
          sentCount += 1;
        } catch {
          failedCount += 1;
        }
      }
    }

    return { sentCount, failedCount };
  }

  async sendExpoPushBatch(
    messages: ExpoPushMessage[],
  ): Promise<{ sent: number; failed: number }> {
    if (messages.length === 0) return { sent: 0, failed: 0 };
    const env = getEnv();

    // In non-production or when no Expo access token and mock/test mode
    if (env.nodeEnv === 'test' || !env.isProduction) {
      for (const m of messages) {
        this.mockSentStore.push({
          token: m.to,
          title: m.title,
          body: m.body,
          data: m.data,
          platform: 'expo',
          timestamp: new Date().toISOString(),
          ticketId: `expo_mock_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        });
      }
      this.logger.log(`[EXPO-PUSH-MOCK] Dispatched ${messages.length} push notifications`);
      return { sent: messages.length, failed: 0 };
    }

    // Live Expo Push API
    const chunks = this.chunkArray(messages, 100);
    let totalSent = 0;
    let totalFailed = 0;

    for (const chunk of chunks) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8000);
      try {
        const headers: Record<string, string> = {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'Accept-Encoding': 'gzip, deflate',
        };
        if (env.expoAccessToken) {
          headers.Authorization = `Bearer ${env.expoAccessToken}`;
        }

        const response = await fetch('https://exp.host/--/api/v2/push/send', {
          method: 'POST',
          headers,
          body: JSON.stringify(chunk),
          signal: controller.signal,
        });

        if (!response.ok) {
          this.logger.warn(`Expo push gateway returned HTTP ${response.status}`);
          totalFailed += chunk.length;
          continue;
        }

        const result = (await response.json()) as {
          data?: Array<{
            status: 'ok' | 'error';
            id?: string;
            message?: string;
            details?: { error?: string };
          }>;
        };

        if (Array.isArray(result.data)) {
          for (let i = 0; i < result.data.length; i++) {
            const ticket = result.data[i];
            const original = chunk[i];
            if (ticket.status === 'ok') {
              totalSent += 1;
            } else {
              totalFailed += 1;
              if (ticket.details?.error === 'DeviceNotRegistered' && original?.to) {
                // Device token is expired or app was uninstalled; clean up
                await this.prisma.pushDeviceToken
                  .deleteMany({ where: { token: original.to } })
                  .catch(() => undefined);
                this.logger.log(`Pruned unregistered device token: ${original.to}`);
              }
            }
          }
        } else {
          totalSent += chunk.length;
        }
      } catch (error) {
        this.logger.warn(`Failed to dispatch Expo push chunk: ${String(error)}`);
        totalFailed += chunk.length;
      } finally {
        clearTimeout(timeout);
      }
    }

    return { sent: totalSent, failed: totalFailed };
  }

  async sendWebPush(
    token: string,
    endpoint: string | null | undefined,
    _p256dh: string | null | undefined,
    _auth: string | null | undefined,
    title: string,
    body: string,
    data?: Record<string, any>,
  ): Promise<void> {
    const env = getEnv();
    if (env.nodeEnv === 'test' || !env.isProduction || !endpoint) {
      this.mockSentStore.push({
        token,
        title,
        body,
        data,
        platform: 'web',
        timestamp: new Date().toISOString(),
        ticketId: `web_mock_${Date.now()}`,
      });
      return;
    }

    // Direct Web Push RFC 8291
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          TTL: '86400',
        },
        body: JSON.stringify({ title, body, data }),
        signal: controller.signal,
      });

      if (response.status === 404 || response.status === 410) {
        // Subscription expired
        await this.prisma.pushDeviceToken.deleteMany({ where: { token } }).catch(() => undefined);
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  private chunkArray<T>(items: T[], size: number): T[][] {
    const chunks: T[][] = [];
    for (let i = 0; i < items.length; i += size) {
      chunks.push(items.slice(i, i + size));
    }
    return chunks;
  }

  getMockSentStore(): SentPushRecord[] {
    return [...this.mockSentStore];
  }

  clearMockSentStore(): void {
    this.mockSentStore.length = 0;
  }
}
