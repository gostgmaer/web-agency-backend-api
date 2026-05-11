/**
 * routes/proxy.js
 *
 * Single proxy file for all microservice forwarding.
 *
 * Two proxy patterns:
 *
 *   buildProxy(target, basePath, name)
 *     Bearer-auth proxy for dashboard / API routes.
 *     Always injects x-tenant-id.
 *     When authenticate() runs first, also injects x-user-id, x-user-role,
 *     x-session-id, x-request-id from the verified JWT payload.
 *
 *   buildPortalProxy(cookieName, target, name)
 *     Cookie-auth proxy for standalone product frontends.
 *     - POST /api/v1/auth/sso/exchange  — PUBLIC (sets the session cookie)
 *     - ALL /*                          — validates the session cookie, then
 *                                         streams the raw body to the backend
 *     Rate limited to 300 req/min in production.
 *     Only the session cookie is forwarded downstream (all others stripped).
 *
 * Route map (all mounted under app.use("/api", proxyRoutes)):
 *
 *   PUBLIC
 *     /auth/*                   → IAM /api/v1/iam/auth/*
 *     /iam/health               → IAM /api/v1/iam/health
 *     /iam/settings/public      → IAM /api/v1/iam/settings/public (branding/login config)
 *
 *   AUTHENTICATED (Bearer token verified at gateway)
 *     /profile/*                → IAM /api/v1/iam/profile/*
 *     /rbac/*                   → IAM /api/v1/iam/rbac/*
 *     /users/*                  → IAM /api/v1/iam/users/*
 *     /customer/users/*         → IAM /api/v1/iam/users/*
 *     /tenants/*                → IAM /api/v1/iam/tenants/*
 *     /sessions/*               → IAM /api/v1/iam/sessions/*
 *     /iam/logs|stats|security|api-keys|webhooks|flags|apps|settings/*
 *                               → IAM
 *     /files/*                  → File Upload /api/files/*
 *     /customer/*               → AI Communication /api/v1/*
 *     /communication/admin/*    → AI Communication /api/v1/admin/*
 *     /job-agent/proxy/*        → Job Agent /api/v1/*
 *
 *   PORTAL (cookie-auth, raw stream — product frontends)
 *     /portal/communication/*   → AI Communication (ea_comm_session cookie)
 *     /portal/job-agent/*       → Job Agent        (ja_session cookie)
 */

import express                  from 'express';
import { createProxyMiddleware } from 'http-proxy-middleware';
import jwt                       from 'jsonwebtoken';
import rateLimit                 from 'express-rate-limit';
import axios                     from 'axios';
import { config }                from '../config/index.js';
import { JWT_SECRET }            from '../config/jwt.js';
import logger                    from '../utils/logger.js';
import { getRuntimeTenantFallback } from '../utils/tenantFallback.js';
import { authenticate }          from '../middleware/auth.js';
import { addGatewaySignatureHeaders } from '../utils/gatewayHmac.js';

const router = express.Router();

// ─── Helpers ──────────────────────────────────────────────────────────────────

function serviceUnavailable(serviceName) {
  return (_req, res) => {
    logger.warn(`Proxy request blocked — ${serviceName} URL not configured`);
    res.status(503).json({
      success: false,
      message: `${serviceName} is not available. Please contact the administrator.`,
    });
  };
}

/** Parse protocol+host from a full URL ("http://localhost:3303/api/v1" → "http://localhost:3303"). */
function parseHost(raw) {
  if (!raw) return null;
  try {
    const u = new URL(raw.trim().replace(/\/+$/, ''));
    return `${u.protocol}//${u.host}`;
  } catch {
    return raw.trim().replace(/\/api.*$/, '').replace(/\/+$/, '') || null;
  }
}

/** Parse pathname from a full URL ("http://localhost:3306/api/v1" → "/api/v1"). */
function parsePath(raw, fallback = '/api/v1') {
  if (!raw) return fallback;
  try { return new URL(raw.trim().replace(/\/+$/, '')).pathname.replace(/\/$/, '') || fallback; }
  catch { return fallback; }
}

/** Extract one named cookie from a raw Cookie header string. */
function extractCookie(header, name) {
  if (!header) return null;
  const m = String(header).match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return m ? decodeURIComponent(m[1]) : null;
}

// ─── buildProxy ───────────────────────────────────────────────────────────────
/**
 * Bearer-auth transparent proxy.
 * Injects x-tenant-id always.
 * Injects x-user-* when authenticate() has already populated req.user.
 */
