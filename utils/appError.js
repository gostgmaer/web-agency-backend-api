/**
 * AppError — lead-service compatible error class with static factory methods.
 * Used by lead services, controllers, and middleware.
 */
export class AppError extends Error {
  constructor(statusCode, message, code = null, errors = null) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.errors = errors;
    this.isOperational = true;
    Error.captureStackTrace(this, this.constructor);
  }

  static badRequest(message, errors = null)         { return new AppError(400, message, 'BAD_REQUEST', errors); }
  static unauthorized(message = 'Unauthorized')     { return new AppError(401, message, 'UNAUTHORIZED'); }
  static forbidden(message = 'Forbidden')           { return new AppError(403, message, 'FORBIDDEN'); }
  static notFound(message = 'Not found')            { return new AppError(404, message, 'NOT_FOUND'); }
  static conflict(message)                          { return new AppError(409, message, 'CONFLICT'); }
  static unprocessable(message, errors = null)      { return new AppError(422, message, 'UNPROCESSABLE', errors); }
  static validation(message, errors = null)         { return new AppError(422, message, 'VALIDATION_ERROR', errors); }
  static internal(message = 'Internal server error') { return new AppError(500, message, 'INTERNAL_ERROR'); }
}

export default AppError;
