import { Injectable, Logger } from '@nestjs/common';
import * as crypto from 'crypto';
import { CredentialType, Prisma } from '@prisma/client';
import { AppException } from '../common/app.exception';
import { PrismaService } from '../common/prisma.service';
import { CredentialsService } from '../visitors/credentials.service';
import { RateLimitService } from '../common/rate-limit.service';
import { MqttService } from '../devices/mqtt.service';
import { NotificationsService } from '../notifications/notifications.service';
import { BiometricsService } from '../devices/biometrics.service';

export interface VerifyContext {
  societyId: string;
  accessPointId: string;
  credentialType: 'PIN' | 'QR' | 'BIOMETRIC' | 'FINGERPRINT' | 'FACE';
  credential: string;
  requestId: string;
  source: 'DEVICE' | 'GUARD_CONSOLE' | 'BIOMETRIC_READER';
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

export const REASON = {
  VALID: 'VALID_VISITOR_PASS',
  VALID_BIOMETRIC: 'VALID_RESIDENT_BIOMETRIC',
  BIOMETRIC_NOT_RECOGNIZED: 'BIOMETRIC_NOT_RECOGNIZED',
  EXPIRED: 'PASS_EXPIRED',
  NOT_YET_VALID: 'PASS_NOT_YET_VALID',
  REVOKED: 'PASS_REVOKED',
  ALREADY_USED: 'PASS_ALREADY_USED',
  INVALID: 'INVALID_CREDENTIAL',
  WRONG_AP: 'WRONG_ACCESS_POINT',
  WRONG_SOCIETY: 'WRONG_SOCIETY',
  APPROVAL: 'APPROVAL_REQUIRED',
  DEVICE_DISABLED: 'DEVICE_DISABLED',
  RATE_LIMIT: 'RATE_LIMIT_EXCEEDED',
  CONTROLLER: 'CONTROLLER_UNAVAILABLE',
  SAFETY: 'SAFETY_INTERLOCK_ACTIVE',
  INTERNAL: 'INTERNAL_ERROR',
} as const;


const COMMAND_EXPIRY_SECONDS = 30;
const IDEMPOTENCY_TTL_MINUTES = 10;

type AuthorizedOutcome = {
  kind: 'AUTHORIZED';
  accessEventId: string;
  commandId: string;
  redemptionId: string;
  expiresAt: Date;
  passId: string;
  hostUserId: string;
  visitorName: string;
  societyId: string;
  deviceId?: string;
  accessPointId: string;
};

type TxOutcome =
  | { kind: 'DENIED'; reasonCode: string; accessEventId: string }
  | AuthorizedOutcome;

@Injectable()
export class AccessEngineService {
  private readonly logger = new Logger(AccessEngineService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly credentials: CredentialsService,
    private readonly rateLimit: RateLimitService,
    private readonly mqtt: MqttService,
    private readonly notifications: NotificationsService,
    private readonly biometrics: BiometricsService,
  ) {}

