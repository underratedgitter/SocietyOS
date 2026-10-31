process.env.RATE_LIMIT_ENABLED = 'false';
process.env.MQTT_URL = '';

import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { getEnv } from '../../src/config';
import {
  Agent,
  USERS,
  cookieValue,
  createTestApp,
  login,
  setCookies,
} from './support';

describe('Authentication and session lifecycle (integration)', () => {
  let app: INestApplication;
  let server: ReturnType<INestApplication['getHttpServer']>;

  beforeAll(async () => {
    app = await createTestApp();
    server = app.getHttpServer();
  });

  afterAll(async () => {
    await app.close();
  });

  it('sets HTTP-only cookies and never returns tokens in the response body', async () => {
    const agent = request.agent(server);
    const response = await login(agent, USERS.residentA);

    expect(response.body.user).toMatchObject({
      email: USERS.residentA.email,
      mustChangePassword: false,
    });
    expect(response.body.accessToken).toBeUndefined();
    expect(response.body.refreshToken).toBeUndefined();

    const cookies = setCookies(response).join('\n');
    expect(cookies).toMatch(/sos_at=[^;]+;\s*Max-Age=900/);
    expect(cookies).toMatch(/sos_rt=[^;]+;\s*Max-Age=2592000/);
    expect(cookies).toMatch(/HttpOnly/i);
    expect(cookies).toMatch(/SameSite=Strict/i);

    const me = await agent.get('/api/v1/auth/me').expect(200);
    expect(me.body.user.email).toBe(USERS.residentA.email);
    expect(me.body.flats[0].id).toEqual(expect.any(String));
    expect(me.body.memberships[0].society.id).toEqual(expect.any(String));
  });

  it('returns the same generic error for a bad password and an unknown account', async () => {
    const wrongPassword = await request(server)
      .post('/api/v1/auth/login')
      .send({ email: USERS.residentA.email, password: 'WrongPassword#2026' })
      .expect(401);
    expect(wrongPassword.body.code).toBe('INVALID_CREDENTIALS');

    const unknownAccount = await request(server)
      .post('/api/v1/auth/login')
      .send({ email: 'nobody-here@societyos.dev', password: 'WrongPassword#2026' })
      .expect(401);
    expect(unknownAccount.body.code).toBe('INVALID_CREDENTIALS');
    expect(unknownAccount.body.message).toBe(wrongPassword.body.message);
  });

  it('rotates the refresh token and rejects reuse of the rotated token', async () => {
    const agent = request.agent(server);
    const loggedIn = await login(agent, USERS.residentA);
    const firstRefresh = cookieValue(loggedIn, 'sos_rt');
    expect(firstRefresh).toBeTruthy();

    const rotated = await request(server)
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: firstRefresh })
      .expect(200);
    const secondRefresh = cookieValue(rotated, 'sos_rt');
    expect(secondRefresh).toBeTruthy();
    expect(secondRefresh).not.toBe(firstRefresh);
    expect(rotated.body.user.email).toBe(USERS.residentA.email);

    const replay = await request(server)
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: firstRefresh })
      .expect(401);
    expect(replay.body.code).toBe('INVALID_SESSION');

    await request(server)
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: secondRefresh })
      .expect(200);
  });

  it('revokes the session and clears both cookies on logout', async () => {
    const agent = request.agent(server);
    const loggedIn = await login(agent, USERS.residentA);
    const refresh = cookieValue(loggedIn, 'sos_rt');
    expect(refresh).toBeTruthy();

    const loggedOut = await agent
      .post('/api/v1/auth/logout')
      .send({ refreshToken: refresh })
      .expect(200);
    expect(loggedOut.body).toEqual({ ok: true });

    const cleared = setCookies(loggedOut).join('\n');
    expect(cleared).toMatch(/sos_at=;/);
    expect(cleared).toMatch(/sos_rt=;/);

    await agent.get('/api/v1/auth/me').expect(401);
    await request(server)
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: refresh })
      .expect(401);
  });

  it('rejects cookie-authenticated mutations from a foreign origin', async () => {
    const agent = request.agent(server);
    await login(agent, USERS.residentA);

    const rejected = await agent
      .post('/api/v1/visitor-passes')
      .set('Origin', 'https://evil.example')
      .send({})
      .expect(403);
    expect(rejected.body.code).toBe('CSRF_ORIGIN_REJECTED');

    // The same cookie-authenticated request from the configured web origin
    // passes the CSRF gate and reaches normal request validation instead.
    const allowedOrigin = getEnv().corsOrigins[0];
    const allowed = await agent
      .post('/api/v1/visitor-passes')
      .set('Origin', allowedOrigin)
      .send({})
      .expect(400);
    expect(allowed.body.code).toBe('VALIDATION_FAILED');
  });

  it('refuses a password change when the current password is wrong', async () => {
    const agent = request.agent(server);
    await login(agent, USERS.residentA);

    const response = await agent
      .post('/api/v1/auth/change-password')
      .send({ currentPassword: 'DefinitelyNotThePassword1', newPassword: 'NewResident#2026' })
      .expect(401);
    expect(response.body.code).toBe('INVALID_CREDENTIALS');

    // The rejected change must not invalidate the original credential.
    await request(server)
      .post('/api/v1/auth/login')
      .send(USERS.residentA)
      .expect(200);
  });
});
