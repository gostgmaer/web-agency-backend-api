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
 *     x-user-email, x-user-name (if present), x-session-id, x-request-id
 *     from the verified JWT payload.
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
 *     /files/*                  → File Upload /api/files/* (Bearer + x-api-key injected by gateway)
 *     /comm/customer/users/*    → IAM /api/v1/iam/users/* (team management)
 *     /comm/customer/*          → AI Communication /api/v1/*
 *     /comm/admin/*             → AI Communication /api/v1/admin/*
 *     /job-agent/proxy/*        → Job Agent /api/v1/*
 *     /ai-workflow/*            → AI Workflow Agent /v1/* (HMAC signed)
 *
 *   PUBLIC (no Bearer — OAuth provider redirects)
 *     /comm/email-accounts/oauth/* → AI Communication /api/v1/email-accounts/oauth/*
 *
 *   PORTAL (cookie-auth, raw stream — product frontends)
 *     /comm/portal/*            → AI Communication (ea_comm_session cookie)
 *     /job-agent/portal/*       → Job Agent        (ja_session cookie)
 */

import express                  from 'express';
import { createProxyMiddleware } from 'http-proxy-middleware';
import jwt                       from 'jsonwebtoken';
import rateLimit                 from 'express-rate-limit';
import axios                     from 'axios';
import { JWT_SECRET, PORTAL_SESSION_SECRET, JWT_ALGORITHM, JWT_ISSUER, JWT_AUDIENCE, PORTAL_SESSION_ALGORITHM } from '../config/jwt.js';
import { config }                  from '../config/index.js';
import logger                    from '../utils/logger.js';
import { RedisRateLimitStore }   from '../utils/redisRateLimitStore.js';
import { getRuntimeTenantFallback } from '../utils/tenantFallback.js';
import { authenticate }          from '../middleware/auth.js';
import { addGatewaySignatureHeaders, createFileServiceHmac } from '../utils/gatewayHmac.js';
import { signAiWorkflowRequest }               from '../utils/aiWorkflowSigning.js';

const router = express.Router();

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Optional authenticate — validates Bearer token if present, passes through if absent.
 * Used on routes that serve both public and authenticated callers (e.g. file uploads
 * from the public contact form AND authenticated dashboard file management).
 */
