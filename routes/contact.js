import express from 'express';
import { authenticate } from '../middleware/auth.js';
import { validateRequest, sanitizeInput } from '../middleware/validation.js';
import { createContactValidation, contactIdValidation } from '../validation/contactValidation.js';
import { getPaginationParams, getPaginationMeta } from '../utils/pagination.js';
import { sendContactNotification, sendContactConfirmation } from '../utils/email.js';
import Contact from '../models/Contact.js';
import logger from '../utils/logger.js';

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
      userAgent: req.get('User-Agent')
    };

    const contact = new Contact(contactData);
    await contact.save();

    // Send email notifications
    try {
      await sendContactNotification(contact);
      await sendContactConfirmation(contact);
    } catch (emailError) {
      logger.error('Failed to send contact emails:', emailError);
      // Don't fail the request if email fails
    }

    logger.info('Contact form submitted', { 
      contactId: contact._id, 
      email: contact.email,
      subject: contact.subject 
    });

    res.status(201).json({
      success: true,
      message: 'Thank you for contacting us. We will get back to you soon',
      data: {
        id: contact._id,
        message: 'Contact form submitted successfully'
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
 *           enum: [new, read, replied, closed]
 *       - in: query
 *         name: priority
 *         schema:
 *           type: string
 *           enum: [low, medium, high]
 *     responses:
 *       200:
 *         description: Contacts retrieved successfully
 *       401:
 *         description: Unauthorized
 */
router.get('/', authenticate, async (req, res, next) => {
  try {
    const { page, limit, skip } = getPaginationParams(req);
    const { status, priority } = req.query;

    let filter = {};
    if (status) filter.status = status;
    if (priority) filter.priority = priority;

    const total = await Contact.countDocuments(filter);
    const contacts = await Contact.find(filter)
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
    const contact = await Contact.findById(req.params.id);

    if (!contact) {
      return res.status(404).json({
        success: false,
        message: 'Contact not found'
      });
    }

    // Mark as read if it was new
    if (contact.status === 'new') {
      contact.status = 'read';
      await contact.save();
    }

    res.json({
      success: true,
      message: 'Contact retrieved successfully',
      data: { contact }
    });
  } catch (error) {
    next(error);
  }
});

export default router;