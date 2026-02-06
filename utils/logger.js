import winston from 'winston';

const ENABLE_LOGGING = process.env.ENABLE_LOGGING === 'true';

let logger;

if (!ENABLE_LOGGING) {
  // 🔕 Logging disabled → fallback to console
  logger = console;
} else {
  // ✅ Winston logger
  logger = winston.createLogger({
    level: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
    format: winston.format.combine(
      winston.format.timestamp(),
      winston.format.errors({ stack: true }),
      winston.format.json()
    ),
    defaultMeta: { service: 'web-agency-api' },
    transports: [
      new winston.transports.File({
        filename: 'logs/error.log',
        level: 'error'
      }),
      new winston.transports.File({
        filename: 'logs/combined.log'
      })
    ]
  });

  // 🖥 Console logging in non-production
  if (process.env.NODE_ENV !== 'production') {
    logger.add(
      new winston.transports.Console({
        format: winston.format.combine(
          winston.format.colorize(),
          winston.format.simple()
        )
      })
    );
  }
}

export default logger;
