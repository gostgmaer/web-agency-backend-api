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
 *   "bypass" mode for direct frontend calls — determined by auth strategy
 *   in config. See notes inline.
 */

import express       from 'express';
import axios         from 'axios';
import { provision } from '../utils/productProvisioner.js';
import { AppError }  from '../utils/errors.js';
import { authenticate, authorize } from '../middleware/auth.js';
import { config }    from '../config/index.js';
import logger        from '../utils/logger.js';

const router = express.Router();

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/communication/provision
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Provision an AI Communication account.
 *
 * Body:
 *   name         {string}  required — customer full name
 *   email        {string}  required — customer email
 *   planKey      {string}  required — EasyDev plan key (starter | growth | business)
 *   paymentId    {string}  optional — Razorpay/Stripe payment ID for audit trail
 *   businessName {string}  optional — company/brand name (defaults to name)
 *   externalId   {string}  optional — external reference ID
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
router.post('/provision', async (req, res, next) => {
  try {
    const { name, email, planKey, paymentId, businessName, externalId } = req.body;

    if (!name || typeof name !== 'string' || name.trim().length === 0) {
      throw new AppError('name is required.', 400);
    }
    if (!email || typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new AppError('A valid email address is required.', 400);
    }
    if (!planKey || typeof planKey !== 'string') {
      throw new AppError('planKey is required (starter | growth | business).', 400);
    }

    logger.info('Manual provision request', { email, planKey, paymentId });

    const result = await provision('easydev-communication', {
      name:         name.trim(),
      email:        email.toLowerCase().trim(),
      planKey:      planKey.toLowerCase().trim(),
      paymentId,
      businessName: businessName?.trim() || name.trim(),
      externalId,
    });

    return res.status(201).json({
      success: true,
      message: result.alreadyExists
        ? 'Account already exists — please log in.'
        : 'AI Communication account provisioned successfully.',
      data: result,
    });
  } catch (err) {
    next(err);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/communication/launch
//
// Generates a short-lived (5 min) SSO token via the IAM service and returns
// a signed launch URL to the AI Communication frontend.
//
// The EasyDev customer dashboard calls this endpoint when the customer clicks
// "Open App". The browser is then redirected to:
//   <COMMUNICATION_FRONTEND_URL>/sso?token=<ssoToken>&appId=<applicationId>
//
// The AI comm frontend exchanges the SSO token for a session (3-day cookie),
// so subsequent visits are auto-logged in.
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
// ─────────────────────────────────────────────────────────────────────────────
router.get('/launch', authenticate, authorize('member'), async (req, res, next) => {
  try {
    const iamCfg = config.iam;

    if (!iamCfg.applicationId) {
      throw new AppError('SSO launch is not configured (IAM_APPLICATION_ID missing).', 503);
    }
    if (!iamCfg.commFrontendUrl) {
      throw new AppError('SSO launch is not configured (COMMUNICATION_FRONTEND_URL missing).', 503);
    }

    // Forward the customer's own IAM JWT directly to the IAM SSO generate endpoint.
    // IAM uses @CurrentUser('userId') to resolve the caller from the JWT payload.
    const customerJwt = req.headers.authorization; // "Bearer <iam_access_token>"

    const iamRes = await axios.post(
      `${iamCfg.serviceUrl}/api/v1/iam/sso/generate`,
      {
        applicationId: iamCfg.applicationId,
        ...(iamCfg.tenantId ? { tenantId: iamCfg.tenantId } : {}),
      },
      {
        headers: {
          Authorization: customerJwt,
          'Content-Type': 'application/json',
        },
        timeout: 10_000,
      },
    );

    const { token, expiresIn } = iamRes.data?.data ?? iamRes.data;
    if (!token) throw new AppError('IAM did not return an SSO token.', 502);

    const launchUrl = `${iamCfg.commFrontendUrl}/sso?token=${encodeURIComponent(token)}&appId=${encodeURIComponent(iamCfg.applicationId)}`;

    logger.info('SSO launch URL generated', { userId: req.user.id, applicationId: iamCfg.applicationId });

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
    if (status === 404) return next(new AppError('Application not found — please contact support.', 404));
    logger.error('SSO launch failed', { error: err?.message });
    next(err);
  }
});

export default router;
