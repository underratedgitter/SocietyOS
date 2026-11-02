import { Response } from 'express';
import { getEnv } from '../config';
import { ACCESS_COOKIE, REFRESH_COOKIE } from './auth.constants';
import { TokenPair } from './auth.service';

export const REFRESH_MAX_AGE_MS = 30 * 24 * 3600 * 1000;

export function setAuthCookies(res: Response, tokens: TokenPair): void {
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
