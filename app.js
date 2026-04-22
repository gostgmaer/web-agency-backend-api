import express from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import mongoSanitize from "express-mongo-sanitize";
import dotenv from "dotenv";
import compression from "compression";
import { randomUUID } from "crypto";
import mongoose from "mongoose";
import path from "path";

// Middleware
import { errorHandler, notFound } from "./middleware/errorHandler.js";

// Routes — owned by this service
import newsletterRoutes     from "./routes/newsletter.js";
import uploadRoutes         from "./routes/upload.js";
import calculatorRoutes     from "./routes/calculator.js";
import paymentsRoutes       from "./routes/payments.js";
import communicationRoutes  from "./routes/communication.js";
import leadRoutes           from "./routes/leads.js";

// Proxy routes — forwarded to microservices
import proxyRoutes from "./routes/proxy.js";

import logger from "./utils/logger.js";
import { config } from "./config/index.js";

dotenv.config();

const app = express();
const isDevelopment = config.app.nodeEnv !== "production";

/**
 * Request ID middleware - adds unique ID for request tracking
 */
app.use((req, res, next) => {
  req.requestId = req.headers['x-request-id'] || randomUUID();
  res.setHeader('X-Request-ID', req.requestId);
  next();
});

/**
 * Request timing middleware
 */
app.use((req, res, next) => {
  req.startTime = Date.now();

  res.on('finish', () => {
    const duration = Date.now() - req.startTime;
    // Log requests that are slow (> 1s) or errors
    if (duration > 1000 || res.statusCode >= 400) {
      logger.logRequest(req, res, duration);
    }
  });

  next();
});

/**
 * Compression middleware - gzip responses
 */
app.use(compression({
  level: 6, // Balance between compression ratio and speed
  threshold: 1024, // Only compress responses > 1KB
  filter: (req, res) => {
    if (req.headers['x-no-compression']) {
      return false;
    }
    return compression.filter(req, res);
  }
}));

/**
 * Rate limiting - optimized for 100 RPS
 * Window: 1 minute, Max: 200 requests per IP (allows burst)
 */
const limiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute window
  max: 200, // 200 requests per minute per IP (allows for burst)
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    error: {
      code: 'RATE_LIMIT_EXCEEDED',
      message: 'Too many requests from this IP. Please wait a moment and try again.'
    }
  },
  skip: (req) => {
    // Skip rate limiting for health checks
    return req.path === '/api/health';
  },
  keyGenerator: (req) => {
    return req.headers['x-forwarded-for']?.split(',')[0] || req.ip;
  }
});

// Security middleware
app.use(helmet({
  crossOriginResourcePolicy: { policy: "cross-origin" },
  contentSecurityPolicy: isDevelopment ? false : undefined
}));

// CORS configuration
const corsOriginsRaw = config.app.corsOrigins ?? [];
const allowedOrigins = (Array.isArray(corsOriginsRaw) ? corsOriginsRaw : String(corsOriginsRaw).split(","))
	.map((origin) => origin.trim())
	.filter(Boolean)
	.map((origin) => origin.replace(/\/$/, ""));

