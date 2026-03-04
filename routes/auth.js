import express from 'express';
import jwt from 'jsonwebtoken';
import { authenticate } from '../middleware/auth.js';
import { validateRequest } from '../middleware/validation.js';
import { loginValidation } from '../validation/authValidation.js';
import Admin from '../models/Admin.js';
import logger from '../utils/logger.js';
import { AuthenticationError, BadRequestError } from '../utils/errors.js';
import { config } from "../config/index.js";

const router = express.Router();

/**
 * @swagger
 * /api/auth/login:
 *   post:
 *     summary: Admin login
 *     tags: [Auth]
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
 *     responses:
 *       200:
 *         description: Login successful
 *       401:
 *         description: Invalid credentials
 */
router.post('/login', loginValidation, validateRequest, async (req, res, next) => {
  try {
    const { email, password } = req.body;

    // Find admin with password field (since it's select: false by default)
    const admin = await Admin.findOne({ email }).select('+password +loginAttempts +lockUntil');

    if (!admin) {
      // Log failed attempt for non-existent user (but don't reveal this)
      logger.warn('Login attempt for non-existent user', { email });
      throw new AuthenticationError('Invalid email or password');
    }

    // Check if account is locked
    if (admin.isLocked) {
      const lockTime = Math.ceil((admin.lockUntil - Date.now()) / 60000);
      logger.warn('Login attempt on locked account', { email, lockUntil: admin.lockUntil });
      throw new AuthenticationError(`Account is locked. Try again in ${lockTime} minutes`);
    }

    // Check if account is active
    if (!admin.isActive) {
      logger.warn('Login attempt on deactivated account', { email });
      throw new AuthenticationError('Account is deactivated. Please contact support');
    }

    // Check password
    const isMatch = await admin.matchPassword(password);

    if (!isMatch) {
      // Increment failed login attempts
      await admin.incLoginAttempts();

      const attemptsLeft = 5 - (admin.loginAttempts + 1);
      logger.warn('Failed login attempt', { email, attemptsLeft });

      if (attemptsLeft > 0) {
        throw new AuthenticationError(`Invalid email or password. ${attemptsLeft} attempts remaining`);
      } else {
        throw new AuthenticationError('Account has been locked due to too many failed attempts');
      }
    }

    // Reset login attempts on successful login
    await admin.resetLoginAttempts();

    // Generate JWT token
    const tokenPayload = {
      id: admin._id,
      email: admin.email,
      role: admin.role
    };

    const token = jwt.sign(tokenPayload, config.jwt.secret, { expiresIn: config.jwt.expire || "7d" });

    // Generate refresh token (optional)
    const refreshToken = jwt.sign({ id: admin._id }, config.jwt.refreshSecret || config.jwt.secret, {
			expiresIn: "30d",
		});

    logger.info('Admin logged in successfully', {
      email: admin.email,
      role: admin.role
    });

    res.json({
			success: true,
			message: "Login successful",
			data: { admin: admin.toJSON(), token, refreshToken, expiresIn: config.jwt.expire || "7d" },
		});
  } catch (error) {
    next(error);
  }
});

/**
 * @swagger
 * /api/auth/refresh:
 *   post:
 *     summary: Refresh access token
 *     tags: [Auth]
 */
router.post('/refresh', async (req, res, next) => {
  try {
    const { refreshToken } = req.body;

    if (!refreshToken) {
      throw new BadRequestError('Refresh token is required');
    }

    // Verify refresh token
    const decoded = jwt.verify(refreshToken, config.jwt.refreshSecret || config.jwt.secret);

    const admin = await Admin.findById(decoded.id);

    if (!admin || !admin.isActive) {
      throw new AuthenticationError('Invalid refresh token');
    }

    // Generate new access token
    const token = jwt.sign({ id: admin._id, email: admin.email, role: admin.role }, config.jwt.secret, {
			expiresIn: config.jwt.expire || "7d",
		});

    res.json({
      success: true,
      message: 'Token refreshed',
      data: { token }
    });
  } catch (error) {
    if (error.name === 'JsonWebTokenError' || error.name === 'TokenExpiredError') {
      next(new AuthenticationError('Invalid or expired refresh token'));
    } else {
      next(error);
    }
  }
});

/**
 * @swagger
 * /api/auth/profile:
 *   get:
 *     summary: Get current admin profile
 *     tags: [Auth]
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
    const admin = await Admin.findById(req.admin._id);

    if (!admin) {
      throw new AuthenticationError('Admin not found');
    }

    res.json({
      success: true,
      message: 'Profile retrieved successfully',
      data: { admin }
    });
  } catch (error) {
    next(error);
  }
});

/**
 * @swagger
 * /api/auth/profile:
 *   put:
 *     summary: Update current admin profile
 *     tags: [Auth]
 *     security:
 *       - bearerAuth: []
 */
router.put('/profile', authenticate, async (req, res, next) => {
  try {
    const { name, avatar } = req.body;
    const updateData = {};

    if (name) updateData.name = name;
    if (avatar !== undefined) updateData.avatar = avatar;

    const admin = await Admin.findByIdAndUpdate(
      req.admin._id,
      updateData,
      { new: true, runValidators: true }
    );

    if (!admin) {
      throw new AuthenticationError('Admin not found');
    }

    logger.info('Admin profile updated', { email: admin.email });

    res.json({
      success: true,
      message: 'Profile updated successfully',
      data: { admin }
    });
  } catch (error) {
    next(error);
  }
});

/**
 * @swagger
 * /api/auth/change-password:
 *   post:
 *     summary: Change password
 *     tags: [Auth]
 *     security:
 *       - bearerAuth: []
 */
router.post('/change-password', authenticate, async (req, res, next) => {
  try {
    const { currentPassword, newPassword } = req.body;

    if (!currentPassword || !newPassword) {
      throw new BadRequestError('Current password and new password are required');
    }

    if (newPassword.length < 6) {
      throw new BadRequestError('New password must be at least 6 characters');
    }

    const admin = await Admin.findById(req.admin._id).select('+password');

    if (!admin) {
      throw new AuthenticationError('Admin not found');
    }

    // Verify current password
    const isMatch = await admin.matchPassword(currentPassword);
    if (!isMatch) {
      throw new AuthenticationError('Current password is incorrect');
    }

    // Update password
    admin.password = newPassword;
    await admin.save();

    logger.info('Admin password changed', { email: admin.email });

    res.json({
      success: true,
      message: 'Password changed successfully'
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
 *     tags: [Auth]
 *     security:
 *       - bearerAuth: []
 */
router.post('/logout', authenticate, async (req, res, next) => {
  try {
    // In a more complete implementation, you would:
    // 1. Add the token to a blacklist (Redis)
    // 2. Clear any server-side sessions

    logger.info('Admin logged out', { email: req.admin.email });

    res.json({
      success: true,
      message: 'Logged out successfully'
    });
  } catch (error) {
    next(error);
  }
});

/**
 * @swagger
 * /api/auth/verify:
 *   get:
 *     summary: Verify token validity
 *     tags: [Auth]
 *     security:
 *       - bearerAuth: []
 */
router.get('/verify', authenticate, async (req, res, next) => {
  try {
    res.json({
      success: true,
      message: 'Token is valid',
      data: {
        admin: {
          id: req.admin._id,
          email: req.admin.email,
          name: req.admin.name,
          role: req.admin.role
        }
      }
    });
  } catch (error) {
    next(error);
  }
});

export default router;