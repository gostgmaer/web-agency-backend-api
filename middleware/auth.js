import jwt from 'jsonwebtoken';
import { JWT_SECRET, JWT_ISSUER, JWT_AUDIENCE } from '../config/jwt.js';
import logger from '../utils/logger.js';

/**
 * Verifies the Bearer access token issued by the user-auth-service.
 * Validates issuer + audience claims. No local DB lookup — stateless verification only.
 * Attaches req.user = { id, email, role, tenantId, sessionId } from decoded payload.
 */
export const authenticate = (req, res, next) => {
  try {
    let token;

    if (req.headers.authorization && req.headers.authorization.startsWith('Bearer')) {
      token = req.headers.authorization.split(' ')[1];
    }

    if (!token) {
      return res.status(401).json({
        success: false,
        message: 'Access denied. No token provided'
      });
    }

    const decoded = jwt.verify(token, JWT_SECRET, {
      issuer: JWT_ISSUER,
      audience: JWT_AUDIENCE,
    });

    // Map user-auth-service JWT claims to a consistent shape.
    // IAM tokens carry `roles: string[]` — take the first entry as the
    // canonical single-role value used by adminAccess / authorize().
    const roleFromArray = Array.isArray(decoded.roles) ? decoded.roles[0] : undefined;
    req.user = {
      id: decoded.sub,
      email: decoded.email,
      role: decoded.role ?? roleFromArray,
      tenantId: decoded.tenantId,
      sessionId: decoded.sessionId,
    };

    next();
  } catch (error) {
    if (error.name === 'JsonWebTokenError') {
      return res.status(401).json({
        success: false,
        message: 'Invalid token'
      });
    }

    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({
        success: false,
        message: 'Token has expired'
      });
    }

    logger.error('Authentication error:', error);
    return res.status(500).json({
      success: false,
      message: 'Server error during authentication'
    });
  }
};

export const authorize = (...roles) => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({
        success: false,
        message: 'Access denied. Authentication required'
      });
    }

    if (!roles.includes(req.user.role)) {
      return res.status(403).json({
        success: false,
        message: `Access denied. Required role: ${roles.join(' or ')}`
      });
    }

    next();
  };
};