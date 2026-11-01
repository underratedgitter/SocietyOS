import { Injectable, Logger } from '@nestjs/common';
import { getEnv } from '../config';

export interface SentWhatsappRecord {
  to: string;
  message: string;
  template: string;
  provider: string;
  timestamp: string;
  messageId?: string;
  payload?: Record<string, any>;
}

@Injectable()
export class WhatsappDispatcherService {
  private readonly logger = new Logger(WhatsappDispatcherService.name);
  private readonly mockSentStore: SentWhatsappRecord[] = [];

  normalizePhoneNumber(phone: string): string {
    if (!phone || typeof phone !== 'string') return '';
    const cleaned = phone.replace(/[\s\-()]/g, '');
    if (cleaned.startsWith('+')) return cleaned;
    if (cleaned.startsWith('0') && cleaned.length === 11 && /^\d{11}$/.test(cleaned)) {
      return `+91${cleaned.slice(1)}`;
    }
    if (cleaned.length === 10 && /^\d{10}$/.test(cleaned)) return `+91${cleaned}`;
    if (cleaned.length === 12 && cleaned.startsWith('91')) return `+${cleaned}`;
    return cleaned ? `+${cleaned}` : '';
  }

  formatMessage(template: string, payload: Record<string, any>): string {
    switch (template) {
      case 'VISITOR_PASS_ISSUED': {
        const flat = payload.flatNumber ? `Flat ${payload.flatNumber}` : 'Residence';
        const pin = payload.pin ? `🔑 *Entry PIN*: ${payload.pin}\n` : '';
        const window = payload.validWindow ? `🕒 *Validity*: ${payload.validWindow}\n` : '';
        const link = payload.passUrl ? `📲 *Digital Pass*: ${payload.passUrl}\n` : '';
        return (
          `🏢 *SocietyOS Visitor Pass*\n\n` +
          `Your entry pass for *${flat}* is confirmed.\n` +
          `${pin}${window}${link}\n` +
          `Present this PIN or QR code at the security gate for immediate clearance.`
        );
      }
      case 'VISITOR_PASS_APPROVED': {
        const flat = payload.flatNumber ? `Flat ${payload.flatNumber}` : 'Residence';
        const pin = payload.pin ? `🔑 *Entry PIN*: ${payload.pin}\n` : '';
        const window = payload.validWindow ? `🕒 *Validity*: ${payload.validWindow}\n` : '';
        return (
          `✅ *SocietyOS Pass Approved*\n\n` +
          `Your visitor pass for *${flat}* has been approved by the resident.\n` +
          `${pin}${window}\n` +
          `Welcome to SocietyOS!`
        );
      }
      case 'VISITOR_PASS_REVOKED': {
        const flat = payload.flatNumber ? `Flat ${payload.flatNumber}` : 'Residence';
        return `⚠️ *SocietyOS Pass Revoked*\n\nYour visitor pass for *${flat}* has been cancelled.`;
      }
      case 'VISITOR_ARRIVED': {
        const visitor = payload.visitorName || 'Visitor';
        const gate = payload.accessPointName ? ` at *${payload.accessPointName}*` : '';
        const flat = payload.flatNumber ? ` for *Flat ${payload.flatNumber}*` : '';
        const time = payload.at ? ` (${new Date(payload.at).toLocaleTimeString()})` : '';
        return (
          `🚪 *Gate Arrival Alert*\n\n` +
          `Visitor *${visitor}* has verified and arrived${gate}${flat}${time}.\n` +
          `Gate entry has been authorized.`
        );
      }
      case 'MAINTENANCE_INVOICE_GENERATED': {
        const title = payload.title || 'Maintenance Dues';
        const amount = payload.amount !== undefined ? `₹${payload.amount.toLocaleString('en-IN')}` : '';
        const due = payload.dueDate ? `\n📅 *Due Date*: ${payload.dueDate}` : '';
        return (
          `📋 *New Maintenance Invoice*\n\n` +
          `An invoice has been generated for *${title}*.\n` +
          `💰 *Amount Due*: ${amount}${due}\n\n` +
          `You can settle this invoice securely via SocietyOS resident portal.`
        );
      }
      case 'PAYMENT_CONFIRMATION': {
        const title = payload.title || 'Maintenance Bill';
        const amount = payload.amount !== undefined ? `₹${payload.amount.toLocaleString('en-IN')}` : '';
        const ref = payload.paymentReference ? `\n🔖 *Transaction Ref*: ${payload.paymentReference}` : '';
        return (
          `🎉 *Payment Receipt Confirmed*\n\n` +
          `Your payment of ${amount} for *${title}* has been processed successfully.${ref}\n\n` +
          `Thank you for keeping your society dues up to date!`
        );
      }
      default:
        return payload.body || payload.message || `SocietyOS WhatsApp update: ${template}`;
    }
  }

