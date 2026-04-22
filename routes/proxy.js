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
// AI Communication — Customer Auth  (/api/auth/customer/**)
//
// MUST be registered BEFORE the generic /auth proxy so that
// /auth/customer/* hits the AI Communication backend, not user-auth-service.
//
// Path rewriting:  /auth/customer/login  →  AI Comm /api/v1/auth/login
// ---------------------------------------------------------------------------

const communicationApiUrl = config.products?.['easydev-communication']?.apiUrl;
const communicationProxyTarget = communicationApiUrl
  ? communicationApiUrl.replace(/\/api\/v1\/?$/, '')
  : null;

if (communicationProxyTarget) {
  router.use('/auth/customer', buildProxy(communicationProxyTarget, '/api/v1/auth', 'AI Communication Auth'));
} else {
  router.use('/auth/customer', serviceUnavailable('AI Communication Auth'));
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
// File Upload Service  (/api/files/**)
// ---------------------------------------------------------------------------

if (config.fileUpload.serviceUrl) {
  router.use('/files', buildProxy(config.fileUpload.serviceUrl, '/api/files', 'File Upload Service'));
} else {
  router.use('/files', serviceUnavailable('File Upload Service'));
}

// ---------------------------------------------------------------------------
// AI Communication — Customer Data  (/api/customer/**)
//
// All post-login customer dashboard calls are proxied here.
// Path rewriting:  /customer/business  →  AI Comm /api/v1/business
//                  /customer/channels  →  AI Comm /api/v1/channels
//                  /customer/users     →  AI Comm /api/v1/users
//                  /customer/conversations/stats  →  AI Comm /api/v1/conversations/stats
//                  /customer/messages/stats       →  AI Comm /api/v1/messages/stats
//
// The customer's Bearer token is forwarded transparently — AI Comm validates it.
// ---------------------------------------------------------------------------

if (communicationProxyTarget) {
  router.use('/customer', buildProxy(communicationProxyTarget, '/api/v1', 'AI Communication'));
} else {
  router.use('/customer', serviceUnavailable('AI Communication'));
}

export default router;
