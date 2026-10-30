import { Injectable, UnauthorizedException } from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import * as crypto from 'crypto';
import * as jwt from 'jsonwebtoken';
import { PrismaService } from '../common/prisma.service';
import { AppException } from '../common/app.exception';

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
}

const ACCESS_TTL_SECONDS = 900; // 15 minutes
const REFRESH_TTL_DAYS = 30;

@Injectable()
export class AuthService {
  constructor(private readonly prisma: PrismaService) {}

  async login(email: string, password: string, userAgent?: string) {
    const user = await this.prisma.user.findUnique({ where: { email: email.toLowerCase().trim() } });
    if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
      throw AppException.unauthorized('INVALID_CREDENTIALS', 'Invalid email or password');
    }
    if (user.isPlatformAdmin === false) {
      const active = await this.prisma.societyMembership.findFirst({
        where: { userId: user.id, status: 'ACTIVE' },
      });
      if (!active) throw AppException.forbidden('ACCOUNT_DISABLED', 'No active memberships');
    }
    const tokens = await this.issueTokens(user, userAgent);
    return { ...tokens, user: this.toSafeUser(user) };
  }

  async refresh(refreshToken: string, userAgent?: string) {
    const hash = this.sha256(refreshToken);
    const session = await this.prisma.session.findUnique({ where: { refreshTokenHash: hash } });
    if (!session || session.revokedAt || session.expiresAt <= new Date()) {
      throw AppException.unauthorized('INVALID_SESSION', 'Session is invalid or expired');
    }
    const user = await this.prisma.user.findUnique({ where: { id: session.userId } });
    if (!user) throw AppException.unauthorized('INVALID_SESSION');
    // Rotate: revoke old, issue new pair.
    await this.prisma.session.update({ where: { id: session.id }, data: { revokedAt: new Date() } });
    const tokens = await this.issueTokens(user, userAgent ?? session.userAgent ?? undefined);
    return { ...tokens, user: this.toSafeUser(user) };
  }

  async logout(refreshToken: string) {
    const hash = this.sha256(refreshToken);
    await this.prisma.session.updateMany({
      where: { refreshTokenHash: hash, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    return { ok: true };
  }

  async me(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: {
        memberships: {
          include: { society: { select: { id: true, name: true, slug: true, timezone: true } } },
        },
        flatMemberships: {
          include: { flat: { include: { building: { select: { id: true, name: true, societyId: true } } } } },
        },
      },
    });
    if (!user) throw AppException.unauthorized('INVALID_SESSION');
    return {
      user: this.toSafeUser(user),
      memberships: user.memberships.map((m) => ({
        society: m.society,
        role: m.role,
        status: m.status,
      })),
      flats: user.flatMemberships.map((f) => ({
        id: f.flat.id,
        flatNumber: f.flat.flatNumber,
        building: f.flat.building,
        relationship: f.relationship,
      })),
    };
  }

  private async issueTokens(user: { id: string; email: string; name: string; isPlatformAdmin: boolean }, userAgent?: string): Promise<TokenPair> {
    const accessToken = jwt.sign(
      { sub: user.id, email: user.email, name: user.name, isPlatformAdmin: user.isPlatformAdmin },
      process.env.JWT_ACCESS_SECRET || 'dev-only-access-secret-change-in-prod',
      { expiresIn: ACCESS_TTL_SECONDS },
    );
    const refreshToken = crypto.randomBytes(48).toString('base64url');
    await this.prisma.session.create({
      data: {
        userId: user.id,
        refreshTokenHash: this.sha256(refreshToken),
        userAgent,
        expiresAt: new Date(Date.now() + REFRESH_TTL_DAYS * 24 * 3600 * 1000),
      },
    });
    return { accessToken, refreshToken, expiresIn: ACCESS_TTL_SECONDS };
  }

  private sha256(value: string) {
    return crypto.createHash('sha256').update(value).digest('hex');
  }

  private toSafeUser(user: { id: string; name: string; email: string; phone: string | null; isPlatformAdmin: boolean }): SafeUser {
    return {
      id: user.id,
      name: user.name,
      email: user.email,
      phone: user.phone,
      isPlatformAdmin: user.isPlatformAdmin,
    };
  }
}
