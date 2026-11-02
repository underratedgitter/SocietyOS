import { Body, Controller, Get, Post, Req, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { IsArray, IsBoolean, IsIn, IsInt, IsObject, IsOptional, IsString, IsUUID, Max, MaxLength, Min, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { DeviceAuthGuard } from './device-auth.guard';
import { AuthedRequest } from '../auth/jwt-auth.guard';
import { PrismaService } from '../common/prisma.service';
import { AppException } from '../common/app.exception';

const DEVICE_EVENT_TYPES = [
  'COMMAND_RECEIVED',
  'ACK',
  'STATE_CHANGED',
  'SENSOR',
  'HEARTBEAT',
  'TAMPER',
  'FAULT',
] as const;

export class QueuedOfflineEventDto {
  @IsInt()
  @Min(1)
  sequence!: number;

  @IsUUID()
  accessPointId!: string;

  @IsString()
  credentialType!: string;

  @IsIn(['AUTHORIZED', 'DENIED'])
  decision!: 'AUTHORIZED' | 'DENIED';

  @IsString()
  reasonCode!: string;

  @IsString()
  timestamp!: string;

  @IsOptional()
  @IsString()
  passId?: string;

  @IsOptional()
  @IsString()
  credentialHash?: string;
}

export class SyncOfflineEventsDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => QueuedOfflineEventDto)
  events!: QueuedOfflineEventDto[];
}


export class DeviceHealthDto {
  @IsBoolean()
  online!: boolean;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10_000_000)
  uptimeS?: number;

  @IsOptional()
  @IsInt()
  @Min(-150)
  @Max(0)
  rssi?: number;

  @IsOptional()
  @IsObject()
  meta?: Record<string, unknown>;
}

export class DeviceEventDto {
  @IsIn(DEVICE_EVENT_TYPES)
  type!: (typeof DEVICE_EVENT_TYPES)[number];

  @IsOptional()
  @IsUUID()
  accessPointId?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  sequence?: number;

  @IsObject()
  payload!: Record<string, unknown>;
}

@ApiTags('device-api')
@Controller('device-api')
@UseGuards(DeviceAuthGuard)
export class DeviceApiController {
  constructor(private readonly prisma: PrismaService) {}

  @Get('me')
  me(@Req() req: AuthedRequest) {
    return this.prisma.device.findUnique({
      where: { id: req.device!.id },
      select: {
        id: true,
        deviceUid: true,
        name: true,
        societyId: true,
        status: true,
        firmware: true,
        lastSeenAt: true,
        accessPoints: {
          include: { accessPoint: { select: { id: true, name: true, type: true, location: true } } },
        },
      },
    });
  }

  @Post('health')
  async health(@Req() req: AuthedRequest, @Body() dto: DeviceHealthDto) {
    const payloadSize = JSON.stringify(dto.meta ?? {}).length;
    if (payloadSize > 4096) throw AppException.unprocessable('PAYLOAD_TOO_LARGE', 'Health metadata is too large');
    await this.prisma.$transaction([
      this.prisma.deviceHealthLog.create({
        data: {
          deviceId: req.device!.id,
          online: dto.online,
          uptimeS: dto.uptimeS,
          rssi: dto.rssi,
          meta: (dto.meta ?? {}) as never,
        },
      }),
      this.prisma.device.update({
        where: { id: req.device!.id },
        data: { lastSeenAt: new Date() },
      }),
    ]);
    return { ok: true, serverTime: new Date().toISOString() };
  }

