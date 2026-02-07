import express from 'express';
import { authenticate } from '../middleware/auth.js';
import { validateRequest, sanitizeInput } from '../middleware/validation.js';
import { subscribeValidation, unsubscribeValidation } from '../validation/newsletterValidation.js';
import { getPaginationParams, getPaginationMeta } from '../utils/pagination.js';
import { sendNewsletterWelcome } from '../utils/email.js';
import Newsletter from '../models/Newsletter.js';
import logger from '../utils/logger.js';
import { NotFoundError, BadRequestError, ConflictError } from '../utils/errors.js';

const router = express.Router();

/**
 * @swagger
 * /api/newsletter/subscribe:
 *   post:
 *     summary: Subscribe to newsletter
 *     tags: [Newsletter]
 */
router.post('/subscribe', subscribeValidation, validateRequest, sanitizeInput, async (req, res, next) => {
  try {
    const { email, name, preferences } = req.body;

    // Check if already subscribed
    const existing = await Newsletter.findOne({ email: email.toLowerCase() });

    if (existing) {
      if (existing.isActive) {
        return res.status(200).json({
          success: true,
          message: 'You are already subscribed to our newsletter'
        });
      }

      // Resubscribe
      await existing.resubscribe();

      logger.info('Newsletter resubscribed', { email });

      return res.json({
        success: true,
        message: 'Welcome back! You have been resubscribed to our newsletter'
      });
    }

    const subscriber = new Newsletter({
      email: email.toLowerCase(),
      name,
      preferences,
      source: 'website',
      ipAddress: req.ip,
      userAgent: req.get('User-Agent'),
      isConfirmed: false // For double opt-in
    });

    // Generate confirmation token
    await subscriber.generateConfirmationToken();

    // Send welcome/confirmation email (non-blocking)
    sendNewsletterWelcome(subscriber).catch(emailError => {
      logger.error('Failed to send newsletter welcome email:', {
        error: emailError.message,
        email
      });
    });

    logger.info('Newsletter subscribed', {
      email,
      source: subscriber.source
    });

    res.status(201).json({
      success: true,
      message: 'Please check your email to confirm your subscription',
      data: {
        email: subscriber.email,
        requiresConfirmation: true
      }
    });
  } catch (error) {
    next(error);
  }
});

/**
 * @swagger
 * /api/newsletter/confirm/{token}:
 *   get:
 *     summary: Confirm newsletter subscription
 *     tags: [Newsletter]
 */
