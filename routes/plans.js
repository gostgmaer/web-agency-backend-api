import express from 'express';
import { authenticate } from '../middleware/auth.js';
import { validateRequest, sanitizeInput } from '../middleware/validation.js';
import { createPlanValidation, updatePlanValidation, planIdValidation } from '../validation/planValidation.js';
import { getPaginationParams, getPaginationMeta } from '../utils/pagination.js';
import Plan from '../models/Plan.js';
import logger from '../utils/logger.js';
import { NotFoundError, BadRequestError } from '../utils/errors.js';

const router = express.Router();

/**
 * @swagger
 * /api/plans:
 *   get:
 *     summary: Get active plans (Public)
 *     tags: [Plans]
 */
router.get('/', async (req, res, next) => {
  try {
    const { category, billingCycle, targetAudience } = req.query;

    let filter = { isActive: true, isArchived: false };
    if (category) filter.category = category;
    if (billingCycle) filter.billingCycle = billingCycle;
    if (targetAudience) filter.targetAudience = targetAudience;

    const plans = await Plan.find(filter)
      .sort({ order: 1, price: 1 });

    res.json({
      success: true,
      message: 'Plans retrieved successfully',
      data: { plans }
    });
  } catch (error) {
    next(error);
  }
});

/**
 * @swagger
 * /api/plans/featured:
 *   get:
 *     summary: Get featured plans (Public)
 *     tags: [Plans]
 */
router.get('/featured', async (req, res, next) => {
  try {
    const plans = await Plan.find({
      isActive: true,
      isArchived: false,
      $or: [{ isFeatured: true }, { isPopular: true }]
    })
      .sort({ order: 1 })
      .limit(3);

    res.json({
      success: true,
      message: 'Featured plans retrieved',
      data: { plans }
    });
  } catch (error) {
    next(error);
  }
});

/**
 * @swagger
 * /api/plans/compare:
 *   get:
 *     summary: Compare multiple plans (Public)
 *     tags: [Plans]
 */
router.get('/compare', async (req, res, next) => {
  try {
    const { ids } = req.query;

    if (!ids) {
      throw new BadRequestError('Plan IDs are required (comma-separated)');
    }

    const planIds = ids.split(',').map(id => id.trim());

    if (planIds.length < 2 || planIds.length > 4) {
      throw new BadRequestError('Please select 2-4 plans to compare');
    }

    const comparison = await Plan.compareFeatures(planIds);

    res.json({
      success: true,
      message: 'Plan comparison retrieved',
      data: comparison
    });
  } catch (error) {
    next(error);
  }
});

/**
 * @swagger
 * /api/plans/categories:
 *   get:
 *     summary: Get plan categories with counts (Public)
 *     tags: [Plans]
 */
router.get('/categories', async (req, res, next) => {
  try {
    const categories = await Plan.aggregate([
      { $match: { isActive: true, isArchived: false } },
      { $group: { _id: '$category', count: { $sum: 1 } } },
      { $sort: { count: -1 } }
    ]);

    res.json({
      success: true,
      message: 'Categories retrieved',
      data: { categories }
    });
  } catch (error) {
    next(error);
  }
});

/**
 * @swagger
 * /api/plans/admin:
 *   get:
 *     summary: Get all plans including inactive (Admin only)
 *     tags: [Plans]
 *     security:
 *       - bearerAuth: []
 */
router.get('/admin', authenticate, async (req, res, next) => {
  try {
    const { page, limit, skip } = getPaginationParams(req);
    const { category, isActive, isArchived, search } = req.query;

    let filter = {};
    if (category) filter.category = category;
    if (isActive !== undefined) filter.isActive = isActive === 'true';
    if (isArchived !== undefined) filter.isArchived = isArchived === 'true';

    if (search) {
      filter.$or = [
        { name: { $regex: search, $options: 'i' } },
        { description: { $regex: search, $options: 'i' } }
      ];
    }

    const total = await Plan.countDocuments(filter);
    const plans = await Plan.find(filter)
      .sort({ order: 1, createdAt: -1 })
      .skip(skip)
      .limit(limit);

    const pagination = getPaginationMeta(total, page, limit);

    res.json({
      success: true,
      message: 'Plans retrieved',
      data: { plans, pagination }
    });
  } catch (error) {
    next(error);
  }
});

/**
 * @swagger
 * /api/plans/{slug}:
 *   get:
 *     summary: Get plan by slug (Public)
 *     tags: [Plans]
 */
router.get('/:slug', async (req, res, next) => {
  try {
    const plan = await Plan.findOne({
      slug: req.params.slug,
      isActive: true,
      isArchived: false
    });

    if (!plan) {
      throw new NotFoundError('Plan');
    }

    // Track view
    await plan.trackView();

    res.json({
      success: true,
      message: 'Plan retrieved successfully',
      data: { plan }
    });
  } catch (error) {
    next(error);
  }
});

/**
 * @swagger
 * /api/plans:
 *   post:
 *     summary: Create new plan (Admin only)
 *     tags: [Plans]
 *     security:
 *       - bearerAuth: []
 */
router.post('/', authenticate, createPlanValidation, validateRequest, sanitizeInput, async (req, res, next) => {
  try {
    const plan = new Plan(req.body);
    await plan.save();

    logger.info('Plan created', {
      planId: plan._id,
      name: plan.name,
      createdBy: req.admin.email
    });

    res.status(201).json({
      success: true,
      message: 'Plan created successfully',
      data: { plan }
    });
  } catch (error) {
    next(error);
  }
});