  @Post('events')
  async events(@Req() req: AuthedRequest, @Body() dto: DeviceEventDto) {
    if (JSON.stringify(dto.payload).length > 8192) {
      throw AppException.unprocessable('PAYLOAD_TOO_LARGE', 'Event payload is too large');
    }
    if (dto.accessPointId) {
      const link = await this.prisma.deviceAccessPoint.findUnique({
        where: {
          deviceId_accessPointId: {
            deviceId: req.device!.id,
            accessPointId: dto.accessPointId,
          },
        },
      });
      if (!link) throw AppException.forbidden('WRONG_ACCESS_POINT', 'Access point is not assigned to this device');
    }
    if (dto.sequence != null && typeof this.prisma.deviceEvent.findFirst === 'function') {
      const existing = await this.prisma.deviceEvent.findFirst({
        where: { deviceId: req.device!.id, sequence: dto.sequence },
        select: { id: true },
      });
      if (existing) {
        await this.prisma.device.update({
          where: { id: req.device!.id },
          data: { lastSeenAt: new Date() },
        }).catch(() => undefined);
        return { ok: true, eventId: existing.id, duplicate: true };
      }
    }

    try {
      const event = await this.prisma.deviceEvent.create({
        data: {
          deviceId: req.device!.id,
          accessPointId: dto.accessPointId,
          type: dto.type,
          sequence: dto.sequence,
          payload: dto.payload as never,
        },
      });
      await this.prisma.device.update({
        where: { id: req.device!.id },
        data: { lastSeenAt: new Date() },
      });
      return { ok: true, eventId: event.id };
    } catch (err: any) {
      if (
        (err?.code === 'P2002' || String(err).includes('sequence')) &&
        dto.sequence != null &&
        typeof this.prisma.deviceEvent.findFirst === 'function'
      ) {
        const existing = await this.prisma.deviceEvent.findFirst({
          where: { deviceId: req.device!.id, sequence: dto.sequence },
          select: { id: true },
        });
        return { ok: true, eventId: existing?.id, duplicate: true };
      }
      throw err;
    }
  }

