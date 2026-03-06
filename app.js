import express from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import mongoSanitize from "express-mongo-sanitize";
import swaggerJsdoc from "swagger-jsdoc";
import swaggerUi from "swagger-ui-express";
import dotenv from "dotenv";
import compression from "compression";
import { randomUUID } from "crypto";
import mongoose from "mongoose";
import path from "path";

// Middleware
import { errorHandler, notFound } from "./middleware/errorHandler.js";
// import { requestLogger } from "./middleware/requestLogger.js";

// Routes
import authRoutes from "./routes/auth.js";
import newsletterRoutes from "./routes/newsletter.js";
import blogRoutes from "./routes/blog.js";
import contactRoutes from "./routes/contact.js";
import inquiryRoutes from "./routes/inquiry.js";
import planRoutes from "./routes/plans.js";
import uploadRoutes from "./routes/upload.js";

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

/**
 * Stricter rate limit for auth endpoints
 */
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20, // 20 attempts per 15 minutes
  message: {
    success: false,
    error: {
      code: 'AUTH_RATE_LIMIT',
      message: 'Too many login attempts. Please try again in 15 minutes.'
    }
  }
});

// Swagger configuration
const swaggerOptions = {
  definition: {
    openapi: "3.0.0",
    info: {
      title: "Web Development Agency API",
      version: "1.0.0",
      description: "REST API for Web Development Agency website"
    },
    components: {
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "JWT"
        }
      }
    }
  },
  apis: ["./routes/*.js"]
};

const specs = swaggerJsdoc(swaggerOptions);

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
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-ID']
  })
);

// Apply global rate limiter
app.use(limiter);

// Body parsers with size limits
app.use(express.json({
  limit: "10mb",
  verify: (req, res, buf) => {
    req.rawBody = buf;
  }
}));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

// Serve uploaded files from local storage.
app.use("/uploads", express.static(path.resolve(process.cwd(), "uploads")));

// Security: Sanitize against NoSQL injection
app.use(mongoSanitize());

// app.use(requestLogger);

// API Docs (only in development/staging)
if (isDevelopment || config.app.enableSwagger === "true") {
	app.use("/api-docs", swaggerUi.serve, swaggerUi.setup(specs));
}

// Apply stricter rate limit to auth routes
app.use("/api/auth/login", authLimiter);

// Routes
app.use("/api/auth", authRoutes);
app.use("/api/newsletter", newsletterRoutes);
app.use("/api/blogs", blogRoutes);
app.use("/api/contact", contactRoutes);
app.use("/api/inquiry", inquiryRoutes);
app.use("/api/plans", planRoutes);
app.use("/api/upload", uploadRoutes);

/**
 * Enhanced health check with system metrics
 */
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

/**
 * Readiness check for load balancers
 */
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
