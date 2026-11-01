import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import * as jwt from 'jsonwebtoken';
import { randomUUID } from 'crypto';
import { PrismaService } from '../common/prisma.service';
import { AppException } from '../common/app.exception';
import { generateTemporaryPassword, randomToken, sha256 } from '../common/crypto.util';
import { getEnv } from '../config';

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

export interface SafeUser {
  id: string;
  name: string;
  email: string;
  phone: string | null;
  isPlatformAdmin: boolean;
  mustChangePassword: boolean;
}

type UserRecord = {
  id: string;
  name: string;
  email: string;
  phone: string | null;
  isPlatformAdmin: boolean;
  mustChangePassword: boolean;
};

const ACCESS_TTL_SECONDS = 900;
const REFRESH_TTL_DAYS = 30;
// A valid bcrypt hash used only to equalize login timing for unknown emails.
const DUMMY_HASH = '$2b$12$DKaIwekXY3Ezhe.MhdVmk.o7Gr39ANzrCrS//GJ3FqrrLyxT21oUS';
const BCRYPT_ROUNDS = 12;

@Injectable()
export class AuthService {
  constructor(private readonly prisma: PrismaService) {}

  async login(email: string, password: string, userAgent?: string) {
    const normalized = email.toLowerCase().trim();
    const user = await this.prisma.user.findUnique({ where: { email: normalized } });
    const passwordMatches = await bcrypt.compare(password, user?.passwordHash ?? DUMMY_HASH);
    if (!user || !passwordMatches) {
      throw AppException.unauthorized('INVALID_CREDENTIALS', 'Invalid email or password');
    }
    await this.assertCanLogin(user.id, user.isPlatformAdmin);
    const tokens = await this.issueTokens(user, userAgent);
    return { ...tokens, user: this.toSafeUser(user) };
  }

  async refresh(refreshToken: string, userAgent?: string) {
    if (!refreshToken || refreshToken.length > 512) {
      throw AppException.unauthorized('INVALID_SESSION', 'Session is invalid or expired');
    }
    const hash = sha256(refreshToken);
    const session = await this.prisma.session.findUnique({
      where: { refreshTokenHash: hash },
      include: { user: true },
    });
    if (!session || session.revokedAt || session.expiresAt <= new Date()) {
      throw AppException.unauthorized('INVALID_SESSION', 'Session is invalid or expired');
    }
    await this.assertCanLogin(session.user.id, session.user.isPlatformAdmin);

    const now = new Date();
    const result = await this.prisma.$transaction(async (tx) => {
      const revoked = await tx.session.updateMany({
        where: { id: session.id, revokedAt: null, expiresAt: { gt: now } },
        data: { revokedAt: now },
      });
      if (revoked.count !== 1) {
        throw AppException.unauthorized('INVALID_SESSION', 'Session is invalid or expired');
      }
      const tokens = await this.issueTokens(session.user, userAgent ?? session.userAgent ?? undefined, tx);
      return { tokens, user: session.user };
    });
    return { ...result.tokens, user: this.toSafeUser(result.user) };
  }

  async logout(refreshToken: string): Promise<{ ok: true }> {
    if (refreshToken) {
      await this.prisma.session.updateMany({
        where: { refreshTokenHash: sha256(refreshToken), revokedAt: null },
        data: { revokedAt: new Date() },
      });
    }
    return { ok: true };
  }

  async changePassword(userId: string, currentPassword: string, newPassword: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw AppException.unauthorized('INVALID_SESSION');
    if (!(await bcrypt.compare(currentPassword, user.passwordHash))) {
      throw AppException.unauthorized('INVALID_CREDENTIALS', 'Current password is incorrect');
    }
    if (currentPassword === newPassword) {
      throw AppException.unprocessable('PASSWORD_UNCHANGED', 'Choose a password different from the current one');
    }
    const passwordHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
    const updated = await this.prisma.$transaction(async (tx) => {
      const next = await tx.user.update({
        where: { id: userId },
        data: { passwordHash, mustChangePassword: false },
      });
      await tx.session.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      return next;
    });
    const tokens = await this.issueTokens(updated);
    await this.prisma.auditLog.create({
      data: {
        actorUserId: userId,
        action: 'PASSWORD_CHANGED',
        entityType: 'User',
        entityId: userId,
      },
    }).catch(() => undefined);
    return { ...tokens, user: this.toSafeUser(updated) };
  }