  @Post('sync-offline')
  async syncOffline(@Req() req: AuthedRequest, @Body() dto: SyncOfflineEventsDto) {
    if (!dto.events || !Array.isArray(dto.events)) {
      throw AppException.badRequest('INVALID_PAYLOAD', 'events must be an array');
    }
    if (dto.events.length > 500) {
      throw AppException.unprocessable('BATCH_TOO_LARGE', 'Maximum 500 events per batch');
    }

    const deviceId = req.device!.id;
    const societyId = req.device!.societyId;

    const apIds = Array.from(new Set(dto.events.map((e) => e.accessPointId)));
    const validAps = await this.prisma.accessPoint.findMany({
      where: {
        id: { in: apIds },
        societyId,
        devices: { some: { deviceId } },
      },
      select: { id: true },
    });
    const validApSet = new Set(validAps.map((ap) => ap.id));

    let syncedCount = 0;
    let duplicateCount = 0;
    const now = new Date();
    const seenSequencesInBatch = new Set<number>();

    await this.prisma.$transaction(async (tx) => {
      // Serialize offline event ingestion for this device using advisory lock
      if (typeof (tx as any).$executeRawUnsafe === 'function') {
        await (tx as any)
          .$executeRawUnsafe(
            `SELECT pg_advisory_xact_lock(hashtext('device-sync'), hashtext($1))`,
            deviceId,
          )
          .catch(() => undefined);
      }

      const batchSeqs = dto.events.map((e) => e.sequence).filter((s): s is number => s != null);
      const existingInDb =
        batchSeqs.length > 0 && typeof tx.deviceEvent.findMany === 'function'
          ? await tx.deviceEvent.findMany({
              where: { deviceId, sequence: { in: batchSeqs } },
              select: { sequence: true },
            })
          : [];
      const dbSeqSet = new Set(existingInDb.map((e) => e.sequence));

      for (const ev of dto.events) {
        if (!validApSet.has(ev.accessPointId)) continue;

        // Replay / duplicate prevention by sequence within batch and database
        if (ev.sequence != null) {
          if (seenSequencesInBatch.has(ev.sequence) || dbSeqSet.has(ev.sequence)) {
            duplicateCount++;
            continue;
          }
          seenSequencesInBatch.add(ev.sequence);
        }

        // Additional sequence check if sequence exists
        if (ev.sequence != null && typeof tx.deviceEvent.findFirst === 'function') {
          const existing = await tx.deviceEvent.findFirst({
            where: {
              deviceId,
              sequence: ev.sequence,
            },
            select: { id: true },
          });
          if (existing) {
            duplicateCount++;
            continue;
          }
        }

        const credType = (['PIN', 'QR'].includes(ev.credentialType) ? ev.credentialType : null) as any;
        const requestedAt = new Date(ev.timestamp);
        let validTime = !isNaN(requestedAt.getTime()) ? requestedAt : now;
        let clockDriftDetected = false;
        let driftMs = 0;

        if (!isNaN(requestedAt.getTime())) {
          driftMs = requestedAt.getTime() - now.getTime();
          // Future clock drift (> 60s ahead) is clamped to server time to prevent audit log corruption
          if (driftMs > 60_000) {
            clockDriftDetected = true;
            validTime = now;
          } else if (driftMs < -30 * 86400_000) {
            // Extreme past drift (> 30 days) is flagged
            clockDriftDetected = true;
          }
        }

        // Atomically reserve the device event sequence BEFORE creating access events or updating pass usage
        if (typeof (tx as any).$executeRawUnsafe === 'function') {
          await (tx as any).$executeRawUnsafe('SAVEPOINT dev_ev_ins').catch(() => undefined);
        }
        try {
          await tx.deviceEvent.create({
            data: {
              deviceId,
              accessPointId: ev.accessPointId,
              type: 'ACK',
              sequence: ev.sequence,
              payload: {
                offlineSequence: ev.sequence,
                decision: ev.decision,
                reasonCode: ev.reasonCode,
                source: 'OFFLINE_CONTROLLER_SYNC',
                clockDriftDetected,
              } as never,
            },
          });
          if (typeof (tx as any).$executeRawUnsafe === 'function') {
            await (tx as any).$executeRawUnsafe('RELEASE SAVEPOINT dev_ev_ins').catch(() => undefined);
          }
        } catch (err: any) {
          if (typeof (tx as any).$executeRawUnsafe === 'function') {
            await (tx as any).$executeRawUnsafe('ROLLBACK TO SAVEPOINT dev_ev_ins').catch(() => undefined);
          }
          if (err?.code === 'P2002' || String(err).includes('sequence') || String(err).includes('unique')) {
            duplicateCount++;
            continue;
          }
          throw err;
        }

        const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        let passId = ev.passId;
        if (!passId && ev.credentialHash && typeof (tx as any).visitorPassCredential?.findFirst === 'function') {
          const cred = await (tx as any).visitorPassCredential.findFirst({
            where: { credentialHash: ev.credentialHash, pass: { societyId } },
            select: { passId: true },
          });
          if (cred) passId = cred.passId;
        }
        const candidatePassId = passId && UUID_REGEX.test(passId) ? passId : undefined;

        // passId is device-supplied: only accept passes owned by the device's own society,
        // otherwise a device could consume or exhaust another tenant's passes.
        let ownedPass: { id: string; usedCount: number; maxUses: number; status: string } | null = null;
        if (candidatePassId && typeof (tx as any).visitorPass?.findUnique === 'function') {
          const pass = await (tx as any).visitorPass.findUnique({
            where: { id: candidatePassId },
            select: { id: true, societyId: true, usedCount: true, maxUses: true, status: true },
          });
          if (pass && pass.societyId === societyId) ownedPass = pass;
        }
        const validPassId = ownedPass?.id;

        await tx.accessEvent.create({
          data: {
            societyId,
            accessPointId: ev.accessPointId,
            deviceId,
            passId: validPassId,
            decision: ev.decision,
            reasonCode: ev.reasonCode,
            source: 'OFFLINE_EDGE_CONTROLLER',
            credentialType: credType,
            requestedAt: validTime,
            meta: {
              offlineSequence: ev.sequence,
              rawCredentialType: ev.credentialType,
              resyncedAt: now.toISOString(),
              reportedTimestamp: ev.timestamp,
              clockDriftDetected,
              driftMs,
            } as never,
          },
        });

        if (ev.decision === 'AUTHORIZED' && ownedPass && typeof (tx as any).visitorPass?.update === 'function') {
          const nextCount = ownedPass.usedCount + 1;
          await (tx as any).visitorPass.update({
            where: { id: ownedPass.id },
            data: {
              usedCount: nextCount,
              ...(nextCount >= ownedPass.maxUses && ownedPass.status === 'ACTIVE'
                ? { status: 'EXHAUSTED' }
                : {}),
            },
          });
        }

        syncedCount++;
      }

      await tx.device.update({
        where: { id: deviceId },
        data: { lastSeenAt: now },
      });
    });

    return { ok: true, syncedCount, duplicateCount, serverTime: now.toISOString() };
  }