const optionalAuthenticate = (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    delete req.headers['x-tenant-id'];
    delete req.headers['x-tenant-slug'];
    return next();
  }
  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, JWT_SECRET, {
      issuer: JWT_ISSUER,
      audience: JWT_AUDIENCE,
      algorithms: [JWT_ALGORITHM],
    });
    const roleFromArray = Array.isArray(decoded.roles) ? decoded.roles[0] : undefined;
    req.user = {
      id: decoded.sub,
      email: decoded.email,
      role: decoded.role ?? roleFromArray,
      tenantId: decoded.tenantId,
      tenantDisplayId: typeof decoded.tenantSlug === 'string' ? decoded.tenantSlug.trim() : undefined,
      sessionId: decoded.sessionId,
    };
    req.headers['x-tenant-id'] = decoded.tenantId;
    req.headers['x-tenant-slug'] = decoded.tenantSlug;
  } catch (err) {
    logger.debug(`Optional auth token validation failed: ${err.message}`);
    delete req.headers['x-tenant-id'];
    delete req.headers['x-tenant-slug'];
  }
  next();
};

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
          proxyReq.setHeader('x-user-email', req.user.email     ?? '');
          if (req.user.name) proxyReq.setHeader('x-user-name', req.user.name);
          proxyReq.setHeader('x-session-id', req.user.sessionId ?? '');
        }
        if (req.requestId) proxyReq.setHeader('x-request-id', req.requestId);

        // Sign the ACTUAL outgoing path. http-proxy-middleware has already applied
        // pathRewrite (req.url now holds the rewritten downstream path), so
        // `${basePath}${req.url}` would DOUBLE the prefix and break the downstream
        // GatewayHmacGuard (which verifies over its own req.url). proxyReq.path is
        // the canonical outgoing path the downstream service receives.
        const signatureHeaders = addGatewaySignatureHeaders({}, {
          method: req.method,
          path: proxyReq.path || `${basePath}${req.url || ''}`,
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
      proxyRes(proxyRes, _req, res) {
        res.setHeader(
          'Access-Control-Expose-Headers',
          [
            'X-Request-ID',
            'x-request-id',
            'request-id',
            'x-rtb-fingerprint-id',
            'X-Gateway-HMAC',
            'X-Gateway-Timestamp',
          ].join(', '),
        );
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
    store: new RedisRateLimitStore(60_000),
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
      // The signed tenantId/requestId must also be sent as headers so any
      // downstream GatewayHmacGuard reconstructs the same payload.
      const exchangeTenantId = req.user?.tenantId || req.headers['x-tenant-id'] || '';
      const response = await axios.post(
        `${target}/api/v1/auth/sso/exchange`,
        req.body ?? {},
        {
          headers: addGatewaySignatureHeaders({
            'Content-Type':   'application/json',
            'x-tenant-id':    exchangeTenantId,
            'x-request-id':   req.requestId      ?? '',
            'x-forwarded-for': req.ip             ?? '',
          }, {
            method: 'POST',
            path: '/api/v1/auth/sso/exchange',
            tenantId: exchangeTenantId,
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
      const decoded = jwt.verify(token, PORTAL_SESSION_SECRET, { algorithms: [PORTAL_SESSION_ALGORITHM] });
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
        proxyReq.setHeader('x-user-email',   req.user?.email    ?? '');
        if (req.user?.name) proxyReq.setHeader('x-user-name', req.user.name);
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
          // proxyReq.path is the rewritten outgoing path; avoid double-prefixing
          // (req.url is already rewritten by http-proxy-middleware at this point).
          path: proxyReq.path || `/api/v1/iam/auth${req.url || ''}`,
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

  router.use('/files', optionalAuthenticate, buildProxy(config.fileUpload.serviceUrl, '/api/files', 'File Upload', {
    onProxyReq(proxyReq, req) {
      // Resolve effective user identity (authenticated or anonymous public caller).
      const userId    = req.user?.id    || 'anonymous';
      const userEmail = req.user?.email || '';
      const userRole  = req.user?.role  || 'anonymous';

      // Inject identity headers — file service reads these from x-user-* (set by tenantMiddleware).
      proxyReq.setHeader('x-user-id',    userId);
      proxyReq.setHeader('x-user-role',  userRole);
      proxyReq.setHeader('x-user-email', userEmail);

      // Override HMAC with the format the file service expects: userId:userEmail:userRole
      // (file-upload-service/src/middleware/rbac.js verifyGatewaySignature)
      const hmac = createFileServiceHmac({
        userId,
        userEmail,
        userRole,
        secret: config.fileUpload?.gatewayHmacSecret,
      });
      if (hmac) proxyReq.setHeader('X-Gateway-HMAC', hmac);

      // Strip headers the file service does not need.
      proxyReq.removeHeader('x-user-name');
      proxyReq.removeHeader('x-session-id');
      proxyReq.removeHeader('x-request-id');
      proxyReq.removeHeader('authorization');
      proxyReq.removeHeader('x-gateway-timestamp');
    },
  }));
} else {
  router.use('/files', serviceUnavailable('File Upload'));
}

// ─── AI Communication ─────────────────────────────────────────────────────────
//  All routes share the /comm prefix:
//  /comm/email-accounts/oauth/* — PUBLIC (OAuth redirect, no Bearer)
//  /comm/admin/*                — AUTHENTICATED Bearer  (admin panel)
//  /comm/portal/*               — cookie-auth portal    (AI Comm standalone frontend)
//  /comm/customer/users/*       — AUTHENTICATED Bearer  (team management → IAM)
//  /comm/customer/*             — AUTHENTICATED Bearer  (EasyDev dashboard → AI Comm)
//  Adding a new route: router.use('/comm/something', authenticate, commProxy('/something'))
// ─────────────────────────────────────────────────────────────────────────────

const commTarget = config.communication?.proxyTarget ?? null;
const commPath   = config.communication?.proxyPath   ?? '/api/v1';

// Returns a proxy to the AI Comm backend at the given sub-path, or a 503
// middleware when the service is not configured — no if/else at each route.
const commProxy       = (subPath = '', label = 'AI Communication') =>
  commTarget
    ? buildProxy(commTarget, `${commPath}${subPath}`, label)
    : serviceUnavailable(label);

const commPortalProxy = () =>
  commTarget
    ? buildPortalProxy('ea_comm_session', commTarget, 'AI Communication Portal')
    : serviceUnavailable('AI Communication Portal');

// Specific sub-paths registered BEFORE the broader /comm/customer catch-all.
router.use('/comm/email-accounts/oauth', commProxy('/email-accounts/oauth', 'AI Communication OAuth'));
router.use('/comm/admin',          authenticate, commProxy('/admin', 'AI Communication Admin'));
router.use('/comm/portal',                       commPortalProxy());
// Team management → IAM (must sit before the /comm/customer catch-all).
router.use('/comm/customer/users', authenticate,
  config.auth.serviceUrl
    ? buildProxy(config.auth.serviceUrl, '/api/v1/iam/users', 'IAM')
    : serviceUnavailable('IAM'));
router.use('/comm/customer',       authenticate, commProxy());

// ─── Job Agent Service ────────────────────────────────────────────────────────
//  All routes share the /job-agent prefix:
//  /job-agent/portal/*  — cookie-auth portal    (Job Agent standalone frontend)
//  /job-agent/proxy/*   — AUTHENTICATED Bearer  (EasyDev dashboard → Job Agent)
//  Adding a new route: router.use('/job-agent/something', authenticate, jobProxy('/something'))
// ─────────────────────────────────────────────────────────────────────────────

const jobTarget = parseHost(process.env.JOB_AGENT_URL || '');
const jobPath   = parsePath(process.env.JOB_AGENT_URL || '');

const jobProxy       = (subPath = '', label = 'Job Agent') =>
  jobTarget
    ? buildProxy(jobTarget, `${jobPath}${subPath}`, label)
    : serviceUnavailable(label);

const jobPortalProxy = () =>
  jobTarget
    ? buildPortalProxy('ja_session', jobTarget, 'Job Agent Portal')
    : serviceUnavailable('Job Agent Portal');

router.use('/job-agent/portal', jobPortalProxy());
router.use('/job-agent/proxy',  authenticate, jobProxy());

// ─── AI Workflow Agent ─────────────────────────────────────────────────────
//  Authenticated Bearer proxy with HMAC-SHA256 request signing.
//  The AI agent requires x-signature-key-version, x-signature-timestamp,
//  and x-signature headers computed over METHOD\nPATH\nTIMESTAMP\nSHA256(BODY).
//  All routes share the /ai-workflow prefix:
//  /ai-workflow/v1/analytics/*  — AUTHENTICATED Bearer (EasyDev dashboard → AI agent)
// ─────────────────────────────────────────────────────────────────────────────

const aiWorkflowTarget = parseHost(config.aiWorkflow?.serviceUrl || '');
const aiWorkflowPath   = parsePath(config.aiWorkflow?.serviceUrl || '', '');
const aiWorkflowSecret = config.aiWorkflow?.signingSecret || '';

if (aiWorkflowTarget && aiWorkflowSecret) {
  const aiWorkflowProxy = createProxyMiddleware({
    target: aiWorkflowTarget,
    changeOrigin: true,
    pathRewrite: (path) => `${aiWorkflowPath}${path}`,
    on: {
      proxyReq(proxyReq, req) {
        const { tenantId } = getRuntimeTenantFallback();
        const effectiveTenantId = String(req.headers['x-tenant-id'] || req.user?.tenantId || tenantId || '');

        // Inject tenant and principal headers required by the AI agent.
        proxyReq.setHeader('x-tenant-id', effectiveTenantId);
        if (req.user) {
          proxyReq.setHeader('x-principal-id', req.user.id ?? '');
          // Map gateway role to AI agent roles (admin, operator, viewer).
          const role = String(req.user.role || 'viewer').toLowerCase();
          const aiRole = ['admin', 'operator', 'viewer'].includes(role) ? role : 'viewer';
          proxyReq.setHeader('x-principal-roles', aiRole);
        }
        if (req.requestId) proxyReq.setHeader('x-trace-id', req.requestId);

        // Compute HMAC-SHA256 signature over the downstream request PATH ONLY.
        // The AI agent verifies using Starlette scope["path"], which EXCLUDES the
        // query string — so the signed path must have the query stripped.
        // proxyReq.path is the actual rewritten target path (http-proxy-middleware
        // already applied pathRewrite to req.url by this point).
        const downstreamPath = String(proxyReq.path || `${aiWorkflowPath}${req.url || ''}`).split('?')[0];
        const signingHeaders = signAiWorkflowRequest({
          method: req.method,
          path: downstreamPath,
          body: '',   // analytics endpoints are GET-only; body is empty
          secret: aiWorkflowSecret,
        });
        if (signingHeaders) {
          proxyReq.setHeader('x-signature-key-version', signingHeaders['x-signature-key-version']);
          proxyReq.setHeader('x-signature-timestamp',   signingHeaders['x-signature-timestamp']);
          proxyReq.setHeader('x-signature',             signingHeaders['x-signature']);
        }

        // Strip the browser Authorization header — the AI agent uses signing, not Bearer.
        proxyReq.removeHeader('authorization');
      },
      error(err, _req, res) {
        logger.error('AI Workflow proxy error:', { message: err.message });
        if (!res.headersSent) {
          res.status(502).json({
            success: false,
            message: 'AI Workflow service is currently unavailable. Please try again later.',
          });
        }
      },
    },
  });

  router.use('/ai-workflow', authenticate, aiWorkflowProxy);
} else {
  if (!aiWorkflowTarget) {
    logger.info('AI_WORKFLOW_URL not configured — /ai-workflow routes will return 503');
  } else if (!aiWorkflowSecret) {
    logger.warn('AI_WORKFLOW_SIGNING_SECRET not configured — /ai-workflow routes will return 503');
  }
  router.use('/ai-workflow', serviceUnavailable('AI Workflow'));
}

export default router;
