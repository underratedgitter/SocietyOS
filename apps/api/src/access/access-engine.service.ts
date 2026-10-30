import { Injectable, Logger } from '@nestjs/common';
import * as crypto from 'crypto';
import { CredentialType, Prisma } from '@prisma/client';
import { PrismaService } from '../common/prisma.service';
import { CredentialsService } from '../visitors/credentials.service';
import { RateLimitService } from '../common/rate-limit.service';
import { MqttService, commandTopic } from '../devices/mqtt.service';
import { NotificationsService } from '../notifications/notifications.service';

export interface VerifyContext {
  societyId: string;
  accessPointId: string;
  credentialType: 'PIN' | 'QR';
  credential: string;
  requestId: string;
  source: 'DEVICE' | 'GUARD_CONSOLE';
  deviceId?: string;
  deviceUid?: string;
  actorUserId?: string;
}

export interface VerifyResponse {
  decision: 'AUTHORIZED' | 'DENIED';
  reasonCode: string;
  accessEventId: string;
  commandId?: string;
  expiresAt?: string;
}

/** Reason codes from blueprint §5 plus PASS_NOT_YET_VALID for future windows. */
const REASON = {
  VALID: 'VALID_VISITOR_PASS',
  EXPIRED: 'PASS_EXPIRED',
  NOT_YET_VALID: 'PASS_NOT_YET_VALID',
  REVOKED: 'PASS_REVOKED',
  ALREADY_USED: 'PASS_ALREADY_USED',
  INVALID: 'INVALID_CREDENTIAL',
  WRONG_AP: 'WRONG_ACCESS_POINT',
  WRONG_SOCIETY: 'WRONG_SOCIETY',
  APPROVAL: 'APPROVAL_REQUIRED',
  RATE_LIMIT: 'RATE_LIMIT_EXCEEDED',
  CONTROLLER: 'CONTROLLER_UNAVAILABLE',
} as const;

const COMMAND_EXPIRY_SECONDS = 30;

type TxOutcome =
  | { kind: 'DENIED'; reasonCode: string; accessEventId: string }
  | {
      kind: 'AUTHORIZED';
      accessEventId: string;
      commandId: string;
      expiresAt: Date;
      passId: string;
      hostUserId: string;
      visitorName: string;
      societyId: string;
      deviceId: string;
      accessPointId: string;
      commandTopic: string;
      commandPayload: Record<string, unknown>;
    };

@Injectable()
export class AccessEngineService {
  private readonly logger = new Logger(AccessEngineService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly credentials: CredentialsService,
    private readonly rateLimit: RateLimitService,
    private readonly mqtt: MqttService,
    private readonly notifications: NotificationsService,
  ) {}

  async verify(ctx: VerifyContext): Promise<VerifyResponse> {
    const idemKey = `access-verify:${ctx.deviceUid ?? ctx.actorUserId ?? 'anon'}:${ctx.requestId}`;

    // 1. Replay protection — same requestId returns the original response.
    const cached = await this.prisma.idempotencyRecord.findUnique({ where: { key: idemKey } });
    if (cached) return cached.responseBody as unknown as VerifyResponse;

    // 2. Rate limits: per device/user, then per credential material.
    const bucketId = ctx.deviceId ?? ctx.actorUserId ?? 'anon';
    const deviceRl = await this.rateLimit.hit(`verify:${bucketId}`, 60, 60);
    if (!deviceRl.allowed) return this.denyImmediate(ctx, REASON.RATE_LIMIT, idemKey);

    const credHash = this.credentials.hash(ctx.credential);
    const credRl = await this.rateLimit.hit(`cred:${credHash.slice(0, 32)}`, 15, 900);
    if (!credRl.allowed) {
      await this.prisma.securityAlert.create({
        data: {
          societyId: ctx.societyId,
          severity: 'WARNING',
          type: 'CREDENTIAL_BRUTE_FORCE',
          detail: { source: ctx.source, attempts: credRl.count, windowSec: 900 } as never,
        },
      });
      return this.denyImmediate(ctx, REASON.RATE_LIMIT, idemKey);
    }

    // 3. Evaluate, consume and (for the device flow) issue the gate command.
    const outcome = await this.prisma.$transaction((tx) => this.evaluateAndConsume(tx, ctx, credHash));

    if (outcome.kind === 'DENIED') {
      const response: VerifyResponse = { decision: 'DENIED', reasonCode: outcome.reasonCode, accessEventId: outcome.accessEventId };
      await this.prisma.idempotencyRecord.create({
        data: { key: idemKey, endpoint: 'access/verify', responseBody: response as never },
      }).catch(() => undefined);
      return response;
    }

    // 4. Device flow: publish the short-lived command. Fail-closed on broker loss.
    if (ctx.source === 'DEVICE') {
      try {
        await this.mqtt.publish(outcome.commandTopic, outcome.commandPayload, 1);
      } catch (err) {
        this.logger.warn(`command publish failed (${outcome.commandId}): ${String(err)}`);
        return this.compensate(outcome, idemKey);
      }
    }

    const response: VerifyResponse = {
      decision: 'AUTHORIZED',
      reasonCode: REASON.VALID,
      accessEventId: outcome.accessEventId,
      ...(ctx.source === 'DEVICE'
        ? { commandId: outcome.commandId, expiresAt: outcome.expiresAt.toISOString() }
        : {}),
    };
    await this.prisma.idempotencyRecord.create({
      data: { key: idemKey, endpoint: 'access/verify', responseBody: response as never },
    }).catch(() => undefined);

    // 5. Arrival notification to the host via the transactional outbox.
    await this.notifications
      .enqueue({
        societyId: outcome.societyId,
        userId: outcome.hostUserId,
        channel: 'PUSH',
        template: 'VISITOR_ARRIVED',
        payload: {
          visitorName: outcome.visitorName,
          accessPointId: outcome.accessPointId,
          at: new Date().toISOString(),
        },
      })
      .catch((err) => this.logger.warn(`notification enqueue failed: ${String(err)}`));

    return response;
  }