router.get('/confirm/:token', async (req, res, next) => {
  try {
    const subscriber = await Newsletter.findOne({
      confirmationToken: req.params.token
    }).select('+confirmationToken');

    if (!subscriber) {
      throw new NotFoundError('Invalid or expired confirmation token');
    }

    if (subscriber.isConfirmed) {
      return res.json({
        success: true,
        message: 'Your subscription is already confirmed'
      });
    }

    await subscriber.confirmSubscription();

    logger.info('Newsletter subscription confirmed', {
      email: subscriber.email
    });

    res.json({
      success: true,
      message: 'Your subscription has been confirmed. Thank you!'
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
 */
router.post('/unsubscribe', unsubscribeValidation, validateRequest, async (req, res, next) => {
  try {
    const { email, reason, feedback } = req.body;

    const subscriber = await Newsletter.findOne({ email: email.toLowerCase() });

    if (!subscriber) {
      throw new NotFoundError('Subscription not found');
    }

    if (!subscriber.isActive) {
      return res.json({
        success: true,
        message: 'You are already unsubscribed'
      });
    }

    await subscriber.unsubscribe(reason, feedback);

    logger.info('Newsletter unsubscribed', {
      email,
      reason
    });

    res.json({
      success: true,
      message: 'You have been successfully unsubscribed. We are sorry to see you go!'
    });
  } catch (error) {
    next(error);
  }
});

/**
 * @swagger
 * /api/newsletter/subscribers:
 *   get:
 *     summary: Get all subscribers (Admin only)
 *     tags: [Newsletter]
 *     security:
 *       - bearerAuth: []
 */
router.get('/subscribers', authenticate, async (req, res, next) => {
  try {
    const { page, limit, skip } = getPaginationParams(req);
    const { isActive, isConfirmed, tag, search } = req.query;

    let filter = {};
    if (isActive !== undefined) filter.isActive = isActive === 'true';
    if (isConfirmed !== undefined) filter.isConfirmed = isConfirmed === 'true';
    if (tag) filter.tags = tag;
    if (search) {
      filter.$or = [
        { email: { $regex: search, $options: 'i' } },
        { name: { $regex: search, $options: 'i' } }
      ];
    }

    const total = await Newsletter.countDocuments(filter);
    const subscribers = await Newsletter.find(filter)
      .select('-confirmationToken')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit);

    const pagination = getPaginationMeta(total, page, limit);

    res.json({
      success: true,
      message: 'Subscribers retrieved successfully',
      data: { subscribers, pagination }
    });
  } catch (error) {
    next(error);
  }
});

/**
 * @swagger
 * /api/newsletter/stats:
 *   get:
 *     summary: Get newsletter statistics (Admin only)
 *     tags: [Newsletter]
 *     security:
 *       - bearerAuth: []
 */
router.get('/stats', authenticate, async (req, res, next) => {
  try {
    const stats = await Newsletter.getStats();

    // Recent growth (last 30 days)
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const recentSubscribers = await Newsletter.countDocuments({
      createdAt: { $gte: thirtyDaysAgo }
    });

    const recentUnsubscribes = await Newsletter.countDocuments({
      unsubscribedAt: { $gte: thirtyDaysAgo }
    });

    res.json({
      success: true,
      message: 'Newsletter statistics retrieved',
      data: {
        ...stats,
        recentGrowth: {
          period: '30 days',
          newSubscribers: recentSubscribers,
          unsubscribes: recentUnsubscribes,
          netGrowth: recentSubscribers - recentUnsubscribes
        }
      }
    });
  } catch (error) {
    next(error);
  }
});

/**
 * @swagger
 * /api/newsletter/subscriber/{id}:
 *   get:
 *     summary: Get subscriber by ID (Admin only)
 *     tags: [Newsletter]
 *     security:
 *       - bearerAuth: []
 */
router.get('/subscriber/:id', authenticate, async (req, res, next) => {
  try {
    const subscriber = await Newsletter.findById(req.params.id)
      .select('-confirmationToken');

    if (!subscriber) {
      throw new NotFoundError('Subscriber');
    }

    res.json({
      success: true,
      message: 'Subscriber retrieved',
      data: { subscriber }
    });
  } catch (error) {
    next(error);
  }
});

/**
 * @swagger
 * /api/newsletter/subscriber/{id}/tags:
 *   patch:
 *     summary: Update subscriber tags (Admin only)
 *     tags: [Newsletter]
 *     security:
 *       - bearerAuth: []
 */
router.patch('/subscriber/:id/tags', authenticate, async (req, res, next) => {
  try {
    const { tags } = req.body;

    if (!Array.isArray(tags)) {
      throw new BadRequestError('Tags must be an array');
    }

    const subscriber = await Newsletter.findByIdAndUpdate(
      req.params.id,
      { tags: tags.map(t => t.toLowerCase().trim()) },
      { new: true }
    );

    if (!subscriber) {
      throw new NotFoundError('Subscriber');
    }

    logger.info('Subscriber tags updated', {
      subscriberId: subscriber._id,
      tags,
      updatedBy: req.admin.email
    });

    res.json({
      success: true,
      message: 'Tags updated successfully',
      data: { subscriber }
    });
  } catch (error) {
    next(error);
  }
});

/**
 * @swagger
 * /api/newsletter/track/open:
 *   post:
 *     summary: Track email open (for email tracking pixel)
 *     tags: [Newsletter]
 */
router.post('/track/open', async (req, res, next) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(200).end(); // Silent fail for tracking
    }

    const subscriber = await Newsletter.findOne({ email: email.toLowerCase() });
    if (subscriber) {
      await subscriber.trackEmailOpened();
    }

    res.status(200).end();
  } catch (error) {
    res.status(200).end(); // Silent fail for tracking
  }
});

/**
 * @swagger
 * /api/newsletter/track/click:
 *   post:
 *     summary: Track email click
 *     tags: [Newsletter]
 */
router.post('/track/click', async (req, res, next) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(200).end();
    }

    const subscriber = await Newsletter.findOne({ email: email.toLowerCase() });
    if (subscriber) {
      await subscriber.trackEmailClicked();
    }

    res.status(200).end();
  } catch (error) {
    res.status(200).end();
  }
});

/**
 * @swagger
 * /api/newsletter/subscriber/{id}:
 *   delete:
 *     summary: Delete subscriber (Admin only)
 *     tags: [Newsletter]
 *     security:
 *       - bearerAuth: []
 */
router.delete('/subscriber/:id', authenticate, async (req, res, next) => {
  try {
    const subscriber = await Newsletter.findByIdAndDelete(req.params.id);

    if (!subscriber) {
      throw new NotFoundError('Subscriber');
    }

    logger.info('Subscriber deleted', {
      email: subscriber.email,
      deletedBy: req.admin.email
    });

    res.json({
      success: true,
      message: 'Subscriber deleted successfully',
      data: {}
    });
  } catch (error) {
    next(error);
  }
});

export default router;