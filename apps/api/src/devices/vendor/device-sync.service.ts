import { Injectable } from '@nestjs/common';
import { DeviceSyncCommand, DeviceSyncCommandKind, Prisma } from '@prisma/client';
import { PrismaService } from '../../common/prisma.service';
import { AppException } from '../../common/app.exception';

/** A command is re-delivered if the device never acknowledged it within this window. */
const REDELIVER_AFTER_MS = 5 * 60 * 1000;
/** After this many deliveries without an ack the command is marked FAILED for an operator. */
const MAX_ATTEMPTS = 5;
const MAX_BATCH = 50;

export interface SyncUserPayload {
  deviceUserId: string;
  /** Display name shown on the terminal. Vendors cap this length, so it is pre-truncated. */
  name?: string;
}

/**
 * Queue of commands that must reach vendor terminals. Vendor devices are usually behind NAT, so
 * the cloud never connects to them: the device (ZKTeco ADMS) or the on-site edge connector pulls.
 */
@Injectable()
export class DeviceSyncService {
  constructor(private readonly prisma: PrismaService) {}

  async enqueue(
    deviceIds: string[],
    kind: DeviceSyncCommandKind,
    payload: SyncUserPayload | Record<string, never>,
  ): Promise<number> {
    if (deviceIds.length === 0) return 0;
    const result = await this.prisma.deviceSyncCommand.createMany({
      data: deviceIds.map((deviceId) => ({
        deviceId,
        kind,
        payload: payload as Prisma.InputJsonValue,
      })),
    });
    return result.count;
  }

  /** Vendor devices in a society that need user add/remove commands. */
  async vendorDeviceIds(societyId: string): Promise<string[]> {
    const devices = await this.prisma.device.findMany({
      where: { societyId, status: 'ACTIVE', protocol: { not: 'NATIVE' } },
      select: { id: true },
    });
    return devices.map((device) => device.id);
  }

  /**
   * Hands out pending commands (and unacknowledged ones past the redelivery window) and marks
   * them SENT. Runs in one transaction with row locks so two concurrent polls from the same
   * device never receive the same command twice.
   */
  async pull(deviceId: string, limit = MAX_BATCH): Promise<DeviceSyncCommand[]> {
    const take = Math.min(Math.max(limit, 1), MAX_BATCH);
    const redeliverBefore = new Date(Date.now() - REDELIVER_AFTER_MS);
    return this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM "DeviceSyncCommand"
        WHERE "deviceId" = ${deviceId}::uuid
          AND (status = 'PENDING' OR (status = 'SENT' AND "sentAt" < ${redeliverBefore}))
        ORDER BY "createdAt" ASC
        LIMIT ${take}
        FOR UPDATE SKIP LOCKED`;
      if (rows.length === 0) return [];
      const ids = rows.map((row) => row.id);
      const now = new Date();
      await tx.deviceSyncCommand.updateMany({
        where: { id: { in: ids }, attempts: { gte: MAX_ATTEMPTS } },
        data: { status: 'FAILED', completedAt: now, result: 'No acknowledgement from device' },
      });
      await tx.deviceSyncCommand.updateMany({
        where: { id: { in: ids }, attempts: { lt: MAX_ATTEMPTS } },
        data: { status: 'SENT', sentAt: now, attempts: { increment: 1 } },
      });
      return tx.deviceSyncCommand.findMany({
        where: { id: { in: ids }, status: 'SENT', sentAt: now },
        orderBy: { createdAt: 'asc' },
      });
    });
  }

  /** Records the device's result. Scoped to the device so one device cannot ack another's work. */
  async acknowledge(deviceId: string, commandId: string, success: boolean, result?: string): Promise<void> {
    const updated = await this.prisma.deviceSyncCommand.updateMany({
      where: { id: commandId, deviceId, status: 'SENT' },
      data: {
        status: success ? 'ACKED' : 'FAILED',
        completedAt: new Date(),
        result: result?.slice(0, 500),
      },
    });
    if (updated.count === 0) {
      throw AppException.notFound('SYNC_COMMAND_NOT_FOUND', 'No outstanding command with this id');
    }
  }
}
