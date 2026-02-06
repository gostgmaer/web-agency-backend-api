import { body, param } from 'express-validator';

export const createBlogValidation = [
  body('title')
    .trim()
    .isLength({ min: 1, max: 200 })
    .withMessage('Title is required and must be less than 200 characters'),
  body('slug')
    .trim()
    .isLength({ min: 1, max: 200 })
    .matches(/^[a-z0-9-]+$/)
    .withMessage('Slug must contain only lowercase letters, numbers, and hyphens'),
  body('content')
    .trim()
    .isLength({ min: 1 })
    .withMessage('Content is required'),
  body('excerpt')
    .trim()
    .isLength({ min: 1, max: 500 })
    .withMessage('Excerpt is required and must be less than 500 characters'),
  body('categories')
    .optional()
    .isArray()
    .withMessage('Categories must be an array'),
  body('tags')
    .optional()
    .isArray()
    .withMessage('Tags must be an array'),
  body('isPublished')
    .optional()
    .isBoolean()
    .withMessage('isPublished must be a boolean')
];

export const updateBlogValidation = [
  param('id')
    .isMongoId()
    .withMessage('Invalid blog ID'),
  body('title')
    .optional()
    .trim()
    .isLength({ min: 1, max: 200 })
    .withMessage('Title must be less than 200 characters'),
  body('slug')
    .optional()
    .trim()
    .matches(/^[a-z0-9-]+$/)
    .withMessage('Slug must contain only lowercase letters, numbers, and hyphens'),
  body('content')
    .optional()
    .trim()
    .isLength({ min: 1 })
    .withMessage('Content cannot be empty'),
  body('excerpt')
    .optional()
    .trim()
    .isLength({ min: 1, max: 500 })
    .withMessage('Excerpt must be less than 500 characters'),
  body('categories')
    .optional()
    .isArray()
    .withMessage('Categories must be an array'),
  body('tags')
    .optional()
    .isArray()
    .withMessage('Tags must be an array'),
  body('isPublished')
    .optional()
    .isBoolean()
    .withMessage('isPublished must be a boolean')
];

export const blogIdValidation = [
  param('id')
    .isMongoId()
    .withMessage('Invalid blog ID')
];

export const blogSlugValidation = [
  param('slug')
    .trim()
    .isLength({ min: 1 })
    .matches(/^[a-z0-9-]+$/)
    .withMessage('Invalid blog slug')
];