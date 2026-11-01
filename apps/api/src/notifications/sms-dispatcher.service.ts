import { Injectable, Logger } from '@nestjs/common';
import { getEnv } from '../config';

export interface SentSmsRecord {
  to: string;
  message: string;
  template: string;
  provider: string;
  timestamp: string;
  messageId?: string;
}

@Injectable()
export class SmsDispatcherService {
  private readonly logger = new Logger(SmsDispatcherService.name);
  private readonly mockSentStore: SentSmsRecord[] = [];

  /**
   * Normalize input phone number to E.164 format.
   * Defaults to India (+91) if 10-digit number is provided.
   */
  normalizePhoneNumber(phone: string): string {
    if (!phone || typeof phone !== 'string') return '';
    const cleaned = phone.replace(/[\s\-()]/g, '');
    if (cleaned.startsWith('+')) {
      return cleaned;
    }
    if (cleaned.startsWith('0') && cleaned.length === 11 && /^\d{11}$/.test(cleaned)) {
      return `+91${cleaned.slice(1)}`;
    }
    if (cleaned.length === 10 && /^\d{10}$/.test(cleaned)) {
      return `+91${cleaned}`;
    }
    if (cleaned.length === 12 && cleaned.startsWith('91')) {
      return `+${cleaned}`;
    }
    return cleaned ? `+${cleaned}` : '';
  }

  formatMessage(template: string, payload: Record<string, any>): string {
    switch (template) {
      case 'VISITOR_PASS_ISSUED': {
        const flat = payload.flatNumber ? `Flat ${payload.flatNumber}` : 'the residence';
        const pin = payload.pin ? ` Entry PIN: ${payload.pin}.` : '';
        const window = payload.validWindow ? ` Valid: ${payload.validWindow}.` : '';
        const link = payload.passUrl ? ` Pass link: ${payload.passUrl}` : '';
        return `Your SocietyOS visitor pass for ${flat} is ready.${pin}${window}${link}`.trim();
      }
      case 'VISITOR_PASS_APPROVED': {
        const flat = payload.flatNumber ? `Flat ${payload.flatNumber}` : 'the residence';
        const pin = payload.pin ? ` Entry PIN: ${payload.pin}.` : '';
        const window = payload.validWindow ? ` Valid: ${payload.validWindow}.` : '';
        return `Your SocietyOS visitor pass for ${flat} has been approved!${pin}${window}`.trim();
      }
      case 'VISITOR_PASS_REVOKED': {
        const flat = payload.flatNumber ? `Flat ${payload.flatNumber}` : 'the residence';
        return `Notice: Your SocietyOS visitor pass for ${flat} has been revoked.`;
      }
      case 'VISITOR_ARRIVED': {
        const visitor = payload.visitorName || 'Visitor';
        const gate = payload.accessPointName ? ` at ${payload.accessPointName}` : '';
        const flat = payload.flatNumber ? ` for Flat ${payload.flatNumber}` : '';
        return `Gate Alert: ${visitor} has arrived${gate}${flat}.`;
      }
      case 'MAINTENANCE_INVOICE_GENERATED': {
        const title = payload.title || 'Dues';
        const amount = payload.amount !== undefined ? `INR ${payload.amount}` : '';
        const due = payload.dueDate ? ` due on ${payload.dueDate}` : '';
        return `SocietyOS: New maintenance bill '${title}' for ${amount}${due}.`;
      }
      case 'PAYMENT_CONFIRMATION': {
        const title = payload.title || 'Maintenance';
        const amount = payload.amount !== undefined ? `INR ${payload.amount}` : '';
        const ref = payload.paymentReference ? ` Ref: ${payload.paymentReference}` : '';
        return `SocietyOS: Payment of ${amount} received for '${title}'.${ref} Thank you!`;
      }
      default:
        return payload.body || payload.message || `SocietyOS notification: ${template}`;
    }
  }

  async sendSms(
    to: string,
    template: string,
    payload: Record<string, any>,
  ): Promise<{ success: boolean; messageId: string; provider: string }> {
    const normalizedPhone = this.normalizePhoneNumber(to);
    const message = this.formatMessage(template, payload);
    const env = getEnv();
    const provider = env.smsProvider || 'mock';

    if (provider === 'twilio' && env.twilioAccountSid && env.twilioAuthToken && env.twilioFromPhone) {
      return this.sendViaTwilio(normalizedPhone, message, env.twilioAccountSid, env.twilioAuthToken, env.twilioFromPhone);
    }

    if (provider === 'msg91' && env.msg91AuthKey && env.msg91SenderId) {
      return this.sendViaMsg91(normalizedPhone, message, env.msg91AuthKey, env.msg91SenderId);
    }

    if (env.isProduction && (provider === 'twilio' || provider === 'msg91')) {
      throw new Error(`Configured SMS provider '${provider}' is missing required API credentials in production`);
    }

    // Default: Mock dispatcher (production fallback / test / dev)
    const messageId = `sms_mock_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const record: SentSmsRecord = {
      to: normalizedPhone,
      message,
      template,
      provider: 'mock',
      timestamp: new Date().toISOString(),
      messageId,
    };
    this.mockSentStore.push(record);
    this.logger.log(`[SMS-MOCK] Sent to ${normalizedPhone}: "${message}"`);
    return { success: true, messageId, provider: 'mock' };
  }

  private async sendViaTwilio(
    to: string,
    body: string,
    accountSid: string,
    authToken: string,
    from: string,
  ): Promise<{ success: boolean; messageId: string; provider: string }> {
    const url = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`;
    const params = new URLSearchParams({ To: to, From: from, Body: body });
    const authHeader = `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: authHeader,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: params.toString(),
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Twilio SMS API error HTTP ${response.status}: ${errorText}`);
      }

      const data = (await response.json()) as { sid?: string };
      const messageId = data.sid || `tw_${Date.now()}`;
      return { success: true, messageId, provider: 'twilio' };
    } finally {
      clearTimeout(timeout);
    }
  }

  private async sendViaMsg91(
    to: string,
    message: string,
    authKey: string,
    senderId: string,
  ): Promise<{ success: boolean; messageId: string; provider: string }> {
    const url = 'https://control.msg91.com/api/v5/flow/';
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          authkey: authKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          sender: senderId,
          recipients: [{ mobiles: to.replace('+', ''), message }],
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`MSG91 API error HTTP ${response.status}`);
      }
      return { success: true, messageId: `msg91_${Date.now()}`, provider: 'msg91' };
    } finally {
      clearTimeout(timeout);
    }
  }

  /** For unit / integration testing */
  getMockSentStore(): SentSmsRecord[] {
    return [...this.mockSentStore];
  }

  clearMockSentStore(): void {
    this.mockSentStore.length = 0;
  }
}