/**
 * @swagger
 * /api/plans/{id}:
 *   put:
 *     summary: Update plan (Admin only)
 *     tags: [Plans]
 *     security:
 *       - bearerAuth: []
 */
router.put('/:id', authenticate, updatePlanValidation, validateRequest, sanitizeInput, async (req, res, next) => {
  try {
    const plan = await Plan.findByIdAndUpdate(
      req.params.id,
      req.body,
      { new: true, runValidators: true }
    );

    if (!plan) {
      throw new NotFoundError('Plan');
    }

    logger.info('Plan updated', {
      planId: plan._id,
      name: plan.name,
      updatedBy: req.admin.email
    });

    res.json({
      success: true,
      message: 'Plan updated successfully',
      data: { plan }
    });
  } catch (error) {
    next(error);
  }
});

/**
 * @swagger
 * /api/plans/{id}/activate:
 *   patch:
 *     summary: Activate/deactivate plan (Admin only)
 *     tags: [Plans]
 *     security:
 *       - bearerAuth: []
 */
router.patch('/:id/activate', authenticate, planIdValidation, validateRequest, async (req, res, next) => {
  try {
    const { isActive } = req.body;

    if (typeof isActive !== 'boolean') {
      throw new BadRequestError('isActive must be a boolean');
    }

    const plan = await Plan.findByIdAndUpdate(
      req.params.id,
      { isActive },
      { new: true }
    );

    if (!plan) {
      throw new NotFoundError('Plan');
    }

    logger.info(`Plan ${isActive ? 'activated' : 'deactivated'}`, {
      planId: plan._id,
      updatedBy: req.admin.email
    });

    res.json({
      success: true,
      message: isActive ? 'Plan activated' : 'Plan deactivated',
      data: { plan }
    });
  } catch (error) {
    next(error);
  }
});

/**
 * @swagger
 * /api/plans/{id}/archive:
 *   patch:
 *     summary: Archive plan (Admin only)
 *     tags: [Plans]
 *     security:
 *       - bearerAuth: []
 */
router.patch('/:id/archive', authenticate, planIdValidation, validateRequest, async (req, res, next) => {
  try {
    const plan = await Plan.findById(req.params.id);

    if (!plan) {
      throw new NotFoundError('Plan');
    }

    await plan.archive();

    logger.info('Plan archived', {
      planId: plan._id,
      archivedBy: req.admin.email
    });

    res.json({
      success: true,
      message: 'Plan archived successfully',
      data: { plan }
    });
  } catch (error) {
    next(error);
  }
});

/**
 * @swagger
 * /api/plans/{id}/restore:
 *   patch:
 *     summary: Restore archived plan (Admin only)
 *     tags: [Plans]
 *     security:
 *       - bearerAuth: []
 */
router.patch('/:id/restore', authenticate, planIdValidation, validateRequest, async (req, res, next) => {
  try {
    const plan = await Plan.findById(req.params.id);

    if (!plan) {
      throw new NotFoundError('Plan');
    }

    await plan.restore();

    logger.info('Plan restored', {
      planId: plan._id,
      restoredBy: req.admin.email
    });

    res.json({
      success: true,
      message: 'Plan restored successfully',
      data: { plan }
    });
  } catch (error) {
    next(error);
  }
});

/**
 * @swagger
 * /api/plans/{id}/duplicate:
 *   post:
 *     summary: Duplicate plan (Admin only)
 *     tags: [Plans]
 *     security:
 *       - bearerAuth: []
 */
router.post('/:id/duplicate', authenticate, planIdValidation, validateRequest, async (req, res, next) => {
  try {
    const { newSlug } = req.body;

    if (!newSlug) {
      throw new BadRequestError('newSlug is required');
    }

    const plan = await Plan.findById(req.params.id);

    if (!plan) {
      throw new NotFoundError('Plan');
    }

    const newPlan = await plan.duplicate(newSlug);

    logger.info('Plan duplicated', {
      originalId: plan._id,
      newPlanId: newPlan._id,
      duplicatedBy: req.admin.email
    });

    res.status(201).json({
      success: true,
      message: 'Plan duplicated successfully',
      data: { plan: newPlan }
    });
  } catch (error) {
    next(error);
  }
});

/**
 * @swagger
 * /api/plans/reorder:
 *   patch:
 *     summary: Reorder plans (Admin only)
 *     tags: [Plans]
 *     security:
 *       - bearerAuth: []
 */
router.patch('/reorder', authenticate, async (req, res, next) => {
  try {
    const { orders } = req.body;

    if (!Array.isArray(orders)) {
      throw new BadRequestError('orders must be an array of { id, order }');
    }

    await Promise.all(orders.map(({ id, order }) =>
      Plan.findByIdAndUpdate(id, { order })
    ));

    logger.info('Plans reordered', {
      reorderedBy: req.admin.email
    });

    res.json({
      success: true,
      message: 'Plans reordered successfully',
      data: {}
    });
  } catch (error) {
    next(error);
  }
});

/**
 * @swagger
 * /api/plans/{id}:
 *   delete:
 *     summary: Delete plan (Admin only)
 *     tags: [Plans]
 *     security:
 *       - bearerAuth: []
 */
router.delete('/:id', authenticate, planIdValidation, validateRequest, async (req, res, next) => {
  try {
    const plan = await Plan.findByIdAndDelete(req.params.id);

    if (!plan) {
      throw new NotFoundError('Plan');
    }

    logger.info('Plan deleted', {
      planId: plan._id,
      name: plan.name,
      deletedBy: req.admin.email
    });

    res.json({
      success: true,
      message: 'Plan deleted successfully',
      data: {}
    });
  } catch (error) {
    next(error);
  }
});

export default router;