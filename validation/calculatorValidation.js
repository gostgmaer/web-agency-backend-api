import { body, query } from 'express-validator';

export const estimateValidation = [
  // amount (required unless customBreakdown supplied)
  body('amount')
    .optional()
    .isFloat({ min: 1000 })
    .withMessage('amount must be a number ≥ 1000'),

  // currency
  body('currency')
    .optional()
    .isIn(['INR', 'USD', 'EUR', 'GBP'])
    .withMessage('currency must be INR, USD, EUR, or GBP'),

  // projectType
  body('projectType')
    .optional()
    .isIn(['website', 'webapp', 'ecommerce', 'mobile', 'other'])
    .withMessage('projectType must be website | webapp | ecommerce | mobile | other'),

  // complexityLevel
  body('complexityLevel')
    .optional()
    .isIn(['basic', 'standard', 'advanced', 'enterprise'])
    .withMessage('complexityLevel must be basic | standard | advanced | enterprise'),

  // projectName
  body('projectName')
    .optional()
    .isString()
    .isLength({ max: 200 })
    .withMessage('projectName must be a string ≤ 200 chars'),

  // customBreakdown (object with optional numeric keys)
  body('customBreakdown')
    .optional()
    .isObject()
    .withMessage('customBreakdown must be an object'),

  body('customBreakdown.design')
    .optional()
    .isFloat({ min: 0 })
    .withMessage('customBreakdown.design must be a non-negative number'),

  body('customBreakdown.frontend')
    .optional()
    .isFloat({ min: 0 })
    .withMessage('customBreakdown.frontend must be a non-negative number'),

  body('customBreakdown.backend')
    .optional()
    .isFloat({ min: 0 })
    .withMessage('customBreakdown.backend must be a non-negative number'),

  body('customBreakdown.testing')
    .optional()
    .isFloat({ min: 0 })
    .withMessage('customBreakdown.testing must be a non-negative number'),

  body('customBreakdown.projectManagement')
    .optional()
    .isFloat({ min: 0 })
    .withMessage('customBreakdown.projectManagement must be a non-negative number'),

  body('customBreakdown.deployment')
    .optional()
    .isFloat({ min: 0 })
    .withMessage('customBreakdown.deployment must be a non-negative number'),
];