  private async evaluateAndConsume(
    tx: Prisma.TransactionClient,
    ctx: VerifyContext,
    credHash: string,
  ): Promise<TxOutcome> {
    const now = new Date();

    const recordAccess = async (decision: 'AUTHORIZED' | 'DENIED', reasonCode: string, passId?: string) => {
      const evt = await tx.accessEvent.create({
        data: {
          societyId: ctx.societyId,
          accessPointId: ctx.accessPointId,
          deviceId: ctx.deviceId,
          passId,
          decision,
          reasonCode,
          credentialType: ctx.credentialType as CredentialType,
          source: ctx.source,
          requestId: ctx.requestId,
        },
      });
      return evt.id;
    };

    const credential = await tx.visitorPassCredential.findUnique({
      where: { credentialHash: credHash },
      include: { pass: { include: { visitor: true, accessPoints: true } } },
    });

    if (!credential || credential.type !== ctx.credentialType) {
      return { kind: 'DENIED', reasonCode: REASON.INVALID, accessEventId: await recordAccess('DENIED', REASON.INVALID) };
    }
    const pass = credential.pass;

    if (pass.societyId !== ctx.societyId) {
      return { kind: 'DENIED', reasonCode: REASON.WRONG_SOCIETY, accessEventId: await recordAccess('DENIED', REASON.WRONG_SOCIETY, pass.id) };
    }
    if (!pass.accessPoints.some((l) => l.accessPointId === ctx.accessPointId)) {
      return { kind: 'DENIED', reasonCode: REASON.WRONG_AP, accessEventId: await recordAccess('DENIED', REASON.WRONG_AP, pass.id) };
    }
    if (pass.status === 'REVOKED') {
      return { kind: 'DENIED', reasonCode: REASON.REVOKED, accessEventId: await recordAccess('DENIED', REASON.REVOKED, pass.id) };
    }
    if (pass.status === 'PENDING_APPROVAL' || pass.status === 'DRAFT') {
      return { kind: 'DENIED', reasonCode: REASON.APPROVAL, accessEventId: await recordAccess('DENIED', REASON.APPROVAL, pass.id) };
    }
    if (now < pass.validFrom) {
      return { kind: 'DENIED', reasonCode: REASON.NOT_YET_VALID, accessEventId: await recordAccess('DENIED', REASON.NOT_YET_VALID, pass.id) };
    }
    if (now > pass.validUntil) {
      return { kind: 'DENIED', reasonCode: REASON.EXPIRED, accessEventId: await recordAccess('DENIED', REASON.EXPIRED, pass.id) };
    }
    if (pass.usedCount >= pass.maxUses) {
      return { kind: 'DENIED', reasonCode: REASON.ALREADY_USED, accessEventId: await recordAccess('DENIED', REASON.ALREADY_USED, pass.id) };
    }

    // Atomic redemption: conditional update prevents concurrent reuse
    // (blueprint §8 — transaction locking + unique redemption ids).
    const consumed = await tx.visitorPass.updateMany({
      where: {
        id: pass.id,
        status: 'ACTIVE',
        usedCount: { lt: pass.maxUses },
        validFrom: { lte: now },
        validUntil: { gte: now },
      },
      data: { usedCount: { increment: 1 } },
    });
    if (consumed.count === 0) {
      // Lost a race — re-read for the precise reason code.
      const fresh = await tx.visitorPass.findUnique({ where: { id: pass.id } });
      let reasonCode: string = REASON.ALREADY_USED;
      if (fresh) {
        if (fresh.status === 'REVOKED') reasonCode = REASON.REVOKED;
        else if (now < fresh.validFrom) reasonCode = REASON.NOT_YET_VALID;
        else if (now > fresh.validUntil) reasonCode = REASON.EXPIRED;
      }
      return { kind: 'DENIED', reasonCode, accessEventId: await recordAccess('DENIED', reasonCode, pass.id) };
    }

    await tx.visitorPassUse.create({
      data: {
        passId: pass.id,
        redemptionId: ctx.requestId,
        deviceId: ctx.deviceId,
        accessPointId: ctx.accessPointId,
      },
    });

    // Guard console records the entry but does not command a gate.
    if (ctx.source === 'GUARD_CONSOLE') {
      return {
        kind: 'AUTHORIZED',
        accessEventId: await recordAccess('AUTHORIZED', REASON.VALID, pass.id),
        commandId: '',
        expiresAt: now,
        passId: pass.id,
        hostUserId: pass.hostUserId,
        visitorName: pass.visitor.name,
        societyId: ctx.societyId,
        deviceId: ctx.deviceId ?? '',
        accessPointId: ctx.accessPointId,
        commandTopic: '',
        commandPayload: {},
      };
    }

    const commandId = crypto.randomUUID();
    const expiresAt = new Date(now.getTime() + COMMAND_EXPIRY_SECONDS * 1000);
    const nonce = crypto.randomBytes(12).toString('hex');
    await tx.gateCommand.create({
      data: {
        id: commandId,
        deviceId: ctx.deviceId!,
        accessPointId: ctx.accessPointId,
        type: 'OPEN',
        nonce,
        status: 'ISSUED',
        issuedAt: now,
        expiresAt,
      },
    });

    return {
      kind: 'AUTHORIZED',
      accessEventId: await recordAccess('AUTHORIZED', REASON.VALID, pass.id),
      commandId,
      expiresAt,
      passId: pass.id,
      hostUserId: pass.hostUserId,
      visitorName: pass.visitor.name,
      societyId: ctx.societyId,
      deviceId: ctx.deviceId!,
      accessPointId: ctx.accessPointId,
      commandTopic: commandTopic(ctx.societyId, ctx.deviceId!),
      commandPayload: {
        commandId,
        deviceId: ctx.deviceId,
        accessPointId: ctx.accessPointId,
        type: 'OPEN',
        nonce,
        issuedAt: now.toISOString(),
        expiresAt: expiresAt.toISOString(),
      },
    };
  }

