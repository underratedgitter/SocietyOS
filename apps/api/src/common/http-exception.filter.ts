import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { randomUUID } from 'crypto';

/**
 * Standard error envelope: { code, message, requestId, details? }
 */
@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<Request>();
    const requestId = (req.headers['x-request-id'] as string) || randomUUID();

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let code = 'INTERNAL_ERROR';
    let message = 'An unexpected error occurred';
    let details: unknown;

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const body = exception.getResponse();
      if (typeof body === 'string') {
        message = body;
      } else if (typeof body === 'object' && body !== null) {
        const b = body as Record<string, unknown>;
        code = (b.code as string) || (b.error as string) || code;
        message = (b.message as string) || message;
        if (Array.isArray(b.message)) {
          code = 'VALIDATION_FAILED';
          message = 'Request validation failed';
          details = b.message;
        }
        if (b.details !== undefined) details = b.details;
      }
      if (status === HttpStatus.INTERNAL_SERVER_ERROR) code = 'INTERNAL_ERROR';
    }

    if (status >= 500) {
      this.logger.error(
        `${req.method} ${req.url} -> ${status} ${code}`,
        exception instanceof Error ? exception.stack : String(exception),
      );
    }

    res.status(status).json({ code, message, requestId, ...(details ? { details } : {}) });
  }
}
