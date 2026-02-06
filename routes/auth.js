import express from 'express';
import bcrypt from 'bcryptjs';
import { generateToken } from '../config/jwt.js';
import { authenticate } from '../middleware/auth.js';
import { validateRequest, sanitizeInput } from '../middleware/validation.js';
import { loginValidation } from '../validation/authValidation.js';
import Admin from '../models/Admin.js';
import logger from '../utils/logger.js';

const router = express.Router();

/**
 * @swagger
 * /api/auth/login:
 *   post:
 *     summary: Admin login
 *     tags: [Authentication]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - email
 *               - password
 *             properties:
 *               email:
 *                 type: string
 *                 format: email
 *               password:
 *                 type: string
 *                 minLength: 6
 *     responses:
 *       200:
 *         description: Login successful
 *       400:
 *         description: Validation error
 *       401:
 *         description: Invalid credentials
 */
router.post('/login', loginValidation, validateRequest, sanitizeInput, async (req, res, next) => {
  try {
    const { email, password } = req.body;

    // Find admin by email
    const admin = await Admin.findOne({ email });
    if (!admin) {
      return res.status(401).json({
        success: false,
        message: 'Invalid email or password'
      });
    }

    // Check if account is active
    if (!admin.isActive) {
      return res.status(401).json({
        success: false,
        message: 'Account has been deactivated'
      });
    }

    // Validate password
    const isPasswordValid = await admin.matchPassword(password);
    if (!isPasswordValid) {
      return res.status(401).json({
        success: false,
        message: 'Invalid email or password'
      });
    }

    // Update last login
    admin.lastLogin = new Date();
    await admin.save();

    // Generate token
    const token = generateToken({ id: admin._id, email: admin.email, role: admin.role });

    logger.info('Admin login successful', { adminId: admin._id, email: admin.email });

    res.json({
      success: true,
      message: 'Login successful',
      data: {
        token,
        admin: admin.toJSON()
      }
    });
  } catch (error) {
    next(error);
  }
});

/**
 * @swagger
 * /api/auth/logout:
 *   post:
 *     summary: Admin logout
 *     tags: [Authentication]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Logout successful
 *       401:
 *         description: Unauthorized
 */
router.post('/logout', authenticate, async (req, res, next) => {
  try {
    logger.info('Admin logout', { adminId: req.admin._id, email: req.admin.email });

    res.json({
      success: true,
      message: 'Logout successful',
      data: {}
    });
  } catch (error) {
    next(error);
  }
});

/**
 * @swagger
 * /api/auth/profile:
 *   get:
 *     summary: Get admin profile
 *     tags: [Authentication]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Profile retrieved successfully
 *       401:
 *         description: Unauthorized
 */
router.get('/profile', authenticate, async (req, res, next) => {
  try {
    res.json({
      success: true,
      message: 'Profile retrieved successfully',
      data: {
        admin: req.admin.toJSON()
      }
    });
  } catch (error) {
    next(error);
  }
});

export default router;