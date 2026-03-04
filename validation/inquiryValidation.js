import { body, param } from 'express-validator';
import { SERVICE_OPTIONS, BUDGET_RANGES, TIMELINE_OPTIONS } from '../models/Inquiry.js';

// Extract valid keys from the options
const validProjectTypes = SERVICE_OPTIONS.map(s => s.key);
const validBudgets = BUDGET_RANGES.map(b => b.key);
const validTimelines = TIMELINE_OPTIONS.map(t => t.key);

export const createInquiryValidation = [
  body('name')
    .trim()
    .isLength({ min: 1, max: 100 })
    .withMessage('Name is required and must be less than 100 characters'),
  body('email')
    .isEmail()
    .normalizeEmail()
    .withMessage('Please provide a valid email address'),
  body('phone')
    .optional()
    .trim()
    .isMobilePhone()
    .withMessage('Please provide a valid phone number'),
  body('company')
    .optional()
    .trim()
    .isLength({ max: 100 })
    .withMessage('Company name must be less than 100 characters'),
  body('subject')
    .optional()
    .trim()
    .isLength({ max: 200 })
    .withMessage('Subject must be less than 200 characters'),
  body('projectType')
    .isIn(validProjectTypes)
    .withMessage('Invalid project type'),
  body('budget')
    .isIn(validBudgets)
    .withMessage('Invalid budget range'),
  body('timeline')
    .isIn(validTimelines)
    .withMessage('Invalid timeline'),
  body('description')
    .trim()
    .isLength({ min: 1, max: 5000 })
    .withMessage('Description is required and must be less than 5000 characters'),
  body('requirements')
    .optional()
    .isArray()
    .withMessage('Requirements must be an array'),
  body('preferredContactMethod')
    .optional()
    .isIn(['Email', 'Phone', 'WhatsApp'])
    .withMessage('Invalid contact method'),
];

export const inquiryIdValidation = [
  param('id')
    .isMongoId()
    .withMessage('Invalid inquiry ID')
];