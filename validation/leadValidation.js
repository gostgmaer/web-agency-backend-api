import { body, query, validationResult } from 'express-validator';
import { sendError } from '../utils/responseHelper.js';
import { STATUS_ENUM, BUDGET_ENUM, TIMELINE_ENUM, PROJECT_TYPE_ENUM, CONTACT_METHOD_ENUM } from '../models/Lead.js';

export const handleValidationErrors = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return sendError(res, {
      message: 'Validation failed',
      statusCode: 422,
      details: errors.array().map((e) => ({ field: e.path, message: e.msg })),
      code: 'VALIDATION_ERROR',
    });
  }
  next();
};

export const validateSubmitLead = [
  body('firstName').trim().notEmpty().withMessage('First name is required'),
  body('lastName').trim().notEmpty().withMessage('Last name is required'),
  body('email').trim().isEmail().normalizeEmail().withMessage('Valid email is required'),
  body('subject').trim().notEmpty().isLength({ max: 200 }).withMessage('Subject is required (max 200 chars)'),
  body('message').trim().notEmpty().isLength({ max: 5000 }).withMessage('Message is required (max 5000 chars)'),
  body('phone').optional().trim(),
  body('gdprConsent').custom((v) => v === true || v === 'true').withMessage('GDPR consent is required'),
  body('budget').optional().isIn(BUDGET_ENUM).withMessage('Invalid budget value'),
  body('timeline').optional().isIn(TIMELINE_ENUM).withMessage('Invalid timeline value'),
  body('projectType').optional().isIn(PROJECT_TYPE_ENUM).withMessage('Invalid project type'),
  body('category').optional().isIn(['General Inquiry', 'Technical Support', 'Sales', 'Partnership', 'Feedback', 'Career', 'Other']),
  body('preferredContactMethod').optional().isIn(CONTACT_METHOD_ENUM),
  body('website').optional().isURL({ require_protocol: false }).withMessage('Invalid website URL'),
  body('customFields').optional().isObject(),
  handleValidationErrors,
];

export const validateBulkUpdate = [
  body('ids').isArray({ min: 1 }).withMessage('ids must be a non-empty array'),
  body('ids.*').isMongoId().withMessage('Each id must be a valid MongoId'),
  body('status').optional().isIn(STATUS_ENUM).withMessage('Invalid status value'),
  body('assignedTo').optional().isMongoId().withMessage('assignedTo must be a valid MongoId'),
  handleValidationErrors,
];

export const validateAddNote = [
  body('content').trim().notEmpty().isLength({ max: 2000 }).withMessage('Note content is required (max 2000 chars)'),
  body('isInternal').optional().isBoolean(),
  handleValidationErrors,
];

export const validateContactLead = [
  body('subject').trim().notEmpty().isLength({ max: 200 }).withMessage('Subject is required (max 200 chars)'),
  body('message').trim().notEmpty().isLength({ max: 5000 }).withMessage('Message is required (max 5000 chars)'),
  handleValidationErrors,
];

export const validateSendProposal = [
  body('proposalUrl').trim().notEmpty().isURL().withMessage('Valid proposal URL is required'),
  body('quotedAmount').optional().isFloat({ min: 0 }).withMessage('quotedAmount must be a positive number'),
  body('quotedCurrency').optional().isLength({ min: 3, max: 3 }).isAlpha().withMessage('quotedCurrency must be a 3-letter currency code'),
  body('validUntil').optional().isISO8601().toDate().withMessage('validUntil must be a valid date'),
  body('message').optional().trim().isLength({ max: 2000 }),
  body('attachmentName').optional().trim().isLength({ max: 200 }),
  handleValidationErrors,
];

export const validateReviseProposal = [
  body('proposalUrl').trim().notEmpty().isURL().withMessage('Valid proposal URL is required'),
  body('revisionNote').trim().notEmpty().isLength({ max: 1000 }).withMessage('Revision note is required (max 1000 chars)'),
  body('quotedAmount').optional().isFloat({ min: 0 }),
  body('quotedCurrency').optional().isLength({ min: 3, max: 3 }).isAlpha(),
  body('validUntil').optional().isISO8601().toDate(),
  body('message').optional().trim().isLength({ max: 2000 }),
  body('attachmentName').optional().trim().isLength({ max: 200 }),
  handleValidationErrors,
];

