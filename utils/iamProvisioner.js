import { randomBytes } from 'crypto';
import { config } from '../config/index.js';
import logger from './logger.js';

let cachedAdminToken = null;
let cachedAdminTokenExpiry = 0;

const resolvedTenantIds = new Map();
const resolvedApplicationIds = new Map();
const resolvedRoleIds = new Map();

function iamBaseUrl() {
  return `${config.iam?.serviceUrl || 'http://localhost:4002'}/api/v1/iam`;
}

function unwrapPayload(body) {
  return body?.data ?? body;
}

function unwrapList(body) {
  const payload = unwrapPayload(body);
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.data)) return payload.data;
  return [];
}

async function parseResponseBody(response) {
  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    try {
      return await response.json();
    } catch {
      return {};
    }
  }

  try {
    return await response.text();
  } catch {
    return '';
  }
}

function formatErrorMessage(body, fallback) {
  if (typeof body === 'string' && body.trim()) return body;
  if (body?.message) return body.message;
  if (body?.error) return body.error;
  if (Array.isArray(body?.errors) && body.errors.length > 0) {
    return body.errors.map((entry) => entry?.message || String(entry)).join(', ');
  }
  return fallback;
}

async function getAdminToken() {
  const now = Math.floor(Date.now() / 1000);
  if (cachedAdminToken && cachedAdminTokenExpiry > now + 60) {
    return cachedAdminToken;
  }

  if (config.iam?.adminEmail && config.iam?.adminPassword) {
    const response = await fetch(`${iamBaseUrl()}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: config.iam.adminEmail,
        password: config.iam.adminPassword,
      }),
      signal: AbortSignal.timeout(15_000),
    });

    const body = await parseResponseBody(response);
    if (!response.ok) {
      throw new Error(formatErrorMessage(body, 'IAM admin login failed.'));
    }

    const data = unwrapPayload(body);
    const token = data?.accessToken;
    const expiresIn = Number(data?.expiresIn || 900);

    if (!token) {
      throw new Error('IAM admin login succeeded but no access token was returned.');
    }

    cachedAdminToken = token;
    cachedAdminTokenExpiry = now + expiresIn;
    return cachedAdminToken;
  }

  if (config.iam?.adminJwt) {
    cachedAdminToken = config.iam.adminJwt;
    cachedAdminTokenExpiry = now + 86400;
    return cachedAdminToken;
  }

  throw new Error('IAM admin credentials are not configured in web-agency-backend-api.');
}

async function authHeaders() {
  const token = await getAdminToken();
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  };
}

async function iamRequest(path, options = {}) {
  const {
    method = 'GET',
    body,
    timeout = 15_000,
  } = options;

  const response = await fetch(`${iamBaseUrl()}${path}`, {
    method,
    headers: await authHeaders(),
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(timeout),
  });

  const payload = await parseResponseBody(response);
  if (!response.ok) {
    const error = new Error(formatErrorMessage(payload, `IAM request failed: ${method} ${path}`));
    error.status = response.status;
    error.payload = payload;
    throw error;
  }

  return payload;
}

function normalizeName(fullName) {
  const trimmed = String(fullName || '').trim();
  const parts = trimmed.split(/\s+/).filter(Boolean);
  return {
    firstName: parts[0] || trimmed || 'Customer',
    lastName: parts.length > 1 ? parts.slice(1).join(' ') : '',
  };
}

function generateTemporaryPassword(length = 14) {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789!@#$';
  const bytes = randomBytes(length);
  let password = '';
  for (let index = 0; index < length; index += 1) {
    password += chars[bytes[index] % chars.length];
  }
  return password;
}

export async function resolveTenantId(tenantRef) {
  if (!tenantRef) return null;
  if (resolvedTenantIds.has(tenantRef)) return resolvedTenantIds.get(tenantRef);

  const tenants = unwrapList(await iamRequest('/tenants?page=1&limit=100'));
  const tenant = tenants.find((entry) => {
    const candidateIds = [entry.internalId, entry.id, entry.publicId].filter(Boolean);
    return entry.slug === tenantRef || candidateIds.includes(tenantRef);
  });
  const tenantId = tenant?.internalId || tenant?.id || tenant?.publicId || null;

  if (!tenantId) {
    throw new Error(`IAM tenant "${tenantRef}" was not found.`);
  }

  if (tenant?.slug) {
    resolvedTenantIds.set(tenant.slug, tenantId);
  }
  resolvedTenantIds.set(tenantRef, tenantId);
  return tenantId;
}

export async function resolveApplicationId(applicationSlug, tenantId) {
  if (!applicationSlug) return null;
  const cacheKey = `${tenantId || 'global'}:${applicationSlug}`;
  if (resolvedApplicationIds.has(cacheKey)) return resolvedApplicationIds.get(cacheKey);

  const query = tenantId ? `?tenantId=${encodeURIComponent(tenantId)}` : '';
  const applications = unwrapList(await iamRequest(`/apps${query}`));
  const application = applications.find((entry) => entry.slug === applicationSlug);
  const applicationId = application?.internalId || application?.id || application?.publicId || null;

  if (!applicationId) {
    throw new Error(`IAM application with slug "${applicationSlug}" was not found.`);
  }

  resolvedApplicationIds.set(cacheKey, applicationId);
  return applicationId;
}

async function resolveRoleId(roleName) {
  const normalizedRoleName = roleName || 'member';
  if (resolvedRoleIds.has(normalizedRoleName)) return resolvedRoleIds.get(normalizedRoleName);

  const roles = unwrapList(await iamRequest('/rbac/roles'));
  const role = roles.find((entry) => entry.name === normalizedRoleName);
  const roleId = role?.id || null;

  if (!roleId) {
    throw new Error(`IAM role "${normalizedRoleName}" was not found.`);
  }

  resolvedRoleIds.set(normalizedRoleName, roleId);
  return roleId;
}

async function findUserByEmail(email) {
  const users = unwrapList(
    await iamRequest(`/users?search=${encodeURIComponent(email)}&limit=1`),
  );

  const exactMatch = users.find((entry) => entry.email?.toLowerCase() === email.toLowerCase());
  if (!exactMatch) return null;

  return {
    internalId: exactMatch.internalId || exactMatch.id || null,
    publicId: exactMatch.publicId || null,
    email: exactMatch.email,
  };
}

async function createUser({ email, name, businessName, productId, iamProvisioning }) {
  const temporaryPassword = generateTemporaryPassword();
  const { firstName, lastName } = normalizeName(name);

  const created = unwrapPayload(
    await iamRequest('/users', {
      method: 'POST',
      body: {
        email,
        firstName,
        lastName,
        password: temporaryPassword,
        metadata: {
          bootstrapUser: iamProvisioning.bootstrapUser,
          forcePasswordChange: iamProvisioning.requirePasswordChangeOnFirstLogin,
          provisionSource: 'easydev_gateway_purchase',
          productSlug: iamProvisioning.applicationSlug || productId,
          businessName,
        },
      },
    }),
  );

  return {
    internalId: created?.internalId || created?.id || null,
    publicId: created?.publicId || null,
    temporaryPassword,
    isNewUser: true,
  };
}

async function ensureApplicationGrant({ userId, applicationId, tenantId }) {
  if (!applicationId) return;

  try {
    await iamRequest('/sso/grants', {
      method: 'POST',
      body: {
        userId,
        applicationId,
        ...(tenantId ? { tenantId } : {}),
      },
    });
  } catch (error) {
    if (error.status === 409) return;
    throw error;
  }
}

async function ensureTenantMembership({ tenantId, userId, roleId }) {
  try {
    const membership = unwrapPayload(
      await iamRequest(`/tenants/${tenantId}/users`, {
        method: 'POST',
        body: { userId, roleId },
      }),
    );

    return membership?.userId || null;
  } catch (error) {
    if (error.status === 409) {
      return null;
    }
    throw error;
  }
}

export async function provisionSharedIamUser({ productId, productName, iamProvisioning, customer }) {
  if (!iamProvisioning || iamProvisioning.provider !== 'shared-iam') {
    throw new Error(`Product "${productId}" is not configured for shared IAM provisioning.`);
  }

  const tenantId = await resolveTenantId(iamProvisioning.tenantSlug);
  const applicationId = await resolveApplicationId(iamProvisioning.applicationSlug, tenantId);
  const roleId = await resolveRoleId(iamProvisioning.defaultRole);

  let user = await findUserByEmail(customer.email);
  let temporaryPassword = null;
  let isNewUser = false;

  if (!user) {
    const createdUser = await createUser({
      email: customer.email,
      name: customer.name,
      businessName: customer.businessName,
      productId,
      iamProvisioning,
    });

    user = {
      internalId: createdUser.internalId,
      publicId: createdUser.publicId,
      email: customer.email,
    };
    temporaryPassword = createdUser.temporaryPassword;
    isNewUser = true;

    logger.info('Created shared IAM user for product provisioning', {
      productId,
      productName,
      email: customer.email,
      internalId: user.internalId,
      publicId: user.publicId,
    });
  } else {
    logger.info('Reusing existing shared IAM user for product provisioning', {
      productId,
      productName,
      email: customer.email,
      internalId: user.internalId,
      publicId: user.publicId,
    });
  }

  const membershipUserId = await ensureTenantMembership({
    tenantId,
    userId: user.publicId || user.internalId,
    roleId,
  });

  await ensureApplicationGrant({
    userId: user.publicId || user.internalId,
    applicationId,
    tenantId,
  });

  const resolvedIamUserId = membershipUserId || user.internalId;
  if (!resolvedIamUserId) {
    throw new Error(`Shared IAM provisioning could not resolve an internal user id for ${customer.email}.`);
  }

  return {
    iamUserId: resolvedIamUserId,
    temporaryPassword,
    isNewUser,
  };
}