import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Request, Response } from 'express';
import { randomUUID } from 'crypto';

const REQUEST_ID_RE = /^[A-Za-z0-9._-]{8,80}$/;

export function resolveRequestId(req: Request, res?: Response): string {
  const supplied = typeof req.headers['x-request-id'] === 'string' ? req.headers['x-request-id'] : '';
  const requestId = REQUEST_ID_RE.test(supplied) ? supplied : randomUUID();
  if (res) res.setHeader('x-request-id', requestId);
  return requestId;
}

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();
    const requestId = resolveRequestId(request, response);

    let status: number = HttpStatus.INTERNAL_SERVER_ERROR;
    let code = 'INTERNAL_ERROR';
    let message = 'An unexpected error occurred';
    let details: unknown;

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const body = exception.getResponse();
      if (typeof body === 'string') {
        message = body;
        code = exception.name;
      } else if (body && typeof body === 'object') {
        const record = body as Record<string, unknown>;
        if (Array.isArray(record.message)) {
          code = 'VALIDATION_FAILED';
          message = 'Request validation failed';
          details = record.message;
        } else {
          if (typeof record.code === 'string') code = record.code;
          else if (typeof record.error === 'string') code = record.error;
          if (typeof record.message === 'string') message = record.message;
          if (record.details !== undefined) details = record.details;
        }
      }
      if (status >= 500) {
        code = 'INTERNAL_ERROR';
        message = 'An unexpected error occurred';
        details = undefined;
      } else if (status === HttpStatus.TOO_MANY_REQUESTS) {
        code = code === 'INTERNAL_ERROR' ? 'RATE_LIMIT_EXCEEDED' : code;
        message = message === 'An unexpected error occurred'
          ? 'Too many requests. Try again later.'
          : message;
      }
    } else if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      if (exception.code === 'P2002') {
        status = HttpStatus.CONFLICT;
        code = 'CONFLICT';
        message = 'This record already exists';
      } else if (exception.code === 'P2025') {
        status = HttpStatus.NOT_FOUND;
        code = 'NOT_FOUND';
        message = 'Resource not found';
      }
    } else if (exception instanceof Prisma.PrismaClientValidationError) {
      status = HttpStatus.BAD_REQUEST;
      code = 'INVALID_REQUEST';
      message = 'Request could not be processed';
    }

    if (status >= 500) {
      this.logger.error(
        `${request.method} ${request.path} -> ${status} ${code} (${requestId})`,
        exception instanceof Error ? exception.stack : String(exception),
      );
    } else if (status === HttpStatus.TOO_MANY_REQUESTS) {
      this.logger.warn(`${request.method} ${request.path} -> 429 ${code} (${requestId})`);
    }

    if (response.headersSent) return;
    response.status(status).json({
      code,
      message,
      requestId,
      ...(details === undefined ? {} : { details }),
    });
  }
}
