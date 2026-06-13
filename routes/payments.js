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
import { randomUUID, timingSafeEqual } from 'crypto';
import jwt           from 'jsonwebtoken';
import rateLimit     from 'express-rate-limit';
import { config }    from '../config/index.js';
import { JWT_SECRET, JWT_ISSUER, JWT_AUDIENCE, JWT_ALGORITHM } from '../config/jwt.js';
import { RedisRateLimitStore } from '../utils/redisRateLimitStore.js';
import logger        from '../utils/logger.js';
import { provision } from '../utils/productProvisioner.js';
import { AppError }  from '../utils/errors.js';
import { apiCall }   from '../lib/axiosCall.js';
import { authenticate, authorize } from '../middleware/auth.js';
import { getRuntimeTenantFallback } from '../utils/tenantFallback.js';
import { addGatewaySignatureHeaders, getPathFromUrl } from '../utils/gatewayHmac.js';

const router = express.Router();

// ─── Plan price catalog ───────────────────────────────────────────────────────

const BILLING_PLANS = {
  starter: {
    planId: 'plan_easydev_starter_inr_monthly',
    productName: 'EasyDev Starter Plan',
    trialDays: 3,
    interval: 'month',
    intervalCount: 1,
    INR: 49900,
  },
  growth: {
    // Internal key stays "growth"; customer-facing name is "Pro".
    planId: 'plan_easydev_growth_inr_monthly',
    productName: 'EasyDev Pro Plan',
    trialDays: 3,
    interval: 'month',
    intervalCount: 1,
    INR: 149900,
  },
  payg: {
    planId: 'plan_easydev_payg_inr',
    productName: 'EasyDev Pay as you go Plan',
    trialDays: 0,
    interval: 'month',
    intervalCount: 1,
    // Pay-as-you-go: ₹0 to activate, unlimited usage billed postpaid at
    // ₹0.50/reply and invoiced monthly. No upfront charge.
    INR: 0,
    billingModel: 'usage',
    perReplyPaise: 50,
  },
};

const PLAN_KEY_ALIASES = {
  starter: 'starter',
  free: 'starter',
  growth: 'growth',
  pro: 'growth',
  payg: 'payg',
  'pay-as-you-go': 'payg',
  business: 'payg',
  enterprise: 'payg',
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
const BLOCKING_SUBSCRIPTION_STATUSES = new Set(['trial', 'active', 'past_due']);

// ─── Pending order store ──────────────────────────────────────────────────────
// Maps provider orderId / sessionId → { transactionId, attemptId, planKey, customerEmail }
// Entries expire after PENDING_TTL_MS to prevent unbounded growth.
//
// SECURITY FIX TODO: Replace in-memory Map with Redis for multi-instance deployments
// In-memory storage is lost on process restart, causing payment verification to fail
// if the verify request arrives after the service restarts during the payment window.
// See: ../config/index.js config.redis for connection details

let pendingOrdersRedis = null;
const pendingOrders = new Map();
const PENDING_TTL_MS = 60 * 60 * 1000; // 1 hour

if (config.redis?.enabled && config.redis?.url) {
  try {
    const { default: Redis } = await import('ioredis');
    pendingOrdersRedis = new Redis(config.redis.url, {
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
      lazyConnect: true,
    });
    pendingOrdersRedis.connect().catch((err) => {
      logger.warn(`[payments] Redis connect failed, using in-memory pending store: ${err.message}`);
      pendingOrdersRedis = null;
    });
    pendingOrdersRedis.on('error', (err) => {
      logger.warn(`[payments] Redis error, switching to in-memory pending store: ${err.message}`);
      pendingOrdersRedis = null;
    });
  } catch (err) {
    logger.warn(`[payments] ioredis unavailable, using in-memory pending store: ${err.message}`);
    pendingOrdersRedis = null;
  }
}

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of pendingOrders.entries()) {
    if (v.expiresAt < now) pendingOrders.delete(k);
  }
}, 5 * 60 * 1000).unref();

function pendingStoreKey(key) {
  return `checkout:pending:${key}`;
}

async function storePending(key, value) {
  const payload = { ...value, expiresAt: Date.now() + PENDING_TTL_MS };

  if (pendingOrdersRedis) {
    try {
      await pendingOrdersRedis.set(
        pendingStoreKey(key),
        JSON.stringify(payload),
        'PX',
        PENDING_TTL_MS,
      );
      return;
    } catch (err) {
      logger.warn(`[payments] Failed to write pending checkout to Redis, using memory fallback: ${err.message}`);
    }
  }

  pendingOrders.set(key, payload);
}

