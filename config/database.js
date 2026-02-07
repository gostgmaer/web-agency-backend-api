import mongoose from 'mongoose';
import logger from '../utils/logger.js';

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/web-agency';

/**
 * MongoDB connection options optimized for performance
 */
const connectionOptions = {
  // Connection pool settings
  maxPoolSize: 20, // Maximum number of connections in the pool
  minPoolSize: 5,  // Minimum number of connections to maintain

  // Connection timeout settings
  serverSelectionTimeoutMS: 5000, // Timeout for selecting server
  socketTimeoutMS: 45000, // Socket timeout

  // Keep alive settings
  heartbeatFrequencyMS: 10000, // How often to send heartbeat

  // Retry settings
  retryWrites: false, // Disabled due to Azure CosmosDB
  retryReads: true,

  // Other optimizations
  maxIdleTimeMS: 120000, // 2 minutes idle before closing
  compressors: ['zlib'], // Enable compression
};

/**
 * Connect to MongoDB with retry logic
 */
export const connectDatabase = async (retries = 5, delay = 5000) => {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const conn = await mongoose.connect(MONGODB_URI, connectionOptions);

      logger.info(`MongoDB connected successfully`, {
        host: conn.connection.host,
        database: conn.connection.name,
        poolSize: connectionOptions.maxPoolSize
      });

      return conn;
    } catch (error) {
      logger.error(`Database connection attempt ${attempt}/${retries} failed`, {
        error: error.message,
        retryIn: attempt < retries ? `${delay / 1000}s` : 'no more retries'
      });

      if (attempt === retries) {
        logger.error('Failed to connect to database after all retries');
        throw error;
      }

      // Wait before retrying
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
};

/**
 * Gracefully disconnect from MongoDB
 */
export const disconnectDatabase = async () => {
  try {
    await mongoose.connection.close();
    logger.info('MongoDB connection closed');
  } catch (error) {
    logger.error('Error closing MongoDB connection', { error: error.message });
    throw error;
  }
};

// Connection event handlers
mongoose.connection.on('error', (error) => {
  logger.error('MongoDB connection error', { error: error.message });
});

mongoose.connection.on('disconnected', () => {
  logger.warn('MongoDB disconnected');
});

mongoose.connection.on('reconnected', () => {
  logger.info('MongoDB reconnected');
});

// Monitor connection pool (for debugging)
if (process.env.NODE_ENV === 'development') {
  mongoose.connection.on('connected', () => {
    logger.debug('MongoDB connection pool established');
  });
}

export default mongoose;