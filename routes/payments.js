/**
 * routes/payments.js
 *
 * Payment adapter — delegates all gateway processing to payment-microservice.
 *
 * The public-facing API surface (URLs, request/response bodies) is preserved
 * so the easydev frontend requires zero changes.
 *
 * Checkout routes call payment-microservice with service-to-service API key
 * auth (no user JWT required for public checkout flows).
 *
 * Admin routes forward the caller's JWT to payment-microservice for full
 * RBAC enforcement.
 *
 * In-memory pending order store maps provider order/session ID → PM transaction
 * data needed for the verify step. For multi-instance deployments, replace the
 * Map with a Redis-backed TTL store.
 *
 * POST /api/payments/razorpay/create-order
 * POST /api/payments/razorpay/verify
 * POST /api/payments/stripe/create-session
 * GET  /api/payments/stripe/verify-session
 * POST /api/payments/webhooks/razorpay
 * POST /api/payments/webhooks/stripe
 * GET  /api/payments/admin/stats
 * GET  /api/payments/admin/transactions
 * GET  /api/payments/admin/subscriptions
 */

import express       from 'express';
import { randomUUID } from 'crypto';
import { config }    from '../config/index.js';
import logger        from '../utils/logger.js';
import { provision } from '../utils/productProvisioner.js';
import { AppError }  from '../utils/errors.js';
import { apiCall }   from '../lib/axiosCall.js';
import { authenticate, authorize } from '../middleware/auth.js';

const router = express.Router();

// ─── Plan price catalog ───────────────────────────────────────────────────────

/** Razorpay amounts in paise (INR smallest unit). */
const PLAN_PAISE = {
  starter:  199900,   // ₹1,999
  growth:   499900,   // ₹4,999
  business: 1299900,  // ₹12,999
};

/** Stripe amounts in cents (USD smallest unit). */
const PLAN_CENTS = {
  starter:  2700,   // $27
  growth:   6700,   // $67
  business: 17400,  // $174
};

// ─── Pending order store ──────────────────────────────────────────────────────
// Maps provider orderId / sessionId → { transactionId, attemptId, planKey, customerEmail }
// Entries expire after PENDING_TTL_MS to prevent unbounded growth.

const pendingOrders = new Map();
const PENDING_TTL_MS = 60 * 60 * 1000; // 1 hour

function storePending(key, value) {
  // Evict stale entries on every write (lazy GC)
  for (const [k, v] of pendingOrders.entries()) {
    if (v.expiresAt < Date.now()) pendingOrders.delete(k);
  }
  pendingOrders.set(key, { ...value, expiresAt: Date.now() + PENDING_TTL_MS });
}

