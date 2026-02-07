/**
 * Custom Error Classes for Web Agency Backend
 * Provides human-readable error messages with error codes for tracking
 */

// Base Application Error
export class AppError extends Error {
    constructor(message, statusCode = 500, code = 'INTERNAL_ERROR') {
        super(message);
        this.name = this.constructor.name;
        this.statusCode = statusCode;
        this.code = code;
        this.isOperational = true; // Distinguishes operational errors from programming errors
        this.timestamp = new Date().toISOString();
        Error.captureStackTrace(this, this.constructor);
    }

    toJSON() {
        return {
            code: this.code,
            message: this.message,
            statusCode: this.statusCode,
            timestamp: this.timestamp
        };
    }
}

// 400 Bad Request Errors
export class ValidationError extends AppError {
    constructor(message = 'Validation failed', errors = []) {
        super(message, 400, 'VALIDATION_ERROR');
        this.errors = errors;
    }

    toJSON() {
        return {
            ...super.toJSON(),
            errors: this.errors
        };
    }
}

export class BadRequestError extends AppError {
    constructor(message = 'Bad request') {
        super(message, 400, 'BAD_REQUEST');
    }
}

// 401 Authentication Errors
export class AuthenticationError extends AppError {
    constructor(message = 'Authentication required') {
        super(message, 401, 'AUTHENTICATION_ERROR');
    }
}

export class InvalidTokenError extends AppError {
    constructor(message = 'Invalid or expired token') {
        super(message, 401, 'INVALID_TOKEN');
    }
}

// 403 Authorization Errors
export class ForbiddenError extends AppError {
    constructor(message = 'Access denied') {
        super(message, 403, 'FORBIDDEN');
    }
}

// 404 Not Found Errors
export class NotFoundError extends AppError {
    constructor(resource = 'Resource', message = null) {
        super(message || `${resource} not found`, 404, 'NOT_FOUND');
        this.resource = resource;
    }
}

// 409 Conflict Errors
export class ConflictError extends AppError {
    constructor(message = 'Resource already exists') {
        super(message, 409, 'CONFLICT');
    }
}

export class DuplicateError extends AppError {
    constructor(field = 'Resource') {
        super(`${field} already exists`, 409, 'DUPLICATE_ERROR');
        this.field = field;
    }
}

// 422 Unprocessable Entity
export class UnprocessableEntityError extends AppError {
    constructor(message = 'Unable to process the request') {
        super(message, 422, 'UNPROCESSABLE_ENTITY');
    }
}

// 429 Rate Limit Errors
export class RateLimitError extends AppError {
    constructor(message = 'Too many requests, please try again later') {
        super(message, 429, 'RATE_LIMIT_EXCEEDED');
    }
}

// 500 Internal Errors
export class InternalError extends AppError {
    constructor(message = 'An unexpected error occurred') {
        super(message, 500, 'INTERNAL_ERROR');
    }
}

// 503 Service Unavailable
export class ServiceUnavailableError extends AppError {
    constructor(service = 'Service', message = null) {
        super(message || `${service} is temporarily unavailable`, 503, 'SERVICE_UNAVAILABLE');
        this.service = service;
    }
}

// Database specific errors
export class DatabaseError extends AppError {
    constructor(message = 'Database operation failed') {
        super(message, 500, 'DATABASE_ERROR');
    }
}

// External service errors
export class ExternalServiceError extends AppError {
    constructor(service = 'External service', message = null) {
        super(message || `Failed to communicate with ${service}`, 502, 'EXTERNAL_SERVICE_ERROR');
        this.service = service;
    }
}

/**
 * Human-readable error messages for common scenarios
 * Used in production mode to provide user-friendly messages
 */
export const ERROR_MESSAGES = {
    // Authentication
    INVALID_CREDENTIALS: 'The email or password you entered is incorrect. Please try again.',
    TOKEN_EXPIRED: 'Your session has expired. Please log in again.',
    TOKEN_INVALID: 'Your session is invalid. Please log in again.',
    ACCOUNT_DEACTIVATED: 'Your account has been deactivated. Please contact support.',
    ACCESS_DENIED: 'You do not have permission to perform this action.',

    // Validation
    VALIDATION_FAILED: 'Please check your input and try again.',
    INVALID_ID: 'The provided ID is not valid.',
    REQUIRED_FIELD: 'Please fill in all required fields.',
    INVALID_EMAIL: 'Please enter a valid email address.',

    // Resources
    RESOURCE_NOT_FOUND: 'The requested resource could not be found.',
    RESOURCE_EXISTS: 'This resource already exists.',

    // Rate limiting
    RATE_LIMIT: 'You have made too many requests. Please wait a moment and try again.',

    // Server errors
    INTERNAL_ERROR: 'Something went wrong on our end. Please try again later.',
    DATABASE_ERROR: 'We are experiencing technical difficulties. Please try again later.',
    SERVICE_UNAVAILABLE: 'This service is temporarily unavailable. Please try again later.',

    // Email
    EMAIL_FAILED: 'We could not send the email at this time. Please try again later.'
};

export default {
    AppError,
    ValidationError,
    BadRequestError,
    AuthenticationError,
    InvalidTokenError,
    ForbiddenError,
    NotFoundError,
    ConflictError,
    DuplicateError,
    UnprocessableEntityError,
    RateLimitError,
    InternalError,
    ServiceUnavailableError,
    DatabaseError,
    ExternalServiceError,
    ERROR_MESSAGES
};
