import { Injectable } from '@nestjs/common';
import { Prisma, VisitorPass } from '@prisma/client';
import { AppException } from '../common/app.exception';
import { PrismaService } from '../common/prisma.service';
import { AuthzService } from '../common/authz.service';
import { CredentialsService } from '../visitors/credentials.service';
import { visitorPolicy } from '../societies/policy';
import { RegisterRelativeDto, QuickPassDto } from './relatives.dto';

@Injectable()
export class RelativesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly authz: AuthzService,
    private readonly credentials: CredentialsService,
  ) {}

  async listRelatives(callerSub: string, flatId: string) {
    const context = await this.authz.flat(callerSub, flatId, ['RESIDENT', 'SOCIETY_ADMIN']);

    const visitors = await this.prisma.visitor.findMany({
      where: {
        societyId: context.societyId,
        category: 'RELATIVE',
        passes: { some: { flatId } },
      },
      include: {
        passes: {
          where: { flatId },
          orderBy: { createdAt: 'desc' },
          take: 3,
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    const now = new Date();

    return visitors.map((visitor) => {
      const activePass = visitor.passes.find(
        (pass) =>
          pass.status === 'ACTIVE' &&
          pass.validFrom <= now &&
          pass.validUntil >= now &&
          pass.usedCount < pass.maxUses,
      );

      // Parse relation and vehicle if encoded in the name e.g. "Ramesh Patel (Father) [MH 02 CZ 4411]"
      let displayName = visitor.name;
      let relation = 'Family / Relative';
      let vehicle: string | undefined = undefined;

      const vehicleMatch = displayName.match(/\[(.*?)\]/);
      if (vehicleMatch) {
        vehicle = vehicleMatch[1];
        displayName = displayName.replace(/\s*\[.*?\]/, '').trim();
      }

      const relationMatch = displayName.match(/\((.*?)\)/);
      if (relationMatch) {
        relation = relationMatch[1];
        displayName = displayName.replace(/\s*\(.*?\)/, '').trim();
      }

      const lastPass = visitor.passes[0];

      return {
        id: visitor.id,
        visitorId: visitor.id,
        societyId: visitor.societyId,
        flatId,
        name: displayName,
        rawName: visitor.name,
        phone: visitor.phone,
        relation,
        defaultVehicle: vehicle,
        createdAt: visitor.createdAt.toISOString(),
        lastVisitAt: lastPass ? lastPass.createdAt.toISOString() : null,
        activePassCount: activePass ? 1 : 0,
        activePassId: activePass?.id,
      };
    });
  }

  async registerRelative(callerSub: string, flatId: string, dto: RegisterRelativeDto) {
    const context = await this.authz.flat(callerSub, flatId, ['RESIDENT', 'SOCIETY_ADMIN']);

    const trimmedName = dto.name.trim();
    const trimmedRelation = dto.relation.trim();
    const trimmedVehicle = dto.defaultVehicle?.trim().toUpperCase();

    let formattedName = `${trimmedName} (${trimmedRelation})`;
    if (trimmedVehicle) {
      formattedName += ` [${trimmedVehicle}]`;
    }

    const phone = dto.phone?.trim() || null;

    // Reject duplicate relative for this flat
    const existing = await this.prisma.visitor.findFirst({
      where: {
        societyId: context.societyId,
        name: formattedName.slice(0, 120),
        category: 'RELATIVE',
        passes: { some: { flatId } },
      },
    });
    if (existing) {
      throw AppException.conflict('DUPLICATE_RELATIVE', 'A relative with this name and relationship is already registered for this flat');
    }

    // Check gate availability before creating relative
    const accessPoints = await this.prisma.accessPoint.findMany({
      where: { societyId: context.societyId },
      select: { id: true, name: true, type: true },
    });
    if (accessPoints.length === 0) {
      throw AppException.unprocessable('NO_GATES_CONFIGURED', 'No active gates configured for this society');
    }

    // Automatically issue an initial 72-hour pass for the newly registered relative so they can visit immediately!
    const society = await this.prisma.society.findUnique({
      where: { id: context.societyId },
      select: { settings: true },
    });
    const policy = visitorPolicy(society?.settings);
    // Checked before creating the visitor so a rejected request leaves no orphaned record.
    await this.assertDailyPassCapacity(flatId, policy.maxPassesPerFlatPerDay);

    const visitor = await this.prisma.visitor.create({
      data: {
        societyId: context.societyId,
        name: formattedName.slice(0, 120),
        phone,
        category: 'RELATIVE',
      },
    });

    const now = new Date();
    const validHours = Math.min(72, policy.maxPassDurationHours);
    const validFrom = now;
    const validUntil = new Date(now.getTime() + validHours * 3600 * 1000);

    let pin = this.credentials.generatePin();
    let qr = this.credentials.generateQrToken();
    const maxUses = Math.min(policy.maxUsesPerPass, 5);

    let pass: any;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        pass = await this.createPassWithinCap(flatId, policy.maxPassesPerFlatPerDay, {
          data: {
            societyId: context.societyId,
            flatId,
            hostUserId: callerSub,
            visitorId: visitor.id,
            category: 'RELATIVE',
            status: 'ACTIVE',
            validFrom,
            validUntil,
            maxUses,
            credentials: {
              create: [
                {
                  type: pin.type,
                  credentialHash: this.credentials.hash(pin.plaintext),
                  keyId: this.credentials.keyVersion,
                  // Scopes the per-society PIN uniqueness index; NULL would bypass it.
                  societyId: context.societyId,
                },
                {
                  type: qr.type,
                  credentialHash: this.credentials.hash(qr.plaintext),
                  keyId: this.credentials.keyVersion,
                  // Scopes the per-society PIN uniqueness index; NULL would bypass it.
                  societyId: context.societyId,
                },
              ],
            },
            accessPoints: {
              create: accessPoints.map((ap) => ({ accessPointId: ap.id })),
            },
          },
        });
        break;
      } catch (err: any) {
        if ((err?.code === 'P2002' || String(err).includes('credentialHash')) && attempt < 4) {
          pin = this.credentials.generatePin();
          qr = this.credentials.generateQrToken();
          continue;
        }
        throw err;
      }
    }

    return {
      relative: {
        id: visitor.id,
        visitorId: visitor.id,
        societyId: visitor.societyId,
        flatId,
        name: trimmedName,
        phone: visitor.phone,
        relation: trimmedRelation,
        defaultVehicle: trimmedVehicle,
        createdAt: visitor.createdAt.toISOString(),
      },
      initialPass: {
        id: pass.id,
        status: pass.status,
        validFrom: pass.validFrom.toISOString(),
        validUntil: pass.validUntil.toISOString(),
        maxUses: pass.maxUses,
        credentials: {
          pin: pin.plaintext,
          qrToken: qr.plaintext,
        },
      },
    };
  }

  async issueQuickPass(
    callerSub: string,
    flatId: string,
    visitorId: string,
    dto: QuickPassDto,
  ) {
    const context = await this.authz.flat(callerSub, flatId, ['RESIDENT', 'SOCIETY_ADMIN']);

    const visitor = await this.prisma.visitor.findUnique({
      where: { id: visitorId },
    });
    if (!visitor || visitor.societyId !== context.societyId || visitor.category !== 'RELATIVE') {
      throw AppException.notFound('VISITOR_NOT_FOUND', 'Active relative not found in this society');
    }

    // Verify relative is associated with this flat (prevents IDOR across flats)
    const flatAssociation = await this.prisma.visitorPass.findFirst({
      where: { flatId, visitorId },
    });
    if (!flatAssociation) {
      throw AppException.notFound('VISITOR_NOT_FOUND', 'Relative not found for this flat');
    }

    const society = await this.prisma.society.findUnique({
      where: { id: context.societyId },
      select: { settings: true },
    });
    const policy = visitorPolicy(society?.settings);
    await this.assertDailyPassCapacity(flatId, policy.maxPassesPerFlatPerDay);

    const accessPoints = await this.prisma.accessPoint.findMany({
      where: { societyId: context.societyId },
      select: { id: true, name: true, type: true },
    });
    if (accessPoints.length === 0) {
      throw AppException.unprocessable('NO_GATES_CONFIGURED', 'No active gates configured for this society');
    }

    const now = new Date();
    const hours = Math.min(dto.validHours || 24, policy.maxPassDurationHours);
    const validFrom = now;
    const validUntil = new Date(now.getTime() + hours * 3600 * 1000);
    const maxUses = Math.min(dto.maxUses || 5, policy.maxUsesPerPass);

    let pin = this.credentials.generatePin();
    let qr = this.credentials.generateQrToken();

    let pass: any;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        pass = await this.createPassWithinCap(flatId, policy.maxPassesPerFlatPerDay, {
          data: {
            societyId: context.societyId,
            flatId,
            hostUserId: callerSub,
            visitorId: visitor.id,
            category: 'RELATIVE',
            status: 'ACTIVE',
            validFrom,
            validUntil,
            maxUses,
            credentials: {
              create: [
                {
                  type: pin.type,
                  credentialHash: this.credentials.hash(pin.plaintext),
                  keyId: this.credentials.keyVersion,
                  // Scopes the per-society PIN uniqueness index; NULL would bypass it.
                  societyId: context.societyId,
                },
                {
                  type: qr.type,
                  credentialHash: this.credentials.hash(qr.plaintext),
                  keyId: this.credentials.keyVersion,
                  // Scopes the per-society PIN uniqueness index; NULL would bypass it.
                  societyId: context.societyId,
                },
              ],
            },
            accessPoints: {
              create: accessPoints.map((ap) => ({ accessPointId: ap.id })),
            },
          },
          include: {
            flat: {
              include: { building: { select: { name: true } } },
            },
          },
        });
        break;
      } catch (err: any) {
        if ((err?.code === 'P2002' || String(err).includes('credentialHash')) && attempt < 4) {
          pin = this.credentials.generatePin();
          qr = this.credentials.generateQrToken();
          continue;
        }
        throw err;
      }
    }

    return {
      pass: {
        id: pass.id,
        societyId: pass.societyId,
        status: pass.status,
        category: pass.category,
        visitor: {
          id: visitor.id,
          name: visitor.name,
          phone: visitor.phone,
        },
        flat: {
          id: pass.flatId,
          building: pass.flat.building.name,
          flatNumber: pass.flat.flatNumber,
        },
        validFrom: pass.validFrom.toISOString(),
        validUntil: pass.validUntil.toISOString(),
        maxUses: pass.maxUses,
        usedCount: pass.usedCount,
      },
      credentials: {
        pin: pin.plaintext,
        qrToken: qr.plaintext,
      },
    };
  }

  /**
   * Relative passes count toward the same per-flat daily cap as passes issued through the
   * visitor-pass flow; otherwise quick-pass would let a resident mint unlimited gate credentials.
   */
  private async assertDailyPassCapacity(flatId: string, maxPassesPerFlatPerDay: number): Promise<void> {
    const recent = await this.prisma.visitorPass.count({
      where: { flatId, createdAt: { gte: new Date(Date.now() - 24 * 3600 * 1000) } },
    });
    if (recent >= maxPassesPerFlatPerDay) {
      throw AppException.unprocessable('INVITATION_LIMIT', 'Too many passes created for this flat today');
    }
  }

  /**
   * Re-checks the cap and inserts under the same per-flat advisory lock as the visitor-pass flow,
   * so parallel quick-pass requests cannot all pass the count and exceed the cap together.
   */
  private createPassWithinCap(
    flatId: string,
    maxPassesPerFlatPerDay: number,
    args: Prisma.VisitorPassCreateArgs,
  ): Promise<VisitorPass> {
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('visitor-pass-create'), hashtext(${flatId}))`;
      const recent = await tx.visitorPass.count({
        where: { flatId, createdAt: { gte: new Date(Date.now() - 24 * 3600 * 1000) } },
      });
      if (recent >= maxPassesPerFlatPerDay) {
        throw AppException.unprocessable('INVITATION_LIMIT', 'Too many passes created for this flat today');
      }
      return tx.visitorPass.create(args);
    });
  }

  async deleteRelative(callerSub: string, flatId: string, visitorId: string) {
    const context = await this.authz.flat(callerSub, flatId, ['RESIDENT', 'SOCIETY_ADMIN']);

    const visitor = await this.prisma.visitor.findUnique({
      where: { id: visitorId },
    });
    if (!visitor || visitor.societyId !== context.societyId) {
      throw AppException.notFound('VISITOR_NOT_FOUND', 'Relative not found in this society');
    }

    // Verify relative is associated with this flat (prevents IDOR across flats)
    const flatAssociation = await this.prisma.visitorPass.findFirst({
      where: { flatId, visitorId },
    });
    if (!flatAssociation) {
      throw AppException.notFound('VISITOR_NOT_FOUND', 'Relative not found for this flat');
    }

    // Revoke any active passes for this relative on this flat
    const now = new Date();
    await this.prisma.visitorPass.updateMany({
      where: {
        flatId,
        visitorId,
        societyId: context.societyId,
        status: 'ACTIVE',
        validUntil: { gt: now },
      },
      data: {
        status: 'REVOKED',
        revokedAt: now,
        revokedBy: callerSub,
      },
    });

    // Unlink relative from directory by reclassifying visitor category
    await this.prisma.visitor.update({
      where: { id: visitorId },
      data: { category: 'OTHER' },
    });

    return { ok: true };
  }
}
