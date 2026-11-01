import { Body, Controller, Get, HttpCode, Post, Req, Res, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsEmail, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { Request, Response } from 'express';
import { AuthService, TokenPair } from './auth.service';
import { JwtAuthGuard } from './jwt-auth.guard';
import { CurrentUser } from './current-user.decorator';
import { AuthedRequest, JwtUser } from './jwt-auth.guard';
import { RateLimitService } from '../common/rate-limit.service';
import { AppException } from '../common/app.exception';
import { getEnv } from '../config';
import { ACCESS_COOKIE, REFRESH_COOKIE } from './auth.constants';

const REFRESH_MAX_AGE_MS = 30 * 24 * 3600 * 1000;

export class LoginDto {
  @IsEmail()
  @MaxLength(254)
  email!: string;

  @IsString()
  @MinLength(8)
  @MaxLength(128)
  password!: string;
}

export class RefreshDto {
  @IsOptional()
  @IsString()
  @MaxLength(512)
  refreshToken?: string;
}

export class LogoutDto {
  @IsOptional()
  @IsString()
  @MaxLength(512)
  refreshToken?: string;
}

export class ChangePasswordDto {
  @IsString()
  @MinLength(8)
  @MaxLength(128)
  currentPassword!: string;

  @IsString()
  @MinLength(12)
  @MaxLength(128)
  newPassword!: string;
}

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly rateLimit: RateLimitService,
  ) {}

  @Post('login')
  @HttpCode(200)
  async login(
    @Body() dto: LoginDto,
    @Req() req: AuthedRequest,
    @Res({ passthrough: true }) res: Response,
  ) {
    const ip = req.ip || 'unknown';
    const email = dto.email.toLowerCase().trim();
    const isLoopback =
      ip === '127.0.0.1' ||
      ip === '::1' ||
      ip === '::ffff:127.0.0.1' ||
      ip === 'localhost' ||
      ip === 'unknown';
    const ipLimitCount = isLoopback ? 1000 : 20;

    const [ipLimit, accountLimit] = await Promise.all([
      this.rateLimit.hit(`auth:login:ip:${ip}`, ipLimitCount, 15 * 60),
      this.rateLimit.hit(`auth:login:account:${email}`, 5, 15 * 60),
    ]);
    if (!ipLimit.allowed || !accountLimit.allowed) {
      throw AppException.tooMany('Too many sign-in attempts. Try again later.');
    }
    const result = await this.auth.login(email, dto.password, req.headers['user-agent']);
    if (this.rateLimit) {
      await Promise.all([
        typeof this.rateLimit.reset === 'function'
          ? this.rateLimit.reset(`auth:login:account:${email}`)
          : Promise.resolve(),
        typeof this.rateLimit.decrement === 'function'
          ? this.rateLimit.decrement(`auth:login:ip:${ip}`)
          : Promise.resolve(),
      ]);
    }
    this.setAuthCookies(res, result);
    const isMobileClient =
      req.headers['x-client-type'] === 'mobile' ||
      req.headers['x-auth-mode'] === 'bearer';
    return {
      user: result.user,
      expiresIn: result.expiresIn,
      ...(isMobileClient ? { accessToken: result.accessToken, refreshToken: result.refreshToken } : {}),
    };
  }

  @Post('refresh')
  @HttpCode(200)
  async refresh(
    @Body() dto: RefreshDto,
    @Req() req: AuthedRequest,
    @Res({ passthrough: true }) res: Response,
  ) {
    const ip = req.ip || 'unknown';
    const isLoopback =
      ip === '127.0.0.1' ||
      ip === '::1' ||
      ip === '::ffff:127.0.0.1' ||
      ip === 'localhost' ||
      ip === 'unknown';
    const limit = await this.rateLimit.hit(`auth:refresh:ip:${ip}`, isLoopback ? 1000 : 60, 15 * 60);
    if (!limit.allowed) throw AppException.tooMany();
    const token = dto.refreshToken || this.cookie(req, REFRESH_COOKIE);
    if (!token) throw AppException.unauthorized('INVALID_SESSION', 'Session is invalid or expired');
    const result = await this.auth.refresh(token, req.headers['user-agent']);
    this.setAuthCookies(res, result);
    const isMobileClient =
      req.headers['x-client-type'] === 'mobile' ||
      req.headers['x-auth-mode'] === 'bearer';
    return {
      user: result.user,
      expiresIn: result.expiresIn,
      ...(isMobileClient ? { accessToken: result.accessToken, refreshToken: result.refreshToken } : {}),
    };
  }

  @Post('logout')
  @HttpCode(200)
  async logout(
    @Body() dto: LogoutDto,
    @Req() req: AuthedRequest,
    @Res({ passthrough: true }) res: Response,
  ) {
    const token = dto.refreshToken || this.cookie(req, REFRESH_COOKIE) || '';
    await this.auth.logout(token);
    this.clearAuthCookies(res);
    return { ok: true };
  }

  @Get('me')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  me(@CurrentUser() user: JwtUser) {
    return this.auth.me(user!.sub);
  }

  @Post('change-password')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  async changePassword(
    @CurrentUser() user: JwtUser,
    @Body() dto: ChangePasswordDto,
    @Req() req: AuthedRequest,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.auth.changePassword(user!.sub, dto.currentPassword, dto.newPassword);
    this.setAuthCookies(res, result);
    const isMobileClient =
      req.headers['x-client-type'] === 'mobile' ||
      req.headers['x-auth-mode'] === 'bearer';
    return {
      user: result.user,
      expiresIn: result.expiresIn,
      ...(isMobileClient ? { accessToken: result.accessToken, refreshToken: result.refreshToken } : {}),
    };
  }

  private cookie(req: Request, name: string): string | undefined {
    const header = req.headers.cookie;
    if (!header) return undefined;
    for (const part of header.split(';')) {
      const index = part.indexOf('=');
      if (index < 0) continue;
      if (part.slice(0, index).trim() !== name) continue;
      try {
        return decodeURIComponent(part.slice(index + 1).trim());
      } catch {
        return part.slice(index + 1).trim();
      }
    }
    return undefined;
  }

  private setAuthCookies(res: Response, tokens: TokenPair): void {
    const env = getEnv();
    const base = {
      httpOnly: true,
      secure: env.cookieSecure,
      sameSite: 'strict' as const,
      path: '/',
    };
    res.cookie(ACCESS_COOKIE, tokens.accessToken, {
      ...base,
      maxAge: tokens.expiresIn * 1000,
    });
    res.cookie(REFRESH_COOKIE, tokens.refreshToken, {
      ...base,
      maxAge: REFRESH_MAX_AGE_MS,
    });
  }

  private clearAuthCookies(res: Response): void {
    const env = getEnv();
    const base = {
      httpOnly: true,
      secure: env.cookieSecure,
      sameSite: 'strict' as const,
      path: '/',
    };
    res.clearCookie(ACCESS_COOKIE, base);
    res.clearCookie(REFRESH_COOKIE, base);
  }
}
