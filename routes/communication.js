/**
 * routes/communication.js
 *
 * Provision / manage EasyDev AI Communication Platform accounts.
 *
 * These routes are called by the EasyDev frontend (or by the payments route
 * after a successful Razorpay/Stripe payment).
 *
 * POST /api/communication/provision
 *   Provision a new AI Communication account.
 *   Requires a valid JWT (authenticate middleware) except in the test/dev
 *   "bypass" mode for direct frontend calls â€” determined by auth strategy
 *   in config. See notes inline.
 */

import express       from 'express';
import axios         from 'axios';
import jwt           from 'jsonwebtoken';
import { provision } from '../utils/productProvisioner.js';
import { resolveApplicationId, resolveTenantId } from '../utils/iamProvisioner.js';
import { AppError }  from '../utils/errors.js';
import { config }    from '../config/index.js';
import { authenticate } from '../middleware/auth.js';
import logger        from '../utils/logger.js';

const router = express.Router();

function decodeTenantIdFromBearer(authorizationHeader) {
  if (!authorizationHeader || !authorizationHeader.startsWith('Bearer ')) {
    return null;
  }

  try {
    const token = authorizationHeader.slice(7).trim();
    const decoded = jwt.decode(token);
    const tenantId = typeof decoded?.tenantId === 'string' ? decoded.tenantId.trim() : '';
    return tenantId || null;
  } catch {
    return null;
  }
}

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// POST /api/communication/provision
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/**
 * Provision an AI Communication account.
 *
 * Body:
 *   name         {string}  required â€” customer full name
 *   email        {string}  required â€” customer email
 *   planKey      {string}  required â€” EasyDev plan key (starter | growth | payg)
 *   paymentId    {string}  optional â€” Razorpay/Stripe payment ID for audit trail
 *   businessName {string}  optional â€” company/brand name (defaults to name)
 *   externalId   {string}  optional â€” external reference ID
 *
 * Returns:
 *   { success, message, data: { loginUrl, userId, businessId, temporaryPassword } }
 *
 * Auth note:
 *   This endpoint is intentionally unauthenticated so that EasyDev (a static
 *   export) can call it directly after a Razorpay payment. The security model
 *   relies on the fact that:
 *   - The endpoint only creates accounts, not reads or deletes.
 *   - The AI Communication backend itself is protected by X-Api-Key.
 *   - Rate limiting in the express app prevents abuse.
 *
 *   If you need stronger protection here, add the `authenticate` middleware
 *   from middleware/auth.js and require a Bearer token from the admin dashboard.
 */
