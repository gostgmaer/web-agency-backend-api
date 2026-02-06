import express from 'express';
import { authenticate } from '../middleware/auth.js';
import { validateRequest, sanitizeInput } from '../middleware/validation.js';
import { createPlanValidation, updatePlanValidation, planIdValidation } from '../validation/planValidation.js';
import { getPaginationParams, getPaginationMeta } from '../utils/pagination.js';
import Plan from '../models/Plan.js';
import logger from '../utils/logger.js';

const router = express.Router();

/**
 * @swagger
 * /api/plans:
 *   get:
 *     summary: Get all active plans
 *     tags: [Plans]
 *     parameters:
 *       - in: query
 *         name: category
 *         schema:
 *           type: string
 *           enum: [website, maintenance, hosting, consulting]
 *       - in: query
 *         name: billingCycle
 *         schema:
 *           type: string
 *           enum: [monthly, yearly, one-time]
 *     responses:
 *       200:
 *         description: Plans retrieved successfully
 */
router.get('/', async (req, res, next) => {
  try {
    const { category, billingCycle } = req.query;

    let filter = { isActive: true };
    if (category) filter.category = category;
    if (billingCycle) filter.billingCycle = billingCycle;

    const plans = await Plan.find(filter).sort({ order: 1, createdAt: -1 });

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
 * /api/plans:
 *   post:
 *     summary: Create new plan (Admin only)
 *     tags: [Plans]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - name
 *               - slug
 *               - description
 *               - price
 *               - billingCycle
 *               - category
 *             properties:
 *               name:
 *                 type: string
 *               slug:
 *                 type: string
 *               description:
 *                 type: string
 *               price:
 *                 type: number
 *               currency:
 *                 type: string
 *               billingCycle:
 *                 type: string
 *                 enum: [monthly, yearly, one-time]
 *               category:
 *                 type: string
 *                 enum: [website, maintenance, hosting, consulting]
 *               features:
 *                 type: array
 *                 items:
 *                   type: object
 *                   properties:
 *                     name:
 *                       type: string
 *                     included:
 *                       type: boolean
 *                     description:
 *                       type: string
 *               isPopular:
 *                 type: boolean
 *               isActive:
 *                 type: boolean
 *               order:
 *                 type: integer
 *     responses:
 *       201:
 *         description: Plan created successfully
 *       400:
 *         description: Validation error
 *       401:
 *         description: Unauthorized
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
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               name:
 *                 type: string
 *               slug:
 *                 type: string
 *               description:
 *                 type: string
 *               price:
 *                 type: number
 *               currency:
 *                 type: string
 *               billingCycle:
 *                 type: string
 *                 enum: [monthly, yearly, one-time]
 *               category:
 *                 type: string
 *                 enum: [website, maintenance, hosting, consulting]
 *               features:
 *                 type: array
 *                 items:
 *                   type: object
 *                   properties:
 *                     name:
 *                       type: string
 *                     included:
 *                       type: boolean
 *                     description:
 *                       type: string
 *               isPopular:
 *                 type: boolean
 *               isActive:
 *                 type: boolean
 *               order:
 *                 type: integer
 *     responses:
 *       200:
 *         description: Plan updated successfully
 *       400:
 *         description: Validation error
 *       401:
 *         description: Unauthorized
 *       404:
 *         description: Plan not found
 */
router.put('/:id', authenticate, updatePlanValidation, validateRequest, sanitizeInput, async (req, res, next) => {
  try {
    const plan = await Plan.findByIdAndUpdate(
      req.params.id,
      req.body,
      { new: true, runValidators: true }
    );

    if (!plan) {
      return res.status(404).json({
        success: false,
        message: 'Plan not found'
      });
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
 * /api/plans/{id}:
 *   delete:
 *     summary: Delete plan (Admin only)
 *     tags: [Plans]
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
 *         description: Plan deleted successfully
 *       401:
 *         description: Unauthorized
 *       404:
 *         description: Plan not found
 */
router.delete('/:id', authenticate, planIdValidation, validateRequest, async (req, res, next) => {
  try {
    const plan = await Plan.findByIdAndDelete(req.params.id);

    if (!plan) {
      return res.status(404).json({
        success: false,
        message: 'Plan not found'
      });
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