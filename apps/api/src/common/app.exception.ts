import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * Application error carrying a stable machine code, HTTP status and safe message.
 * Rendered as the standard error envelope by HttpExceptionFilter:
 *   { code, message, requestId, details? }
 */
export class AppException extends HttpException {
  constructor(
    public readonly code: string,
    message: string,
    status: HttpStatus = HttpStatus.BAD_REQUEST,
    public readonly details?: unknown,
  ) {
    super({ code, message, details }, status);
  }

  static badRequest(code: string, message: string, details?: unknown) {
    return new AppException(code, message, HttpStatus.BAD_REQUEST, details);
  }

  static unauthorized(code = 'UNAUTHENTICATED', message = 'Authentication required') {
    return new AppException(code, message, HttpStatus.UNAUTHORIZED);
  }

  static forbidden(code = 'FORBIDDEN', message = 'You are not allowed to perform this action') {
    return new AppException(code, message, HttpStatus.FORBIDDEN);
  }

  static notFound(code = 'NOT_FOUND', message = 'Resource not found') {
    return new AppException(code, message, HttpStatus.NOT_FOUND);
  }

  static conflict(code: string, message: string, details?: unknown) {
    return new AppException(code, message, HttpStatus.CONFLICT, details);
  }

  static unprocessable(code: string, message: string, details?: unknown) {
    return new AppException(code, message, HttpStatus.UNPROCESSABLE_ENTITY, details);
  }

  static tooMany(message = 'Too many requests. Try again later.', code = 'RATE_LIMIT_EXCEEDED') {
    return new AppException(code, message, HttpStatus.TOO_MANY_REQUESTS);
  }
}
