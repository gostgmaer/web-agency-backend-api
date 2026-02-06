import express from 'express';
import { authenticate } from '../middleware/auth.js';
import { validateRequest, sanitizeInput } from '../middleware/validation.js';
import { createInquiryValidation, inquiryIdValidation } from '../validation/inquiryValidation.js';
import { getPaginationParams, getPaginationMeta } from '../utils/pagination.js';
import { sendInquiryNotification, sendInquiryConfirmation } from '../utils/email.js';
import Inquiry from '../models/Inquiry.js';
import logger from '../utils/logger.js';

const router = express.Router();

/**
 * @swagger
 * /api/inquiry:
 *   post:
 *     summary: Submit project inquiry
 *     tags: [Inquiry]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - name
 *               - email
 *               - projectType
 *               - budget
 *               - timeline
 *               - description
 *             properties:
 *               name:
 *                 type: string
 *               email:
 *                 type: string
 *                 format: email
 *               phone:
 *                 type: string
 *               company:
 *                 type: string
 *               projectType:
 *                 type: string
 *                 enum: [website, webapp, mobile, ecommerce, other]
 *               budget:
 *                 type: string
 *                 enum: [under-5k, 5k-10k, 10k-25k, 25k-50k, over-50k]
 *               timeline:
 *                 type: string
 *                 enum: [asap, 1-month, 2-3months, 3-6months, flexible]
 *               description:
 *                 type: string
 *               requirements:
 *                 type: array
 *                 items:
 *                   type: string
 *     responses:
 *       201:
 *         description: Inquiry submitted successfully
 *       400:
 *         description: Validation error
 */
router.post('/', createInquiryValidation, validateRequest, sanitizeInput, async (req, res, next) => {
  try {
    const inquiryData = {
      ...req.body,
      ipAddress: req.ip,
      userAgent: req.get('User-Agent')
    };

    const inquiry = new Inquiry(inquiryData);
    await inquiry.save();

    // Send email notifications
    try {
      await sendInquiryNotification(inquiry);
      await sendInquiryConfirmation(inquiry);
    } catch (emailError) {
      logger.error('Failed to send inquiry emails:', emailError);
      // Don't fail the request if email fails
    }

    logger.info('Project inquiry submitted', { 
      inquiryId: inquiry._id, 
      email: inquiry.email,
      projectType: inquiry.projectType 
    });

    res.status(201).json({
      success: true,
      message: 'Thank you for your project inquiry. We will review your requirements and get back to you soon',
      data: {
        id: inquiry._id,
        message: 'Project inquiry submitted successfully'
      }
    });
  } catch (error) {
    next(error);
  }
});

/**
 * @swagger
 * /api/inquiry:
 *   get:
 *     summary: Get all inquiries (Admin only)
 *     tags: [Inquiry]
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
 *           enum: [new, reviewing, quoted, accepted, rejected, completed]
 *       - in: query
 *         name: projectType
 *         schema:
 *           type: string
 *           enum: [website, webapp, mobile, ecommerce, other]
 *       - in: query
 *         name: priority
 *         schema:
 *           type: string
 *           enum: [low, medium, high]
 *     responses:
 *       200:
 *         description: Inquiries retrieved successfully
 *       401:
 *         description: Unauthorized
 */
router.get('/', authenticate, async (req, res, next) => {
  try {
    const { page, limit, skip } = getPaginationParams(req);
    const { status, projectType, priority } = req.query;

    let filter = {};
    if (status) filter.status = status;
    if (projectType) filter.projectType = projectType;
    if (priority) filter.priority = priority;

    const total = await Inquiry.countDocuments(filter);
    const inquiries = await Inquiry.find(filter)
      .populate('assignedTo', 'name email')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit);

    const pagination = getPaginationMeta(total, page, limit);

    res.json({
      success: true,
      message: 'Inquiries retrieved successfully',
      data: {
        inquiries,
        pagination
      }
    });
  } catch (error) {
    next(error);
  }
});

/**
 * @swagger
 * /api/inquiry/{id}:
 *   get:
 *     summary: Get inquiry by ID (Admin only)
 *     tags: [Inquiry]
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
 *         description: Inquiry retrieved successfully
 *       401:
 *         description: Unauthorized
 *       404:
 *         description: Inquiry not found
 */
router.get('/:id', authenticate, inquiryIdValidation, validateRequest, async (req, res, next) => {
  try {
    const inquiry = await Inquiry.findById(req.params.id)
      .populate('assignedTo', 'name email')
      .populate('notes.createdBy', 'name email');

    if (!inquiry) {
      return res.status(404).json({
        success: false,
        message: 'Inquiry not found'
      });
    }

    // Mark as reviewing if it was new
    if (inquiry.status === 'new') {
      inquiry.status = 'reviewing';
      await inquiry.save();
    }

    res.json({
      success: true,
      message: 'Inquiry retrieved successfully',
      data: { inquiry }
    });
  } catch (error) {
    next(error);
  }
});

/**
 * @swagger
 * /api/inquiry/{id}:
 *   delete:
 *     summary: Delete inquiry (Admin only)
 *     tags: [Inquiry]
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
 *         description: Inquiry deleted successfully
 *       401:
 *         description: Unauthorized
 *       404:
 *         description: Inquiry not found
 */
router.delete('/:id', authenticate, inquiryIdValidation, validateRequest, async (req, res, next) => {
  try {
    const inquiry = await Inquiry.findByIdAndDelete(req.params.id);

    if (!inquiry) {
      return res.status(404).json({
        success: false,
        message: 'Inquiry not found'
      });
    }

    logger.info('Inquiry deleted', { 
      inquiryId: inquiry._id, 
      email: inquiry.email,
      deletedBy: req.admin.email 
    });

    res.json({
      success: true,
      message: 'Inquiry deleted successfully',
      data: {}
    });
  } catch (error) {
    next(error);
  }
});

export default router;