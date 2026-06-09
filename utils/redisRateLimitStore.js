import Redis from "ioredis";
import { config } from "../config/index.js";
import logger from "./logger.js";

let redis = null;

if (config.redis?.enabled && config.redis?.url) {
  try {
    redis = new Redis(config.redis.url, {
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
      lazyConnect: true,
    });
    redis.connect().catch((err) => {
      logger.warn(`[RedisRateLimitStore] Redis connect failed: ${err.message}`);
      redis = null;
    });
  } catch (err) {
    logger.warn(`[RedisRateLimitStore] Redis init failed: ${err.message}`);
    redis = null;
  }
}

export class RedisRateLimitStore {
  constructor(windowMs) {
    this.windowMs = windowMs || 60000;
    this.memStore = new Map();
  }

  async increment(key) {
    if (redis) {
      try {
        const count = await redis.incr(key);
        if (count === 1) {
          await redis.pexpire(key, this.windowMs);
        }
        const ttlMs = await redis.pttl(key);
        const resetTime = new Date(Date.now() + (ttlMs > 0 ? ttlMs : this.windowMs));
        return {
          totalHits: count,
          resetTime,
        };
      } catch (err) {
        logger.warn(`[RedisRateLimitStore] Redis increment error: ${err.message}`);
        // Fallback to memory on Redis command failure
      }
    }

    // Memory fallback
    const now = Date.now();
    let record = this.memStore.get(key);
    if (!record || now > record.resetTime.getTime()) {
      record = {
        totalHits: 0,
        resetTime: new Date(now + this.windowMs),
      };
    }
    record.totalHits += 1;
    this.memStore.set(key, record);
    return record;
  }

  async decrement(key) {
    if (redis) {
      try {
        await redis.decr(key);
        return;
      } catch (err) {
        logger.warn(`[RedisRateLimitStore] Redis decrement error: ${err.message}`);
      }
    }
    const record = this.memStore.get(key);
    if (record && record.totalHits > 0) {
      record.totalHits -= 1;
    }
  }

  async resetKey(key) {
    if (redis) {
      try {
        await redis.del(key);
        return;
      } catch (err) {
        logger.warn(`[RedisRateLimitStore] Redis resetKey error: ${err.message}`);
      }
    }
    this.memStore.delete(key);
  }
}