  async me(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: {
        memberships: {
          include: { society: { select: { id: true, name: true, slug: true, timezone: true } } },
          orderBy: { createdAt: 'asc' },
        },
        flatMemberships: {
          where: { endedAt: null },
          include: {
            flat: { include: { building: { select: { id: true, name: true, societyId: true } } } },
          },
          orderBy: { createdAt: 'asc' },
        },
      },
    });
    if (!user) throw AppException.unauthorized('INVALID_SESSION');
    return {
      user: this.toSafeUser(user),
      memberships: user.memberships.map((membership) => ({
        society: membership.society,
        role: membership.role,
        status: membership.status,
      })),
      flats: user.flatMemberships.map((link) => ({
        id: link.flat.id,
        flatNumber: link.flat.flatNumber,
        building: link.flat.building,
        relationship: link.relationship,
      })),
    };
  }

  async createUserWithTemporaryPassword(
    input: {
      name: string;
      email: string;
      phone?: string;
      mustChangePassword?: boolean;
    },
    db: Prisma.TransactionClient | PrismaService = this.prisma,
  ): Promise<{ user: UserRecord; temporaryPassword: string }> {
    const email = input.email.toLowerCase().trim();
    const existing = await db.user.findUnique({ where: { email } });
    if (existing) {
      throw AppException.conflict('EMAIL_IN_USE', 'A user with this email already exists');
    }
    const temporaryPassword = generateTemporaryPassword();
    const user = await db.user.create({
      data: {
        name: input.name.trim(),
        email,
        phone: input.phone?.trim() || null,
        passwordHash: await bcrypt.hash(temporaryPassword, BCRYPT_ROUNDS),
        mustChangePassword: input.mustChangePassword ?? true,
      },
    });
    return { user, temporaryPassword };
  }

  async findOrCreateUserWithTemporaryPassword(
    input: { name: string; email: string; phone?: string },
    db: Prisma.TransactionClient | PrismaService = this.prisma,
  ): Promise<{ user: UserRecord; temporaryPassword: string | null }> {
    const email = input.email.toLowerCase().trim();
    const existing = await db.user.findUnique({ where: { email } });
    if (existing) return { user: existing, temporaryPassword: null };
    const created = await this.createUserWithTemporaryPassword(input, db);
    return created;
  }

  private async assertCanLogin(userId: string, isPlatformAdmin: boolean): Promise<void> {
    if (isPlatformAdmin) return;
    const active = await this.prisma.societyMembership.count({
      where: { userId, status: 'ACTIVE' },
    });
    if (active === 0) {
      throw AppException.forbidden('ACCOUNT_DISABLED', 'This account has no active society membership');
    }
  }

  private async issueTokens(
    user: UserRecord,
    userAgent?: string,
    db: Prisma.TransactionClient | PrismaService = this.prisma,
  ): Promise<TokenPair> {
    const env = getEnv();
    const accessToken = jwt.sign(
      {
        sub: user.id,
        email: user.email,
        name: user.name,
        isPlatformAdmin: user.isPlatformAdmin,
        typ: 'access',
      },
      env.jwtAccessSecret,
      {
        algorithm: 'HS256',
        expiresIn: ACCESS_TTL_SECONDS,
        issuer: env.jwtIssuer,
        audience: env.jwtAudience,
        jwtid: randomUUID(),
      },
    );
    const refreshToken = randomToken(48);
    await db.session.create({
      data: {
        userId: user.id,
        refreshTokenHash: sha256(refreshToken),
        userAgent: userAgent?.slice(0, 300),
        expiresAt: new Date(Date.now() + REFRESH_TTL_DAYS * 24 * 3600 * 1000),
      },
    });
    return { accessToken, refreshToken, expiresIn: ACCESS_TTL_SECONDS };
  }

  async issueSessionTokens(
    user: UserRecord,
    userAgent?: string,
    db: Prisma.TransactionClient | PrismaService = this.prisma,
  ): Promise<TokenPair> {
    return this.issueTokens(user, userAgent, db);
  }

  toSafeUser(user: UserRecord): SafeUser {
    return {
      id: user.id,
      name: user.name,
      email: user.email,
      phone: user.phone,
      isPlatformAdmin: user.isPlatformAdmin,
      mustChangePassword: user.mustChangePassword,
    };
  }
}