export const validateDeclineProposal = [
  body('declinedReason').trim().notEmpty().isLength({ max: 1000 }).withMessage('Decline reason is required (max 1000 chars)'),
  body('note').optional().trim().isLength({ max: 2000 }),
  handleValidationErrors,
];

export const validateSendContract = [
  body('contractUrl').trim().notEmpty().isURL().withMessage('Valid contract URL is required'),
  body('message').optional().trim().isLength({ max: 2000 }),
  body('attachmentName').optional().trim().isLength({ max: 200 }),
  handleValidationErrors,
];

export const validateMarkLost = [
  body('lostReason').trim().notEmpty().isLength({ max: 1000 }).withMessage('Lost reason is required (max 1000 chars)'),
  body('note').optional().trim().isLength({ max: 2000 }),
  handleValidationErrors,
];

export const validateHoldLead = [
  body('onHoldReason').optional().trim().isLength({ max: 1000 }),
  body('resumeDate').optional().isISO8601().toDate().custom((v) => {
    if (v && v <= new Date()) throw new Error('resumeDate must be in the future');
    return true;
  }),
  handleValidationErrors,
];

export const validateReopenLead = [
  body('note').trim().notEmpty().isLength({ max: 1000 }).withMessage('Reopen note is required (max 1000 chars)'),
  handleValidationErrors,
];

export const validateStatusTransition = [
  body('status').trim().notEmpty().isIn(STATUS_ENUM).withMessage('Invalid status value'),
  body('note').optional().trim().isLength({ max: 2000 }),
  handleValidationErrors,
];

export const validateUpdateLead = [
  body('firstName').optional().trim().notEmpty(),
  body('lastName').optional().trim().notEmpty(),
  body('email').optional().trim().isEmail().normalizeEmail(),
  body('phone').optional().trim(),
  body('company').optional().trim(),
  body('subject').optional().trim().isLength({ max: 200 }),
  body('budget').optional().isIn(BUDGET_ENUM),
  body('timeline').optional().isIn(TIMELINE_ENUM),
  body('projectType').optional().isIn(PROJECT_TYPE_ENUM),
  body('pipelineStage').optional().trim(),
  body('nextFollowUp').optional().isISO8601().toDate(),
  body('tags').optional().isArray(),
  body('assignedTo').optional().isMongoId(),
  handleValidationErrors,
];

export const validateSignContract = [
  body('note').optional().trim().isLength({ max: 2000 }),
  body('signedDate').optional().isISO8601().toDate(),
  handleValidationErrors,
];

export const validateMarkWon = [
  body('note').optional().trim().isLength({ max: 2000 }),
  body('closedRevenue').optional().isFloat({ min: 0 }),
  handleValidationErrors,
];

export const validateAddAttachment = [
  body('attachments').optional().isArray({ min: 1 }).withMessage('attachments must be a non-empty array'),
  body('attachments.*.fileId').if(body('attachments').exists()).notEmpty().withMessage('Each attachment must have a fileId'),
  body('attachments.*.url').if(body('attachments').exists()).notEmpty().isURL().withMessage('Each attachment must have a valid url'),
  body('attachments.*.filename').if(body('attachments').exists()).notEmpty().withMessage('Each attachment must have a filename'),
  body('attachments.*.size').optional().isInt({ min: 0 }),
  body('fileId').if(body('attachments').not().exists()).notEmpty().withMessage('fileId is required'),
  body('url').if(body('attachments').not().exists()).notEmpty().isURL().withMessage('A valid url is required'),
  body('filename').if(body('attachments').not().exists()).notEmpty().withMessage('filename is required'),
  body('size').optional().isInt({ min: 0 }),
  handleValidationErrors,
];

export const validateListQuery = [
  query('page').optional().isInt({ min: 1 }).toInt(),
  query('limit').optional().isInt({ min: 1, max: 200 }).toInt(),
  query('status').optional().isIn(STATUS_ENUM),
  query('priority').optional().isIn(['low', 'medium', 'high', 'urgent']),
  query('sort').optional().isIn(['createdAt', 'updatedAt', 'score', 'priority']),
  query('order').optional().isIn(['asc', 'desc']),
  handleValidationErrors,
];
