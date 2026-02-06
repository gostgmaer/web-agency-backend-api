import { body, param } from 'express-validator';

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
  body('projectType')
    .isIn(['website', 'webapp', 'mobile', 'ecommerce', 'other'])
    .withMessage('Invalid project type'),
  body('budget')
    .isIn(['under-5k', '5k-10k', '10k-25k', '25k-50k', 'over-50k'])
    .withMessage('Invalid budget range'),
  body('timeline')
    .isIn(['asap', '1-month', '2-3months', '3-6months', 'flexible'])
    .withMessage('Invalid timeline'),
  body('description')
    .trim()
    .isLength({ min: 1, max: 2000 })
    .withMessage('Description is required and must be less than 2000 characters'),
  body('requirements')
    .optional()
    .isArray()
    .withMessage('Requirements must be an array')
];

export const inquiryIdValidation = [
  param('id')
    .isMongoId()
    .withMessage('Invalid inquiry ID')
];