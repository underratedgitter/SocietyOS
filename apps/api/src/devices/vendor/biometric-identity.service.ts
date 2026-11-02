import { Injectable } from '@nestjs/common';
import { BiometricIdentity, Prisma } from '@prisma/client';
import { PrismaService } from '../../common/prisma.service';
import { AppException } from '../../common/app.exception';
import { AuditService } from '../../common/audit.service';
import { DeviceSyncService } from './device-sync.service';
import { ALLOCATED_USER_ID_PATTERN, DEVICE_USER_ID_PATTERN } from './vendor-event';

/** Most terminals show 24 characters at best; longer names are rejected by some firmware. */
const TERMINAL_NAME_MAX = 24;

/**
 * Maps residents to the user IDs stored on biometric terminals. Fingerprints and faces are
 * enrolled at the terminal against this ID; SocietyOS never handles the biometric itself.
 */
@Injectable()
export class BiometricIdentityService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly sync: DeviceSyncService,
  ) {}

  list(societyId: string): Promise<BiometricIdentity[]> {
    return this.prisma.biometricIdentity.findMany({
      where: { societyId },
      orderBy: { createdAt: 'asc' },
    });
  }

  /**
   * Assigns (or re-activates) a resident's terminal user ID and queues the user onto every vendor
   * device in the society. `requestedId` lets an admin keep IDs already enrolled on existing
   * terminals; otherwise the next free numeric ID is allocated.
   */
  async assign(
    actorUserId: string,
    societyId: string,
    userId: string,
    requestedId?: string,
  ): Promise<BiometricIdentity> {
    if (requestedId !== undefined && !DEVICE_USER_ID_PATTERN.test(requestedId)) {
      throw AppException.badRequest('INVALID_DEVICE_USER_ID', 'Device user ID must be 1-32 letters, digits, - or _');
    }

    const resident = await this.prisma.user.findFirst({
      where: {
        id: userId,
        flatMemberships: { some: { endedAt: null, flat: { building: { societyId } } } },
      },
      select: { id: true, name: true },
    });
    if (!resident) {
      throw AppException.notFound('RESIDENT_NOT_FOUND', 'No active resident with this id in the society');
    }

    const identity = await this.prisma.$transaction(async (tx) => {
      // Serialises allocation per society so two admins cannot be handed the same next ID.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('biometric-identity'), hashtext(${societyId}))`;

      const existing = await tx.biometricIdentity.findUnique({
        where: { societyId_userId: { societyId, userId } },
      });
      if (existing) {
        if (requestedId !== undefined && requestedId !== existing.deviceUserId) {
          throw AppException.conflict(
            'DEVICE_USER_ID_ALREADY_ASSIGNED',
            `Resident already has device user ID ${existing.deviceUserId}`,
          );
        }
        if (!existing.revokedAt) return existing;
        return tx.biometricIdentity.update({ where: { id: existing.id }, data: { revokedAt: null } });
      }

      const deviceUserId = requestedId ?? (await this.nextFreeId(tx, societyId));
      try {
        return await tx.biometricIdentity.create({ data: { societyId, userId, deviceUserId } });
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
          throw AppException.conflict('DEVICE_USER_ID_TAKEN', `Device user ID ${deviceUserId} belongs to someone else`);
        }
        throw error;
      }
    });

    await this.sync.enqueue(await this.sync.vendorDeviceIds(societyId), 'UPSERT_USER', {
      deviceUserId: identity.deviceUserId,
      name: resident.name.slice(0, TERMINAL_NAME_MAX),
    });
    await this.audit.record({
      societyId,
      actorUserId,
      action: 'BIOMETRIC_IDENTITY_ASSIGNED',
      entityType: 'BiometricIdentity',
      entityId: identity.id,
      meta: { userId, deviceUserId: identity.deviceUserId },
    });
    return identity;
  }

  /**
   * Revokes the ID and queues its removal from every vendor terminal. The row is kept so the ID is
   * never reissued to another person while an old fingerprint may still sit on a device.
   */
  async revoke(actorUserId: string, societyId: string, identityId: string): Promise<BiometricIdentity> {
    const revoked = await this.prisma.biometricIdentity.updateMany({
      where: { id: identityId, societyId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    const identity = await this.prisma.biometricIdentity.findFirst({ where: { id: identityId, societyId } });
    if (!identity) {
      throw AppException.notFound('BIOMETRIC_IDENTITY_NOT_FOUND', 'Biometric identity not found');
    }
    if (revoked.count === 0) return identity;

    await this.sync.enqueue(await this.sync.vendorDeviceIds(societyId), 'DELETE_USER', {
      deviceUserId: identity.deviceUserId,
    });
    await this.audit.record({
      societyId,
      actorUserId,
      action: 'BIOMETRIC_IDENTITY_REVOKED',
      entityType: 'BiometricIdentity',
      entityId: identity.id,
      meta: { userId: identity.userId, deviceUserId: identity.deviceUserId },
    });
    return identity;
  }

  private async nextFreeId(tx: Prisma.TransactionClient, societyId: string): Promise<string> {
    const rows = await tx.$queryRaw<{ max: number | null }[]>`
      SELECT MAX("deviceUserId"::bigint)::int AS max FROM "BiometricIdentity"
      WHERE "societyId" = ${societyId}::uuid AND "deviceUserId" ~ '^[0-9]{1,9}$'`;
    const next = String((rows[0]?.max ?? 0) + 1);
    if (!ALLOCATED_USER_ID_PATTERN.test(next)) {
      throw AppException.conflict('DEVICE_USER_ID_EXHAUSTED', 'No numeric device user IDs left for this society');
    }
    return next;
  }
}
