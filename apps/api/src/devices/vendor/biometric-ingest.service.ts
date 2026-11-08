import { Injectable, Logger } from '@nestjs/common';
import { DeviceProtocol, Prisma } from '@prisma/client';
import { PrismaService } from '../../common/prisma.service';
import {
  DEVICE_USER_ID_PATTERN,
  IngestOutcome,
  MAX_CLOCK_SKEW_MS,
  MAX_EVENT_AGE_MS,
  VendorBiometricEvent,
  dedupeKeyFor,
} from './vendor-event';

export interface IngestingDevice {
  id: string;
  societyId: string;
  protocol: DeviceProtocol;
}

const MAX_EVENTS_PER_BATCH = 500;

type Decision = { decision: 'AUTHORIZED' | 'DENIED'; reasonCode: string; userId?: string; flatNumber?: string };

/**
 * Turns vendor-reported matches into SocietyOS access decisions. The terminal has already decided
 * locally (and usually driven its own lock relay); SocietyOS re-checks the resident against live
 * membership data, records the access event, and when the terminal let in someone who no longer
 * has access, raises an alert and queues removal of that user from the terminal.
 */
@Injectable()
export class BiometricIngestService {
  private readonly logger = new Logger(BiometricIngestService.name);

  constructor(private readonly prisma: PrismaService) {}

  async ingest(device: IngestingDevice, events: VendorBiometricEvent[], now = new Date()): Promise<IngestOutcome[]> {
    if (events.length > MAX_EVENTS_PER_BATCH) {
      throw new RangeError(`At most ${MAX_EVENTS_PER_BATCH} events per batch`);
    }
    const accessPointId = await this.primaryAccessPoint(device.id);
    const outcomes: IngestOutcome[] = [];
    for (const event of events) {
      outcomes.push(await this.ingestOne(device, accessPointId, event, now));
    }
    await this.prisma.device.update({ where: { id: device.id }, data: { lastSeenAt: now } });
    return outcomes;
  }

  private async ingestOne(
    device: IngestingDevice,
    accessPointId: string | null,
    event: VendorBiometricEvent,
    now: Date,
  ): Promise<IngestOutcome> {
    const dedupeKey = dedupeKeyFor(event);
    const rejection = this.validate(event, now);
    if (rejection) return { status: 'REJECTED', dedupeKey, reason: rejection };

    const decision = await this.decide(device.societyId, event);
    try {
      const accessEventId = await this.prisma.$transaction(async (tx) => {
        // Receipt first: a resent punch hits the unique key and rolls back without a second event.
        const receipt = await tx.biometricEventReceipt.create({ data: { deviceId: device.id, dedupeKey } });
        const accessEvent = await tx.accessEvent.create({
          data: {
            societyId: device.societyId,
            accessPointId,
            deviceId: device.id,
            decision: decision.decision,
            reasonCode: decision.reasonCode,
            source: 'BIOMETRIC_READER',
            requestedAt: event.occurredAt,
            meta: {
              protocol: device.protocol,
              method: event.method,
              deviceUserId: event.deviceUserId,
              matchedOnDevice: event.matched,
              ...(decision.userId ? { userId: decision.userId, flatNumber: decision.flatNumber } : {}),
            },
          },
        });
        await tx.biometricEventReceipt.update({ where: { id: receipt.id }, data: { accessEventId: accessEvent.id } });
        // Same transaction as the receipt: if this fails the punch rolls back and the device's
        // retry redoes it, instead of hitting DUPLICATE and silently losing the revocation.
        if (event.matched && decision.decision === 'DENIED') {
          await this.handleStaleDeviceUser(tx, device, event, decision.reasonCode);
        }
        return accessEvent.id;
      });

      return { status: 'RECORDED', dedupeKey, accessEventId, ...decision };
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        return { status: 'DUPLICATE', dedupeKey };
      }
      throw error;
    }
  }

  private validate(event: VendorBiometricEvent, now: Date): string | null {
    if (!DEVICE_USER_ID_PATTERN.test(event.deviceUserId)) return 'INVALID_DEVICE_USER_ID';
    const at = event.occurredAt.getTime();
    if (Number.isNaN(at)) return 'INVALID_TIMESTAMP';
    if (at > now.getTime() + MAX_CLOCK_SKEW_MS) return 'TIMESTAMP_IN_FUTURE';
    if (at < now.getTime() - MAX_EVENT_AGE_MS) return 'TIMESTAMP_TOO_OLD';
    return null;
  }

  private async decide(societyId: string, event: VendorBiometricEvent): Promise<Decision> {
    if (!event.matched) return { decision: 'DENIED', reasonCode: 'BIOMETRIC_NOT_MATCHED_ON_DEVICE' };

    const identity = await this.prisma.biometricIdentity.findUnique({
      where: { societyId_deviceUserId: { societyId, deviceUserId: event.deviceUserId } },
    });
    if (!identity) return { decision: 'DENIED', reasonCode: 'UNKNOWN_DEVICE_USER' };
    if (identity.revokedAt) {
      return { decision: 'DENIED', reasonCode: 'BIOMETRIC_IDENTITY_REVOKED', userId: identity.userId };
    }

    const membership = await this.prisma.residentFlatMembership.findFirst({
      where: { userId: identity.userId, endedAt: null, flat: { building: { societyId } } },
      select: { flat: { select: { flatNumber: true } } },
    });
    if (!membership) {
      return { decision: 'DENIED', reasonCode: 'RESIDENT_MEMBERSHIP_INACTIVE', userId: identity.userId };
    }
    return {
      decision: 'AUTHORIZED',
      reasonCode: 'VALID_RESIDENT_BIOMETRIC',
      userId: identity.userId,
      flatNumber: membership.flat.flatNumber,
    };
  }

  /** The terminal admitted someone SocietyOS denies: alert, and remove known-revoked users. */
  private async handleStaleDeviceUser(
    tx: Prisma.TransactionClient,
    device: IngestingDevice,
    event: VendorBiometricEvent,
    reasonCode: string,
  ): Promise<void> {
    this.logger.warn(`Device ${device.id} admitted device user ${event.deviceUserId} denied by SocietyOS (${reasonCode})`);
    await tx.securityAlert.create({
      data: {
        societyId: device.societyId,
        severity: 'WARNING',
        type: 'VENDOR_DEVICE_STALE_USER',
        detail: { deviceId: device.id, deviceUserId: event.deviceUserId, reasonCode, method: event.method },
      },
    });
    // Unknown IDs are only flagged: on terminals that predate SocietyOS they are real residents
    // who have not been mapped yet, and deleting them would lock them out.
    if (reasonCode === 'UNKNOWN_DEVICE_USER') return;
    const alreadyQueued = await tx.deviceSyncCommand.findFirst({
      where: {
        deviceId: device.id,
        kind: 'DELETE_USER',
        status: { in: ['PENDING', 'SENT'] },
        payload: { path: ['deviceUserId'], equals: event.deviceUserId },
      },
      select: { id: true },
    });
    if (!alreadyQueued) {
      await tx.deviceSyncCommand.create({
        data: { deviceId: device.id, kind: 'DELETE_USER', payload: { deviceUserId: event.deviceUserId } },
      });
    }
  }

  private async primaryAccessPoint(deviceId: string): Promise<string | null> {
    const link = await this.prisma.deviceAccessPoint.findFirst({
      where: { deviceId },
      orderBy: { id: 'asc' },
      select: { accessPointId: true },
    });
    return link?.accessPointId ?? null;
  }
}