async function getPending(key) {
  if (pendingOrdersRedis) {
    try {
      const raw = await pendingOrdersRedis.get(pendingStoreKey(key));
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed || parsed.expiresAt < Date.now()) {
        await pendingOrdersRedis.del(pendingStoreKey(key)).catch(() => {});
        return null;
      }
      return parsed;
    } catch (err) {
      logger.warn(`[payments] Failed to read pending checkout from Redis, falling back to memory: ${err.message}`);
    }
  }

  const entry = pendingOrders.get(key);
  if (!entry) return null;
  if (entry.expiresAt < Date.now()) {
    pendingOrders.delete(key);
    return null;
  }
  return entry;
}

async function deletePending(key) {
  if (pendingOrdersRedis) {
    await pendingOrdersRedis.del(pendingStoreKey(key)).catch(() => {});
  }
  pendingOrders.delete(key);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const pmUrl = () => {
  if (!config.payment?.serviceUrl) {
    throw new Error("PAYMENT_SERVICE_URL is not configured");
  }
  return config.payment.serviceUrl;
};

function resolveEffectiveTenantId(explicitTenantId) {
  const runtimeTenantId = getRuntimeTenantFallback().tenantId;
  const tenantId = explicitTenantId || runtimeTenantId || null;
  if (!tenantId) {
    throw new AppError('Tenant context is missing. Configure TENANT and restart gateway.', 503);
  }
  return tenantId;
}

/** Service-to-service headers for payment-microservice (API key auth). */
function pmServiceHeaders(tenantId, userId, userEmail) {
  const effectiveTenant = resolveEffectiveTenantId(tenantId);
  const headers = {
    'x-api-key':    config.payment?.apiKey || '',
    'x-tenant-id':  effectiveTenant,
		'x-tenant-slug': effectiveTenant,
    'Content-Type': 'application/json',
  };
  if (userId) headers['x-user-id'] = userId;
  if (userEmail) headers['x-user-email'] = userEmail;
  return headers;
}

/** User JWT passthrough headers for admin calls to payment-microservice. */
function pmAuthHeaders(bearerToken, tenantId) {
  const effectiveTenant = resolveEffectiveTenantId(tenantId);
  return {
    'Authorization': bearerToken || '',
    'x-tenant-id':   effectiveTenant,
		'x-tenant-slug': effectiveTenant,
    'Content-Type':  'application/json',
  };
}

/**
 * Call payment-microservice with service (x-api-key) or user (Bearer) auth.
 * Every request is signed with the gateway HMAC headers so payment-microservice
 * can enforce GatewayHmacGuard ("only reachable through the gateway").
 *
 * The signed payload must mirror exactly what the guard reconstructs:
 *   METHOD | /full/path?query | x-tenant-id header | x-request-id header | ts
 */
function pmApi(method, path, { data, tenantId, userId, userEmail, bearer, requestId } = {}) {
  const url = `${pmUrl()}${path}`;
  const headers = bearer
    ? pmAuthHeaders(bearer, tenantId)
    : pmServiceHeaders(tenantId, userId, userEmail);
  if (requestId) headers['x-request-id'] = requestId;

  const signed = addGatewaySignatureHeaders(headers, {
    method,
    path: getPathFromUrl(url),
    tenantId: headers['x-tenant-id'] || '',
    requestId: requestId || '',
    secret: config.gateway?.hmacSecret,
  });

  return apiCall(url, {
    method,
    ...(data !== undefined ? { data } : {}),
    headers: signed,
  });
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
  const normalizedPlanKey = typeof planKey === 'string' ? PLAN_KEY_ALIASES[planKey.toLowerCase().trim()] : null;
  const plan = normalizedPlanKey ? BILLING_PLANS[normalizedPlanKey] : null;
  if (!plan) {
    throw new AppError(`Invalid plan key: ${planKey}`, 400);
  }
  return plan;
}

function normalizePlanKey(planKey) {
  if (typeof planKey !== 'string') return null;
  return PLAN_KEY_ALIASES[planKey.toLowerCase().trim()] || null;
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function asTrimmedString(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim();
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
      algorithms: [JWT_ALGORITHM],
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

function normalizeCustomerSubscriptionStatus(subscription) {
  const mappedStatus = mapSubscriptionStatus(subscription?.status);
  const trialEndMs = subscription?.trialEnd ? Date.parse(subscription.trialEnd) : Number.NaN;
  const inTrialWindow = Number.isFinite(trialEndMs) && trialEndMs > Date.now();

  if (inTrialWindow && mappedStatus !== 'cancelled' && mappedStatus !== 'expired') {
    return 'trial';
  }

  return mappedStatus;
}

function isBlockingProductStatus(status) {
  return BLOCKING_SUBSCRIPTION_STATUSES.has(String(status || '').toLowerCase());
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

function hasValidCommunicationApiKey(req) {
  const expected = config.products?.['easydev-ai-communication']?.apiKey;
  const provided = typeof req.headers['x-api-key'] === 'string' ? req.headers['x-api-key'].trim() : '';

  if (!expected || !provided) {
    return false;
  }

  const a = Buffer.from(provided.padEnd(expected.length));
  const b = Buffer.from(expected.padEnd(provided.length));

  return timingSafeEqual(a, b) && provided === expected;
}

function compareDateDesc(left, right) {
  const leftMs = left ? Date.parse(left) : Number.NaN;
  const rightMs = right ? Date.parse(right) : Number.NaN;

  if (!Number.isFinite(leftMs) && !Number.isFinite(rightMs)) return 0;
  if (!Number.isFinite(leftMs)) return 1;
  if (!Number.isFinite(rightMs)) return -1;

  return rightMs - leftMs;
}

function pickPreferredProduct(items) {
  if (!Array.isArray(items) || items.length === 0) {
    return null;
  }

  const statusRank = {
    trial: 0,
    active: 1,
    past_due: 2,
    cancelled: 3,
    expired: 4,
  };

  return [...items].sort((left, right) => {
    const leftRank = statusRank[left?.status] ?? Number.MAX_SAFE_INTEGER;
    const rightRank = statusRank[right?.status] ?? Number.MAX_SAFE_INTEGER;

    if (leftRank !== rightRank) {
      return leftRank - rightRank;
    }

    const periodComparison = compareDateDesc(left?.currentPeriodEnd, right?.currentPeriodEnd);
    if (periodComparison !== 0) {
      return periodComparison;
    }

    return compareDateDesc(left?.trialEndsAt, right?.trialEndsAt);
  })[0] ?? null;
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
  const normalizedPlanKey = normalizePlanKey(metadata.planKey)
    || (normalizedPlanId ? PLAN_KEY_BY_PLAN_ID[normalizedPlanId] || null : null);
  const configuredPlan = normalizedPlanKey ? BILLING_PLANS[normalizedPlanKey] : null;
  const { productId, productConfig } = resolveConfiguredProduct(rawProductId, planApplicationId);
  const launchSlug = productConfig?.iamProvisioning?.applicationSlug || planApplicationId || productId || null;

  const normalizedStatus = normalizeCustomerSubscriptionStatus(subscription);

  return {
    id: subscription?.id,
    productId,
    applicationId: planApplicationId,
    launchSlug,
    launchable: Boolean(launchSlug),
    productName: productConfig?.name || plan.name || productId || 'Purchased product',
    productDescription: productConfig?.description || plan.description || '',
    planId: normalizedPlanId,
    planKey: normalizedPlanKey,
    planName: configuredPlan?.productName || plan.name || normalizedPlanId || 'Plan',
    price: toMajorCurrencyUnit(plan.amount, plan.currency),
    currency: plan.currency || 'INR',
    status: normalizedStatus,
    trialEndsAt: subscription?.trialEnd || null,
    currentPeriodStart: subscription?.currentPeriodStart || null,
    currentPeriodEnd: subscription?.currentPeriodEnd || null,
    cancelAtPeriodEnd: Boolean(subscription?.cancelledAt) && normalizedStatus !== 'cancelled',
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
  const planKey = normalizePlanKey(rawPlanKey)
    || (normalizedPlanId ? PLAN_KEY_BY_PLAN_ID[normalizedPlanId] || null : null);
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

async function ensureNoActiveProductSubscription({ tenantId, customerId, customerEmail, productId, requestId }) {
  const result = await pmApi('GET', '/api/v1/subscriptions', {
    tenantId,
    userId: customerId,
    userEmail: customerEmail,
    requestId,
  });

  if (result.error) {
    logger.error('subscription pre-check failed', {
      status: result.status,
      tenantId,
      customerId,
      productId,
    });
    throw new AppError(result.data?.message || 'Failed to validate existing subscriptions.', result.status || 502);
  }

  const subscriptions = extractCollection(result.data).items;
  const existing = subscriptions
    .map(normalizeCustomerProduct)
    .find((item) => item.productId === productId && isBlockingProductStatus(item.status));

  if (existing) {
    throw new AppError(
      `You already have an active ${existing.productName || productId} subscription.`,
      409,
    );
  }
}

async function assertVerifiedTransactionIntegrity({ transactionId, tenantId, pending, requestId }) {
  const txResult = await pmApi('GET', `/api/v1/payments/${encodeURIComponent(transactionId)}`, {
    tenantId,
    userId: pending.customerId,
    userEmail: pending.customerEmail,
    requestId,
  });

  if (txResult.error) {
    logger.error('transaction integrity check failed: unable to fetch transaction', {
      transactionId,
      status: txResult.status,
    });
    throw new AppError(txResult.data?.message || 'Failed to validate verified transaction.', txResult.status || 502);
  }

  const tx = txResult.data?.data ?? txResult.data;
  const metadata = tx?.metadata && typeof tx.metadata === 'object' ? tx.metadata : {};
  const expectedPlan = getBillingPlan(pending.planKey);
  const violations = [];

  if (asTrimmedString(tx?.status).toUpperCase() !== 'SUCCESS') {
    violations.push(`status=${asTrimmedString(tx?.status) || 'unknown'}`);
  }

  if (asTrimmedString(tx?.tenantId) !== asTrimmedString(tenantId)) {
    violations.push('tenantId mismatch');
  }

  if (asTrimmedString(metadata?.productId) !== asTrimmedString(pending.productId)) {
    violations.push('productId mismatch');
  }

  if (normalizePlanKey(metadata?.planKey) !== normalizePlanKey(pending.planKey)) {
    violations.push('planKey mismatch');
  }

  if (asTrimmedString(metadata?.planId) !== asTrimmedString(expectedPlan.planId)) {
    violations.push('planId mismatch');
  }

  if (
    pending.customerEmail &&
    normalizeEmail(metadata?.customerEmail) !== normalizeEmail(pending.customerEmail)
  ) {
    violations.push('customerEmail mismatch');
  }

  if (
    pending.customerId &&
    asTrimmedString(metadata?.customerId) !== asTrimmedString(pending.customerId)
  ) {
    violations.push('customerId mismatch');
  }

  if (asTrimmedString(tx?.currency).toUpperCase() !== 'INR') {
    violations.push('currency mismatch');
  }

  if (asTrimmedString(tx?.amount) !== asTrimmedString(expectedPlan.INR)) {
    violations.push('amount mismatch');
  }

  if (violations.length > 0) {
    logger.error('transaction integrity violation detected after verify', {
      transactionId,
      violations,
      expected: {
        tenantId,
        productId: pending.productId,
        planKey: pending.planKey,
        planId: expectedPlan.planId,
        customerId: pending.customerId,
        customerEmail: pending.customerEmail,
        amount: expectedPlan.INR,
        currency: 'INR',
      },
      actual: {
        tenantId: tx?.tenantId,
        productId: metadata?.productId,
        planKey: metadata?.planKey,
        planId: metadata?.planId,
        customerId: metadata?.customerId,
        customerEmail: metadata?.customerEmail,
        amount: tx?.amount,
        currency: tx?.currency,
        status: tx?.status,
      },
    });

    throw new AppError(
      'Payment verification integrity check failed. Please contact support with your order reference.',
      409,
    );
  }
}

/** Shared post-payment provisioning: provision the product account and respond. */
async function handlePostPayment(res, { productId, name, email, planKey, paymentId, businessName, externalId, tenantId, requestId, prepaidReplyCredits }) {
  let provisionResult = null;
  try {
    provisionResult = await provision(productId, {
      name,
      email,
      planKey,
      paymentId,
      businessName: businessName || name,
      externalId,
      tenantId,
      requestId,
      ...(Number(prepaidReplyCredits) > 0 ? { prepaidReplyCredits: Number(prepaidReplyCredits) } : {}),
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
// Public checkout endpoints carry no Bearer auth — apply tight per-IP rate
// limits (production only, mirroring the portal proxy pattern).
const initiateLimiter = rateLimit({
  windowMs: 60_000,
  max: 20,
  store: new RedisRateLimitStore(60_000, 'rl:pay:init:'),
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many checkout attempts. Please try again shortly.' },
  skip: () => process.env.NODE_ENV !== 'production',
});

const verifyLimiter = rateLimit({
  windowMs: 60_000,
  max: 30,
  store: new RedisRateLimitStore(60_000, 'rl:pay:verify:'),
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many verification attempts. Please try again shortly.' },
  skip: () => process.env.NODE_ENV !== 'production',
});

router.post('/initiate', initiateLimiter, async (req, res, next) => {
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
    const normalizedPlanKey = normalizePlanKey(planKey);
    const plan     = getBillingPlan(normalizedPlanKey);

    // Usage-billed plans (pay-as-you-go) have no upfront charge — they are
    // activated for free and billed monthly on actual usage. Route them to
    // POST /payments/activate instead of the payment-order flow.
    if (plan.billingModel === 'usage') {
      throw new AppError(
        'Pay-as-you-go has no upfront payment. Use POST /api/payments/activate to enable it.',
        400,
      );
    }

    const orderId  = randomUUID();
    const idempKey = randomUUID();
    const tenantId = resolveEffectiveTenantId(req.headers['x-tenant-id']);
    const checkoutIdentity = resolveCheckoutIdentity(req, customerEmail);
    const customerId = checkoutIdentity.customerId;

    await ensureNoActiveProductSubscription({
      tenantId,
      customerId,
      customerEmail: checkoutIdentity.customerEmail,
      productId,
      requestId: req.requestId,
    });

    if (!PUBLIC_CHECKOUT_PROVIDERS.includes(p)) {
      throw new AppError(`${p} is not available for public checkout.`, 400);
    }

    // ── Public checkout uses INR providers only ──
    const amount = plan.INR;

    const result = await pmApi('POST', '/api/v1/payments/initiate', {
      tenantId,
      userId: customerId,
      requestId: req.requestId,
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
          planKey: normalizedPlanKey,
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
    await storePending(refKey, {
      transactionId: pmData.transactionId,
      attemptId:     option.attemptId,
      productId,
      planKey: normalizedPlanKey,
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
router.post('/verify', verifyLimiter, async (req, res, next) => {
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

    const pending = await getPending(token);
    if (!pending) {
      throw new AppError('Payment order not found or has expired. Please restart the checkout.', 404);
    }

    const requestedProductId = typeof req.body?.productId === 'string' ? req.body.productId.trim() : '';
    const requestedPlanKey = normalizePlanKey(req.body?.planKey);
    const requestedEmail = typeof email === 'string' ? normalizeEmail(email) : '';

    if (requestedProductId && pending.productId && requestedProductId !== pending.productId) {
      throw new AppError('Checkout payload mismatch: product cannot be changed after initiation.', 409);
    }

    if (requestedPlanKey && pending.planKey && requestedPlanKey !== pending.planKey) {
      throw new AppError('Checkout payload mismatch: plan cannot be changed after initiation.', 409);
    }

    if (requestedEmail && pending.customerEmail && requestedEmail !== normalizeEmail(pending.customerEmail)) {
      throw new AppError('Checkout payload mismatch: email does not match initiated order.', 409);
    }

    const { transactionId, attemptId } = pending;
    const tenantId = resolveEffectiveTenantId(req.headers['x-tenant-id']);

    // Build provider-specific verify payload
    const verifyData = p === 'RAZORPAY'
      ? { attemptId, providerPaymentId: paymentId, providerSignature: signature }
      : { attemptId, providerPaymentId: token };

    const result = await pmApi('POST', `/api/v1/payments/${encodeURIComponent(transactionId)}/verify`, {
      tenantId,
      userId: pending.customerId,
      requestId: req.requestId,
      data: verifyData,
    });

    if (result.error) {
      logger.error(`payment-microservice ${p} verify failed`, { transactionId, status: result.status });
      throw new AppError(result.data?.message || 'Payment verification failed.', result.status || 502);
    }

    const pmData = result.data?.data ?? result.data;
    if (pmData && pmData.success === false) {
      logger.warn(`payment-microservice ${p} verify returned success=false`, { transactionId });
      throw new AppError('Payment verification failed. Please check your payment details and try again.', 400);
    }

    await assertVerifiedTransactionIntegrity({
      transactionId,
      tenantId,
      pending,
      requestId: req.requestId,
    });

    await deletePending(token);
    const resolvedPlanKey = normalizePlanKey(pending.planKey);
    if (!resolvedPlanKey) {
      throw new AppError('Unable to resolve planKey for verification. Please restart checkout.', 400);
    }

    return handlePostPayment(res, {
      productId:    resolveProductId({ productId: pending.productId }),
      name:         name || pending.customerEmail,
      email:        String(pending.customerEmail || email),
      planKey:      resolvedPlanKey,
      paymentId:    p === 'RAZORPAY' ? paymentId : token,
      businessName,
      externalId,
      tenantId,
      requestId:    req.requestId || '',
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/payments/activate
 *
 * Activates a zero-cost, usage-billed plan (pay-as-you-go) with NO upfront
 * payment. Provisions the product account directly; usage is billed monthly
 * on actual replies (₹0.50/reply) via the usage-invoicing job.
 * Body: { planKey, customerEmail, name?, businessName?, productId? }
 */
router.post('/activate', initiateLimiter, async (req, res, next) => {
  try {
    if (!config.payment?.apiKey) {
      throw new AppError('Payment service is not configured on this server.', 503);
    }

    const { planKey, customerEmail, name, businessName, externalId } = req.body;
    if (!planKey || !customerEmail) {
      throw new AppError('planKey and customerEmail are required.', 400);
    }

    const productId = resolveProductId(req.body);
    const normalizedPlanKey = normalizePlanKey(planKey);
    const plan = getBillingPlan(normalizedPlanKey);

    // Only zero-cost usage-billed plans may be activated without payment.
    if (plan.billingModel !== 'usage') {
      throw new AppError('This plan requires payment. Use POST /api/payments/initiate.', 400);
    }

    const tenantId = resolveEffectiveTenantId(req.headers['x-tenant-id']);
    const checkoutIdentity = resolveCheckoutIdentity(req, customerEmail);
    const customerId = checkoutIdentity.customerId;

    await ensureNoActiveProductSubscription({
      tenantId,
      customerId,
      customerEmail: checkoutIdentity.customerEmail,
      productId,
      requestId: req.requestId,
    });

    return handlePostPayment(res, {
      productId,
      name:         name || checkoutIdentity.customerEmail,
      email:        String(checkoutIdentity.customerEmail),
      planKey:      normalizedPlanKey,
      businessName,
      externalId,
      tenantId,
      requestId:    req.requestId || '',
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
        pmApi('GET', `/api/v1/subscriptions${qs ? `?${qs}` : ''}`, {
          tenantId,
          userId: customerId,
          requestId: req.requestId,
        })
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
          pmApi('GET', `/api/v1/payments${qs ? `?${qs}` : ''}`, {
            tenantId,
            userId: customerId,
            requestId: req.requestId,
          })
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
  '/internal/products/:productId/current',
  async (req, res, next) => {
    try {
      if (!hasValidCommunicationApiKey(req)) {
        throw new AppError('Unauthorized.', 401);
      }
      if (!config.payment?.serviceUrl) throw new AppError('Payment service is not configured.', 503);
      if (!config.payment?.apiKey) throw new AppError('Payment service API key is not configured.', 503);

      const productId = typeof req.params?.productId === 'string' ? req.params.productId.trim() : '';
      const email = typeof req.query?.email === 'string' ? normalizeEmail(req.query.email) : '';
      const iamUserId = typeof req.query?.iamUserId === 'string' ? req.query.iamUserId.trim() : '';
      const tenantId = typeof req.query?.tenantId === 'string' ? req.query.tenantId.trim() : req.headers['x-tenant-id'];

      if (!productId) {
        throw new AppError('productId is required.', 400);
      }
      if (!config.products?.[productId]) {
        throw new AppError(`Unknown productId "${productId}".`, 400);
      }
      if (!email && !iamUserId) {
        throw new AppError('Provide email or iamUserId.', 400);
      }

      const customerIds = uniqueById([
        iamUserId ? { id: iamUserId } : null,
        email ? { id: buildCheckoutCustomerId(email) } : null,
      ].filter(Boolean)).map((item) => item.id);

      const subscriptionResults = await Promise.all(customerIds.map((customerId) =>
        pmApi('GET', '/api/v1/subscriptions', {
          tenantId,
          userId: customerId,
          userEmail: email || undefined,
          requestId: req.requestId,
        })
      ));

      const failedSubscription = subscriptionResults.find((result) => result.error);
      if (failedSubscription) {
        logger.error('internal customer product lookup failed', { status: failedSubscription.status, productId, iamUserId, email });
        throw new AppError(failedSubscription.data?.message || 'Failed to fetch subscriptions.', failedSubscription.status || 502);
      }

      let items = uniqueById(subscriptionResults.flatMap((result) => extractCollection(result.data).items))
        .map(normalizeCustomerProduct)
        .filter((item) => item.productId === productId);

      if (items.length === 0) {
        const transactionResults = await Promise.all(customerIds.map((customerId) =>
          pmApi('GET', '/api/v1/payments', {
            tenantId,
            userId: customerId,
            userEmail: email || undefined,
            requestId: req.requestId,
          })
        ));

        const failedTransaction = transactionResults.find((result) => result.error);
        if (failedTransaction) {
          logger.error('internal customer product transaction fallback failed', { status: failedTransaction.status, productId, iamUserId, email });
          throw new AppError(failedTransaction.data?.message || 'Failed to fetch subscriptions.', failedTransaction.status || 502);
        }

        items = uniqueById(
          transactionResults
            .flatMap((result) => extractCollection(result.data).items)
            .map(normalizeLegacyTransactionProduct)
            .filter(Boolean)
            .filter((item) => item.productId === productId),
        );
      }

      return res.status(200).json({
        success: true,
        message: 'Product subscription retrieved.',
        data: pickPreferredProduct(items),
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
        pmApi('GET', `/api/v1/billing/invoices${qs ? `?${qs}` : ''}`, {
          tenantId,
          userId: customerId,
          requestId: req.requestId,
        })
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
      const result = await pmApi('GET', '/api/v1/payment-methods', {
        tenantId,
        userId: req.user?.id,
        userEmail: req.user?.email,
        requestId: req.requestId,
      });

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
      const result = await pmApi('POST', '/api/v1/payment-methods/setup-intent', {
        tenantId,
        userId: req.user?.id,
        userEmail: req.user?.email,
        requestId: req.requestId,
        data: {
          provider: req.body?.provider,
        },
      });

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
      const result = await pmApi('POST', `/api/v1/payment-methods/setup-intents/${encodeURIComponent(req.params.setupIntentId)}/complete`, {
        tenantId,
        userId: req.user?.id,
        userEmail: req.user?.email,
        requestId: req.requestId,
        data: {
          provider: req.body?.provider,
          setAsDefault: req.body?.setAsDefault,
        },
      });

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
      const result = await pmApi('PATCH', `/api/v1/payment-methods/${encodeURIComponent(req.params.paymentMethodId)}/default`, {
        tenantId,
        userId: req.user?.id,
        userEmail: req.user?.email,
        requestId: req.requestId,
        data: {
          provider: req.body?.provider,
        },
      });

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
      const result = await pmApi('DELETE', `/api/v1/subscriptions/${encodeURIComponent(req.params.id)}`, {
        tenantId,
        userId: req.user?.id,
        requestId: req.requestId,
        data: {
          reason: req.body?.reason,
          immediate: Boolean(req.body?.immediate),
        },
      });

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

      const requestedPlanKey = normalizePlanKey(req.body?.planKey) || '';
      const targetPlan = getBillingPlan(requestedPlanKey);
      const tenantId = req.headers['x-tenant-id'];
      const result = await pmApi('PATCH', `/api/v1/subscriptions/${encodeURIComponent(req.params.id)}/plan`, {
        tenantId,
        userId: req.user?.id,
        requestId: req.requestId,
        data: { planId: targetPlan.planId },
      });

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
    // 503 (not 200) so Razorpay retries instead of silently dropping the event.
    logger.warn('Razorpay webhook received but PAYMENT_SERVICE_URL not set');
    return res.sendStatus(503);
  }

  try {
    const webhookUrl = `${pmUrl()}/api/v1/webhooks/razorpay`;
    const response = await fetch(webhookUrl, {
      method:  'POST',
      headers: addGatewaySignatureHeaders({
        'content-type':         'application/json',
        'x-razorpay-signature': req.headers['x-razorpay-signature'] || '',
      }, {
        method: 'POST',
        path: getPathFromUrl(webhookUrl),
        tenantId: req.headers['x-tenant-id'] || '',
        requestId: req.requestId,
        secret: config.gateway?.hmacSecret,
      }),
      body:   req.body,
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      logger.error('Razorpay webhook forward rejected by payment-microservice', { status: response.status });
      // 4xx = invalid signature/payload — do not ask the provider to retry.
      return res.sendStatus(response.status >= 500 ? 502 : 200);
    }
    return res.sendStatus(200);
  } catch (err) {
    logger.error('Razorpay webhook forwarding error', { error: err.message });
    // Surface a retryable failure so Razorpay redelivers the event.
    return res.sendStatus(502);
  }
});

/**
 * POST /api/payments/webhooks/stripe
 * Forwards the signed raw payload to payment-microservice for verification + processing.
 */
router.post('/webhooks/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
  if (!config.payment?.serviceUrl) {
    // 503 (not 200) so Stripe retries instead of silently dropping the event.
    logger.warn('Stripe webhook received but PAYMENT_SERVICE_URL not set');
    return res.sendStatus(503);
  }

  try {
    const webhookUrl = `${pmUrl()}/api/v1/webhooks/stripe`;
    const response = await fetch(webhookUrl, {
      method:  'POST',
      headers: addGatewaySignatureHeaders({
        'content-type':    'application/json',
        'stripe-signature': req.headers['stripe-signature'] || '',
      }, {
        method: 'POST',
        path: getPathFromUrl(webhookUrl),
        tenantId: req.headers['x-tenant-id'] || '',
        requestId: req.requestId,
        secret: config.gateway?.hmacSecret,
      }),
      body:   req.body,
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      logger.error('Stripe webhook forward rejected by payment-microservice', { status: response.status });
      // 4xx = invalid signature/payload — do not ask the provider to retry.
      return res.sendStatus(response.status >= 500 ? 502 : 200);
    }
    return res.sendStatus(200);
  } catch (err) {
    logger.error('Stripe webhook forwarding error', { error: err.message });
    // Surface a retryable failure so Stripe redelivers the event.
    return res.sendStatus(502);
  }
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

    const tenantId = resolveEffectiveTenantId(req.headers['x-tenant-id']);
    const result   = await pmApi('GET', '/api/v1/payments/methods', {
      tenantId,
      requestId: req.requestId,
    });

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

/**
 * GET /api/payments/subscriptions/plans
 *
 * Proxies plan catalog reads to payment-microservice so clients can discover
 * available plans through the gateway contract.
 */
router.get('/subscriptions/plans', async (req, res, next) => {
  try {
    if (!config.payment?.serviceUrl) {
      throw new AppError('Payment service is not configured.', 503);
    }

    // Public catalog read — no tenant requirement, but still signed so the
    // GatewayHmacGuard on payment-microservice accepts it.
    const qs = new URLSearchParams(req.query).toString();
    const plansUrl = `${pmUrl()}/api/v1/subscriptions/plans${qs ? `?${qs}` : ''}`;
    const result = await apiCall(plansUrl, {
      method: 'GET',
      headers: addGatewaySignatureHeaders({}, {
        method: 'GET',
        path: getPathFromUrl(plansUrl),
        tenantId: '',
        requestId: '',
        secret: config.gateway?.hmacSecret,
      }),
    });

    if (result.error) {
      logger.error('payment plan catalog failed', { status: result.status });
      throw new AppError(result.data?.message || 'Failed to fetch subscription plans.', result.status || 502);
    }

    return res.status(200).json(result.data);
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

      const result = await pmApi('GET', '/api/v1/admin/dashboard', {
        bearer: req.headers['authorization'],
        tenantId: req.headers['x-tenant-id'],
        requestId: req.requestId,
      });

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
      const result = await pmApi('GET', `/api/v1/admin/transactions${qs ? `?${qs}` : ''}`, {
        bearer: req.headers['authorization'],
        tenantId: req.headers['x-tenant-id'],
        requestId: req.requestId,
      });

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
      const result = await pmApi('GET', `/api/v1/admin/subscriptions${qs ? `?${qs}` : ''}`, {
        bearer: req.headers['authorization'],
        tenantId: req.headers['x-tenant-id'],
        requestId: req.requestId,
      });

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
