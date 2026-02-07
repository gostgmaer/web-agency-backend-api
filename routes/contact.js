import express from 'express';
import { authenticate } from '../middleware/auth.js';
import { validateRequest, sanitizeInput } from '../middleware/validation.js';
import { createContactValidation, contactIdValidation } from '../validation/contactValidation.js';
import { getPaginationParams, getPaginationMeta } from '../utils/pagination.js';
import { sendContactNotification, sendContactConfirmation } from '../utils/email.js';
import Contact from '../models/Contact.js';
import logger from '../utils/logger.js';
import { NotFoundError, BadRequestError } from '../utils/errors.js';

const router = express.Router();

/**
 * @swagger
 * /api/contact:
 *   post:
 *     summary: Submit contact form
 *     tags: [Contact]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - name
 *               - email
 *               - subject
 *               - message
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
 *               subject:
 *                 type: string
 *               message:
 *                 type: string
 *     responses:
 *       201:
 *         description: Contact form submitted successfully
 *       400:
 *         description: Validation error
 */
router.post('/', createContactValidation, validateRequest, sanitizeInput, async (req, res, next) => {
  try {
    const contactData = {
      ...req.body,
      ipAddress: req.ip,
      userAgent: req.get('User-Agent'),
      referrer: req.get('Referer')
    };

    const contact = new Contact(contactData);
    await contact.save();

    // Send email notifications (non-blocking)
    Promise.all([
      sendContactNotification(contact),
      sendContactConfirmation(contact)
    ]).catch(emailError => {
      logger.error('Failed to send contact emails:', { error: emailError.message, contactId: contact._id });
    });

    logger.info('Contact form submitted', {
      contactId: contact._id,
      email: contact.email,
      subject: contact.subject,
      priority: contact.priority
    });

    res.status(201).json({
      success: true,
      message: 'Thank you for contacting us. We will get back to you soon',
      data: {
        id: contact._id,
        priority: contact.priority // Show auto-detected priority
      }
    });
  } catch (error) {
    next(error);
  }
});

/**
 * @swagger
 * /api/contact:
 *   get:
 *     summary: Get all contacts (Admin only)
 *     tags: [Contact]
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
 *           enum: [new, read, replied, closed, spam]
 *       - in: query
 *         name: priority
 *         schema:
 *           type: string
 *           enum: [low, medium, high, urgent]
 *       - in: query
 *         name: search
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Contacts retrieved successfully
 *       401:
 *         description: Unauthorized
 */
router.get('/', authenticate, async (req, res, next) => {
  try {
    const { page, limit, skip } = getPaginationParams(req);
    const { status, priority, search } = req.query;

    let filter = { isDeleted: false };
    if (status) filter.status = status;
    if (priority) filter.priority = priority;

    // Text search
    if (search) {
      filter.$text = { $search: search };
    }

    const total = await Contact.countDocuments(filter);
    const contacts = await Contact.find(filter)
      .populate('repliedBy', 'name email')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit);

    const pagination = getPaginationMeta(total, page, limit);

    res.json({
      success: true,
      message: 'Contacts retrieved successfully',
      data: {
        contacts,
        pagination
      }
    });
  } catch (error) {
    next(error);
  }
});

/**
 * @swagger
 * /api/contact/stats:
 *   get:
 *     summary: Get contact statistics (Admin only)
 *     tags: [Contact]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Statistics retrieved successfully
 */
router.get('/stats', authenticate, async (req, res, next) => {
  try {
    const statusCounts = await Contact.countByStatus();
    const total = await Contact.countDocuments({ isDeleted: false });
    const todayCount = await Contact.countDocuments({
      isDeleted: false,
      createdAt: { $gte: new Date().setHours(0, 0, 0, 0) }
    });

    res.json({
      success: true,
      message: 'Contact statistics retrieved',
      data: {
        total,
        today: todayCount,
        byStatus: statusCounts.reduce((acc, curr) => {
          acc[curr._id] = curr.count;
          return acc;
        }, {})
      }
    });
  } catch (error) {
    next(error);
  }
});

/**
 * @swagger
 * /api/contact/{id}:
 *   get:
 *     summary: Get contact by ID (Admin only)
 *     tags: [Contact]
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
 *         description: Contact retrieved successfully
 *       401:
 *         description: Unauthorized
 *       404:
 *         description: Contact not found
 */
