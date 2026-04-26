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
 * POST /api/payments/initiate
 * POST /api/payments/verify
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
  if (!body.productId) {
    throw new AppError('productId is required. Pass the product you are purchasing.', 400);
  }
  return body.productId;
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
    // 409 = already purchased — surface this directly to the UI so the user
    // sees a clear message instead of a generic "payment successful" screen.
    if (err.statusCode === 409 || err.status === 409) {
      return res.status(409).json({
        success: false,
        message: err.message,
        data: { paymentVerified: true },
      });
    }
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
// CHECKOUT — unified initiate + verify
// ─────────────────────────────────────────────────────────────────────────────

/**
 * POST /api/payments/initiate
 *
 * Starts a payment with any enabled provider.
 * Body:    { provider, planKey, customerEmail, successUrl?, cancelUrl? }
 *          provider    — 'RAZORPAY' | 'STRIPE' | 'CASH' (value from GET /methods)
 *          successUrl  — required for STRIPE only
 *          cancelUrl   — required for STRIPE only
 * Returns: provider-specific data:
 *          RAZORPAY → { provider, orderId, amount, currency, keyId }
 *          STRIPE   → { provider, sessionId, sessionUrl }
 *          CASH     → { provider, referenceCode, transactionId, attemptId, amount, currency }
 */