function getPending(key) {
  const entry = pendingOrders.get(key);
  if (!entry) return null;
  if (entry.expiresAt < Date.now()) {
    pendingOrders.delete(key);
    return null;
  }
  return entry;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const pmUrl = () => config.payment?.serviceUrl || 'http://localhost:3000';

/** Service-to-service headers for payment-microservice (API key auth). */
function pmServiceHeaders(tenantId) {
  return {
    'x-api-key':    config.payment?.apiKey || '',
    'x-tenant-id':  tenantId || config.tenantId || 'easydev',
    'Content-Type': 'application/json',
  };
}

/** User JWT passthrough headers for admin calls to payment-microservice. */
function pmAuthHeaders(bearerToken, tenantId) {
  return {
    'Authorization': bearerToken || '',
    'x-tenant-id':   tenantId || config.tenantId || 'easydev',
    'Content-Type':  'application/json',
  };
}

function resolveProductId(body) {
  return body.productId || 'easydev-communication';
}

/** Shared post-payment provisioning: provision the product account and respond. */
async function handlePostPayment(res, { productId, name, email, planKey, paymentId, businessName, externalId }) {
  let provisionResult = null;
  try {
    provisionResult = await provision(productId, {
      name,
      email,
      planKey,
      paymentId,
      businessName: businessName || name,
      externalId,
    });
  } catch (err) {
    logger.error('Post-payment provisioning error (payment was successful)', {
      productId,
      email,
      error: err.message,
    });
    return res.status(200).json({
      success: true,
      message: 'Payment verified. Account setup encountered an issue — our team has been notified.',
      data: { paymentVerified: true, provisioningError: err.message },
    });
  }
  return res.status(200).json({
    success: true,
    message: 'Payment verified and account provisioned.',
    data: { paymentVerified: true, ...provisionResult },
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// RAZORPAY
// ─────────────────────────────────────────────────────────────────────────────

/**
 * POST /api/payments/razorpay/create-order
 *
 * Delegates to payment-microservice POST /api/v1/payments/initiate.
 * Body:    { planKey, customerEmail, productId?, amount? }
 * Returns: { orderId, amount, currency, keyId }
 */
router.post('/razorpay/create-order', async (req, res, next) => {
  try {
    if (!config.payment?.apiKey) {
      throw new AppError('Payment service is not configured on this server.', 503);
    }

    const { planKey, customerEmail, amount: rawAmount } = req.body;
    if (!planKey || !customerEmail) {
      throw new AppError('planKey and customerEmail are required.', 400);
    }

    const amount   = rawAmount ?? PLAN_PAISE[planKey?.toLowerCase()] ?? 499900;
    const orderId  = randomUUID();
    const idempKey = randomUUID();
    const tenantId = req.headers['x-tenant-id'] || config.tenantId || 'easydev';

    const result = await apiCall(
      `${pmUrl()}/api/v1/payments/initiate`,
      {
        method: 'POST',
        data: {
          orderId,
          idempotencyKey: idempKey,
          amount,
          currency: 'INR',
          providers: ['RAZORPAY'],
          metadata: { planKey, customerEmail, source: 'web-agency-checkout' },
        },
        headers: pmServiceHeaders(tenantId),
      },
    );

    if (result.error) {
      logger.error('payment-microservice Razorpay initiate failed', { status: result.status, msg: result.message });
      throw new AppError(result.data?.message || 'Failed to create payment order.', result.status || 502);
    }

    const pmData   = result.data?.data ?? result.data;
    const rzOption = Array.isArray(pmData.options) ? pmData.options.find(o => o.provider === 'RAZORPAY') : null;

    if (!rzOption?.orderId) {
      throw new AppError('Payment service did not return a Razorpay order.', 502);
    }

    // Store mapping so the verify step can look up transactionId + attemptId
    storePending(rzOption.orderId, {
      transactionId: pmData.transactionId,
      attemptId:     rzOption.attemptId,
      planKey,
      customerEmail,
    });

    return res.status(201).json({
      success: true,
      message: 'Razorpay order created.',
      data: {
        orderId:  rzOption.orderId,
        amount,
        currency: 'INR',
        keyId:    config.razorpay?.keyId,
      },
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/payments/razorpay/verify
 *
 * Delegates to payment-microservice POST /api/v1/payments/:transactionId/verify.
 * Body:    { orderId, paymentId, signature, planKey, name, email, productId?, businessName?, externalId? }
 * Returns: { paymentVerified, loginUrl?, ... }
 */
router.post('/razorpay/verify', async (req, res, next) => {
  try {
    if (!config.payment?.apiKey) {
      throw new AppError('Payment service is not configured on this server.', 503);
    }

    const { orderId, paymentId, signature, planKey, name, email, businessName, externalId } = req.body;

    if (!orderId || !paymentId || !signature || !email) {
      throw new AppError('orderId, paymentId, signature, and email are required.', 400);
    }

    const pending = getPending(orderId);
    if (!pending) {
      throw new AppError('Payment order not found or has expired. Please restart the checkout.', 404);
    }

    const { transactionId, attemptId } = pending;
    const tenantId = req.headers['x-tenant-id'] || config.tenantId || 'easydev';

    const result = await apiCall(
      `${pmUrl()}/api/v1/payments/${transactionId}/verify`,
      {
        method: 'POST',
        data: { attemptId, providerPaymentId: paymentId, providerSignature: signature },
        headers: pmServiceHeaders(tenantId),
      },
    );

    if (result.error) {
      logger.error('payment-microservice Razorpay verify failed', { transactionId, status: result.status });
      throw new AppError(result.data?.message || 'Payment verification failed.', result.status || 502);
    }

    pendingOrders.delete(orderId);

    const productId = resolveProductId(req.body);
    return handlePostPayment(res, {
      productId,
      name,
      email,
      planKey:      planKey || pending.planKey,
      paymentId,
      businessName,
      externalId,
    });
  } catch (err) {
    next(err);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// STRIPE
// ─────────────────────────────────────────────────────────────────────────────

/**
 * POST /api/payments/stripe/create-session
 *
 * Delegates to payment-microservice with Stripe Checkout Session mode.
 * Body:    { planKey, customerEmail, successUrl, cancelUrl, productId? }
 * Returns: { sessionId, sessionUrl }
 */
router.post('/stripe/create-session', async (req, res, next) => {
  try {
    if (!config.payment?.apiKey) {
      throw new AppError('Payment service is not configured on this server.', 503);
    }

    const { planKey, customerEmail, successUrl, cancelUrl } = req.body;
    if (!planKey || !customerEmail || !successUrl || !cancelUrl) {
      throw new AppError('planKey, customerEmail, successUrl, and cancelUrl are required.', 400);
    }

    const price = PLAN_CENTS[planKey?.toLowerCase()];
    if (!price) throw new AppError(`Invalid plan key: ${planKey}`, 400);

    const orderId  = randomUUID();
    const idempKey = randomUUID();
    const tenantId = req.headers['x-tenant-id'] || config.tenantId || 'easydev';

    const result = await apiCall(
      `${pmUrl()}/api/v1/payments/initiate`,
      {
        method: 'POST',
        data: {
          orderId,
          idempotencyKey: idempKey,
          amount: price,
          currency: 'USD',
          providers: ['STRIPE'],
          metadata: {
            checkoutMode: true,
            successUrl,
            cancelUrl,
            customerEmail,
            productName: `EasyDev ${planKey.charAt(0).toUpperCase() + planKey.slice(1)} Plan`,
            planKey,
            source: 'web-agency-checkout',
          },
        },
        headers: pmServiceHeaders(tenantId),
      },
    );

    if (result.error) {
      logger.error('payment-microservice Stripe initiate failed', { status: result.status, msg: result.message });
      throw new AppError(result.data?.message || 'Failed to create Stripe session.', result.status || 502);
    }

    const pmData       = result.data?.data ?? result.data;
    const stripeOption = Array.isArray(pmData.options) ? pmData.options.find(o => o.provider === 'STRIPE') : null;

    if (!stripeOption?.sessionUrl) {
      throw new AppError('Payment service did not return a Stripe session URL.', 502);
    }

    // stripeOption.orderId is the Stripe session ID (cs_...)
    storePending(stripeOption.orderId, {
      transactionId: pmData.transactionId,
      attemptId:     stripeOption.attemptId,
      planKey,
      customerEmail,
    });

    return res.status(201).json({
      success: true,
      message: 'Stripe checkout session created.',
      data: { sessionId: stripeOption.orderId, sessionUrl: stripeOption.sessionUrl },
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/payments/stripe/verify-session?sessionId=cs_xxx&planKey=growth&name=...&email=...
 *
 * Called after Stripe redirects back to the success URL.
 * Delegates verification to payment-microservice then provisions the product.
 */
router.get('/stripe/verify-session', async (req, res, next) => {
  try {
    if (!config.payment?.apiKey) {
      throw new AppError('Payment service is not configured on this server.', 503);
    }

    const { sessionId, planKey, name, email, businessName, externalId, productId: qProductId } = req.query;
    if (!sessionId || !email) throw new AppError('sessionId and email are required.', 400);

    const pending = getPending(sessionId);
    if (!pending) {
      throw new AppError('Session not found or has expired. Please restart the checkout.', 404);
    }

    const { transactionId, attemptId } = pending;
    const tenantId = req.headers['x-tenant-id'] || config.tenantId || 'easydev';

    const result = await apiCall(
      `${pmUrl()}/api/v1/payments/${transactionId}/verify`,
      {
        method: 'POST',
        data: { attemptId, providerPaymentId: sessionId },
        headers: pmServiceHeaders(tenantId),
      },
    );

    if (result.error) {
      logger.error('payment-microservice Stripe verify failed', { transactionId, status: result.status });
      throw new AppError(result.data?.message || 'Failed to verify Stripe session.', result.status || 502);
    }

    pendingOrders.delete(sessionId);

    return handlePostPayment(res, {
      productId:    qProductId || resolveProductId({}),
      name:         name || email,
      email:        String(email),
      planKey:      planKey || pending.planKey || 'growth',
      paymentId:    String(sessionId),
      businessName: businessName,
      externalId:   externalId,
    });
  } catch (err) {
    next(err);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// WEBHOOKS — raw body forwarded to payment-microservice
// HMAC verification is owned by payment-microservice; no re-verification here.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * POST /api/payments/webhooks/razorpay
 * Forwards the signed raw payload to payment-microservice for verification + processing.
 */
router.post('/webhooks/razorpay', express.raw({ type: 'application/json' }), async (req, res) => {
  if (!config.payment?.serviceUrl) {
    logger.warn('Razorpay webhook received but PAYMENT_SERVICE_URL not set — ignoring');
    return res.sendStatus(200);
  }

  try {
    await fetch(`${pmUrl()}/api/v1/webhooks/razorpay`, {
      method:  'POST',
      headers: {
        'content-type':         'application/json',
        'x-razorpay-signature': req.headers['x-razorpay-signature'] || '',
      },
      body:   req.body,
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    logger.error('Razorpay webhook forwarding error', { error: err.message });
  }

  res.sendStatus(200);
});

/**
 * POST /api/payments/webhooks/stripe
 * Forwards the signed raw payload to payment-microservice for verification + processing.
 */
router.post('/webhooks/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
  if (!config.payment?.serviceUrl) {
    logger.warn('Stripe webhook received but PAYMENT_SERVICE_URL not set — ignoring');
    return res.sendStatus(200);
  }

  try {
    await fetch(`${pmUrl()}/api/v1/webhooks/stripe`, {
      method:  'POST',
      headers: {
        'content-type':    'application/json',
        'stripe-signature': req.headers['stripe-signature'] || '',
      },
      body:   req.body,
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    logger.error('Stripe webhook forwarding error', { error: err.message });
  }

  res.sendStatus(200);
});

// ─────────────────────────────────────────────────────────────────────────────
// ADMIN — authenticated staff only
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /api/payments/admin/stats
 *
 * Revenue, transaction counts, subscription and refund totals.
 * Proxied from payment-microservice GET /api/v1/admin/dashboard.
 */
router.get(
  '/admin/stats',
  authenticate,
  authorize('admin', 'super_admin', 'finance', 'support'),
  async (req, res, next) => {
    try {
      if (!config.payment?.serviceUrl) throw new AppError('Payment service is not configured.', 503);

      const result = await apiCall(
        `${pmUrl()}/api/v1/admin/dashboard`,
        { method: 'GET', headers: pmAuthHeaders(req.headers['authorization'], req.headers['x-tenant-id']) },
      );

      if (result.error) {
        logger.error('payment admin stats failed', { status: result.status });
        throw new AppError(result.data?.message || 'Failed to fetch payment statistics.', result.status || 502);
      }

      return res.status(200).json({
        success: true,
        message: 'Payment statistics retrieved.',
        data: result.data?.data ?? result.data,
      });
    } catch (err) {
      next(err);
    }
  },
);

/**
 * GET /api/payments/admin/transactions
 *
 * Paginated transaction list.
 * Supports: ?page, ?limit, ?status, ?customerId, ?currency
 */
router.get(
  '/admin/transactions',
  authenticate,
  authorize('admin', 'super_admin', 'finance', 'support'),
  async (req, res, next) => {
    try {
      if (!config.payment?.serviceUrl) throw new AppError('Payment service is not configured.', 503);

      const qs     = new URLSearchParams(req.query).toString();
      const result = await apiCall(
        `${pmUrl()}/api/v1/admin/transactions${qs ? `?${qs}` : ''}`,
        { method: 'GET', headers: pmAuthHeaders(req.headers['authorization'], req.headers['x-tenant-id']) },
      );

      if (result.error) {
        logger.error('payment admin transactions failed', { status: result.status });
        throw new AppError(result.data?.message || 'Failed to fetch transactions.', result.status || 502);
      }

      return res.status(200).json({
        success: true,
        message: 'Transactions retrieved.',
        data: result.data?.data ?? result.data,
      });
    } catch (err) {
      next(err);
    }
  },
);

/**
 * GET /api/payments/admin/subscriptions
 *
 * Paginated subscription list from payment-microservice.
 */
router.get(
  '/admin/subscriptions',
  authenticate,
  authorize('admin', 'super_admin', 'finance', 'support'),
  async (req, res, next) => {
    try {
      if (!config.payment?.serviceUrl) throw new AppError('Payment service is not configured.', 503);

      const qs     = new URLSearchParams(req.query).toString();
      const result = await apiCall(
        `${pmUrl()}/api/v1/admin/subscriptions${qs ? `?${qs}` : ''}`,
        { method: 'GET', headers: pmAuthHeaders(req.headers['authorization'], req.headers['x-tenant-id']) },
      );

      if (result.error) {
        logger.error('payment admin subscriptions failed', { status: result.status });
        throw new AppError(result.data?.message || 'Failed to fetch subscriptions.', result.status || 502);
      }

      return res.status(200).json({
        success: true,
        message: 'Subscriptions retrieved.',
        data: result.data?.data ?? result.data,
      });
    } catch (err) {
      next(err);
    }
  },
);

export default router;
