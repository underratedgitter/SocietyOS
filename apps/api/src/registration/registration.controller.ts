import { Body, Controller, Get, HttpCode, Param, Post, Req, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Request, Response } from 'express';
import { RateLimitService } from '../common/rate-limit.service';
import { AppException } from '../common/app.exception';
import { setAuthCookies } from '../auth/cookie.helper';
import { paramStr } from '../common/params';
import { RegisterUserDto, SelfRegisterVisitorDto } from './registration.dto';
import { publicIpRateLimit, RegistrationService } from './registration.service';

@ApiTags('registration')
@Controller()
export class RegistrationController {
  constructor(
    private readonly registrationService: RegistrationService,
    private readonly rateLimit: RateLimitService,
  ) {}

  @Get('public/societies')
  async listSocieties() {
    return this.registrationService.listPublicSocieties();
  }

  @Get('public/societies/:societyId/flats')
  async listFlats(@Param('societyId') societyId: string) {
    return this.registrationService.listPublicFlats(paramStr(societyId));
  }

  @Post('auth/register')
  @HttpCode(201)
  async register(
    @Body() dto: RegisterUserDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const ip = req.ip || 'unknown';
    const limit = await this.rateLimit.hit(`auth:register:ip:${ip}`, publicIpRateLimit(ip, 10, 500), 15 * 60);
    if (!limit.allowed) {
      throw AppException.tooMany('Too many registration attempts. Please try again later.');
    }

    const result = await this.registrationService.registerUser(dto, req.headers['user-agent']);
    setAuthCookies(res, result.tokens);
    const isMobileClient =
      req.headers['x-client-type'] === 'mobile' ||
      req.headers['x-auth-mode'] === 'bearer';

    return {
      user: result.user,
      expiresIn: result.tokens.expiresIn,
      society: result.society,
      flat: result.flat,
      ...(isMobileClient
        ? {
            accessToken: result.tokens.accessToken,
            refreshToken: result.tokens.refreshToken,
          }
        : {}),
    };
  }

  @Post('visitors/self-register')
  @HttpCode(201)
  async selfRegisterVisitor(@Body() dto: SelfRegisterVisitorDto, @Req() req: Request) {
    const ip = req.ip || 'unknown';
    return this.registrationService.selfRegisterVisitor(dto, ip);
  }
}