app.use(
  cors({
    origin: (origin, callback) => {
      // Allow non-browser clients (no Origin header)
      if (!origin) return callback(null, true);

      const normalizedOrigin = origin.replace(/\/$/, "");
      if (allowedOrigins.includes(normalizedOrigin)) {
        return callback(null, true);
      }

      return callback(new Error("Not allowed by CORS"));
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-ID', 'X-Tenant-Id', 'x-tenant-id']
  })
);

// Apply global rate limiter
app.use(limiter);

// Body parsers — scoped to owned routes only so proxy routes receive the raw
// stream and http-proxy-middleware can forward it without body-reinjection hacks.
const jsonParser = express.json({ limit: "10mb" });
const urlencodedParser = express.urlencoded({ extended: true, limit: "10mb" });

// Serve uploaded files from local storage.
app.use("/uploads", express.static(path.resolve(process.cwd(), "uploads")));

// Security: Sanitize against NoSQL injection
app.use(mongoSanitize());

// ─── Response envelope ────────────────────────────────────────────────────────
// Injects: timestamp, requestId, statusCode, status into every JSON response.
// Also serialises _id → id (string), strips __v, strips null values, sets headers.
app.use((req, res, next) => {
  res.setHeader('X-Request-ID', req.requestId);
  const _json = res.json.bind(res);
  res.json = function (body) {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    if (body !== null && body !== undefined && typeof body === 'object' && !Array.isArray(body)) {
      body.timestamp  = new Date().toISOString();
      body.requestId  = req.requestId;
      body.statusCode = res.statusCode;
      body.status     = res.statusCode < 400 ? 'success' : 'error';
    }
    return _json(_cleanResponse(body));
  };
  next();
});

function _cleanResponse(val) {
  if (val === null || val === undefined) return undefined;
  if (typeof val !== 'object') return val;
  if (val instanceof Date) return val;
  if (Buffer.isBuffer(val)) return val;
  if (Array.isArray(val)) return val.map(_cleanResponse).filter(v => v !== undefined);
  const src = typeof val.toJSON === 'function' ? val.toJSON() : val;
  if (typeof src !== 'object' || src === null) return src;
  const out = {};
  for (const key of Object.keys(src)) {
    if (key === '__v' || key === '_id' || key === 'id' ||
        key === 'isDeleted' || key === 'deletedAt' ||
        key === 'created_by' || key === 'updated_by' || key === 'deleted_by') continue;
    const v = _cleanResponse(src[key]);
    if (v !== undefined) out[key] = v;
  }
  const rawId = src.id !== undefined ? src.id : src._id;
  if (rawId !== undefined) out.id = String(rawId);
  return out;
}

// Serve Postman collection for direct import
app.get("/api/postman-collection", (_req, res) => {
  res.sendFile(
    path.resolve(process.cwd(), "postman", "Web-Agency-API.postman_collection.json")
  );
});

// Routes — owned by this service (body parsing applied inline)
// Inject default tenant ID before all routes so microservices always receive
// x-tenant-id even when the client omits it (single-tenant / non-tenanted mode).
if (config.tenantId) {
  app.use((req, _res, next) => {
    if (!req.headers['x-tenant-id']) {
      req.headers['x-tenant-id'] = config.tenantId;
    }
    next();
  });
}
app.use("/api/newsletter",    jsonParser, urlencodedParser, newsletterRoutes);
app.use("/api/upload",        jsonParser, urlencodedParser, uploadRoutes);
app.use("/api/calculator",    jsonParser,                   calculatorRoutes);
app.use("/api/communication", jsonParser,                   communicationRoutes);
app.use("/api/leads",         jsonParser, urlencodedParser, leadRoutes);

// Webhook routes require raw (unparsed) body for HMAC signature verification.
// We skip jsonParser for /webhooks/* paths; those routes apply express.raw()
// internally. All other payment routes get standard JSON body parsing.
app.use(
  "/api/payments",
  (req, res, next) => {
    if (req.path.startsWith("/webhooks/")) return next();  // raw handled in-router
    return jsonParser(req, res, next);
  },
  paymentsRoutes
);

// Proxy routes — transparently forwarded to microservices
// NOTE: proxy routes must come AFTER body-parsing middleware but the
// http-proxy-middleware handles its own streaming; body already consumed
// for owned routes above, proxy routes sit on a separate path namespace.
app.use("/api", proxyRoutes);

app.get("/api/health", (req, res) => {
  const healthData = {
		status: "healthy",
		timestamp: new Date().toISOString(),
		uptime: Math.floor(process.uptime()),
		environment: config.app.nodeEnv || "development",
		version: config.app.version || "1.0.0",
	};

  // Add detailed metrics in development or if requested
  if (isDevelopment || req.query.detailed === "true") {
		const memUsage = process.memoryUsage();
		healthData.memory = {
			heapUsed: Math.round(memUsage.heapUsed / 1024 / 1024) + "MB",
			heapTotal: Math.round(memUsage.heapTotal / 1024 / 1024) + "MB",
			rss: Math.round(memUsage.rss / 1024 / 1024) + "MB",
		};
		healthData.pid = process.pid;
	}

  res.status(200).json({
    success: true,
    message: "Server is running successfully",
    data: healthData
  });
});

app.get("/api/ready", (req, res) => {
  // Check if database is connected (readyState: 1 = connected)
  const isDbReady = mongoose.connection.readyState === 1;

  if (isDbReady) {
    res.status(200).json({
      success: true,
      message: "Service is ready"
    });
  } else {
    res.status(503).json({
      success: false,
      message: "Service is not ready - database not connected"
    });
  }
});

// Error handling
app.use(notFound);
app.use(errorHandler);

export default app;