function buildProxy(target, basePath, serviceName, options = {}) {
  return createProxyMiddleware({
    target,
    changeOrigin: true,
    pathRewrite: (path) => `${basePath}${path}`,
    on: {
      proxyReq(proxyReq, req) {
        const { tenantId } = getRuntimeTenantFallback();
        const effectiveTenantId = String(req.headers['x-tenant-id'] || tenantId || '');
        if (!req.headers['x-tenant-id'] && tenantId) proxyReq.setHeader('x-tenant-id', tenantId);
        if (req.user) {
          proxyReq.setHeader('x-user-id',    req.user.id        ?? '');
          proxyReq.setHeader('x-user-role',  req.user.role      ?? '');
          proxyReq.setHeader('x-session-id', req.user.sessionId ?? '');
        }
        if (req.requestId) proxyReq.setHeader('x-request-id', req.requestId);

        const signatureHeaders = addGatewaySignatureHeaders({}, {
          method: req.method,
          path: `${basePath}${req.url || ''}`,
          tenantId: effectiveTenantId,
          requestId: req.requestId,
          secret: config.gateway?.hmacSecret,
        });
        if (signatureHeaders['X-Gateway-HMAC']) {
          proxyReq.setHeader('X-Gateway-HMAC', signatureHeaders['X-Gateway-HMAC']);
          proxyReq.setHeader('X-Gateway-Timestamp', signatureHeaders['X-Gateway-Timestamp']);
        }

        if (typeof options.onProxyReq === 'function') {
          options.onProxyReq(proxyReq, req);
        }
      },
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

// ─── buildPortalProxy ─────────────────────────────────────────────────────────
/**
 * Cookie-auth portal proxy for standalone product frontends.
 *
 * @param {string} cookieName  Session cookie name set by the product backend (e.g. "ja_session")
 * @param {string|null} target Protocol+host of the backend (e.g. "http://localhost:3306")
 * @param {string} serviceName Name used in log / error messages
 * @returns {express.Router}
 */
function buildPortalProxy(cookieName, target, serviceName) {
  const r = express.Router();

  // Rate limit — 300 req/min per IP in production; unlimited in dev
  r.use(rateLimit({
    windowMs: 60_000,
    max: 300,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, message: 'Too many requests. Please slow down.' },
    skip: () => process.env.NODE_ENV !== 'production',
  }));

  if (!target) {
    r.use(serviceUnavailable(serviceName));
    return r;
  }

  // ── PUBLIC: SSO token → session cookie exchange ──────────────────────────
  // The product frontend exchanges the short-lived IAM SSO token for an
  // httpOnly session cookie.  We use axios (not createProxyMiddleware) so we
  // can intercept Set-Cookie and re-set it against the gateway origin.
  r.post('/api/v1/auth/sso/exchange', express.json({ limit: '1mb' }), async (req, res, next) => {
    try {
      const response = await axios.post(
        `${target}/api/v1/auth/sso/exchange`,
        req.body ?? {},
        {
          headers: addGatewaySignatureHeaders({
            'Content-Type':   'application/json',
            'x-request-id':   req.requestId      ?? '',
            'x-forwarded-for': req.ip             ?? '',
          }, {
            method: 'POST',
            path: '/api/v1/auth/sso/exchange',
            tenantId: req.user?.tenantId || req.headers['x-tenant-id'] || '',
            requestId: req.requestId,
            secret: config.gateway?.hmacSecret,
          }),
          timeout: 15_000,
          validateStatus: () => true,
        },
      );
      const setCookies = response.headers['set-cookie'];
      if (setCookies) res.setHeader('Set-Cookie', setCookies);
      return res.status(response.status).json(response.data);
    } catch (err) { next(err); }
  });

  // ── AUTHENTICATED: validate session cookie ───────────────────────────────
  r.use((req, res, next) => {
    const token = extractCookie(req.headers.cookie ?? '', cookieName);
    if (!token) {
      return res.status(401).json({
        success: false,
        message: 'No active session. Please open the app from your EasyDev dashboard.',
      });
    }
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      req.user = {
        id:       decoded.sub,
        email:    decoded.email,
        role:     Array.isArray(decoded.roles) ? decoded.roles[0] : (decoded.role ?? ''),
        tenantId: decoded.tenantId ?? '',
      };
      req.headers['x-tenant-id'] = req.user.tenantId;
      next();
    } catch {
      return res.status(401).json({
        success: false,
        message: 'Session expired. Please re-open the app from your EasyDev dashboard.',
      });
    }
  });

  // ── Transparent stream proxy ─────────────────────────────────────────────
  // Raw body is preserved so multipart file uploads work correctly.
  // Only the session cookie is forwarded — all other browser cookies are stripped.
  r.use(createProxyMiddleware({
    target,
    changeOrigin: true,
    on: {
      proxyReq(proxyReq, req) {
        const sessionCookie = extractCookie(req.headers.cookie ?? '', cookieName);
        proxyReq.setHeader('cookie',         sessionCookie ? `${cookieName}=${sessionCookie}` : '');
        proxyReq.setHeader('x-tenant-id',    req.user?.tenantId ?? '');
        proxyReq.setHeader('x-user-id',      req.user?.id       ?? '');
        proxyReq.setHeader('x-user-role',    req.user?.role     ?? '');
        if (req.requestId) proxyReq.setHeader('x-request-id',   req.requestId);
        if (req.ip)        proxyReq.setHeader('x-forwarded-for', req.ip);

        const signatureHeaders = addGatewaySignatureHeaders({}, {
          method: req.method,
          path: req.url || '/',
          tenantId: req.user?.tenantId || '',
          requestId: req.requestId,
          secret: config.gateway?.hmacSecret,
        });
        if (signatureHeaders['X-Gateway-HMAC']) {
          proxyReq.setHeader('X-Gateway-HMAC', signatureHeaders['X-Gateway-HMAC']);
          proxyReq.setHeader('X-Gateway-Timestamp', signatureHeaders['X-Gateway-Timestamp']);
        }
      },
      error(err, _req, res) {
        logger.error(`${serviceName} portal proxy error:`, { message: err.message });
        if (!res.headersSent) {
          res.status(502).json({
            success: false,
            message: `${serviceName} is temporarily unavailable.`,
          });
        }
      },
    },
  }));

  return r;
}

// ─── IAM / Auth Service ───────────────────────────────────────────────────────
//  PUBLIC        → /auth, /iam/health
//  AUTHENTICATED → everything else
// ─────────────────────────────────────────────────────────────────────────────

if (config.auth.serviceUrl) {
  const iam = config.auth.serviceUrl;

  // Inject x-forwarded-base-url so IAM can derive OAuth callback URLs
  // dynamically from the gateway's public origin — no AUTH_PUBLIC_BASE_URL
  // env var needed in the IAM service when deployed behind this gateway.
  function injectForwardedBaseUrl(proxyReq, req) {
    const proto = req.headers['x-forwarded-proto'] || (req.secure ? 'https' : 'http');
    const host  = req.headers['x-forwarded-host']  || req.get('host') || 'localhost';
    proxyReq.setHeader('x-forwarded-base-url', `${proto}://${host}/api/auth`);
  }

  // Public
  router.use('/auth', createProxyMiddleware({
    target: iam,
    changeOrigin: true,
    pathRewrite: (path) => `/api/v1/iam/auth${path}`,
    on: {
      proxyReq(proxyReq, req) {
        const { tenantId } = getRuntimeTenantFallback();
        const effectiveTenantId = String(req.headers['x-tenant-id'] || tenantId || '');
        if (!req.headers['x-tenant-id'] && tenantId) proxyReq.setHeader('x-tenant-id', tenantId);
        if (req.requestId) proxyReq.setHeader('x-request-id', req.requestId);

        const signatureHeaders = addGatewaySignatureHeaders({}, {
          method: req.method,
          path: `/api/v1/iam/auth${req.url || ''}`,
          tenantId: effectiveTenantId,
          requestId: req.requestId,
          secret: config.gateway?.hmacSecret,
        });
        if (signatureHeaders['X-Gateway-HMAC']) {
          proxyReq.setHeader('X-Gateway-HMAC', signatureHeaders['X-Gateway-HMAC']);
          proxyReq.setHeader('X-Gateway-Timestamp', signatureHeaders['X-Gateway-Timestamp']);
        }

        injectForwardedBaseUrl(proxyReq, req);
      },
      error(err, _req, res) {
        logger.error('IAM proxy error:', { message: err.message });
        if (!res.headersSent) res.status(502).json({ success: false, message: 'IAM is currently unavailable.' });
      },
    },
  }));
  router.use('/iam/health',   buildProxy(iam, '/api/v1/iam/health', 'IAM'));

  // Authenticated
  router.use('/profile',       authenticate, buildProxy(iam, '/api/v1/iam/profile',       'IAM'));
  router.use('/rbac',          authenticate, buildProxy(iam, '/api/v1/iam/rbac',          'IAM'));
  router.use('/users',         authenticate, buildProxy(iam, '/api/v1/iam/users',         'IAM'));
  router.use('/customer/users',authenticate, buildProxy(iam, '/api/v1/iam/users',         'IAM'));
  router.use('/tenants',       authenticate, buildProxy(iam, '/api/v1/iam/tenants',       'IAM'));
  router.use('/sessions',      authenticate, buildProxy(iam, '/api/v1/iam/sessions',      'IAM'));
  router.use('/iam/logs',      authenticate, buildProxy(iam, '/api/v1/iam/logs',          'IAM'));
  router.use('/iam/stats',     authenticate, buildProxy(iam, '/api/v1/iam/stats',         'IAM'));
  router.use('/iam/security',  authenticate, buildProxy(iam, '/api/v1/iam/security',      'IAM'));
  router.use('/iam/api-keys',  authenticate, buildProxy(iam, '/api/v1/iam/api-keys',      'IAM'));
  router.use('/iam/webhooks',  authenticate, buildProxy(iam, '/api/v1/iam/webhooks',      'IAM'));
  router.use('/iam/flags',     authenticate, buildProxy(iam, '/api/v1/iam/feature-flags', 'IAM'));
  router.use('/iam/apps',      authenticate, buildProxy(iam, '/api/v1/iam/apps',          'IAM'));
  router.use('/iam/settings/public',          buildProxy(iam, '/api/v1/iam/settings/public', 'IAM')); // public — no auth
  router.use('/iam/settings',  authenticate, buildProxy(iam, '/api/v1/iam/settings',      'IAM'));
  router.use('/admin',         authenticate, buildProxy(iam, '/api/v1/iam/users',         'IAM')); // legacy
} else {
  for (const p of ['/auth', '/iam/health', '/profile', '/rbac', '/users', '/customer/users',
                   '/tenants', '/sessions', '/iam/logs', '/iam/stats', '/iam/security',
                   '/iam/api-keys', '/iam/webhooks', '/iam/flags', '/iam/apps', '/iam/settings/public', '/iam/settings', '/admin']) {
    router.use(p, serviceUnavailable('IAM'));
  }
}

// ─── File Upload Service ──────────────────────────────────────────────────────

if (config.fileUpload.serviceUrl) {
  if (!config.gateway?.hmacSecret) {
    logger.warn('FILE_UPLOAD_HMAC_SECRET is not configured; X-Gateway-HMAC will not be sent to downstream services.');
  }

  router.use('/files', buildProxy(config.fileUpload.serviceUrl, '/api/files', 'File Upload'));
} else {
  router.use('/files', serviceUnavailable('File Upload'));
}

// ─── AI Communication ─────────────────────────────────────────────────────────
//  /customer/*             — AUTHENTICATED Bearer  (dashboard)
//  /communication/admin/*  — AUTHENTICATED Bearer  (admin panel)
//  /portal/communication/* — cookie-auth portal    (AI Comm standalone frontend)
// ─────────────────────────────────────────────────────────────────────────────

const commTarget = config.communication?.proxyTarget ?? null;
const commPath   = config.communication?.proxyPath   ?? '/api/v1';

if (commTarget) {
  router.use('/customer',            authenticate, buildProxy(commTarget, commPath,                   'AI Communication'));
  router.use('/communication/admin', authenticate, buildProxy(commTarget, `${commPath}/admin`,        'AI Communication Admin'));
  router.use('/portal/communication',              buildPortalProxy('ea_comm_session', commTarget,    'AI Communication Portal'));
} else {
  router.use('/customer',            serviceUnavailable('AI Communication'));
  router.use('/communication/admin', serviceUnavailable('AI Communication'));
  router.use('/portal/communication',serviceUnavailable('AI Communication Portal'));
}

// ─── Job Agent Service ────────────────────────────────────────────────────────
//  /job-agent/proxy/*  — AUTHENTICATED Bearer  (dashboard)
//  /portal/job-agent/* — cookie-auth portal    (Job Agent standalone frontend)
// ─────────────────────────────────────────────────────────────────────────────

const jobTarget = parseHost(process.env.JOB_AGENT_URL || '');
const jobPath   = parsePath(process.env.JOB_AGENT_URL || '');

if (jobTarget) {
  router.use('/job-agent/proxy',  authenticate, buildProxy(jobTarget, jobPath,    'Job Agent'));
  router.use('/portal/job-agent',              buildPortalProxy('ja_session', jobTarget, 'Job Agent Portal'));
} else {
  router.use('/job-agent/proxy',  serviceUnavailable('Job Agent'));
  router.use('/portal/job-agent', serviceUnavailable('Job Agent Portal'));
}

export default router;
