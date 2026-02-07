import winston from 'winston';

const NODE_ENV = process.env.NODE_ENV || 'development';
const ENABLE_LOGGING = process.env.ENABLE_LOGGING !== 'false'; // Default to true unless explicitly disabled
const LOG_LEVEL = process.env.LOG_LEVEL || (NODE_ENV === 'production' ? 'info' : 'debug');

// Detect serverless/read-only filesystem environments
const IS_SERVERLESS = !!(
  process.env.VERCEL ||
  process.env.AWS_LAMBDA_FUNCTION_NAME ||
  process.env.NETLIFY ||
  process.env.SERVERLESS ||
  process.env.DISABLE_FILE_LOGGING === 'true'
);

/**
 * Custom log format for console output
 */
const consoleFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.colorize({ all: true }),
  winston.format.printf(({ timestamp, level, message, ...meta }) => {
    const metaStr = Object.keys(meta).length ? JSON.stringify(meta, null, 2) : '';
    return `[${timestamp}] ${level}: ${message} ${metaStr}`;
  })
);

/**
 * JSON format for file output (production)
 */
const fileFormat = winston.format.combine(
  winston.format.timestamp(),
  winston.format.errors({ stack: true }),
  winston.format.json()
);

/**
 * Create Winston logger instance
 */
const createLogger = () => {
  const transports = [];

  // Console transport - always enabled in development, controlled by env in production
  if (NODE_ENV !== 'production' || ENABLE_LOGGING) {
    transports.push(
      new winston.transports.Console({
        format: consoleFormat,
        level: LOG_LEVEL
      })
    );
  }

  // File transports - only in production when NOT in serverless environment
  if (ENABLE_LOGGING && NODE_ENV === 'production' && !IS_SERVERLESS) {
    try {
      transports.push(
        new winston.transports.File({
          filename: 'logs/error.log',
          level: 'error',
          format: fileFormat,
          maxsize: 5242880, // 5MB
          maxFiles: 5
        }),
        new winston.transports.File({
          filename: 'logs/combined.log',
          format: fileFormat,
          maxsize: 5242880, // 5MB
          maxFiles: 5
        })
      );
    } catch (err) {
      // Silently skip file logging if directory creation fails
      console.warn('File logging disabled - could not create logs directory');
    }
  }

  // If no transports, add a silent transport to prevent errors
  if (transports.length === 0) {
    transports.push(new winston.transports.Console({ silent: true }));
  }

  return winston.createLogger({
    level: LOG_LEVEL,
    defaultMeta: {
      service: 'web-agency-api',
      environment: NODE_ENV
    },
    transports,
    // Don't exit on handled exceptions
    exitOnError: false
  });
};

const logger = createLogger();

/**
 * Create a child logger with request context
 * @param {Object} meta - Additional metadata (requestId, userId, etc.)
 */
logger.child = (meta) => {
  return logger.child(meta);
};

/**
 * Log HTTP request info
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @param {number} duration - Request duration in ms
 */
logger.logRequest = (req, res, duration) => {
  const logData = {
    method: req.method,
    url: req.originalUrl,
    status: res.statusCode,
    duration: `${duration}ms`,
    ip: req.ip,
    userAgent: req.get('User-Agent'),
    requestId: req.requestId
  };

  if (res.statusCode >= 400) {
    logger.warn('HTTP Request', logData);
  } else {
    logger.info('HTTP Request', logData);
  }
};

/**
 * Log error with full context
 * @param {Error} error - Error object
 * @param {Object} context - Additional context
 */
logger.logError = (error, context = {}) => {
  logger.error(error.message, {
    ...context,
    errorCode: error.code,
    statusCode: error.statusCode,
    stack: error.stack,
    isOperational: error.isOperational
  });
};

// Log startup info
logger.info(`Logger initialized`, {
  level: LOG_LEVEL,
  environment: NODE_ENV,
  loggingEnabled: ENABLE_LOGGING
});

export default logger;
