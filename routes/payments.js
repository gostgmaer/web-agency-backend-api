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
import jwt           from 'jsonwebtoken';
import { config }    from '../config/index.js';
import { JWT_SECRET, JWT_ISSUER, JWT_AUDIENCE } from '../config/jwt.js';
import logger        from '../utils/logger.js';
import { provision } from '../utils/productProvisioner.js';
import { AppError }  from '../utils/errors.js';
import { apiCall }   from '../lib/axiosCall.js';
import { authenticate, authorize } from '../middleware/auth.js';

const router = express.Router();

// ─── Plan price catalog ───────────────────────────────────────────────────────

const BILLING_PLANS = {
  starter: {
    planId: 'plan_easydev_starter_inr_monthly',
    productName: 'EasyDev Starter Plan',
    trialDays: 3,
    interval: 'month',
    intervalCount: 1,
    INR: 199900,
  },
  growth: {
    planId: 'plan_easydev_growth_inr_monthly',
    productName: 'EasyDev Growth Plan',
    trialDays: 3,
    interval: 'month',
    intervalCount: 1,
    INR: 499900,
  },
  business: {
    planId: 'plan_easydev_business_inr_monthly',
    productName: 'EasyDev Business Plan',
    trialDays: 3,
    interval: 'month',
    intervalCount: 1,
    INR: 1299900,
  },
};

const SUBSCRIPTION_STATUS_MAP = {
  TRIALING: 'trial',
  ACTIVE: 'active',
  PAST_DUE: 'past_due',
  CANCELLED: 'cancelled',
  EXPIRED: 'expired',
};

const PLAN_KEY_BY_PLAN_ID = Object.fromEntries(
  Object.entries(BILLING_PLANS).map(([planKey, plan]) => [plan.planId, planKey]),
);

const PUBLIC_CHECKOUT_PROVIDERS = ['RAZORPAY', 'CASH'];

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
function pmServiceHeaders(tenantId, userId) {
  const headers = {
    'x-api-key':    config.payment?.apiKey || '',
    'x-tenant-id':  tenantId || config.tenantId || 'easydev',
    'Content-Type': 'application/json',
  };
  if (userId) headers['x-user-id'] = userId;
  return headers;
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
  const requestedProductId = typeof body?.productId === 'string' ? body.productId.trim() : '';
  if (requestedProductId) {
    if (!config.products?.[requestedProductId]) {
      throw new AppError(`Unknown productId "${requestedProductId}".`, 400);
    }
    return requestedProductId;
  }

  const configuredProductIds = Object.keys(config.products || {});
  if (configuredProductIds.length === 1) {
    return configuredProductIds[0];
  }

  throw new AppError('productId is required. Pass the product you are purchasing.', 400);
}

function getBillingPlan(planKey) {
  const plan = BILLING_PLANS[planKey?.toLowerCase()];
  if (!plan) {
    throw new AppError(`Invalid plan key: ${planKey}`, 400);
  }
  return plan;
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function buildCheckoutCustomerId(email) {
  return `checkout:${normalizeEmail(email)}`;
}

function tryResolveCheckoutUser(req) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) return null;

  try {
    const decoded = jwt.verify(authHeader.split(' ')[1], JWT_SECRET, {
      issuer: JWT_ISSUER,
      audience: JWT_AUDIENCE,
    });

    return {
      id: typeof decoded?.sub === 'string' ? decoded.sub : null,
      email: typeof decoded?.email === 'string' ? normalizeEmail(decoded.email) : null,
    };
  } catch (error) {
    logger.debug('Ignoring invalid bearer token on public checkout route', {
      message: error?.message,
    });
    return null;
  }
}

function resolveCheckoutIdentity(req, customerEmail) {
  const authenticatedUser = tryResolveCheckoutUser(req);
  const normalizedEmail = authenticatedUser?.email || normalizeEmail(customerEmail);

  return {
    customerId: authenticatedUser?.id || buildCheckoutCustomerId(normalizedEmail),
    customerEmail: normalizedEmail,
    legacyCustomerId: buildCheckoutCustomerId(normalizedEmail),
  };
}

function mapSubscriptionStatus(status) {
  if (typeof status !== 'string') return 'active';
  return SUBSCRIPTION_STATUS_MAP[status.toUpperCase()] || status.toLowerCase();
}