router.get('/:id', authenticate, contactIdValidation, validateRequest, async (req, res, next) => {
  try {
    const contact = await Contact.findOne({ _id: req.params.id, isDeleted: false })
      .populate('repliedBy', 'name email');

    if (!contact) {
      throw new NotFoundError('Contact');
    }

    // Mark as read if it was new
    await contact.markAsRead();

    res.json({
      success: true,
      message: 'Contact retrieved successfully',
      data: { contact }
    });
  } catch (error) {
    next(error);
  }
});

/**
 * @swagger
 * /api/contact/{id}/status:
 *   patch:
 *     summary: Update contact status (Admin only)
 *     tags: [Contact]
 *     security:
 *       - bearerAuth: []
 */
router.patch('/:id/status', authenticate, contactIdValidation, validateRequest, async (req, res, next) => {
  try {
    const { status, adminNotes } = req.body;

    if (!status || !['new', 'read', 'replied', 'closed', 'spam'].includes(status)) {
      throw new BadRequestError('Invalid status value');
    }

    const contact = await Contact.findOne({ _id: req.params.id, isDeleted: false });

    if (!contact) {
      throw new NotFoundError('Contact');
    }

    contact.status = status;
    if (adminNotes) contact.adminNotes = adminNotes;
    await contact.save();

    logger.info('Contact status updated', {
      contactId: contact._id,
      status,
      updatedBy: req.admin.email
    });

    res.json({
      success: true,
      message: 'Contact status updated successfully',
      data: { contact }
    });
  } catch (error) {
    next(error);
  }
});

/**
 * @swagger
 * /api/contact/{id}/reply:
 *   post:
 *     summary: Reply to contact (Admin only)
 *     tags: [Contact]
 *     security:
 *       - bearerAuth: []
 */
router.post('/:id/reply', authenticate, contactIdValidation, validateRequest, async (req, res, next) => {
  try {
    const { replyMessage } = req.body;

    if (!replyMessage || replyMessage.trim().length === 0) {
      throw new BadRequestError('Reply message is required');
    }

    const contact = await Contact.findOne({ _id: req.params.id, isDeleted: false });

    if (!contact) {
      throw new NotFoundError('Contact');
    }

    await contact.reply(req.admin._id, replyMessage);

    // TODO: Send reply email to contact

    logger.info('Contact replied', {
      contactId: contact._id,
      repliedBy: req.admin.email
    });

    res.json({
      success: true,
      message: 'Reply recorded successfully',
      data: { contact }
    });
  } catch (error) {
    next(error);
  }
});

/**
 * @swagger
 * /api/contact/{id}/spam:
 *   patch:
 *     summary: Mark contact as spam (Admin only)
 *     tags: [Contact]
 *     security:
 *       - bearerAuth: []
 */
router.patch('/:id/spam', authenticate, contactIdValidation, validateRequest, async (req, res, next) => {
  try {
    const contact = await Contact.findOne({ _id: req.params.id, isDeleted: false });

    if (!contact) {
      throw new NotFoundError('Contact');
    }

    await contact.markAsSpam();

    logger.info('Contact marked as spam', {
      contactId: contact._id,
      markedBy: req.admin.email
    });

    res.json({
      success: true,
      message: 'Contact marked as spam',
      data: {}
    });
  } catch (error) {
    next(error);
  }
});

/**
 * @swagger
 * /api/contact/{id}:
 *   delete:
 *     summary: Delete contact (Admin only) - Soft delete
 *     tags: [Contact]
 *     security:
 *       - bearerAuth: []
 */
router.delete('/:id', authenticate, contactIdValidation, validateRequest, async (req, res, next) => {
  try {
    const contact = await Contact.findOne({ _id: req.params.id, isDeleted: false });

    if (!contact) {
      throw new NotFoundError('Contact');
    }

    await contact.softDelete();

    logger.info('Contact deleted', {
      contactId: contact._id,
      deletedBy: req.admin.email
    });

    res.json({
      success: true,
      message: 'Contact deleted successfully',
      data: {}
    });
  } catch (error) {
    next(error);
  }
});

export default router;