  async verify(ctx: VerifyContext): Promise<VerifyResponse> {
    if (
      ctx.credentialType === 'BIOMETRIC' ||
      ctx.credentialType === 'FINGERPRINT' ||
      ctx.credentialType === 'FACE'
    ) {
      const bioResult = await this.biometrics.verifyResidentBiometric(ctx.societyId, {
        accessPointId: ctx.accessPointId,
        templateHash: ctx.credential,
        type: ctx.credentialType === 'FACE' ? 'FACE' : 'FINGERPRINT',
      });
      return {
        decision: bioResult.decision as 'AUTHORIZED' | 'DENIED',
        reasonCode: bioResult.reasonCode,
        accessEventId: bioResult.accessEventId,
      };
    }

    const actor = ctx.deviceId ?? ctx.actorUserId ?? 'anon';
    const idemKey = `access-verify:${actor}:${ctx.requestId}`;
    const credentialHash = this.credentials.hash(ctx.credential);

    const cached = await this.prisma.idempotencyRecord.findUnique({ where: { key: idemKey } });
    if (cached && (!cached.expiresAt || cached.expiresAt > new Date())) {
      if (cached.requestHash && cached.requestHash !== credentialHash) {
        throw AppException.conflict(
          'IDEMPOTENCY_PAYLOAD_MISMATCH',
          'This request ID was already used with a different credential',
        );
      }
      return cached.responseBody as unknown as VerifyResponse;
    }

    const deviceLimit = await this.rateLimit.hit(`verify:device:${actor}`, 60, 60);
    if (!deviceLimit.allowed) return this.denyImmediate(ctx, REASON.RATE_LIMIT, idemKey, credentialHash);

    const credentialLimit = await this.rateLimit.hit(`verify:credential:${credentialHash}`, 15, 15 * 60);
    if (!credentialLimit.allowed) {
      await this.prisma.securityAlert.create({
        data: {
          societyId: ctx.societyId,
          severity: 'WARNING',
          type: 'CREDENTIAL_BRUTE_FORCE',
          detail: { source: ctx.source, attempts: credentialLimit.count, windowSec: 900 } as never,
        },
      }).catch(() => undefined);
      return this.denyImmediate(ctx, REASON.RATE_LIMIT, idemKey, credentialHash);
    }

    const outcome = await this.prisma.$transaction((tx) => this.evaluateAndConsume(tx, ctx, credentialHash));
    if (outcome.kind === 'DENIED') {
      const response: VerifyResponse = {
        decision: 'DENIED',
        reasonCode: outcome.reasonCode,
        accessEventId: outcome.accessEventId,
      };
      await this.remember(idemKey, response, credentialHash);
      return response;
    }

    if (ctx.source === 'DEVICE') {
      try {
        await this.mqtt.publishCommand(outcome.commandId);
      } catch (error) {
        this.logger.warn(`Gate command ${outcome.commandId} could not be dispatched: ${String(error)}`);
        return this.compensate(outcome, ctx, idemKey, credentialHash);
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
    await this.remember(idemKey, response, credentialHash);

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
      .catch((error) => this.logger.warn(`Notification enqueue failed: ${String(error)}`));

    return response;
  }

  private async evaluateAndConsume(
    tx: Prisma.TransactionClient,
    ctx: VerifyContext,
    credentialHash: string,
  ): Promise<TxOutcome> {
    const now = new Date();
    const accessPoint = await tx.accessPoint.findFirst({
      where: { id: ctx.accessPointId, societyId: ctx.societyId },
      select: { id: true },
    });
    if (!accessPoint) {
      return {
        kind: 'DENIED',
        reasonCode: REASON.WRONG_AP,
        accessEventId: await this.recordAccess(tx, ctx, 'DENIED', REASON.WRONG_AP, null, null),
      };
    }

    if (ctx.source === 'DEVICE') {
      const device = await tx.device.findUnique({
        where: { id: ctx.deviceId! },
        select: { id: true, societyId: true, status: true },
      });
      if (!device || device.societyId !== ctx.societyId) {
        return {
          kind: 'DENIED',
          reasonCode: REASON.DEVICE_DISABLED,
          accessEventId: await this.recordAccess(tx, ctx, 'DENIED', REASON.DEVICE_DISABLED, null),
        };
      }
      if (device.status !== 'ACTIVE') {
        return {
          kind: 'DENIED',
          reasonCode: REASON.DEVICE_DISABLED,
          accessEventId: await this.recordAccess(tx, ctx, 'DENIED', REASON.DEVICE_DISABLED, null),
        };
      }
      const link = await tx.deviceAccessPoint.findUnique({
        where: {
          deviceId_accessPointId: {
            deviceId: ctx.deviceId!,
            accessPointId: ctx.accessPointId,
          },
        },
      });
      if (!link) {
        return {
          kind: 'DENIED',
          reasonCode: REASON.WRONG_AP,
          accessEventId: await this.recordAccess(tx, ctx, 'DENIED', REASON.WRONG_AP, null),
        };
      }
    }

    const credential = await tx.visitorPassCredential.findUnique({
      where: { credentialHash },
      include: { pass: { include: { visitor: true, accessPoints: true } } },
    });
    if (!credential || credential.type !== ctx.credentialType) {
      return {
        kind: 'DENIED',
        reasonCode: REASON.INVALID,
        accessEventId: await this.recordAccess(tx, ctx, 'DENIED', REASON.INVALID, null),
      };
    }
    const pass = credential.pass;

    if (pass.societyId !== ctx.societyId) {
      return {
        kind: 'DENIED',
        reasonCode: REASON.WRONG_SOCIETY,
        accessEventId: await this.recordAccess(tx, ctx, 'DENIED', REASON.WRONG_SOCIETY, pass.id),
      };
    }
    if (!pass.accessPoints.some((link) => link.accessPointId === ctx.accessPointId)) {
      return {
        kind: 'DENIED',
        reasonCode: REASON.WRONG_AP,
        accessEventId: await this.recordAccess(tx, ctx, 'DENIED', REASON.WRONG_AP, pass.id),
      };
    }
    if (pass.status === 'REVOKED') {
      return {
        kind: 'DENIED',
        reasonCode: REASON.REVOKED,
        accessEventId: await this.recordAccess(tx, ctx, 'DENIED', REASON.REVOKED, pass.id),
      };
    }
    if (pass.status === 'PENDING_APPROVAL' || pass.status === 'DRAFT') {
      return {
        kind: 'DENIED',
        reasonCode: REASON.APPROVAL,
        accessEventId: await this.recordAccess(tx, ctx, 'DENIED', REASON.APPROVAL, pass.id),
      };
    }
    if (now < pass.validFrom) {
      return {
        kind: 'DENIED',
        reasonCode: REASON.NOT_YET_VALID,
        accessEventId: await this.recordAccess(tx, ctx, 'DENIED', REASON.NOT_YET_VALID, pass.id),
      };
    }
    if (now > pass.validUntil) {
      return {
        kind: 'DENIED',
        reasonCode: REASON.EXPIRED,
        accessEventId: await this.recordAccess(tx, ctx, 'DENIED', REASON.EXPIRED, pass.id),
      };
    }
    if (pass.usedCount >= pass.maxUses) {
      return {
        kind: 'DENIED',
        reasonCode: REASON.ALREADY_USED,
        accessEventId: await this.recordAccess(tx, ctx, 'DENIED', REASON.ALREADY_USED, pass.id),
      };
    }

    if (ctx.source === 'DEVICE') {
      const commandCredential = await tx.deviceCredential.findFirst({
        where: { deviceId: ctx.deviceId!, revokedAt: null, commandSecretEnc: { not: null } },
        select: { id: true },
      });
      if (!commandCredential) {
        return {
          kind: 'DENIED',
          reasonCode: REASON.CONTROLLER,
          accessEventId: await this.recordAccess(tx, ctx, 'DENIED', REASON.CONTROLLER, pass.id),
        };
      }
    }

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
    if (consumed.count !== 1) {
      const fresh = await tx.visitorPass.findUnique({ where: { id: pass.id } });
      let reasonCode: string = REASON.ALREADY_USED;
      if (!fresh) reasonCode = REASON.INVALID;
      else if (fresh.status === 'REVOKED') reasonCode = REASON.REVOKED;
      else if (fresh.status === 'PENDING_APPROVAL' || fresh.status === 'DRAFT') reasonCode = REASON.APPROVAL;
      else if (now < fresh.validFrom) reasonCode = REASON.NOT_YET_VALID;
      else if (now > fresh.validUntil) reasonCode = REASON.EXPIRED;
      return {
        kind: 'DENIED',
        reasonCode,
        accessEventId: await this.recordAccess(tx, ctx, 'DENIED', reasonCode, pass.id),
      };
    }

    const redemptionId = crypto.randomUUID();
    await tx.visitorPassUse.create({
      data: {
        passId: pass.id,
        redemptionId,
        deviceId: ctx.deviceId,
        accessPointId: ctx.accessPointId,
      },
    });

    if (ctx.source === 'GUARD_CONSOLE') {
      return {
        kind: 'AUTHORIZED',
        accessEventId: await this.recordAccess(tx, ctx, 'AUTHORIZED', REASON.VALID, pass.id),
        commandId: '',
        redemptionId,
        expiresAt: now,
        passId: pass.id,
        hostUserId: pass.hostUserId,
        visitorName: pass.visitor.name,
        societyId: ctx.societyId,
        accessPointId: ctx.accessPointId,
      };
    }

    const commandId = crypto.randomUUID();
    const expiresAt = new Date(now.getTime() + COMMAND_EXPIRY_SECONDS * 1000);
    await tx.gateCommand.create({
      data: {
        id: commandId,
        deviceId: ctx.deviceId!,
        accessPointId: ctx.accessPointId,
        type: 'OPEN',
        nonce: crypto.randomBytes(16).toString('hex'),
        status: 'ISSUED',
        issuedAt: now,
        expiresAt,
      },
    });

    return {
      kind: 'AUTHORIZED',
      accessEventId: await this.recordAccess(tx, ctx, 'AUTHORIZED', REASON.VALID, pass.id),
      commandId,
      redemptionId,
      expiresAt,
      passId: pass.id,
      hostUserId: pass.hostUserId,
      visitorName: pass.visitor.name,
      societyId: ctx.societyId,
      deviceId: ctx.deviceId,
      accessPointId: ctx.accessPointId,
    };
  }

  private async recordAccess(
    tx: Prisma.TransactionClient,
    ctx: VerifyContext,
    decision: 'AUTHORIZED' | 'DENIED',
    reasonCode: string,
    passId: string | null,
    accessPointId: string | null = ctx.accessPointId,
  ): Promise<string> {
    const event = await tx.accessEvent.create({
      data: {
        societyId: ctx.societyId,
        accessPointId,
        deviceId: ctx.deviceId,
        passId,
        decision,
        reasonCode,
        credentialType: ctx.credentialType as CredentialType,
        source: ctx.source,
        requestId: ctx.requestId,
      },
    });
    return event.id;
  }

  /** The command could not be dispatched; roll back the redemption, keep the denial event. */
  private async compensate(
    outcome: AuthorizedOutcome,
    ctx: VerifyContext,
    idemKey: string,
    credentialHash: string,
  ): Promise<VerifyResponse> {
    const denial = await this.prisma.$transaction(async (tx) => {
      await tx.gateCommand.updateMany({
        where: { id: outcome.commandId, status: 'ISSUED' },
        data: { status: 'EXPIRED' },
      });
      await tx.visitorPassUse.deleteMany({ where: { redemptionId: outcome.redemptionId } });
      await tx.visitorPass.updateMany({
        where: { id: outcome.passId, usedCount: { gt: 0 } },
        data: { usedCount: { decrement: 1 } },
      });
      const event = await tx.accessEvent.create({
        data: {
          societyId: ctx.societyId,
          accessPointId: ctx.accessPointId,
          deviceId: ctx.deviceId,
          passId: outcome.passId,
          decision: 'DENIED',
          reasonCode: REASON.CONTROLLER,
          credentialType: ctx.credentialType as CredentialType,
          source: ctx.source,
          requestId: ctx.requestId,
        },
      });
      return event;
    });
    const response: VerifyResponse = {
      decision: 'DENIED',
      reasonCode: REASON.CONTROLLER,
      accessEventId: denial.id,
    };
    await this.remember(idemKey, response, credentialHash);
    return response;
  }

  private async denyImmediate(
    ctx: VerifyContext,
    reasonCode: string,
    idemKey: string,
    credentialHash: string,
  ): Promise<VerifyResponse> {
    const event = await this.prisma.accessEvent.create({
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
    const response: VerifyResponse = { decision: 'DENIED', reasonCode, accessEventId: event.id };
    await this.remember(idemKey, response, credentialHash);
    return response;
  }

  private async remember(key: string, response: VerifyResponse, requestHash: string): Promise<void> {
    await this.prisma.idempotencyRecord.create({
      data: {
        key,
        endpoint: 'access.verify',
        responseBody: response as never,
        requestHash,
        expiresAt: new Date(Date.now() + IDEMPOTENCY_TTL_MINUTES * 60 * 1000),
      },
    }).catch(() => undefined);
  }
}
