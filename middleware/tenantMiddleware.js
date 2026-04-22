/**
 * Tenant middleware.
 * Both middlewares resolve tenantId from the x-tenant-id header (injected by
 * app.js if omitted, so clients never need to send it explicitly in single-tenant mode).
 *
 * requireTenantHeader — public routes
 * setTenantFromUser   — authenticated routes (same header-based resolution)
 */
import AppError from '../utils/appError.js';
import { config } from '../config/index.js';

const TENANCY_ENABLED = config.tenant.enabled;
const DEFAULT_TENANT_ID = config.tenant.defaultTenantId || 'easydev';

function resolveFromHeader(req, res, next) {
  if (!TENANCY_ENABLED) {
    req.tenantId = null;
    return next();
  }
  const tenantId = ((req.headers['x-tenant-id'] || DEFAULT_TENANT_ID) || '').trim();
  if (!tenantId) {
    req.tenantId = DEFAULT_TENANT_ID;
    return next();
  }
  const isObjectId = /^[a-f\d]{24}$/i.test(tenantId);
  const isSlug     = /^[a-z0-9_-]{2,64}$/i.test(tenantId);
  if (!isObjectId && !isSlug) {
    return next(AppError.badRequest('Invalid x-tenant-id format'));
  }
  req.tenantId = tenantId;
  next();
}

export const requireTenantHeader = resolveFromHeader;
export const setTenantFromUser   = resolveFromHeader;
