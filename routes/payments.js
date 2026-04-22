/**
 * routes/payments.js
 *
 * Handles payment gateway integration for all EasyDev products.
 *
 * Supported gateways:
 *   - Razorpay  (popular in India)
 *   - Stripe    (international)
 *
 * Every successful payment ends with a call to productProvisioner.provision()
 * which creates the purchased product's account and returns a loginUrl.
 *
 * Required env vars (per gateway — leave unset to disable that gateway):
 *   RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET, RAZORPAY_WEBHOOK_SECRET
 *   STRIPE_SECRET_KEY,  STRIPE_WEBHOOK_SECRET
 *
 * POST /api/payments/razorpay/create-order
 * POST /api/payments/razorpay/verify
 * POST /api/payments/stripe/create-session
 * GET  /api/payments/stripe/verify-session
 * POST /api/payments/webhooks/razorpay   (Razorpay server-to-server webhook)
 * POST /api/payments/webhooks/stripe     (Stripe server-to-server webhook)
 */

import express            from 'express';
import crypto             from 'crypto';
import { config }         from '../config/index.js';
import logger             from '../utils/logger.js';
import { provision }      from '../utils/productProvisioner.js';
import { AppError }       from '../utils/errors.js';

const router = express.Router();

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Resolve the effective productId: explicit field beats plan-key heuristic. */
function resolveProductId(body) {
  if (body.productId) return body.productId;
  // Default to AI Communication for backward-compat with EasyDev checkout
  return 'easydev-communication';
}

