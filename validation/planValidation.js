import { body, param } from 'express-validator';

export const createPlanValidation = [
  body('name')
    .trim()
    .isLength({ min: 1, max: 100 })
    .withMessage('Plan name is required and must be less than 100 characters'),
  body('slug')
    .trim()
    .isLength({ min: 1, max: 100 })
    .matches(/^[a-z0-9-]+$/)
    .withMessage('Slug must contain only lowercase letters, numbers, and hyphens'),
  body('description')
    .trim()
    .isLength({ min: 1, max: 500 })
    .withMessage('Description is required and must be less than 500 characters'),
  body('price')
    .isFloat({ min: 0 })
    .withMessage('Price must be a positive number'),
  body('currency')
    .optional()
    .isLength({ min: 3, max: 3 })
    .withMessage('Currency must be a 3-character code'),
  body('billingCycle')
    .isIn(['monthly', 'yearly', 'one-time'])
    .withMessage('Invalid billing cycle'),
  body('category')
    .isIn(['website', 'maintenance', 'hosting', 'consulting'])
    .withMessage('Invalid category'),
  body('features')
    .optional()
    .isArray()
    .withMessage('Features must be an array'),
  body('isPopular')
    .optional()
    .isBoolean()
    .withMessage('isPopular must be a boolean'),
  body('isActive')
    .optional()
    .isBoolean()
    .withMessage('isActive must be a boolean'),
  body('order')
    .optional()
    .isInt({ min: 0 })
    .withMessage('Order must be a positive integer')
];

export const updatePlanValidation = [
  param('id')
    .isMongoId()
    .withMessage('Invalid plan ID'),
  body('name')
    .optional()
    .trim()
    .isLength({ min: 1, max: 100 })
    .withMessage('Plan name must be less than 100 characters'),
  body('slug')
    .optional()
    .trim()
    .matches(/^[a-z0-9-]+$/)
    .withMessage('Slug must contain only lowercase letters, numbers, and hyphens'),
  body('description')
    .optional()
    .trim()
    .isLength({ min: 1, max: 500 })
    .withMessage('Description must be less than 500 characters'),
  body('price')
    .optional()
    .isFloat({ min: 0 })
    .withMessage('Price must be a positive number'),
  body('currency')
    .optional()
    .isLength({ min: 3, max: 3 })
    .withMessage('Currency must be a 3-character code'),
  body('billingCycle')
    .optional()
    .isIn(['monthly', 'yearly', 'one-time'])
    .withMessage('Invalid billing cycle'),
  body('category')
    .optional()
    .isIn(['website', 'maintenance', 'hosting', 'consulting'])
    .withMessage('Invalid category'),
  body('features')
    .optional()
    .isArray()
    .withMessage('Features must be an array'),
  body('isPopular')
    .optional()
    .isBoolean()
    .withMessage('isPopular must be a boolean'),
  body('isActive')
    .optional()
    .isBoolean()
    .withMessage('isActive must be a boolean'),
  body('order')
    .optional()
    .isInt({ min: 0 })
    .withMessage('Order must be a positive integer')
];

export const planIdValidation = [
  param('id')
    .isMongoId()
    .withMessage('Invalid plan ID')
];