/**
 * Tenant middleware.
 * requireTenantHeader — public routes: reads x-tenant-id header.
 * setTenantFromUser   — authenticated routes: reads tenantId from JWT payload.
 */
import AppError from '../utils/appError.js';
import { config } from '../config/index.js';

const TENANCY_ENABLED = config.tenant.enabled;
const DEFAULT_TENANT_ID = config.tenant.defaultTenantId || 'easydev';

export const requireTenantHeader = (req, res, next) => {
  if (!TENANCY_ENABLED) {
    req.tenantId = null;
    return next();
  }
  const tenantId = ((req.headers['x-tenant-id'] || DEFAULT_TENANT_ID) || '').trim();
  if (!tenantId) {
    req.tenantId = 'easydev';
    return next();
  }
  const isObjectId = /^[a-f\d]{24}$/i.test(tenantId);
  const isSlug     = /^[a-z0-9_-]{2,64}$/i.test(tenantId);
  if (!isObjectId && !isSlug) {
    return next(AppError.badRequest('Invalid x-tenant-id format'));
  }
  req.tenantId = tenantId;
  next();
};

export const setTenantFromUser = (req, res, next) => {
  if (!TENANCY_ENABLED) {
    req.tenantId = null;
    return next();
  }
  req.tenantId = req.user?.tenantId || DEFAULT_TENANT_ID || 'easydev';
  next();
};