  async sendWhatsapp(
    to: string,
    template: string,
    payload: Record<string, any>,
  ): Promise<{ success: boolean; messageId: string; provider: string }> {
    const normalizedPhone = this.normalizePhoneNumber(to);
    const message = this.formatMessage(template, payload);
    const env = getEnv();
    const provider = env.whatsappProvider || 'mock';

    if (provider === 'meta' && env.whatsappApiToken && env.whatsappPhoneNumberId) {
      return this.sendViaMeta(normalizedPhone, message, env.whatsappApiToken, env.whatsappPhoneNumberId);
    }

    if (
      provider === 'twilio' &&
      env.twilioAccountSid &&
      env.twilioAuthToken &&
      env.twilioWhatsappFrom
    ) {
      return this.sendViaTwilioWhatsapp(
        normalizedPhone,
        message,
        env.twilioAccountSid,
        env.twilioAuthToken,
        env.twilioWhatsappFrom,
      );
    }

    if (env.isProduction && (provider === 'meta' || provider === 'twilio')) {
      throw new Error(`Configured WhatsApp provider '${provider}' is missing required API credentials in production`);
    }

    // Default mock dispatcher
    const messageId = `wa_mock_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const record: SentWhatsappRecord = {
      to: normalizedPhone,
      message,
      template,
      provider: 'mock',
      timestamp: new Date().toISOString(),
      messageId,
      payload,
    };
    this.mockSentStore.push(record);
    this.logger.log(`[WHATSAPP-MOCK] Sent to ${normalizedPhone}: "${message.slice(0, 80)}..."`);
    return { success: true, messageId, provider: 'mock' };
  }

  private async sendViaMeta(
    to: string,
    text: string,
    apiToken: string,
    phoneNumberId: string,
  ): Promise<{ success: boolean; messageId: string; provider: string }> {
    const url = `https://graph.facebook.com/v20.0/${phoneNumberId}/messages`;
    const recipient = to.replace('+', '');
    const body = {
      messaging_product: 'whatsapp',
      to: recipient,
      type: 'text',
      text: { preview_url: true, body: text },
    };

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Meta WhatsApp API error HTTP ${response.status}: ${errorText}`);
      }

      const data = (await response.json()) as { messages?: Array<{ id: string }> };
      const messageId = data.messages?.[0]?.id || `meta_wa_${Date.now()}`;
      return { success: true, messageId, provider: 'meta' };
    } finally {
      clearTimeout(timeout);
    }
  }

  private async sendViaTwilioWhatsapp(
    to: string,
    body: string,
    accountSid: string,
    authToken: string,
    from: string,
  ): Promise<{ success: boolean; messageId: string; provider: string }> {
    const url = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`;
    const fromWhatsapp = from.startsWith('whatsapp:') ? from : `whatsapp:${from}`;
    const toWhatsapp = `whatsapp:${to}`;
    const params = new URLSearchParams({ To: toWhatsapp, From: fromWhatsapp, Body: body });
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
        throw new Error(`Twilio WhatsApp API error HTTP ${response.status}: ${errorText}`);
      }

      const data = (await response.json()) as { sid?: string };
      return { success: true, messageId: data.sid || `tw_wa_${Date.now()}`, provider: 'twilio' };
    } finally {
      clearTimeout(timeout);
    }
  }

  getMockSentStore(): SentWhatsappRecord[] {
    return [...this.mockSentStore];
  }

  clearMockSentStore(): void {
    this.mockSentStore.length = 0;
  }
}
