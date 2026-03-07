import express from 'express';
import { createProxyMiddleware } from 'http-proxy-middleware';
import { config } from '../config/index.js';
import logger from '../utils/logger.js';

const router = express.Router();

/**
 * Returns a 503 handler for when a service URL is not configured.
 */
function serviceUnavailable(serviceName) {
  return (_req, res) => {
    logger.warn(`Proxy request blocked — ${serviceName} URL not configured`);
    res.status(503).json({
      success: false,
      message: `${serviceName} is not available. Please contact the administrator.`,
    });
  };
}

/**
 * Builds a proxy middleware that rewrites the Express-stripped path back to its
 * full form before forwarding to the target service.
 *
 * Example: mounted at /api/auth, req.url = /login
 *   → forwarded as /api/auth/login on the target.
 */
function buildProxy(target, basePath, serviceName) {
  return createProxyMiddleware({
    target,
    changeOrigin: true,
    pathRewrite: (path) => `${basePath}${path}`,
    on: {
      error(err, _req, res) {
        logger.error(`${serviceName} proxy error:`, { message: err.message });
        if (!res.headersSent) {
          res.status(502).json({
            success: false,
            message: `${serviceName} is currently unavailable. Please try again later.`,
          });
        }
      },
    },
  });
}

// ---------------------------------------------------------------------------
// Auth Service  (/api/auth/**, /api/admin/**)
// ---------------------------------------------------------------------------

if (config.auth.serviceUrl) {
  router.use('/auth', buildProxy(config.auth.serviceUrl, '/api/auth', 'User Auth Service'));
  router.use('/admin', buildProxy(config.auth.serviceUrl, '/api/admin', 'User Auth Service'));
} else {
  router.use('/auth', serviceUnavailable('User Auth Service'));
  router.use('/admin', serviceUnavailable('User Auth Service'));
}

// ---------------------------------------------------------------------------
// Lead Microservice  (/api/leads/**)
// ---------------------------------------------------------------------------

if (config.lead.serviceUrl) {
  router.use('/leads', buildProxy(config.lead.serviceUrl, '/api/leads', 'Lead Microservice'));
} else {
  router.use('/leads', serviceUnavailable('Lead Microservice'));
}

// ---------------------------------------------------------------------------
// File Upload Service  (/api/files/**)
// ---------------------------------------------------------------------------

if (config.fileUpload.serviceUrl) {
  router.use('/files', buildProxy(config.fileUpload.serviceUrl, '/api/files', 'File Upload Service'));
} else {
  router.use('/files', serviceUnavailable('File Upload Service'));
}

export default router;
