import { Body, Controller, INestApplication, Logger, Module, Post } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { NestExpressApplication } from '@nestjs/platform-express';
import express from 'express';
import request from 'supertest';
import { HttpExceptionFilter } from '../src/common/http-exception.filter';

@Controller('echo')
class EchoController {
  @Post()
  echo(@Body() body: Record<string, unknown>): Record<string, unknown> {
    return body;
  }
}

@Module({ controllers: [EchoController] })
class EchoModule {}

describe('HttpExceptionFilter with Express body-parser errors', () => {
  let app: INestApplication;
  let errorLog: jest.SpyInstance;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [EchoModule] }).compile();
    const nest = moduleRef.createNestApplication<NestExpressApplication>({
      bodyParser: false,
      logger: false,
    });
    // Mirrors the body parsing configured in main.ts.
    nest.setGlobalPrefix('api/v1');
    nest.use(express.json({ limit: '100kb', type: ['application/json', 'application/*+json'] }));
    nest.useGlobalFilters(new HttpExceptionFilter());
    await nest.init();
    app = nest;
  });

  beforeEach(() => {
    errorLog = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    errorLog.mockRestore();
  });

  afterAll(async () => {
    await app.close();
  });

  it('returns 413 PAYLOAD_TOO_LARGE (not a 500) for bodies over the limit', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/echo')
      .set('content-type', 'application/json')
      .send(JSON.stringify({ blob: 'x'.repeat(200_000) }));

    expect(res.status).toBe(413);
    expect(res.body).toMatchObject({
      code: 'PAYLOAD_TOO_LARGE',
      message: 'Request body is too large',
    });
    expect(typeof res.body.requestId).toBe('string');
    expect(errorLog).not.toHaveBeenCalled();
  });

  it('returns 415 UNSUPPORTED_MEDIA_TYPE for an unsupported charset', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/echo')
      .set('content-type', 'application/json; charset=bogus')
      .send('{}');

    expect(res.status).toBe(415);
    expect(res.body).toMatchObject({ code: 'UNSUPPORTED_MEDIA_TYPE' });
    expect(errorLog).not.toHaveBeenCalled();
  });

  it('still masks genuine server errors as INTERNAL_ERROR', async () => {
    const filter = new HttpExceptionFilter();
    const json = jest.fn();
    const response = { headersSent: false, setHeader: jest.fn(), status: jest.fn(() => ({ json })) };
    const host = {
      switchToHttp: () => ({
        getResponse: () => response,
        getRequest: () => ({ headers: {}, method: 'GET', path: '/x' }),
      }),
    };
    // An error that carries a status but is not marked safe to expose.
    const internal = Object.assign(new Error('db password=secret'), { status: 400 });

    filter.catch(internal, host as never);

    expect(response.status).toHaveBeenCalledWith(500);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'INTERNAL_ERROR', message: 'An unexpected error occurred' }),
    );
  });
});