router.post('/initiate', async (req, res, next) => {
  try {
    if (!config.payment?.apiKey) {
      throw new AppError('Payment service is not configured on this server.', 503);
    }

    const { provider, planKey, customerEmail, successUrl, cancelUrl } = req.body;
    if (!provider || !planKey || !customerEmail) {
      throw new AppError('provider, planKey, and customerEmail are required.', 400);
    }

    const p        = provider.toUpperCase();
    const orderId  = randomUUID();
    const idempKey = randomUUID();
    const tenantId = req.headers['x-tenant-id'] || config.tenantId || 'easydev';

    // ── STRIPE ──
    if (p === 'STRIPE') {
      if (!successUrl || !cancelUrl) {
        throw new AppError('successUrl and cancelUrl are required for Stripe.', 400);
      }
      const price = PLAN_CENTS[planKey?.toLowerCase()];
      if (!price) throw new AppError(`Invalid plan key: ${planKey}`, 400);

      const result = await apiCall(`${pmUrl()}/api/v1/payments/initiate`, {
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
      });

      if (result.error) {
        logger.error('payment-microservice Stripe initiate failed', { status: result.status });
        throw new AppError(result.data?.message || 'Failed to create Stripe session.', result.status || 502);
      }

      const pmData       = result.data?.data ?? result.data;
      const stripeOption = Array.isArray(pmData.options) ? pmData.options.find(o => o.provider === 'STRIPE') : null;
      if (!stripeOption?.sessionUrl) {
        throw new AppError('Payment service did not return a Stripe session URL.', 502);
      }

      storePending(stripeOption.orderId, {
        transactionId: pmData.transactionId,
        attemptId:     stripeOption.attemptId,
        planKey,
        customerEmail,
      });

      return res.status(201).json({
        success: true,
        message: 'Stripe checkout session created.',
        data: { provider: 'STRIPE', sessionId: stripeOption.orderId, sessionUrl: stripeOption.sessionUrl },
      });
    }

    // ── RAZORPAY / CASH (and any future INR provider) ──
    const amount = PLAN_PAISE[planKey?.toLowerCase()] ?? 499900;

    const result = await apiCall(`${pmUrl()}/api/v1/payments/initiate`, {
      method: 'POST',
      data: {
        orderId,
        idempotencyKey: idempKey,
        amount,
        currency: 'INR',
        providers: [p],
        metadata: { planKey, customerEmail, source: 'web-agency-checkout' },
      },
      headers: pmServiceHeaders(tenantId),
    });

    if (result.error) {
      logger.error(`payment-microservice ${p} initiate failed`, { status: result.status });
      throw new AppError(result.data?.message || `Failed to create ${p} order.`, result.status || 502);
    }

    const pmData = result.data?.data ?? result.data;
    const option = Array.isArray(pmData.options) ? pmData.options.find(o => o.provider === p) : null;
    if (!option) {
      throw new AppError(`Payment service did not return a ${p} order.`, 502);
    }

    const refKey = option.orderId || orderId;
    storePending(refKey, {
      transactionId: pmData.transactionId,
      attemptId:     option.attemptId,
      planKey,
      customerEmail,
    });

    if (p === 'RAZORPAY') {
      if (!option.orderId) throw new AppError('Payment service did not return a Razorpay order.', 502);
      return res.status(201).json({
        success: true,
        message: 'Razorpay order created.',
        data: { provider: 'RAZORPAY', orderId: option.orderId, amount, currency: 'INR', keyId: config.razorpay?.keyId },
      });
    }

    // CASH (and any future offline provider)
    return res.status(201).json({
      success: true,
      message: `${p} order created.`,
      data: {
        provider: p,
        referenceCode: option.orderId || refKey,
        transactionId: pmData.transactionId,
        attemptId:     option.attemptId,
        amount,
        currency: 'INR',
      },
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/payments/verify
 *
 * Verifies a payment with any provider, then provisions the product account.
 * Body (all providers): { provider, token, planKey, name, email, businessName?, externalId? }
 *   token     — orderId (RAZORPAY) | sessionId (STRIPE) | referenceCode (CASH)
 *   RAZORPAY also requires: { paymentId, signature }
 * Returns: { paymentVerified, loginUrl?, ... }
 */
router.post('/verify', async (req, res, next) => {
  try {
    if (!config.payment?.apiKey) {
      throw new AppError('Payment service is not configured on this server.', 503);
    }

    const { provider, token, paymentId, signature, planKey, name, email, businessName, externalId } = req.body;
    if (!provider || !token || !email) {
      throw new AppError('provider, token, and email are required.', 400);
    }

    const p = provider.toUpperCase();
    if (p === 'RAZORPAY' && (!paymentId || !signature)) {
      throw new AppError('paymentId and signature are required for Razorpay verification.', 400);
    }

    const pending = getPending(token);
    if (!pending) {
      throw new AppError('Payment order not found or has expired. Please restart the checkout.', 404);
    }

    const { transactionId, attemptId } = pending;
    const tenantId = req.headers['x-tenant-id'] || config.tenantId || 'easydev';

    // Build provider-specific verify payload
    const verifyData = p === 'RAZORPAY'
      ? { attemptId, providerPaymentId: paymentId, providerSignature: signature }
      : { attemptId, providerPaymentId: token };  // STRIPE: token = sessionId; CASH: token = referenceCode

    const result = await apiCall(
      `${pmUrl()}/api/v1/payments/${transactionId}/verify`,
      { method: 'POST', data: verifyData, headers: pmServiceHeaders(tenantId) },
    );

    if (result.error) {
      logger.error(`payment-microservice ${p} verify failed`, { transactionId, status: result.status });
      throw new AppError(result.data?.message || 'Payment verification failed.', result.status || 502);
    }

    pendingOrders.delete(token);

    return handlePostPayment(res, {
      productId:    resolveProductId(req.body),
      name:         name || email,
      email:        String(email),
      planKey:      planKey || pending.planKey || 'growth',
      paymentId:    p === 'RAZORPAY' ? paymentId : token,
      businessName,
      externalId,
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
// PAYMENT METHODS — public, no auth required
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /api/payments/methods
 *
 * Returns the list of payment providers currently enabled in payment-microservice.
 * The EasyDev frontend calls this on checkout mount and renders ONLY the
 * options that come back — it never hardcodes which gateways are available.
 *
 * Response: { success: true, data: { methods: ['RAZORPAY','STRIPE'], count: 2 } }
 *
 * Falls back gracefully when payment-microservice is unreachable:
 *   - Returns an empty methods array so the frontend can show a helpful error.
 */
router.get('/methods', async (req, res, next) => {
  try {
    if (!config.payment?.serviceUrl) {
      // No payment service configured — return empty so checkout can show a notice
      return res.status(200).json({
        success: true,
        data: { methods: [], count: 0 },
      });
    }

    const tenantId = req.headers['x-tenant-id'] || config.tenantId || 'easydev';
    const result   = await apiCall(
      `${pmUrl()}/api/v1/payments/methods`,
      { method: 'GET', headers: pmServiceHeaders(tenantId) },
    );

    if (result.error) {
      logger.warn('payment-microservice /methods returned error', { status: result.status });
      return res.status(200).json({ success: true, data: { methods: [], count: 0 } });
    }

    const data = result.data?.data ?? result.data;
    return res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
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
