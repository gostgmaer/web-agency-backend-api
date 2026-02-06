import express from 'express';
import { authenticate } from '../middleware/auth.js';
import { validateRequest, sanitizeInput } from '../middleware/validation.js';
import { subscribeValidation, unsubscribeValidation } from '../validation/newsletterValidation.js';
import { getPaginationParams, getPaginationMeta } from '../utils/pagination.js';
import { sendWelcomeEmail } from '../utils/email.js';
import Newsletter from '../models/Newsletter.js';
import logger from '../utils/logger.js';

const router = express.Router();

/**
 * @swagger
 * /api/newsletter/subscribe:
 *   post:
 *     summary: Subscribe to newsletter
 *     tags: [Newsletter]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - email
 *             properties:
 *               email:
 *                 type: string
 *                 format: email
 *     responses:
 *       200:
 *         description: Subscription successful
 *       400:
 *         description: Validation error or already subscribed
 */
router.post('/subscribe', subscribeValidation, validateRequest, sanitizeInput, async (req, res, next) => {
  try {
    const { email } = req.body;

    // Check if already subscribed
    let subscriber = await Newsletter.findOne({ email });

    if (subscriber) {
      if (subscriber.isActive) {
        return res.status(400).json({
          success: false,
          message: 'Email is already subscribed to our newsletter'
        });
      } else {
        // Reactivate subscription
        subscriber.isActive = true;
        subscriber.subscribedAt = new Date();
        subscriber.unsubscribedAt = null;
        await subscriber.save();

        // Send welcome email for resubscription
        try {
          await sendWelcomeEmail(email);
        } catch (emailError) {
          logger.error('Failed to send welcome email for resubscription:', emailError);
          // Don't fail the request if email fails
        }

        logger.info('Newsletter resubscription', { email });

        return res.json({
          success: true,
          message: 'Successfully resubscribed to our newsletter',
          data: { email }
        });
      }
    }

    // Create new subscription
    subscriber = new Newsletter({ email });
    await subscriber.save();

    // Send welcome email
    try {
      await sendWelcomeEmail(email);
    } catch (emailError) {
      logger.error('Failed to send welcome email:', emailError);
      // Don't fail the request if email fails
    }

    logger.info('Newsletter subscription', { email });

    res.status(201).json({
      success: true,
      message: 'Successfully subscribed to our newsletter',
      data: { email }
    });
  } catch (error) {
    next(error);
  }
});

/**
 * @swagger
 * /api/newsletter/unsubscribe:
 *   post:
 *     summary: Unsubscribe from newsletter
 *     tags: [Newsletter]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - email
 *             properties:
 *               email:
 *                 type: string
 *                 format: email
 *     responses:
 *       200:
 *         description: Unsubscription successful
 *       404:
 *         description: Email not found in newsletter
 */
router.post('/unsubscribe', unsubscribeValidation, validateRequest, sanitizeInput, async (req, res, next) => {
  try {
    const { email } = req.body;

    const subscriber = await Newsletter.findOne({ email, isActive: true });

    if (!subscriber) {
      return res.status(404).json({
        success: false,
        message: 'Email not found in our newsletter subscribers'
      });
    }

    subscriber.isActive = false;
    subscriber.unsubscribedAt = new Date();
    await subscriber.save();

    logger.info('Newsletter unsubscription', { email });

    res.json({
      success: true,
      message: 'Successfully unsubscribed from our newsletter',
      data: { email }
    });
  } catch (error) {
    next(error);
  }
});

/**
 * @swagger
 * /api/newsletter:
 *   get:
 *     summary: Get newsletter subscribers (Admin only)
 *     tags: [Newsletter]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *           default: 1
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 10
 *       - in: query
 *         name: status
 *         schema:
 *           type: string
 *           enum: [active, inactive]
 *     responses:
 *       200:
 *         description: Subscribers retrieved successfully
 *       401:
 *         description: Unauthorized
 */
router.get('/', authenticate, async (req, res, next) => {
  try {
    const { page, limit, skip } = getPaginationParams(req);
    const { status } = req.query;

    let filter = {};
    if (status === 'active') filter.isActive = true;
    if (status === 'inactive') filter.isActive = false;

    const total = await Newsletter.countDocuments(filter);
    const subscribers = await Newsletter.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit);

    const pagination = getPaginationMeta(total, page, limit);

    res.json({
      success: true,
      message: 'Newsletter subscribers retrieved successfully',
      data: {
        subscribers,
        pagination
      }
    });
  } catch (error) {
    next(error);
  }
});

/**
 * @swagger
 * /api/newsletter/{id}:
 *   delete:
 *     summary: Delete newsletter subscriber (Admin only)
 *     tags: [Newsletter]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Subscriber deleted successfully
 *       401:
 *         description: Unauthorized
 *       404:
 *         description: Subscriber not found
 */
router.delete('/:id', authenticate, async (req, res, next) => {
  try {
    const subscriber = await Newsletter.findByIdAndDelete(req.params.id);

    if (!subscriber) {
      return res.status(404).json({
        success: false,
        message: 'Newsletter subscriber not found'
      });
    }

    logger.info('Newsletter subscriber deleted', { 
      subscriberId: req.params.id, 
      email: subscriber.email,
      deletedBy: req.admin.email 
    });

    res.json({
      success: true,
      message: 'Newsletter subscriber deleted successfully',
      data: {}
    });
  } catch (error) {
    next(error);
  }
});

export default router;