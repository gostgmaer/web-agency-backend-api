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
import { provision } from '../utils/productProvisioner.js';
import { AppError }  from '../utils/errors.js';
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

export default router;
