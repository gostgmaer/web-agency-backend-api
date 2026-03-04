import dotenv from "dotenv";
import app from "./app.js";
import { connectDatabase, disconnectDatabase } from "./config/database.js";
import logger from "./utils/logger.js";
import { config } from "./config/index.js";

dotenv.config();

const PORT = config.app.port || 3000;
const REQUEST_TIMEOUT = Number(config.performance.requestTimeout) || 30000;
const SHUTDOWN_TIMEOUT = Number(config.performance.shutdownTimeout) || 10000;

let server;
let isShuttingDown = false;

/**
 * Graceful shutdown handler
 */
const gracefulShutdown = async (signal) => {
  if (isShuttingDown) {
    logger.warn('Shutdown already in progress...');
    return;
  }

  isShuttingDown = true;
  logger.info(`${signal} received. Starting graceful shutdown...`);

  // Stop accepting new connections
  if (server) {
    server.close(async (err) => {
      if (err) {
        logger.error('Error closing server', { error: err.message });
      } else {
        logger.info('HTTP server closed');
      }
    });
  }

  // Give ongoing requests time to complete
  const shutdownTimer = setTimeout(() => {
    logger.warn('Shutdown timeout reached, forcing exit');
    process.exit(1);
  }, SHUTDOWN_TIMEOUT);

  try {
    // Close database connection
    await disconnectDatabase();
    logger.info('Database connections closed');

    clearTimeout(shutdownTimer);
    logger.info('Graceful shutdown completed');
    process.exit(0);
  } catch (error) {
    logger.error('Error during shutdown', { error: error.message });
    clearTimeout(shutdownTimer);
    process.exit(1);
  }
};

/**
 * Handle uncaught exceptions
 */
process.on('uncaughtException', (error) => {
  logger.error('Uncaught Exception', {
    error: error.message,
    stack: error.stack
  });

  // Give time for logging before exit
  setTimeout(() => process.exit(1), 1000);
});

/**
 * Handle unhandled promise rejections
 */
process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled Promise Rejection', {
    reason: reason?.message || reason,
    stack: reason?.stack
  });
});

// Graceful shutdown signals
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

/**
 * Start the server
 */
const startServer = async () => {
  try {
    // Connect to database with retry
    await connectDatabase();

    // Start HTTP server
    server = app.listen(PORT, () => {
      logger.info(`🚀 Server running on port ${PORT}`, {
				pid: process.pid,
				environment: config.app.nodeEnv || "development",
				apiDocs: `http://localhost:${PORT}/api-docs`,
			});
    });

    // Set server timeout
    server.timeout = REQUEST_TIMEOUT;
    server.keepAliveTimeout = 65000; // Slightly higher than ALB timeout
    server.headersTimeout = 66000; // Slightly higher than keepAliveTimeout

  } catch (error) {
    logger.error("Failed to start server", { error: error.message });
    process.exit(1);
  }
};

startServer();