  /** Broker unavailable after redemption — roll the use back and deny (fail-closed). */
  private async compensate(outcome: Extract<TxOutcome, { kind: 'AUTHORIZED' }>, idemKey: string): Promise<VerifyResponse> {
    await this.prisma.$transaction(async (tx) => {
      await tx.visitorPassUse.deleteMany({ where: { passId: outcome.passId, redemptionId: idemKey.split(':').pop() } });
      await tx.visitorPass.update({
        where: { id: outcome.passId },
        data: { usedCount: { decrement: 1 } },
      });
      await tx.gateCommand.update({
        where: { id: outcome.commandId },
        data: { status: 'EXPIRED' },
      }).catch(() => undefined);
      await tx.accessEvent.create({
        data: {
          societyId: outcome.societyId,
          accessPointId: outcome.accessPointId,
          deviceId: outcome.deviceId || null,
          passId: outcome.passId,
          decision: 'DENIED',
          reasonCode: REASON.CONTROLLER,
          source: 'DEVICE',
          requestId: idemKey.split(':').pop(),
        },
      });
    });
    const response: VerifyResponse = {
      decision: 'DENIED',
      reasonCode: REASON.CONTROLLER,
      accessEventId: '',
    };
    await this.prisma.idempotencyRecord.create({
      data: { key: idemKey, endpoint: 'access/verify', responseBody: response as never },
    }).catch(() => undefined);
    return response;
  }

  /** Denials that occur before the engine transaction (rate limits). */
  private async denyImmediate(ctx: VerifyContext, reasonCode: string, idemKey: string): Promise<VerifyResponse> {
    const evt = await this.prisma.accessEvent.create({
      data: {
        societyId: ctx.societyId,
        accessPointId: ctx.accessPointId,
        deviceId: ctx.deviceId,
        decision: 'DENIED',
        reasonCode,
        credentialType: ctx.credentialType as CredentialType,
        source: ctx.source,
        requestId: ctx.requestId,
      },
    });
    const response: VerifyResponse = { decision: 'DENIED', reasonCode, accessEventId: evt.id };
    await this.prisma.idempotencyRecord.create({
      data: { key: idemKey, endpoint: 'access/verify', responseBody: response as never },
    }).catch(() => undefined);
    return response;
  }
}
