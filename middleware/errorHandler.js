import logger from '../utils/logger.js';
import { AppError, ERROR_MESSAGES } from '../utils/errors.js';
import { config } from "../config/index.js";

const isDevelopment = config.app.nodeEnv !== "production";

/**
 * Generate a unique request ID for error tracking
 */
const generateErrorId = () => {
  return `ERR-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).substring(2, 7).toUpperCase()}`;
};

/**
 * Format validation errors from express-validator
 */
const formatValidationErrors = (errors) => {
  return errors.map(err => ({
    field: err.path || err.param,
    message: err.msg,
    value: isDevelopment ? err.value : undefined
  }));
};

/**
 * Get human-readable message for common errors
 */
const getHumanReadableMessage = (error) => {
  // If it's an operational error, use its message
  if (error.isOperational) {
    return error.message;
  }

  // Map common error types to user-friendly messages
  switch (error.code) {
    case 'VALIDATION_ERROR':
      return ERROR_MESSAGES.VALIDATION_FAILED;
    case 'AUTHENTICATION_ERROR':
    case 'INVALID_TOKEN':
      return ERROR_MESSAGES.TOKEN_INVALID;
    case 'NOT_FOUND':
      return ERROR_MESSAGES.RESOURCE_NOT_FOUND;
    case 'DUPLICATE_ERROR':
    case 'CONFLICT':
      return ERROR_MESSAGES.RESOURCE_EXISTS;
    case 'RATE_LIMIT_EXCEEDED':
      return ERROR_MESSAGES.RATE_LIMIT;
    case 'DATABASE_ERROR':
      return ERROR_MESSAGES.DATABASE_ERROR;
    default:
      return ERROR_MESSAGES.INTERNAL_ERROR;
  }
};

/**
 * Handle Mongoose CastError (invalid ObjectId)
 */
const handleCastError = (err) => {
  const error = new AppError(`Invalid ${err.path}: ${err.value}`, 400, 'INVALID_ID');
  error.originalError = err;
  return error;
};

/**
 * Handle Mongoose duplicate key error
 */
const handleDuplicateKeyError = (err) => {
  const field = Object.keys(err.keyValue || {})[0] || 'field';
  const value = err.keyValue ? err.keyValue[field] : '';
  const message = `The ${field} "${value}" is already in use. Please choose a different one.`;
  const error = new AppError(message, 409, 'DUPLICATE_ERROR');
  error.field = field;
  error.originalError = err;
  return error;
};

/**
 * Handle Mongoose validation error
 */
const handleValidationError = (err) => {
  const errors = Object.values(err.errors || {}).map(e => ({
    field: e.path,
    message: e.message,
    value: isDevelopment ? e.value : undefined
  }));
  const error = new AppError('Validation failed. Please check your input.', 400, 'VALIDATION_ERROR');
  error.errors = errors;
  error.originalError = err;
  return error;
};

/**
 * Handle JWT errors
 */
const handleJWTError = (err) => {
  if (err.name === 'TokenExpiredError') {
    return new AppError(ERROR_MESSAGES.TOKEN_EXPIRED, 401, 'TOKEN_EXPIRED');
  }
  return new AppError(ERROR_MESSAGES.TOKEN_INVALID, 401, 'INVALID_TOKEN');
};

/**
 * Handle SyntaxError (invalid JSON in request body)
 */
const handleSyntaxError = (err) => {
  return new AppError('Invalid JSON in request body. Please check your request format.', 400, 'INVALID_JSON');
};

/**
 * Main error handler middleware
 */
export const errorHandler = (err, req, res, next) => {
  // Generate unique error ID for tracking
  const errorId = generateErrorId();

  // Transform known error types
  let error = err;

  if (err.name === 'CastError') {
    error = handleCastError(err);
  } else if (err.code === 11000) {
    error = handleDuplicateKeyError(err);
  } else if (err.name === 'ValidationError') {
    error = handleValidationError(err);
  } else if (err.name === 'JsonWebTokenError' || err.name === 'TokenExpiredError') {
    error = handleJWTError(err);
  } else if (err instanceof SyntaxError && err.status === 400) {
    error = handleSyntaxError(err);
  } else if (!(err instanceof AppError)) {
    // Wrap unknown errors
    error = new AppError(
      isDevelopment ? err.message : ERROR_MESSAGES.INTERNAL_ERROR,
      err.statusCode || 500,
      'INTERNAL_ERROR'
    );
    error.originalError = err;
  }

  // Log the error with full context
  logger.logError(error, {
    errorId,
    requestId: req.requestId,
    url: req.originalUrl,
    method: req.method,
    ip: req.ip,
    userAgent: req.get('User-Agent'),
    userId: req.admin?._id?.toString()
  });

  // Build response
  const statusCode = error.statusCode || 500;
  const response = {
    success: false,
    error: {
      code: error.code || 'INTERNAL_ERROR',
      message: isDevelopment ? error.message : getHumanReadableMessage(error),
      errorId // Include error ID for support reference
    }
  };

  // Add validation errors if present
  if (error.errors) {
    response.error.details = error.errors;
  }

  // Add stack trace and additional debug info in development mode
  if (isDevelopment) {
    response.error.stack = error.stack;
    response.error.originalError = error.originalError?.message;
    response.debug = {
      timestamp: new Date().toISOString(),
      path: req.originalUrl,
      method: req.method
    };
  }

  res.status(statusCode).json(response);
};

/**
 * 404 Not Found handler
 */
export const notFound = (req, res) => {
  const errorId = generateErrorId();

  logger.warn('Route not found', {
    errorId,
    requestId: req.requestId,
    url: req.originalUrl,
    method: req.method,
    ip: req.ip
  });

  res.status(404).json({
    success: false,
    error: {
      code: 'ROUTE_NOT_FOUND',
      message: isDevelopment
        ? `The route ${req.method} ${req.originalUrl} does not exist on this server.`
        : 'The page you are looking for does not exist.',
      errorId
    }
  });
};

/**
 * Async handler wrapper to catch errors in async routes
 * @param {Function} fn - Async route handler
 */
export const asyncHandler = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

export default { errorHandler, notFound, asyncHandler };