/**
 * Lead-specific rate limiter factory.
 * Redis-backed when REDIS_URL is configured, in-memory fallback otherwise.
 *
 * Usage:
 *   import { leadRateLimit } from '../middleware/leadRateLimit.js';
 *   const limiter = leadRateLimit({ maxAttempts: 10, windowMs: 15 * 60 * 1000, action: 'lead_submit' });
 */
import { config } from '../config/index.js';
import logger from '../utils/logger.js';

let redis = null;

if (config.redis?.enabled && config.redis?.url) {
  try {
    const { default: Redis } = await import('ioredis');
    redis = new Redis(config.redis.url, {
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
      lazyConnect: true,
    });
    redis.connect().catch((err) => {
      logger.warn(`[leadRateLimit] Redis connect failed, using in-memory fallback: ${err.message}`);
      redis = null;
    });
    redis.on('error', (err) => {
      logger.warn(`[leadRateLimit] Redis error, switching to in-memory: ${err.message}`);
      redis = null;
    });
  } catch (err) {
    logger.warn(`[leadRateLimit] ioredis unavailable, using in-memory: ${err.message}`);
    redis = null;
  }
}

const memStore = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of memStore) {
    if (now > v.resetAt) memStore.delete(k);
  }
}, 5 * 60 * 1000).unref();

async function redisIncr(key, windowMs) {
  const count = await redis.incr(key);
  if (count === 1) await redis.pexpire(key, windowMs);
  const ttlMs = await redis.pttl(key);
  return { count, resetAt: Date.now() + (ttlMs > 0 ? ttlMs : windowMs) };
}

function memIncr(key, windowMs) {
  const now = Date.now();
  const record = memStore.get(key) || { count: 0, resetAt: now + windowMs };
  if (now > record.resetAt) { record.count = 0; record.resetAt = now + windowMs; }
  record.count += 1;
  memStore.set(key, record);
  return record;
}

export function leadRateLimit(options = {}) {
  const cfg = {
    maxAttempts: 100,
    windowMs: 15 * 60 * 1000,
    action: 'general',
    errorMessage: 'Too many requests, please try again later',
    statusCode: 429,
    keyGenerator: (req) => `rl:${options.action || 'general'}:${req.ip}`,
    ...options,
  };

  return async (req, res, next) => {
    const key = cfg.keyGenerator(req);
    let count, resetAt;
    try {
      if (redis) {
        ({ count, resetAt } = await redisIncr(key, cfg.windowMs));
      } else {
        ({ count, resetAt } = memIncr(key, cfg.windowMs));
      }
    } catch (err) {
      logger.warn(`[leadRateLimit] Counter error, allowing request: ${err.message}`);
      return next();
    }

    res.setHeader('X-RateLimit-Limit', cfg.maxAttempts);
    res.setHeader('X-RateLimit-Remaining', Math.max(0, cfg.maxAttempts - count));
    res.setHeader('X-RateLimit-Reset', Math.ceil(resetAt / 1000));

    if (count > cfg.maxAttempts) {
      return res.status(cfg.statusCode).json({ success: false, message: cfg.errorMessage });
    }
    next();
  };
}
