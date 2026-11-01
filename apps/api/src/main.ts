import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger, ValidationPipe } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import express from 'express';
import helmet from 'helmet';
import { randomUUID } from 'crypto';
import { AppModule } from './app.module';
import { HttpExceptionFilter } from './common/http-exception.filter';
import { getEnv } from './config';
import { ACCESS_COOKIE } from './auth/auth.constants';

async function bootstrap(): Promise<void> {
  const env = getEnv();
  const logger = new Logger('Bootstrap');
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bodyParser: false,
    logger: env.isProduction
      ? ['error', 'warn', 'log']
      : ['error', 'warn', 'log', 'debug', 'verbose'],
  });

  app.setGlobalPrefix('api/v1');
  app.disable('x-powered-by');
  if (env.isProduction) app.set('trust proxy', 1);

  app.use(
    helmet({
      contentSecurityPolicy: false,
      crossOriginEmbedderPolicy: false,
      crossOriginResourcePolicy: { policy: 'same-site' },
      referrerPolicy: { policy: 'no-referrer' },
    }),
  );
  app.use(express.json({ limit: '100kb', type: ['application/json', 'application/*+json'] }));
  app.use(express.urlencoded({ extended: false, limit: '50kb' }));
  app.use((req, res, next) => {
    const supplied = req.headers['x-request-id'];
    const valid = typeof supplied === 'string' && /^[A-Za-z0-9._-]{8,80}$/.test(supplied);
    req.headers['x-request-id'] = valid ? supplied : randomUUID();
    res.setHeader('x-request-id', req.headers['x-request-id'] as string);
    next();
  });

  app.enableCors({
    origin: (origin, callback) => {
      if (!origin) return callback(null, true);
      const normalized = origin.replace(/\/$/, '');
      return callback(null, env.corsOrigins.includes(normalized));
    },
    credentials: true,
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'Idempotency-Key',
      'X-Request-Id',
      'X-Requested-With',
      'X-Client-Type',
      'X-Auth-Mode',
    ],
    exposedHeaders: ['X-Request-Id'],
    maxAge: 600,
  });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
      forbidUnknownValues: true,
      stopAtFirstError: true,
      validationError: { target: false, value: false },
    }),
  );
  app.useGlobalFilters(new HttpExceptionFilter());
  app.enableShutdownHooks();

  if (env.swaggerEnabled) {
    const config = new DocumentBuilder()
      .setTitle('SocietyOS API')
      .setDescription('Residential society management and intelligent gate access control')
      .setVersion('1.0.0')
      .addBearerAuth()
      .addCookieAuth(ACCESS_COOKIE, { type: 'apiKey', in: 'cookie' }, 'cookie')
      .build();
    const document = SwaggerModule.createDocument(app, config);
    SwaggerModule.setup('api/docs', app, document, {
      swaggerOptions: { persistAuthorization: true, withCredentials: true },
    });
  }

  await app.listen(env.port);
  logger.log(`SocietyOS API listening on port ${env.port}`);
  if (env.swaggerEnabled) logger.log(`API documentation: http://localhost:${env.port}/api/docs`);
}

void bootstrap().catch((error) => {
  const logger = new Logger('Bootstrap');
  logger.error('Fatal startup error', error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});