function toMajorCurrencyUnit(amount, currency = 'INR') {
  const parsed = Number(amount ?? 0);
  if (!Number.isFinite(parsed)) return 0;

  const zeroDecimalCurrencies = new Set(['JPY', 'KRW']);
  const divisor = zeroDecimalCurrencies.has(String(currency).toUpperCase()) ? 1 : 100;

  return parsed / divisor;
}

function getDaysRemaining(dateValue) {
  if (!dateValue) return 0;

  const targetDate = new Date(dateValue);
  if (Number.isNaN(targetDate.getTime())) return 0;

  return Math.max(0, Math.ceil((targetDate.getTime() - Date.now()) / (1000 * 60 * 60 * 24)));
}

function extractCollection(payload) {
  const data = payload?.data ?? payload;
  if (Array.isArray(data?.data)) {
    return {
      items: data.data,
      total: typeof data.total === 'number' ? data.total : data.data.length,
    };
  }

  if (Array.isArray(data)) {
    return {
      items: data,
      total: data.length,
    };
  }

  return {
    items: [],
    total: 0,
  };
}

function uniqueById(items) {
  const seen = new Set();
  return items.filter((item) => {
    if (!item?.id || seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
}

function resolveLegacyPeriod(from, interval, intervalCount = 1, trialDays = 0) {
  const createdAt = new Date(from);
  if (Number.isNaN(createdAt.getTime())) {
    return {
      status: 'active',
      trialEndsAt: null,
      currentPeriodStart: null,
      currentPeriodEnd: null,
    };
  }

  const trialEndsAt = trialDays > 0
    ? new Date(createdAt.getTime() + trialDays * 24 * 60 * 60 * 1000)
    : null;
  const periodStart = trialEndsAt ?? createdAt;
  const periodEnd = new Date(periodStart);

  switch (String(interval || 'month').toLowerCase()) {
    case 'day':
    case 'daily':
      periodEnd.setDate(periodEnd.getDate() + intervalCount);
      break;
    case 'week':
    case 'weekly':
      periodEnd.setDate(periodEnd.getDate() + intervalCount * 7);
      break;
    case 'year':
    case 'yearly':
      periodEnd.setFullYear(periodEnd.getFullYear() + intervalCount);
      break;
    default:
      periodEnd.setMonth(periodEnd.getMonth() + intervalCount);
      break;
  }

  const inTrial = Boolean(trialEndsAt) && trialEndsAt.getTime() > Date.now();

  return {
    status: inTrial ? 'trial' : 'active',
    trialEndsAt: trialEndsAt?.toISOString() || null,
    currentPeriodStart: periodStart.toISOString(),
    currentPeriodEnd: periodEnd.toISOString(),
  };
}

function resolveConfiguredProduct(productId, applicationId) {
  const configuredProducts = Object.entries(config.products || {});
  const normalizedProductId = typeof productId === 'string' && productId.trim() ? productId.trim() : null;
  const normalizedApplicationId =
    typeof applicationId === 'string' && applicationId.trim() ? applicationId.trim() : null;

  if (normalizedProductId && config.products?.[normalizedProductId]) {
    return { productId: normalizedProductId, productConfig: config.products[normalizedProductId] };
  }

  if (normalizedApplicationId) {
    const matchedProduct = configuredProducts.find(([, productConfig]) =>
      productConfig?.iamProvisioning?.applicationSlug === normalizedApplicationId,
    );

    if (matchedProduct) {
      return { productId: matchedProduct[0], productConfig: matchedProduct[1] };
    }
  }

  return {
    productId: normalizedProductId || normalizedApplicationId,
    productConfig: null,
  };
}

function normalizeCustomerProduct(subscription) {
  const metadata = subscription?.metadata && typeof subscription.metadata === 'object' ? subscription.metadata : {};
  const plan = subscription?.plan && typeof subscription.plan === 'object' ? subscription.plan : {};
  const rawProductId = typeof metadata.productId === 'string' && metadata.productId.trim()
    ? metadata.productId.trim()
    : null;
  const planApplicationId = typeof plan.applicationId === 'string' && plan.applicationId.trim()
    ? plan.applicationId.trim()
    : null;
  const normalizedPlanId = typeof plan.id === 'string' && plan.id.trim()
    ? plan.id.trim()
    : (typeof metadata.planId === 'string' && metadata.planId.trim() ? metadata.planId.trim() : null);
  const { productId, productConfig } = resolveConfiguredProduct(rawProductId, planApplicationId);
  const launchSlug = productConfig?.iamProvisioning?.applicationSlug || planApplicationId || productId || null;

  return {
    id: subscription?.id,
    productId,
    applicationId: planApplicationId,
    launchSlug,
    launchable: Boolean(launchSlug),
    productName: productConfig?.name || plan.name || productId || 'Purchased product',
    productDescription: productConfig?.description || plan.description || '',
    planId: normalizedPlanId,
    planKey: normalizedPlanId ? PLAN_KEY_BY_PLAN_ID[normalizedPlanId] || null : null,
    planName: plan.name || normalizedPlanId || 'Plan',
    price: toMajorCurrencyUnit(plan.amount, plan.currency),
    currency: plan.currency || 'INR',
    status: mapSubscriptionStatus(subscription?.status),
    trialEndsAt: subscription?.trialEnd || null,
    currentPeriodStart: subscription?.currentPeriodStart || null,
    currentPeriodEnd: subscription?.currentPeriodEnd || null,
    cancelAtPeriodEnd: Boolean(subscription?.cancelledAt) && mapSubscriptionStatus(subscription?.status) !== 'cancelled',
    daysRemaining: getDaysRemaining(subscription?.trialEnd || subscription?.currentPeriodEnd),
    billingProvider: typeof metadata.provider === 'string' ? metadata.provider : null,
  };
}

function normalizeLegacyTransactionProduct(transaction) {
  if (!transaction || transaction.status !== 'SUCCESS') return null;

  const metadata = transaction?.metadata && typeof transaction.metadata === 'object' ? transaction.metadata : {};
  const rawProductId = typeof metadata.productId === 'string' && metadata.productId.trim()
    ? metadata.productId.trim()
    : null;
  const normalizedPlanId = typeof metadata.planId === 'string' && metadata.planId.trim()
    ? metadata.planId.trim()
    : null;
  const rawPlanKey = typeof metadata.planKey === 'string' && metadata.planKey.trim()
    ? metadata.planKey.trim().toLowerCase()
    : null;
  const planKey = rawPlanKey && BILLING_PLANS[rawPlanKey]
    ? rawPlanKey
    : (normalizedPlanId ? PLAN_KEY_BY_PLAN_ID[normalizedPlanId] || null : null);
  const configuredPlan = planKey ? BILLING_PLANS[planKey] : null;
  const { productId, productConfig } = resolveConfiguredProduct(rawProductId, null);
  const launchSlug = productConfig?.iamProvisioning?.applicationSlug || productId || null;
  const trialDays = Number.isFinite(Number(metadata.trialDays)) ? Number(metadata.trialDays) : 0;
  const intervalCount = Number.isFinite(Number(metadata.intervalCount)) ? Number(metadata.intervalCount) : 1;
  const period = resolveLegacyPeriod(transaction.createdAt, metadata.interval, intervalCount, trialDays);

  return {
    id: `transaction:${transaction.id}`,
    productId,
    applicationId: null,
    launchSlug,
    launchable: Boolean(launchSlug),
    productName: productConfig?.name || metadata.productName || productId || 'Purchased product',
    productDescription: productConfig?.description || '',
    planId: normalizedPlanId,
    planKey,
    planName: configuredPlan?.productName || normalizedPlanId || 'Plan',
    price: configuredPlan ? toMajorCurrencyUnit(configuredPlan.INR, 'INR') : 0,
    currency: 'INR',
    status: period.status,
    trialEndsAt: period.trialEndsAt,
    currentPeriodStart: period.currentPeriodStart,
    currentPeriodEnd: period.currentPeriodEnd,
    cancelAtPeriodEnd: false,
    daysRemaining: getDaysRemaining(period.trialEndsAt || period.currentPeriodEnd),
    billingProvider: transaction?.attempts?.[0]?.provider || null,
  };
}

function normalizeCustomerInvoice(invoice) {
  const firstItem = Array.isArray(invoice?.items) ? invoice.items[0] : null;
  const invoicePlanName = typeof invoice?.metadata?.planName === 'string' && invoice.metadata.planName.trim()
    ? invoice.metadata.planName.trim()
    : typeof firstItem?.description === 'string' && firstItem.description.trim()
      ? firstItem.description.trim()
      : 'Subscription invoice';

  return {
    id: invoice?.id,
    invoiceNumber: invoice?.invoiceNumber || invoice?.id,
    amount: toMajorCurrencyUnit(invoice?.totalAmount, invoice?.currency),
    currency: invoice?.currency || 'INR',
    status: typeof invoice?.status === 'string' ? invoice.status.toLowerCase() : 'pending',
    createdAt: invoice?.createdAt || new Date().toISOString(),
    paidAt: invoice?.paidAt || null,
    planName: invoicePlanName,
    downloadUrl: null,
  };
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
 * Body:    { provider, planKey, customerEmail, productId? }
 *          provider    — 'RAZORPAY' | 'CASH' (value from GET /methods)
 *          productId   — optional only when exactly one product is configured
 * Returns: provider-specific data:
 *          RAZORPAY → { provider, orderId, amount, currency, keyId }
 *          CASH     → { provider, referenceCode, transactionId, attemptId, amount, currency }
 */
router.post('/initiate', async (req, res, next) => {
  try {
    if (!config.payment?.apiKey) {
      throw new AppError('Payment service is not configured on this server.', 503);
    }

    const { provider, planKey, customerEmail } = req.body;
    if (!provider || !planKey || !customerEmail) {
      throw new AppError('provider, planKey, and customerEmail are required.', 400);
    }

    const productId = resolveProductId(req.body);

    const p        = provider.toUpperCase();
    const plan     = getBillingPlan(planKey);
    const orderId  = randomUUID();
    const idempKey = randomUUID();
    const tenantId = req.headers['x-tenant-id'] || config.tenantId || 'easydev';
    const checkoutIdentity = resolveCheckoutIdentity(req, customerEmail);
    const customerId = checkoutIdentity.customerId;

    if (!PUBLIC_CHECKOUT_PROVIDERS.includes(p)) {
      throw new AppError(`${p} is not available for public checkout.`, 400);
    }

    // ── Public checkout uses INR providers only ──
    const amount = plan.INR;

    const result = await apiCall(`${pmUrl()}/api/v1/payments/initiate`, {
      method: 'POST',
      data: {
        orderId,
        idempotencyKey: idempKey,
        amount,
        currency: 'INR',
        providers: [p],
        metadata: {
          billingMode: 'subscription',
          recurringMode: p === 'RAZORPAY',
          tenantId,
          productId,
          planKey,
          planId: plan.planId,
          customerEmail: checkoutIdentity.customerEmail,
          customerId,
          legacyCustomerId: checkoutIdentity.legacyCustomerId,
          productName: plan.productName,
          trialDays: plan.trialDays,
          interval: plan.interval,
          intervalCount: plan.intervalCount,
          source: 'web-agency-checkout',
        },
      },
      headers: pmServiceHeaders(tenantId, customerId),
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
      productId,
      planKey,
      customerEmail: checkoutIdentity.customerEmail,
      customerId,
    });

    if (p === 'RAZORPAY') {
      if (!option.orderId) throw new AppError('Payment service did not return a Razorpay order.', 502);
      return res.status(201).json({
        success: true,
        message: 'Razorpay order created.',
        data: { provider: 'RAZORPAY', orderId: option.orderId, amount, currency: 'INR', keyId: config.razorpay?.keyId },
      });
    }

    if (p === 'CASH') {
      return res.status(201).json({
        success: true,
        message: 'Cash order created.',
        data: {
          provider: 'CASH',
          referenceCode: option.orderId || refKey,
          transactionId: pmData.transactionId,
          attemptId: option.attemptId,
          amount,
          currency: 'INR',
        },
      });
    }

    throw new AppError(`Unsupported provider returned from payment service: ${p}`, 502);
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/payments/verify
 *
 * Verifies a payment with any provider, then provisions the product account.
 * Body (all providers): { provider, token, planKey, name, email, businessName?, externalId? }
 *   token     — orderId or subscriptionId (RAZORPAY) | referenceCode (CASH)
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
      : { attemptId, providerPaymentId: token };

    const result = await apiCall(
      `${pmUrl()}/api/v1/payments/${transactionId}/verify`,
      { method: 'POST', data: verifyData, headers: pmServiceHeaders(tenantId, pending.customerId) },
    );

    if (result.error) {
      logger.error(`payment-microservice ${p} verify failed`, { transactionId, status: result.status });
      throw new AppError(result.data?.message || 'Payment verification failed.', result.status || 502);
    }

    pendingOrders.delete(token);

    return handlePostPayment(res, {
      productId:    resolveProductId({ productId: req.body.productId || pending.productId }),
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

/**
 * GET /api/payments/subscriptions
 *
 * Lists purchased products for the current member. This normalizes payment
 * subscriptions into a product-centric shape for the EasyDev member portal.
 */
router.get(
  '/subscriptions',
  authenticate,
  async (req, res, next) => {
    try {
      if (!config.payment?.serviceUrl) throw new AppError('Payment service is not configured.', 503);
      if (!config.payment?.apiKey) throw new AppError('Payment service API key is not configured.', 503);

      const qs = new URLSearchParams(req.query).toString();
      const tenantId = req.headers['x-tenant-id'];
      const customerIds = uniqueById([
        req.user?.id ? { id: req.user.id } : null,
        req.user?.email ? { id: buildCheckoutCustomerId(req.user.email) } : null,
      ].filter(Boolean)).map((item) => item.id);

      const subscriptionResults = await Promise.all(customerIds.map((customerId) =>
        apiCall(
          `${pmUrl()}/api/v1/subscriptions${qs ? `?${qs}` : ''}`,
          { method: 'GET', headers: pmServiceHeaders(tenantId, customerId) },
        )
      ));

      const failedSubscription = subscriptionResults.find((result) => result.error);
      if (failedSubscription) {
        logger.error('customer payment subscriptions failed', { status: failedSubscription.status, userId: req.user?.id });
        throw new AppError(failedSubscription.data?.message || 'Failed to fetch subscriptions.', failedSubscription.status || 502);
      }

      const subscriptions = uniqueById(subscriptionResults.flatMap((result) => extractCollection(result.data).items));
      let items = subscriptions.map(normalizeCustomerProduct);

      if (items.length === 0) {
        const transactionResults = await Promise.all(customerIds.map((customerId) =>
          apiCall(
            `${pmUrl()}/api/v1/payments${qs ? `?${qs}` : ''}`,
            { method: 'GET', headers: pmServiceHeaders(tenantId, customerId) },
          )
        ));

        const failedTransaction = transactionResults.find((result) => result.error);
        if (failedTransaction) {
          logger.error('customer payment transactions fallback failed', { status: failedTransaction.status, userId: req.user?.id });
          throw new AppError(failedTransaction.data?.message || 'Failed to fetch subscriptions.', failedTransaction.status || 502);
        }

        items = uniqueById(
          transactionResults
            .flatMap((result) => extractCollection(result.data).items)
            .map(normalizeLegacyTransactionProduct)
            .filter(Boolean),
        );
      }

      return res.status(200).json({
        success: true,
        message: 'Subscriptions retrieved.',
        data: {
          items,
          total: items.length,
        },
      });
    } catch (err) {
      next(err);
    }
  },
);

router.get(
  '/invoices',
  authenticate,
  async (req, res, next) => {
    try {
      if (!config.payment?.serviceUrl) throw new AppError('Payment service is not configured.', 503);
      if (!config.payment?.apiKey) throw new AppError('Payment service API key is not configured.', 503);

      const qs = new URLSearchParams(req.query).toString();
      const tenantId = req.headers['x-tenant-id'];
      const customerIds = uniqueById([
        req.user?.id ? { id: req.user.id } : null,
        req.user?.email ? { id: buildCheckoutCustomerId(req.user.email) } : null,
      ].filter(Boolean)).map((item) => item.id);

      const invoiceResults = await Promise.all(customerIds.map((customerId) =>
        apiCall(
          `${pmUrl()}/api/v1/billing/invoices${qs ? `?${qs}` : ''}`,
          { method: 'GET', headers: pmServiceHeaders(tenantId, customerId) },
        )
      ));

      const failedInvoice = invoiceResults.find((result) => result.error);
      if (failedInvoice) {
        logger.error('customer payment invoices failed', { status: failedInvoice.status, userId: req.user?.id });
        throw new AppError(failedInvoice.data?.message || 'Failed to fetch invoices.', failedInvoice.status || 502);
      }

      const invoices = uniqueById(
        invoiceResults
          .flatMap((result) => extractCollection(result.data).items)
          .map(normalizeCustomerInvoice),
      );

      return res.status(200).json({
        success: true,
        message: 'Invoices retrieved.',
        data: {
          items: invoices,
          total: invoices.length,
        },
      });
    } catch (err) {
      next(err);
    }
  },
);

router.get(
  '/payment-methods',
  authenticate,
  async (req, res, next) => {
    try {
      if (!config.payment?.serviceUrl) throw new AppError('Payment service is not configured.', 503);
      if (!config.payment?.apiKey) throw new AppError('Payment service API key is not configured.', 503);

      const tenantId = req.headers['x-tenant-id'];
      const result = await apiCall(
        `${pmUrl()}/api/v1/payment-methods`,
        {
          method: 'GET',
          headers: pmServiceHeaders(tenantId, req.user?.id),
        },
      );

      if (result.error) {
        logger.error('customer payment methods failed', { status: result.status, userId: req.user?.id });
        throw new AppError(result.data?.message || 'Failed to fetch saved payment methods.', result.status || 502);
      }

      return res.status(200).json({
        success: true,
        message: 'Saved payment methods retrieved.',
        data: result.data?.data ?? result.data,
      });
    } catch (err) {
      next(err);
    }
  },
);

router.post(
  '/payment-methods/setup-intent',
  authenticate,
  async (req, res, next) => {
    try {
      if (!config.payment?.serviceUrl) throw new AppError('Payment service is not configured.', 503);
      if (!config.payment?.apiKey) throw new AppError('Payment service API key is not configured.', 503);

      const tenantId = req.headers['x-tenant-id'];
      const result = await apiCall(
        `${pmUrl()}/api/v1/payment-methods/setup-intent`,
        {
          method: 'POST',
          data: {
            provider: req.body?.provider,
          },
          headers: pmServiceHeaders(tenantId, req.user?.id),
        },
      );

      if (result.error) {
        logger.error('customer payment setup intent failed', { status: result.status, userId: req.user?.id });
        throw new AppError(result.data?.message || 'Failed to create payment method setup intent.', result.status || 502);
      }

      return res.status(201).json({
        success: true,
        message: 'Payment method setup intent created.',
        data: result.data?.data ?? result.data,
      });
    } catch (err) {
      next(err);
    }
  },
);

router.post(
  '/payment-methods/setup-intents/:setupIntentId/complete',
  authenticate,
  async (req, res, next) => {
    try {
      if (!config.payment?.serviceUrl) throw new AppError('Payment service is not configured.', 503);
      if (!config.payment?.apiKey) throw new AppError('Payment service API key is not configured.', 503);

      const tenantId = req.headers['x-tenant-id'];
      const result = await apiCall(
        `${pmUrl()}/api/v1/payment-methods/setup-intents/${encodeURIComponent(req.params.setupIntentId)}/complete`,
        {
          method: 'POST',
          data: {
            provider: req.body?.provider,
            setAsDefault: req.body?.setAsDefault,
          },
          headers: pmServiceHeaders(tenantId, req.user?.id),
        },
      );

      if (result.error) {
        logger.error('customer payment setup completion failed', {
          status: result.status,
          userId: req.user?.id,
          setupIntentId: req.params.setupIntentId,
        });
        throw new AppError(result.data?.message || 'Failed to complete payment method setup.', result.status || 502);
      }

      return res.status(200).json({
        success: true,
        message: 'Payment method setup completed.',
        data: result.data?.data ?? result.data,
      });
    } catch (err) {
      next(err);
    }
  },
);

router.patch(
  '/payment-methods/:paymentMethodId/default',
  authenticate,
  async (req, res, next) => {
    try {
      if (!config.payment?.serviceUrl) throw new AppError('Payment service is not configured.', 503);
      if (!config.payment?.apiKey) throw new AppError('Payment service API key is not configured.', 503);

      const tenantId = req.headers['x-tenant-id'];
      const result = await apiCall(
        `${pmUrl()}/api/v1/payment-methods/${encodeURIComponent(req.params.paymentMethodId)}/default`,
        {
          method: 'PATCH',
          data: {
            provider: req.body?.provider,
          },
          headers: pmServiceHeaders(tenantId, req.user?.id),
        },
      );

      if (result.error) {
        logger.error('customer payment default method update failed', {
          status: result.status,
          userId: req.user?.id,
          paymentMethodId: req.params.paymentMethodId,
        });
        throw new AppError(result.data?.message || 'Failed to update default payment method.', result.status || 502);
      }

      return res.status(200).json({
        success: true,
        message: 'Default payment method updated.',
        data: result.data?.data ?? result.data,
      });
    } catch (err) {
      next(err);
    }
  },
);

router.delete(
  '/subscriptions/:id',
  authenticate,
  async (req, res, next) => {
    try {
      if (!config.payment?.serviceUrl) throw new AppError('Payment service is not configured.', 503);
      if (!config.payment?.apiKey) throw new AppError('Payment service API key is not configured.', 503);
      if (String(req.params.id || '').startsWith('transaction:')) {
        throw new AppError('This purchase must be backfilled to a subscription before it can be cancelled.', 409);
      }

      const tenantId = req.headers['x-tenant-id'];
      const result = await apiCall(
        `${pmUrl()}/api/v1/subscriptions/${encodeURIComponent(req.params.id)}`,
        {
          method: 'DELETE',
          data: {
            reason: req.body?.reason,
            immediate: Boolean(req.body?.immediate),
          },
          headers: pmServiceHeaders(tenantId, req.user?.id),
        },
      );

      if (result.error) {
        logger.error('customer payment cancellation failed', { status: result.status, userId: req.user?.id, subscriptionId: req.params.id });
        throw new AppError(result.data?.message || 'Failed to cancel subscription.', result.status || 502);
      }

      return res.status(200).json({
        success: true,
        message: 'Subscription cancelled.',
        data: result.data?.data ?? result.data,
      });
    } catch (err) {
      next(err);
    }
  },
);

router.patch(
  '/subscriptions/:id/plan',
  authenticate,
  async (req, res, next) => {
    try {
      if (!config.payment?.serviceUrl) throw new AppError('Payment service is not configured.', 503);
      if (!config.payment?.apiKey) throw new AppError('Payment service API key is not configured.', 503);
      if (String(req.params.id || '').startsWith('transaction:')) {
        throw new AppError('This purchase must be backfilled to a subscription before its plan can be changed.', 409);
      }

      const requestedPlanKey = typeof req.body?.planKey === 'string' ? req.body.planKey.trim().toLowerCase() : '';
      const targetPlan = getBillingPlan(requestedPlanKey);
      const tenantId = req.headers['x-tenant-id'];
      const result = await apiCall(
        `${pmUrl()}/api/v1/subscriptions/${encodeURIComponent(req.params.id)}/plan`,
        {
          method: 'PATCH',
          data: { planId: targetPlan.planId },
          headers: pmServiceHeaders(tenantId, req.user?.id),
        },
      );

      if (result.error) {
        logger.error('customer payment plan change failed', {
          status: result.status,
          userId: req.user?.id,
          subscriptionId: req.params.id,
          planKey: requestedPlanKey,
        });
        throw new AppError(result.data?.message || 'Failed to change subscription plan.', result.status || 502);
      }

      return res.status(200).json({
        success: true,
        message: 'Subscription plan updated.',
        data: normalizeCustomerProduct(result.data?.data ?? result.data),
      });
    } catch (err) {
      next(err);
    }
  },
);

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
 * Response: { success: true, data: { methods: ['RAZORPAY', 'CASH'], count: 2 } }
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
    const methods = Array.isArray(data?.methods)
      ? data.methods.filter((method) => PUBLIC_CHECKOUT_PROVIDERS.includes(String(method).toUpperCase()))
      : [];
    return res.status(200).json({ success: true, data: { methods, count: methods.length } });
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
