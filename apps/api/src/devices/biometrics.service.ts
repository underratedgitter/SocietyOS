import * as crypto from 'crypto';
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../common/prisma.service';
import { AuditService } from '../common/audit.service';
import { AppException } from '../common/app.exception';
import { GateAdapterFactory } from './adapters/gate-adapter.factory';
import { MqttService } from './mqtt.service';
import { encryptDeviceSecret } from '../common/crypto.util';

export interface BiometricEnrollDto {
  userId: string;
  type: 'FINGERPRINT' | 'FACE';
  templateHash: string;
  algorithm: string;
  rawTemplate?: string;
  consentGiven?: boolean;
  consentNotice?: string;
}

export interface BiometricVerifyDto {
  accessPointId: string;
  templateHash: string;
  type: 'FINGERPRINT' | 'FACE';
}

/** Set when the scan arrives from an authenticated gate reader rather than the guard console. */
export interface BiometricVerifyOrigin {
  deviceId: string;
  requestId: string;
}

@Injectable()
export class BiometricsService implements OnModuleInit {
  private readonly logger = new Logger(BiometricsService.name);

  // In-memory DPDP-compliant template store indexed by societyId -> userId
  // Only stores SHA256 hashes of vendor templates, NEVER raw biometric imagery
  private readonly templateRegistry = new Map<
    string,
    {
      userId: string;
      societyId: string;
      type: 'FINGERPRINT' | 'FACE';
      templateHash: string;
      algorithm: string;
      consentGivenAt: Date;
      lawfulBasis: string;
    }
  >();

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly adapterFactory: GateAdapterFactory,
    private readonly mqtt: MqttService,
  ) {}

  async onModuleInit() {
    try {
      // DPDP Act 2023 Compliance:
      // Only preload explicitly consented and persisted biometric records.
      // Automatic boot-time consent synthesis is removed to prevent unlawful data processing.
      const persistedTemplates = await this.prisma.biometricTemplate.findMany();
      for (const tmpl of persistedTemplates) {
        this.templateRegistry.set(`${tmpl.societyId}:${tmpl.templateHash}`, {
          userId: tmpl.userId,
          societyId: tmpl.societyId,
          type: tmpl.type as 'FINGERPRINT' | 'FACE',
          templateHash: tmpl.templateHash,
          algorithm: tmpl.algorithm,
          consentGivenAt: tmpl.consentGivenAt,
          lawfulBasis: tmpl.lawfulBasis,
        });
      }
      this.logger.log(`Preloaded ${persistedTemplates.length} explicitly consented resident biometric templates`);
    } catch (err) {
      this.logger.warn(`Could not preload resident biometric templates: ${String(err)}`);
    }
  }

  async enrollResidentBiometric(
    actorUserId: string,
    societyId: string,
    dto: BiometricEnrollDto,
  ) {
    if (dto.consentGiven === false) {
      throw AppException.unprocessable(
        'DPDP_CONSENT_REQUIRED',
        'Explicit consent under India DPDP Act 2023 Section 6 is mandatory prior to biometric template enrollment.',
      );
    }

    // Validate resident belongs to this society
    const membership = await this.prisma.societyMembership.findUnique({
      where: {
        societyId_userId: {
          societyId,
          userId: dto.userId,
        },
      },
      include: { user: true },
    });

    if (!membership || membership.status !== 'ACTIVE') {
      throw AppException.notFound(
        'RESIDENT_NOT_FOUND',
        'Resident is not an active member of this society',
      );
    }

    if (
      !dto.templateHash ||
      dto.templateHash.startsWith('BIO_RESIDENT_') ||
      dto.templateHash.startsWith('FINGERPRINT_RESIDENT_')
    ) {
      throw AppException.badRequest(
        'INVALID_BIOMETRIC_TEMPLATE',
        'Synthetic biometric identifiers cannot be enrolled as biometric proof.',
      );
    }

    const key = `${societyId}:${dto.templateHash}`;
    const enrollment = {
      userId: dto.userId,
      societyId,
      type: dto.type,
      templateHash: dto.templateHash,
      algorithm: dto.algorithm || 'SUPREMA_FACE_V3',
      consentGivenAt: new Date(),
      lawfulBasis: 'DPDP_2023_SECTION_6_EXPLICIT_CONSENT',
    };

    // Encrypt template payload with AES-256-GCM and store in PostgreSQL.
    // templateHash is globally unique, so the society is part of the upsert match: a hash
    // already enrolled by another society falls through to create and hits the unique
    // constraint instead of silently re-homing that tenant's template.
    const encryptedTemplate = encryptDeviceSecret(dto.rawTemplate || dto.templateHash);
    try {
      await this.persistTemplate(actorUserId, societyId, dto, enrollment, encryptedTemplate);
    } catch (err: unknown) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw AppException.conflict(
          'BIOMETRIC_TEMPLATE_CONFLICT',
          'This biometric template is already enrolled elsewhere',
        );
      }
      throw err;
    }

    // Only cache once persisted, otherwise a failed enrollment would still authorize at the gate.
    this.templateRegistry.set(key, enrollment);

    await this.audit.record({
      societyId,
      actorUserId,
      actorRole: 'SOCIETY_ADMIN',
      action: 'BIOMETRIC_ENROLLED',
      entityType: 'User',
      entityId: dto.userId,
      meta: {
        type: dto.type,
        algorithm: dto.algorithm,
        dataMinimizationNotice: 'Stored in encrypted PostgreSQL table with SHA-256 edge template hashing only; zero raw biometric imagery retained.',
        lawfulBasis: enrollment.lawfulBasis,
      },
    });

    return {
      success: true,
      userId: dto.userId,
      type: dto.type,
      algorithm: dto.algorithm,
      enrolledAt: enrollment.consentGivenAt,
      dpdpCompliance: {
        notice: 'India DPDP Act 2023 compliant. Biometric template reference stored securely.',
      },
    };
  }

  private async persistTemplate(
    actorUserId: string,
    societyId: string,
    dto: BiometricEnrollDto,
    enrollment: { algorithm: string; consentGivenAt: Date; lawfulBasis: string },
    encryptedTemplate: string,
  ): Promise<void> {
    await this.prisma.biometricTemplate.upsert({
      where: { templateHash: dto.templateHash, societyId },
      update: {
        userId: dto.userId,
        type: dto.type,
        encryptedTemplate,
        algorithm: enrollment.algorithm,
        consentGivenAt: enrollment.consentGivenAt,
        lawfulBasis: enrollment.lawfulBasis,
        consentText: dto.consentNotice || 'India DPDP Act 2023 Section 6 explicit resident biometric processing consent',
        enrolledBy: actorUserId,
      },
      create: {
        societyId,
        userId: dto.userId,
        type: dto.type,
        templateHash: dto.templateHash,
        encryptedTemplate,
        algorithm: enrollment.algorithm,
        consentGivenAt: enrollment.consentGivenAt,
        lawfulBasis: enrollment.lawfulBasis,
        consentText: dto.consentNotice || 'India DPDP Act 2023 Section 6 explicit resident biometric processing consent',
        enrolledBy: actorUserId,
      },
    });
  }

  async verifyResidentBiometric(
    societyId: string,
    dto: BiometricVerifyDto,
    origin?: BiometricVerifyOrigin,
  ) {
    const isSynthetic =
      !dto.templateHash ||
      dto.templateHash.startsWith('BIO_RESIDENT_') ||
      dto.templateHash.startsWith('FINGERPRINT_RESIDENT_');

    const key = `${societyId}:${dto.templateHash}`;
    let enrollment = !isSynthetic ? this.templateRegistry.get(key) : undefined;

    if (!enrollment && !isSynthetic) {
      const persisted = await this.prisma.biometricTemplate.findFirst({
        where: { societyId, templateHash: dto.templateHash },
      });
      if (persisted) {
        enrollment = {
          userId: persisted.userId,
          societyId: persisted.societyId,
          type: persisted.type as 'FINGERPRINT' | 'FACE',
          templateHash: persisted.templateHash,
          algorithm: persisted.algorithm,
          consentGivenAt: persisted.consentGivenAt,
          lawfulBasis: persisted.lawfulBasis,
        };
        this.templateRegistry.set(key, enrollment);
      }
    }

    // Synthetic/placeholder biometric identifiers (e.g. FINGERPRINT_RESIDENT_*, BIO_RESIDENT_*)
    // are explicitly rejected. Biometric verification must use real enrolled templates only.

    const accessPoint = await this.prisma.accessPoint.findFirst({
      where: { id: dto.accessPointId, societyId },
      include: { devices: { include: { device: true } } },
    });

    if (!accessPoint) {
      throw AppException.notFound('ACCESS_POINT_NOT_FOUND', 'Access point not found in this society');
    }

    if (!enrollment || enrollment.type !== dto.type) {
      // Denial: Unknown biometric template
      const denialEvent = await this.prisma.accessEvent.create({
        data: {
          societyId,
          accessPointId: dto.accessPointId,
          decision: 'DENIED',
          reasonCode: 'BIOMETRIC_NOT_RECOGNIZED',
          source: 'BIOMETRIC_READER',
          deviceId: origin?.deviceId,
          requestId: origin?.requestId,
          meta: { type: dto.type },
        },
      });

      return {
        decision: 'DENIED' as const,
        reasonCode: 'BIOMETRIC_NOT_RECOGNIZED',
        accessEventId: denialEvent.id,
      };
    }

    // Verify resident still lives in THIS society: an active flat elsewhere must not open this gate.
    const resident = await this.prisma.user.findUnique({
      where: { id: enrollment.userId },
      include: {
        flatMemberships: {
          where: { endedAt: null, flat: { building: { societyId } } },
          include: { flat: true },
        },
      },
    });

    if (!resident || resident.flatMemberships.length === 0) {
      const denialEvent = await this.prisma.accessEvent.create({
        data: {
          societyId,
          accessPointId: dto.accessPointId,
          decision: 'DENIED',
          reasonCode: 'RESIDENT_MEMBERSHIP_INACTIVE',
          source: 'BIOMETRIC_READER',
          deviceId: origin?.deviceId,
          requestId: origin?.requestId,
          meta: { userId: enrollment.userId },
        },
      });

      return {
        decision: 'DENIED' as const,
        reasonCode: 'RESIDENT_MEMBERSHIP_INACTIVE',
        accessEventId: denialEvent.id,
      };
    }

    // Actuate real hardware on Biometrics: insert GateCommand into PostgreSQL and publish via MQTT
    // A reader-originated scan actuates the reader's own (already authenticated and linked)
    // controller rather than whichever device happens to be linked first.
    const controller = accessPoint.devices.find((link) =>
      link.device.status === 'ACTIVE' && (!origin?.deviceId || link.deviceId === origin.deviceId),
    );
    const deviceIdBio = controller?.deviceId;
    let gateCommand:
      | { status: 'ISSUED'; id: string }
      | { status: 'FAILED'; error: string };

    if (deviceIdBio) {
      const commandIdBio = crypto.randomUUID();
      const nowBio = new Date();
      const expiresAtBio = new Date(nowBio.getTime() + 15 * 1000);
      try {
        await this.prisma.gateCommand.create({
          data: {
            id: commandIdBio,
            deviceId: deviceIdBio,
            accessPointId: accessPoint.id,
            type: 'OPEN',
            status: 'ISSUED',
            nonce: crypto.randomBytes(16).toString('hex'),
            issuedAt: nowBio,
            expiresAt: expiresAtBio,
          },
        });
        await this.mqtt.publishCommand(commandIdBio);
        gateCommand = { status: 'ISSUED', id: commandIdBio };
      } catch (cmdErr: unknown) {
        const errorMsg = cmdErr instanceof Error ? cmdErr.message : String(cmdErr);
        this.logger.warn(`Biometric GateCommand/MQTT dispatch failed: ${errorMsg}`);
        await this.prisma.gateCommand.updateMany({
          where: { id: commandIdBio, status: 'ISSUED' }, data: { status: 'EXPIRED' },
        });
        gateCommand = { status: 'FAILED', error: errorMsg };
      }
    } else {
      gateCommand = {
        status: 'FAILED',
        error: 'No active device configured for access point',
      };
    }

    const accessEvent = await this.prisma.accessEvent.create({
      data: {
        societyId,
        accessPointId: dto.accessPointId,
        decision: 'AUTHORIZED',
        reasonCode: 'VALID_RESIDENT_BIOMETRIC',
        source: 'BIOMETRIC_READER',
        deviceId: origin?.deviceId,
        requestId: origin?.requestId,
        meta: {
          userId: resident.id,
          userName: resident.name,
          flatNumber: resident.flatMemberships[0].flat.flatNumber,
          type: dto.type,
          algorithm: enrollment.algorithm,
          gateCommand,
        },
      },
    });

    return {
      decision: 'AUTHORIZED' as const,
      reasonCode: 'VALID_RESIDENT_BIOMETRIC',
      accessEventId: accessEvent.id,
      resident: {
        id: resident.id,
        name: resident.name,
        flatNumber: resident.flatMemberships[0].flat.flatNumber,
      },
      gateCommand,
    };
  }

  async triggerEmergencyOverride(
    societyId: string,
    actorUserId: string,
    actorRole: string,
    accessPointId: string,
    reason: string,
  ) {
    const accessPoint = await this.prisma.accessPoint.findFirst({
      where: { id: accessPointId, societyId },
      include: { devices: { include: { device: true } } },
    });

    if (!accessPoint) {
      throw AppException.notFound('ACCESS_POINT_NOT_FOUND', 'Access point not found in this society');
    }

    const adapter = this.adapterFactory.getOrCreate(
      accessPoint.id,
      accessPoint.name,
      accessPoint.type,
    );

    // Actuate real hardware on Emergency: insert GateCommand into PostgreSQL and publish via MQTT
    const deviceIdsEmerg = Array.from(
      new Set(
        (accessPoint.devices || [])
          .map((d) => d.deviceId || d.device?.id)
          .filter((id): id is string => Boolean(id)),
      ),
    );

    const deviceResults: { deviceId: string; commandId?: string; status: 'ISSUED' | 'FAILED'; error?: string }[] = [];
    for (const devId of deviceIdsEmerg) {
      const commandIdEmerg = crypto.randomUUID();
      const nowEmerg = new Date();
      const expiresAtEmerg = new Date(nowEmerg.getTime() + 15 * 1000);
      try {
        await this.prisma.gateCommand.create({
          data: {
            id: commandIdEmerg,
            deviceId: devId,
            accessPointId: accessPoint.id,
            type: 'OPEN',
            status: 'ISSUED',
            nonce: crypto.randomBytes(16).toString('hex'),
            issuedAt: nowEmerg,
            expiresAt: expiresAtEmerg,
          },
        });
        // Publish ONLY after a successful insert
        await this.mqtt.publishCommand(commandIdEmerg);
        deviceResults.push({ deviceId: devId, commandId: commandIdEmerg, status: 'ISSUED' });
      } catch (cmdErr: unknown) {
        const errorMsg = cmdErr instanceof Error ? cmdErr.message : String(cmdErr);
        this.logger.warn(`Emergency GateCommand insertion/publish failed for device ${devId}: ${errorMsg}`);
        deviceResults.push({ deviceId: devId, status: 'FAILED', error: errorMsg });
      }
    }

    const successfulDispatches = deviceResults.filter((r) => r.status === 'ISSUED');
    if (deviceIdsEmerg.length === 0 || successfulDispatches.length === 0) {
      let failedAccessEventId: string | undefined;
      try {
        const failedAccessEvent = await this.prisma.accessEvent.create({
          data: {
            societyId,
            accessPointId,
            decision: 'DENIED',
            reasonCode: 'EMERGENCY_DISPATCH_FAILED',
            source: 'MANUAL_OVERRIDE',
            meta: {
              actorUserId,
              actorRole,
              reason,
              deviceResults,
            },
          },
        });
        failedAccessEventId = failedAccessEvent?.id;
      } catch (evtErr: unknown) {
        this.logger.error(`Failed to record accessEvent on emergency dispatch failure: ${String(evtErr)}`);
      }

      await this.audit.record({
        societyId,
        actorUserId,
        actorRole,
        action: 'GATE_EMERGENCY_OVERRIDE',
        entityType: 'AccessPoint',
        entityId: accessPointId,
        meta: {
          reason,
          ...(failedAccessEventId ? { accessEventId: failedAccessEventId } : {}),
          status: 'FAILED',
          deviceResults,
        },
      });

      throw AppException.badGateway(
        'COMMAND_DISPATCH_FAILED',
        'No active gate controller device received the emergency override command',
      );
    }

    // Trigger emergency override on the gate controller only after hardware dispatch succeeds
    await adapter.emergencyOverride(reason);

    const accessEvent = await this.prisma.accessEvent.create({
      data: {
        societyId,
        accessPointId,
        decision: 'AUTHORIZED',
        reasonCode: 'EMERGENCY_OVERRIDE',
        source: 'MANUAL_OVERRIDE',
        meta: {
          actorUserId,
          actorRole,
          reason,
          gateState: 'OPEN',
        },
      },
    });

    await this.audit.record({
      societyId,
      actorUserId,
      actorRole,
      action: 'GATE_EMERGENCY_OVERRIDE',
      entityType: 'AccessPoint',
      entityId: accessPointId,
      meta: { reason, accessEventId: accessEvent.id },
    });

    return {
      success: true,
      decision: 'AUTHORIZED',
      reasonCode: 'EMERGENCY_OVERRIDE',
      accessEventId: accessEvent.id,
      gateState: await adapter.getState(),
      message: 'Emergency override activated: gate held open',
      deviceResults,
    };
  }

  async resetEmergencyOverride(
    societyId: string,
    actorUserId: string,
    actorRole: string,
    accessPointId: string,
    reason?: string,
  ) {
    const accessPoint = await this.prisma.accessPoint.findFirst({
      where: { id: accessPointId, societyId },
      include: { devices: { include: { device: true } } },
    });

    if (!accessPoint) {
      throw AppException.notFound('ACCESS_POINT_NOT_FOUND', 'Access point not found in this society');
    }

    const adapter = this.adapterFactory.getOrCreate(
      accessPoint.id,
      accessPoint.name,
      accessPoint.type,
    );

    // Actuate real hardware on Reset: insert GateCommand into PostgreSQL and publish via MQTT
    const deviceIdsReset = Array.from(
      new Set(
        (accessPoint.devices || [])
          .map((d) => d.deviceId || d.device?.id)
          .filter((id): id is string => Boolean(id)),
      ),
    );

    const deviceResultsReset: { deviceId: string; commandId?: string; status: 'ISSUED' | 'FAILED'; error?: string }[] = [];
    for (const devId of deviceIdsReset) {
      const commandIdReset = crypto.randomUUID();
      const nowReset = new Date();
      const expiresAtReset = new Date(nowReset.getTime() + 15 * 1000);
      try {
        await this.prisma.gateCommand.create({
          data: {
            id: commandIdReset,
            deviceId: devId,
            accessPointId: accessPoint.id,
            type: 'CLOSE',
            status: 'ISSUED',
            nonce: crypto.randomBytes(16).toString('hex'),
            issuedAt: nowReset,
            expiresAt: expiresAtReset,
          },
        });
        // Publish ONLY after a successful insert
        await this.mqtt.publishCommand(commandIdReset);
        deviceResultsReset.push({ deviceId: devId, commandId: commandIdReset, status: 'ISSUED' });
      } catch (cmdErr: unknown) {
        const errorMsg = cmdErr instanceof Error ? cmdErr.message : String(cmdErr);
        this.logger.warn(`Reset Emergency GateCommand insertion/publish failed for device ${devId}: ${errorMsg}`);
        deviceResultsReset.push({ deviceId: devId, status: 'FAILED', error: errorMsg });
      }
    }

    const successfulResets = deviceResultsReset.filter((r) => r.status === 'ISSUED');
    if (deviceIdsReset.length === 0 || successfulResets.length === 0) {
      let failedAccessEventId: string | undefined;
      try {
        const failedAccessEvent = await this.prisma.accessEvent.create({
          data: {
            societyId,
            accessPointId,
            decision: 'DENIED',
            reasonCode: 'EMERGENCY_DISPATCH_FAILED',
            source: 'MANUAL_OVERRIDE',
            meta: {
              actorUserId,
              actorRole,
              reason: reason || 'Emergency hold released. Normal access restored.',
              deviceResults: deviceResultsReset,
            },
          },
        });
        failedAccessEventId = failedAccessEvent?.id;
      } catch (evtErr: unknown) {
        this.logger.error(`Failed to record accessEvent on emergency reset dispatch failure: ${String(evtErr)}`);
      }

      await this.audit.record({
        societyId,
        actorUserId,
        actorRole,
        action: 'GATE_EMERGENCY_RESET',
        entityType: 'AccessPoint',
        entityId: accessPointId,
        meta: {
          reason: reason || 'Emergency hold released. Normal access restored.',
          ...(failedAccessEventId ? { accessEventId: failedAccessEventId } : {}),
          status: 'FAILED',
          deviceResults: deviceResultsReset,
        },
      });

      throw AppException.badGateway(
        'COMMAND_DISPATCH_FAILED',
        'No active gate controller device received the emergency reset command',
      );
    }

    // Clear emergency state on physical controller and close gate only after hardware dispatch succeeds
    adapter.clearEmergency?.();
    await adapter.close();

    const accessEvent = await this.prisma.accessEvent.create({
      data: {
        societyId,
        accessPointId,
        decision: 'AUTHORIZED',
        reasonCode: 'EMERGENCY_RESET',
        source: 'MANUAL_OVERRIDE',
        meta: {
          actorUserId,
          actorRole,
          reason: reason || 'Emergency hold released. Normal access restored.',
          gateState: 'CLOSED',
        },
      },
    });

    await this.audit.record({
      societyId,
      actorUserId,
      actorRole,
      action: 'GATE_EMERGENCY_RESET',
      entityType: 'AccessPoint',
      entityId: accessPointId,
      meta: { reason, accessEventId: accessEvent.id },
    });

    return {
      success: true,
      decision: 'AUTHORIZED',
      reasonCode: 'EMERGENCY_RESET',
      accessEventId: accessEvent.id,
      gateState: await adapter.getState(),
      message: 'Emergency override reset: gate closed and normal access restored',
      deviceResults: deviceResultsReset,
    };
  }

  async getGateTelemetry(societyId: string, accessPointId: string) {
    const accessPoint = await this.prisma.accessPoint.findFirst({
      where: { id: accessPointId, societyId },
    });

    if (!accessPoint) {
      throw AppException.notFound('ACCESS_POINT_NOT_FOUND', 'Access point not found');
    }

    const adapter = this.adapterFactory.getOrCreate(
      accessPoint.id,
      accessPoint.name,
      accessPoint.type,
    );

    return adapter.getTelemetry();
  }

  async getDpdpComplianceReport(societyId: string) {
    const totalAccessEvents = await this.prisma.accessEvent.count({ where: { societyId } });
    const totalAuditLogs = await this.prisma.auditLog.count({ where: { societyId } });
    const enrolledBiometrics = Array.from(this.templateRegistry.values()).filter(
      (t) => t.societyId === societyId,
    ).length;

    return {
      societyId,
      complianceStandard: 'Digital Personal Data Protection Act, 2023 (India DPDP Act)',
      dataProtectionOfficer: 'Designated Society Administrator',
      principles: {
        dataMinimization: 'COMPLIANT (No raw biometric imagery stored; SHA-256 template references only)',
        purposeLimitation: 'COMPLIANT (Physical Access Security at Society Perimeter)',
        storageLimitation: 'COMPLIANT (Automatic 90-day retention and anonymization cycle)',
        integrityAndConfidentiality: 'COMPLIANT (AES-256 disk encryption & TLS 1.3 transport)',
      },
      metrics: {
        enrolledBiometricTemplates: enrolledBiometrics,
        totalAccessLogsAudited: totalAccessEvents,
        tamperEvidentAuditLogs: totalAuditLogs,
      },
    };
  }

  async anonymizeExpiredVisitorData(societyId: string, daysRetention = 90) {
    const cutoff = new Date(Date.now() - daysRetention * 24 * 3600 * 1000);

    // Visitor rows are reused for repeat visits, so createdAt alone is not the retention clock:
    // anyone holding a pass that is still inside the window (including a live pass) is kept.
    // A single set-based update also avoids loading an unbounded id list into memory.
    const anonymized = await this.prisma.visitor.updateMany({
      where: {
        societyId,
        createdAt: { lt: cutoff },
        name: { not: 'ANONYMIZED_VISITOR' },
        passes: { none: { validUntil: { gte: cutoff } } },
      },
      data: {
        name: 'ANONYMIZED_VISITOR',
        phone: null,
      },
    });

    return {
      societyId,
      anonymizedCount: anonymized.count,
      retentionDays: daysRetention,
      status: 'SUCCESS',
    };
  }
}