  @Get('edge-sync')
  async edgeSync(@Req() req: AuthedRequest) {
    const deviceId = req.device!.id;
    const societyId = req.device!.societyId;

    const device = await this.prisma.device.findUnique({
      where: { id: deviceId },
      include: {
        accessPoints: { select: { accessPointId: true } },
      },
    });

    const apIds = device?.accessPoints.map((ap) => ap.accessPointId) ?? [];
    const now = new Date();
    const boundedFuture = new Date(now.getTime() + 24 * 3600 * 1000);

    const passes = await this.prisma.visitorPass.findMany({
      where: {
        societyId,
        status: 'ACTIVE',
        validUntil: { gte: now },
        validFrom: { lte: boundedFuture },
        revokedAt: null,
        OR: [
          { accessPoints: { none: {} } },
          { accessPoints: { some: { accessPointId: { in: apIds } } } },
        ],
      },
      include: {
        visitor: { select: { name: true } },
        flat: { select: { flatNumber: true, building: { select: { name: true } } } },
        credentials: { select: { credentialHash: true, type: true } },
      },
    });

    const credentialsList = passes
      .filter((p) => p.usedCount < p.maxUses)
      .flatMap((p) =>
        p.credentials.map((c) => ({
          passId: p.id,
          credentialHash: c.credentialHash,
          kind: c.type,
          visitorName: p.visitor.name,
          flatNumber: `${p.flat.building.name} · ${p.flat.flatNumber}`,
          validFrom: p.validFrom.getTime(),
          validUntil: p.validUntil.getTime(),
          maxUses: p.maxUses,
          usedCount: p.usedCount,
        })),
      );

    const biometricTemplates = await this.prisma.biometricTemplate.findMany({
      where: {
        societyId,
        consentGivenAt: { lte: now },
        user: {
          memberships: { some: { societyId, status: 'ACTIVE' } },
          flatMemberships: {
            some: {
              flat: { building: { societyId } },
              endedAt: null,
            },
          },
        },
      },
      include: {
        user: {
          select: {
            id: true,
            name: true,
            flatMemberships: {
              where: {
                flat: { building: { societyId } },
                endedAt: null,
              },
              include: {
                flat: { select: { flatNumber: true, building: { select: { name: true } } } },
              },
            },
          },
        },
      },
    });

    const residentCredentials = biometricTemplates.map((t) => {
      const primaryFlat = t.user.flatMemberships[0]?.flat;
      const flatNumber = primaryFlat
        ? `${primaryFlat.building.name} · ${primaryFlat.flatNumber}`
        : '';
      return {
        credentialHash: t.templateHash,
        kind: 'BIOMETRIC' as const,
        visitorName: `${t.user.name} (Resident)`,
        flatNumber,
        validFrom: 0,
        validUntil: now.getTime() + 365 * 86400_000,
        maxUses: 999999,
        usedCount: 0,
      };
    });

    const revokedPasses = await this.prisma.visitorPass.findMany({
      where: {
        societyId,
        OR: [{ status: 'REVOKED' }, { revokedAt: { not: null } }],
      },
      include: {
        credentials: { select: { credentialHash: true } },
      },
    });
    const revokedPassHashes = (revokedPasses || []).flatMap((p) => p.credentials.map((c) => c.credentialHash));

    const endedResidents = await this.prisma.residentFlatMembership.findMany({
      where: {
        flat: { building: { societyId } },
        endedAt: { not: null },
      },
      select: { userId: true },
    });
    const endedUserIds = Array.from(new Set((endedResidents || []).map((r) => r.userId)));
    const endedTemplates = endedUserIds.length > 0
      ? await this.prisma.biometricTemplate.findMany({
          where: {
            societyId,
            userId: { in: endedUserIds },
          },
          select: { templateHash: true },
        })
      : [];
    const activeResidentHashes = new Set(residentCredentials.map((c) => c.credentialHash));
    const endedResidentHashes = (endedTemplates || [])
      .map((t) => t.templateHash)
      .filter((h) => !activeResidentHashes.has(h));

    const allRevokedHashes = [...revokedPassHashes, ...endedResidentHashes];

    return {
      ok: true,
      serverTime: now.toISOString(),
      societyId,
      deviceId,
      assignedAccessPoints: apIds,
      policy: {
        offlineValidityWindowHours: 24,
        maxOfflineEvents: 500,
        syncIntervalSeconds: 300,
      },
      credentials: [...residentCredentials, ...credentialsList],
      revokedHashes: Array.from(new Set(allRevokedHashes)),
    };
  }
}

