import express from 'express';
import { createProxyMiddleware } from 'http-proxy-middleware';
import { config } from '../config/index.js';
import { apiCall } from '../lib/axiosCall.js';
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

const CUSTOMER_CHANNEL_TYPE_MAP = {
  email: 'email_smtp',
  whatsapp: 'whatsapp_meta',
};

function customerChannelUrl(path = '') {
  const normalizedBasePath = communicationProxyPath.endsWith('/')
    ? communicationProxyPath.slice(0, -1)
    : communicationProxyPath;
  return `${communicationProxyTarget}${normalizedBasePath}${path}`;
}

function customerProxyHeaders(req) {
  return {
    ...(req.headers.authorization ? { Authorization: req.headers.authorization } : {}),
  };
}

function normalizeCustomerChannel(channel) {
  const type = String(channel.channelType || '').startsWith('whatsapp') ? 'whatsapp' : 'email';

  return {
    id: channel.id,
    type,
    identifier: channel.identifier ?? channel.metadata?.identifier ?? '',
    displayName: channel.displayName,
    status: channel.isActive ? 'active' : 'inactive',
    connectedAt: channel.createdAt,
    ...(typeof channel.messageCount === 'number' ? { messageCount: channel.messageCount } : {}),
  };
}

function buildCustomerChannelPayload(body) {
  const type = typeof body?.type === 'string' ? body.type.trim().toLowerCase() : '';
  const identifier = typeof body?.identifier === 'string' ? body.identifier.trim() : '';
  const displayName = typeof body?.displayName === 'string' ? body.displayName.trim() : '';

  if (!CUSTOMER_CHANNEL_TYPE_MAP[type]) {
    return { error: 'type must be one of: email, whatsapp' };
  }
  if (!identifier) {
    return { error: 'identifier is required' };
  }
  if (!displayName) {
    return { error: 'displayName is required' };
  }

  return {
    channelType: CUSTOMER_CHANNEL_TYPE_MAP[type],
    identifier,
    displayName,
    credentials: {
      placeholder: true,
      identifier,
      source: 'customer-dashboard',
    },
  };
}

// ---------------------------------------------------------------------------
// Auth Service  (/api/auth/**, /api/admin/**)
// ---------------------------------------------------------------------------

if (config.auth.serviceUrl) {
  // IAM global prefix is api/v1/iam — rewrite paths accordingly
  router.use('/auth',               buildProxy(config.auth.serviceUrl, '/api/v1/iam/auth',          'User Auth Service'));
  router.use('/rbac',               buildProxy(config.auth.serviceUrl, '/api/v1/iam/rbac',          'User Auth Service'));
  router.use('/users',              buildProxy(config.auth.serviceUrl, '/api/v1/iam/users',         'User Auth Service'));
  router.use('/tenants',            buildProxy(config.auth.serviceUrl, '/api/v1/iam/tenants',       'User Auth Service'));
  router.use('/sessions',           buildProxy(config.auth.serviceUrl, '/api/v1/iam/sessions',      'User Auth Service'));
  router.use('/iam/health',         buildProxy(config.auth.serviceUrl, '/api/v1/iam/health',        'User Auth Service'));
  router.use('/iam/logs',           buildProxy(config.auth.serviceUrl, '/api/v1/iam/logs',          'User Auth Service'));
  router.use('/iam/stats',          buildProxy(config.auth.serviceUrl, '/api/v1/iam/stats',         'User Auth Service'));
  router.use('/iam/security',       buildProxy(config.auth.serviceUrl, '/api/v1/iam/security',      'User Auth Service'));
  router.use('/iam/api-keys',       buildProxy(config.auth.serviceUrl, '/api/v1/iam/api-keys',      'User Auth Service'));
  router.use('/iam/webhooks',       buildProxy(config.auth.serviceUrl, '/api/v1/iam/webhooks',      'User Auth Service'));
  router.use('/iam/flags',          buildProxy(config.auth.serviceUrl, '/api/v1/iam/feature-flags', 'User Auth Service'));
  router.use('/iam/apps',           buildProxy(config.auth.serviceUrl, '/api/v1/iam/apps',          'User Auth Service'));
  router.use('/iam/settings',       buildProxy(config.auth.serviceUrl, '/api/v1/iam/settings',      'User Auth Service'));
  // Legacy /admin path kept for backward-compatibility but no longer used — remove once all clients updated
  router.use('/admin',              buildProxy(config.auth.serviceUrl, '/api/v1/iam/users',         'User Auth Service'));
} else {
  for (const path of ['/auth', '/rbac', '/users', '/tenants', '/sessions',
                       '/iam/health', '/iam/logs', '/iam/stats', '/iam/security', '/iam/api-keys',
                       '/iam/webhooks', '/iam/flags', '/iam/apps', '/iam/settings', '/admin']) {
    router.use(path, serviceUnavailable('User Auth Service'));
  }
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

const communicationProxyTarget = config.communication?.proxyTarget ?? null;
const communicationProxyPath   = config.communication?.proxyPath   ?? '/api/v1';

if (communicationProxyTarget) {
  router.get('/customer/channels', async (req, res) => {
    const response = await apiCall(customerChannelUrl('/channels'), {
      method: 'GET',
      headers: customerProxyHeaders(req),
    });

    if (response.error) {
      return res.status(response.status ?? 502).json(response.data ?? {
        success: false,
        message: 'Failed to fetch customer channels.',
      });
    }

    const channels = Array.isArray(response.data)
      ? response.data
        .filter((channel) => channel.identifier ?? channel.metadata?.identifier)
        .map(normalizeCustomerChannel)
      : [];

    return res.json(channels);
  });

  router.post('/customer/channels', async (req, res) => {
    const payload = buildCustomerChannelPayload(req.body);
    if (payload.error) {
      return res.status(400).json({
        success: false,
        message: payload.error,
      });
    }

    const response = await apiCall(customerChannelUrl('/channels'), {
      method: 'POST',
      headers: customerProxyHeaders(req),
      data: payload,
    });

    if (response.error) {
      return res.status(response.status ?? 502).json(response.data ?? {
        success: false,
        message: 'Failed to add customer channel.',
      });
    }

    return res.status(response.status ?? 201).json(normalizeCustomerChannel(response.data));
  });

  router.delete('/customer/channels/:id', async (req, res) => {
    const response = await apiCall(customerChannelUrl(`/channels/${req.params.id}`), {
      method: 'DELETE',
      headers: customerProxyHeaders(req),
    });

    if (response.error) {
      return res.status(response.status ?? 502).json(response.data ?? {
        success: false,
        message: 'Failed to delete customer channel.',
      });
    }

    return res.status(response.status ?? 204).end();
  });

  router.use('/customer', buildProxy(communicationProxyTarget, communicationProxyPath, 'AI Communication'));
} else {
  router.use('/customer', serviceUnavailable('AI Communication'));
}

export default router;