/** Shared provisioning handler — used by both Razorpay verify and Stripe success. */
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
  } catch (provisionErr) {
    // Payment succeeded but provisioning failed — return partial success so the
    // frontend can still redirect to the dashboard and we can retry later.
    logger.error('Post-payment provisioning error (payment was successful)', {
      productId,
      email,
      error: provisionErr.message,
    });
    return res.status(200).json({
      success: true,
      message: 'Payment verified. Account setup encountered an issue — our team has been notified.',
      data: {
        paymentVerified:   true,
        provisioningError: provisionErr.message,
      },
    });
  }

  return res.status(200).json({
    success: true,
    message: 'Payment verified and account provisioned.',
    data: {
      paymentVerified: true,
      ...provisionResult,
    },
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// RAZORPAY
// ─────────────────────────────────────────────────────────────────────────────

/**
 * POST /api/payments/razorpay/create-order
 *
 * Body: { planKey, customerEmail, productId? }
 * Returns: { orderId, amount, currency, keyId }
 */
router.post('/razorpay/create-order', async (req, res, next) => {
  try {
    const { keyId, keySecret } = config.razorpay ?? {};
    if (!keyId || !keySecret) {
      throw new AppError('Razorpay is not configured on this server.', 503);
    }

    const { planKey, customerEmail, productId: _productId, amount: rawAmount } = req.body;
    if (!planKey || !customerEmail) {
      throw new AppError('planKey and customerEmail are required.', 400);
    }

    // Determine amount in paise (INR smallest unit).
    // For a real deployment load the price from your DB / price catalog.
    // Here we map the EasyDev plan keys to fixed amounts.
    const PLAN_AMOUNT_PAISE = {
      starter:  199900,   // ₹1,999
      growth:   499900,   // ₹4,999
      business: 1299900,  // ₹12,999
    };
    const amount = rawAmount ?? PLAN_AMOUNT_PAISE[planKey?.toLowerCase()] ?? 499900;

    // Call Razorpay Orders API
    const credentials = Buffer.from(`${keyId}:${keySecret}`).toString('base64');
    const rzRes = await fetch('https://api.razorpay.com/v1/orders', {
      method: 'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Basic ${credentials}`,
      },
      body: JSON.stringify({
        amount,
        currency: 'INR',
        receipt:  `rcpt_${Date.now()}`,
        notes:    { planKey, customerEmail },
      }),
      signal: AbortSignal.timeout(15_000),
    });

    const rzBody = await rzRes.json();
    if (!rzRes.ok) {
      throw new AppError(rzBody?.error?.description || 'Failed to create Razorpay order.', 502);
    }

    return res.status(201).json({
      success:  true,
      message:  'Razorpay order created.',
      data: {
        orderId:  rzBody.id,
        amount:   rzBody.amount,
        currency: rzBody.currency,
        keyId,
      },
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/payments/razorpay/verify
 *
 * Body: { orderId, paymentId, signature, planKey, name, email, productId?, businessName?, externalId? }
 * Returns: { paymentVerified, loginUrl?, ... }
 */
router.post('/razorpay/verify', async (req, res, next) => {
  try {
    const { keySecret } = config.razorpay ?? {};
    if (!keySecret) throw new AppError('Razorpay is not configured on this server.', 503);

    const { orderId, paymentId, signature, planKey, name, email, businessName, externalId } = req.body;

    if (!orderId || !paymentId || !signature || !email) {
      throw new AppError('orderId, paymentId, signature, and email are required.', 400);
    }

    // Verify HMAC-SHA256 signature
    const expected = crypto
      .createHmac('sha256', keySecret)
      .update(`${orderId}|${paymentId}`)
      .digest('hex');

    if (!crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature))) {
      logger.warn('Razorpay signature mismatch', { orderId, paymentId });
      throw new AppError('Invalid payment signature.', 400);
    }

    const productId = resolveProductId(req.body);

    await handlePostPayment(res, { productId, name, email, planKey, paymentId, businessName, externalId });
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
 * Body: { planKey, customerEmail, successUrl, cancelUrl, productId? }
 * Returns: { sessionId, sessionUrl }
 */
router.post('/stripe/create-session', async (req, res, next) => {
  try {
    const { secretKey } = config.stripe ?? {};
    if (!secretKey) throw new AppError('Stripe is not configured on this server.', 503);

    const { planKey, customerEmail, successUrl, cancelUrl, productId: _productId } = req.body;
    if (!planKey || !customerEmail || !successUrl || !cancelUrl) {
      throw new AppError('planKey, customerEmail, successUrl, and cancelUrl are required.', 400);
    }

    // Price catalog (unit_amount in cents / paise depending on currency)
    const PLAN_PRICES = {
      starter:  { amount: 2700, currency: 'usd', name: 'EasyDev Starter'  },
      growth:   { amount: 6700, currency: 'usd', name: 'EasyDev Growth'   },
      business: { amount: 17400, currency: 'usd', name: 'EasyDev Business' },
    };
    const price = PLAN_PRICES[planKey?.toLowerCase()];
    if (!price) throw new AppError(`Invalid plan key: ${planKey}`, 400);

    const stripeRes = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: {
        'Authorization':  `Bearer ${secretKey}`,
        'Content-Type':   'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        'payment_method_types[]':             'card',
        'mode':                               'payment',
        'customer_email':                     customerEmail,
        'success_url':                        successUrl,
        'cancel_url':                         cancelUrl,
        'line_items[0][price_data][currency]':            price.currency,
        'line_items[0][price_data][unit_amount]':         String(price.amount),
        'line_items[0][price_data][product_data][name]':  price.name,
        'line_items[0][quantity]':            '1',
        'metadata[planKey]':                  planKey,
      }),
      signal: AbortSignal.timeout(15_000),
    });

    const stripeBody = await stripeRes.json();
    if (!stripeRes.ok) {
      throw new AppError(stripeBody?.error?.message || 'Failed to create Stripe session.', 502);
    }

    return res.status(201).json({
      success: true,
      message: 'Stripe checkout session created.',
      data: {
        sessionId:  stripeBody.id,
        sessionUrl: stripeBody.url,
      },
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/payments/stripe/verify-session?sessionId=cs_xxx&planKey=growth&name=...&email=...
 *
 * Called after Stripe redirects back to the success URL.
 * Verifies the session is paid, then provisions the product.
 */
router.get('/stripe/verify-session', async (req, res, next) => {
  try {
    const { secretKey } = config.stripe ?? {};
    if (!secretKey) throw new AppError('Stripe is not configured on this server.', 503);

    const { sessionId, planKey, name, email, businessName, externalId, productId: queryProductId } = req.query;
    if (!sessionId || !email) throw new AppError('sessionId and email are required.', 400);

    // Fetch session from Stripe
    const stripeRes = await fetch(`https://api.stripe.com/v1/checkout/sessions/${sessionId}`, {
      headers: { Authorization: `Bearer ${secretKey}` },
      signal:  AbortSignal.timeout(15_000),
    });
    const session = await stripeRes.json();

    if (!stripeRes.ok) {
      throw new AppError(session?.error?.message || 'Failed to retrieve Stripe session.', 502);
    }

    if (session.payment_status !== 'paid') {
      throw new AppError(`Payment not completed. Status: ${session.payment_status}`, 402);
    }

    const resolvedPlanKey = planKey || session.metadata?.planKey || 'growth';
    const resolvedProductId = queryProductId || resolveProductId({});

    await handlePostPayment(res, {
      productId:    resolvedProductId,
      name:         name || session.customer_details?.name || email,
      email:        email || session.customer_email,
      planKey:      resolvedPlanKey,
      paymentId:    session.payment_intent || sessionId,
      businessName: businessName,
      externalId:   externalId,
    });
  } catch (err) {
    next(err);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// WEBHOOKS  (server-to-server, signed)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * POST /api/payments/webhooks/razorpay
 *
 * Razorpay sends payment.captured events here.
 * Must be registered in the Razorpay dashboard under Webhooks.
 * Raw body required for HMAC verification — parsed separately below.
 */
router.post('/webhooks/razorpay', express.raw({ type: 'application/json' }), async (req, res) => {
  const webhookSecret = config.razorpay?.webhookSecret;
  if (!webhookSecret) {
    logger.warn('Razorpay webhook received but RAZORPAY_WEBHOOK_SECRET not set — ignoring');
    return res.sendStatus(200);
  }

  const signature = req.headers['x-razorpay-signature'];
  const expected  = crypto.createHmac('sha256', webhookSecret).update(req.body).digest('hex');

  if (!signature || !crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature))) {
    logger.warn('Razorpay webhook signature mismatch — request rejected');
    return res.status(400).json({ success: false, message: 'Invalid webhook signature.' });
  }

  let event;
  try {
    event = JSON.parse(req.body.toString());
  } catch {
    return res.status(400).json({ success: false, message: 'Invalid JSON body.' });
  }

  if (event.event === 'payment.captured') {
    const payment  = event.payload?.payment?.entity ?? {};
    const notes    = payment.notes ?? {};
    const planKey  = notes.planKey   || 'growth';
    const email    = notes.customerEmail || payment.email;

    if (email) {
      provision(resolveProductId(notes), {
        name:      notes.name || email,
        email,
        planKey,
        paymentId: payment.id,
      }).catch(err => logger.error('Webhook provisioning failed', { error: err.message, paymentId: payment.id }));
    }
  }

  res.sendStatus(200);
});

/**
 * POST /api/payments/webhooks/stripe
 *
 * Stripe sends checkout.session.completed events here.
 * Must be registered in the Stripe dashboard under Webhooks → Add endpoint.
 */
router.post('/webhooks/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
  const webhookSecret = config.stripe?.webhookSecret;
  if (!webhookSecret) {
    logger.warn('Stripe webhook received but STRIPE_WEBHOOK_SECRET not set — ignoring');
    return res.sendStatus(200);
  }

  const sig = req.headers['stripe-signature'];
  let event;

  try {
    // Manual Stripe signature verification (avoids Stripe SDK dependency)
    const payload   = req.body.toString();
    const parts     = String(sig).split(',').reduce((acc, p) => {
      const [k, v] = p.split('=');
      acc[k] = v;
      return acc;
    }, {});
    const timestamp = parts.t;
    const sigV1     = parts.v1;

    const expected = crypto
      .createHmac('sha256', webhookSecret)
      .update(`${timestamp}.${payload}`)
      .digest('hex');

    if (!sigV1 || !crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sigV1))) {
      logger.warn('Stripe webhook signature mismatch');
      return res.status(400).json({ success: false, message: 'Invalid webhook signature.' });
    }

    event = JSON.parse(payload);
  } catch (err) {
    return res.status(400).json({ success: false, message: 'Webhook verification failed.' });
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data?.object ?? {};
    if (session.payment_status === 'paid') {
      const planKey = session.metadata?.planKey || 'growth';
      const email   = session.customer_email;

      if (email) {
        provision(resolveProductId(session.metadata ?? {}), {
          name:      session.customer_details?.name || email,
          email,
          planKey,
          paymentId: session.payment_intent || session.id,
        }).catch(err => logger.error('Stripe webhook provisioning failed', {
          error: err.message,
          sessionId: session.id,
        }));
      }
    }
  }

  res.sendStatus(200);
});

export default router;
