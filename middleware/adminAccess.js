/**
 * Admin access middleware.
 * Must run AFTER authenticate (req.user must be populated).
 * Grants access only to roles: admin | super_admin.
 */
const ADMIN_ROLES = ['admin', 'super_admin'];

function adminAccess(req, res, next) {
  if (!req.user || !ADMIN_ROLES.includes(req.user.role)) {
    return res.status(403).json({ success: false, message: 'Admin access required' });
  }
  next();
}

export default adminAccess;