router.post('/provision', authenticate, async (req, res, next) => {
  try {
    const { name, email, planKey, paymentId, businessName, externalId } = req.body;
    const requestedPlanKey = typeof planKey === 'string' ? planKey.toLowerCase().trim() : '';
    const communicationPlanMap = config.products?.['easydev-ai-communication']?.planMap || {};
    const normalizedPlanKey = communicationPlanMap[requestedPlanKey] || null;

    if (!name || typeof name !== 'string' || name.trim().length === 0) {
      throw new AppError('name is required.', 400);
    }
    if (!email || typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new AppError('A valid email address is required.', 400);
    }
    if (!requestedPlanKey) {
      throw new AppError('planKey is required (starter | growth | payg).', 400);
    }
    if (!normalizedPlanKey) {
      throw new AppError('Unsupported planKey. Use starter, growth, or payg.', 400);
    }

    const normalizedEmail = email.toLowerCase().trim();
    const normalizedActorEmail = String(req.user?.email || '').toLowerCase().trim();
    const actorRole = String(req.user?.role || '').toLowerCase();
    const isPrivilegedActor = ['admin', 'super_admin', 'tenant_admin', 'support', 'finance'].includes(actorRole);

    if (!isPrivilegedActor && normalizedActorEmail !== normalizedEmail) {
      throw new AppError('You can only provision the currently authenticated account.', 403);
    }

    logger.info('Manual provision request', {
      actorId: req.user?.id,
      actorRole,
      email: normalizedEmail,
      planKey: normalizedPlanKey,
      paymentId,
    });

    const result = await provision('easydev-ai-communication', {
      name:         name.trim(),
      email:        normalizedEmail,
      planKey:      normalizedPlanKey,
      paymentId,
      businessName: businessName?.trim() || name.trim(),
      externalId,
    });

    return res.status(201).json({
      success: true,
      message: 'AI Communication account provisioned successfully.',
      data: result,
    });
  } catch (err) {
    next(err);
  }
});

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// GET /api/communication/launch?slug=easydev-ai-communication
// GET /api/communication/launch?applicationId=<uuid-or-publicId>
//
// Generates a short-lived (5 min) SSO token via the IAM service and returns
// a signed launch URL to the product's frontend.
//
// Caller must supply exactly one of:
//   ?slug=<kebab-slug>          preferred â€” stable, no UUID needed
//   ?applicationId=<id>         fallback  â€” UUID or publicId from IAM app table
//
// The product's frontendUrl is stored on its IAM application record and is
// returned by SSO /generate â€” no env var required here.
//
// Auth strategy:
//   The EasyDev customer is authenticated against the same IAM service
//   (multi-tannet-auth-services). Their Bearer token in the Authorization header
//   IS an IAM JWT. We forward it directly to the IAM SSO generate endpoint,
//   which reads the user identity from `@CurrentUser('userId')`.
//
//   No admin JWT / x-on-behalf-of required.
//
// Requires:  Authorization: Bearer <IAM access token>
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
router.get('/launch', async (req, res, next) => {
  try {
    const customerJwt = req.headers.authorization;
    if (!customerJwt || !customerJwt.startsWith('Bearer ')) {
      return next(new AppError('Launch requires a valid Bearer access token. Open it from the dashboard or send Authorization: Bearer YOUR_ACCESS_TOKEN.', 401));
    }

    const { slug, applicationId } = req.query;
    const defaultCommunicationSlug = config.products?.['easydev-ai-communication']?.iamProvisioning?.applicationSlug;

    if (slug && applicationId) {
      return next(new AppError('Provide only one of ?slug= or ?applicationId=, not both.', 400));
    }

    // Sanitise â€” both must be non-empty strings
    const resolvedSlug = typeof slug === 'string' && slug.trim()
      ? slug.trim()
      : (!applicationId && defaultCommunicationSlug ? defaultCommunicationSlug : undefined);
    const resolvedAppId = typeof applicationId === 'string' && applicationId.trim() ? applicationId.trim() : undefined;

    if (!resolvedSlug && !resolvedAppId) {
      return next(new AppError('Provide either ?slug= or ?applicationId= to identify the application.', 400));
    }

    const iamCfg = config.iam;
    const tokenTenantId = decodeTenantIdFromBearer(customerJwt);
    const communicationTenantRef =
      tokenTenantId ||
      config.products?.['easydev-ai-communication']?.iamProvisioning?.tenantSlug ||
      config.tenant.defaultTenantId;

    let resolvedTenantId;
    if (communicationTenantRef) {
      try {
        const looksLikeUuid =
          typeof communicationTenantRef === 'string' &&
          /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(communicationTenantRef);

        resolvedTenantId = looksLikeUuid
          ? communicationTenantRef
          : await resolveTenantId(communicationTenantRef);
      } catch (tenantError) {
        logger.error('Failed to resolve IAM tenant for SSO launch', {
          tenantRef: communicationTenantRef,
          error: tenantError?.message,
        });
        return next(new AppError('SSO launch is misconfigured â€” unable to resolve the IAM tenant.', 503));
      }
    }

    const launchApplicationId = resolvedAppId;

    const iamRes = await axios.post(
      `${iamCfg.serviceUrl}/api/v1/iam/sso/generate`,
      {
        ...(resolvedSlug       ? { slug: resolvedSlug }             : {}),
        ...(resolvedAppId      ? { applicationId: resolvedAppId }   : {}),
        ...(resolvedTenantId   ? { tenantId: resolvedTenantId }     : {}),
      },
      {
        headers: {
          Authorization: customerJwt,
          'Content-Type': 'application/json',
        },
        timeout: 10_000,
      },
    );

    const { token, expiresIn, frontendUrl } = iamRes.data?.data ?? iamRes.data;
    if (!token) throw new AppError('IAM did not return an SSO token.', 502);

    // frontendUrl is stored on the IAM application record â€” not in env.
    if (!frontendUrl) {
      const identifier = resolvedSlug ?? resolvedAppId;
      throw new AppError(`SSO launch misconfigured â€” set frontendUrl on the '${identifier}' application record in IAM.`, 503);
    }

    const launchParams = new URLSearchParams({ token });
    if (resolvedSlug) {
      launchParams.set('slug', resolvedSlug);
    }
    if (launchApplicationId) {
      launchParams.set('appId', launchApplicationId);
    }

    const launchUrl = `${frontendUrl}/sso?${launchParams.toString()}`;

    logger.info('SSO launch URL generated', { slug: resolvedSlug, applicationId: launchApplicationId });

    return res.json({
      success: true,
      message: 'SSO launch URL generated',
      data: { launchUrl, expiresIn },
    });
  } catch (err) {
    if (err instanceof AppError) return next(err);
    const status = err?.response?.status;
    if (status === 401) return next(new AppError('Your session has expired. Please log in again.', 401));
    if (status === 403) return next(new AppError('You do not have access to this application. Ensure your AI Communication subscription is active.', 403));
    if (status === 404) return next(new AppError('Application not found â€” please contact support.', 404));
    logger.error('SSO launch failed', { error: err?.message });
    next(err);
  }
});

// /api/communication/admin/* is handled by proxy.js (no jsonParser, createProxyMiddleware)
// See routes/proxy.js -> router.use('/communication/admin', authenticate, buildProxy(...))

export default router;
