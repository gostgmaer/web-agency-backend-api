/**
 * productProvisioner.js
 *
 * Central provisioning hub for all products sold through EasyDev.
 *
 * After a successful payment, the payments route calls `provision(productId, data)`
 * which dispatches to the correct product provisioner below.
 *
 * Adding a new product:
 *   1. Add its config block to config/index.js → products
 *   2. Add a new case to the switch in `provision()`
 *   3. Implement a `_provision<ProductName>()` function in this file
 *
 * All provisioners return:
 *   { success: true, ...productSpecificFields }
 * or throw an Error on failure.
 */

import { config } from '../config/index.js';
import logger from './logger.js';
import { AppError } from './errors.js';
import { sendAdminCreatedUser, sendProductAccessGranted } from './email.js';
import { provisionSharedIamUser } from './iamProvisioner.js';

function getProductIamProvisioning(productConfig) {
  if (!productConfig?.iamProvisioning) return null;

  const iamProvisioning = productConfig.iamProvisioning;
  if (iamProvisioning.provider !== 'shared-iam') return null;

  return {
    provider: iamProvisioning.provider,
    applicationSlug: iamProvisioning.applicationSlug || null,
    tenantSlug: iamProvisioning.tenantSlug || null,
    defaultRole: iamProvisioning.defaultRole || 'member',
    bootstrapUser: iamProvisioning.bootstrapUser !== false,
    requirePasswordChangeOnFirstLogin: iamProvisioning.requirePasswordChangeOnFirstLogin !== false,
  };
}

async function _linkCommunicationIamUser(productCfg, { businessId, iamUserId }) {
  const url = `${productCfg.provisionUrl}/onboarding/link-iam-user`;

  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Api-Key': productCfg.apiKey,
      },
      body: JSON.stringify({ businessId, iamUserId }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (networkErr) {
    logger.error('Communication backend unreachable during IAM link', {
      url,
      businessId,
      iamUserId,
      message: networkErr.message,
    });
    throw new Error('AI Communication account was created, but IAM linking failed. Please contact support.');
  }

  let body;
  try {
    body = await response.json();
  } catch {
    body = {};
  }

  if (!response.ok) {
    const message =
      body?.message ||
      (Array.isArray(body?.errors) ? body.errors.map((entry) => entry.message).join(', ') : null) ||
      `IAM link failed with status ${response.status}`;

    logger.error('Communication IAM link returned non-OK status', {
      status: response.status,
      businessId,
      iamUserId,
      message,
    });
    throw new Error(message);
  }

  return body?.data ?? body;
}

// ─── Public entry point ────────────────────────────────────────────────────────

/**
 * Provision a product account after a successful payment.
 *
 * Common concerns shared by ALL shared-IAM products are handled here:
 *   1. Central IAM provisioning (create / reuse user, grant app access, assign role)
 *   2. sendAdminCreatedUser  → only for brand-new IAM users
 *   3. sendProductAccessGranted → always sent after successful provisioning
 *
 * Each product-specific provisioner (_provision*) is responsible only for:
 *   - Calling its own API
 *   - Handling product-specific error codes (e.g. 409 → "already purchased")
 *   - Returning a normalised result shape:
 *       { success: true, loginUrl, userId, planType, temporaryPassword? }
 *
 * Adding a new product:
 *   1. Add its config block to config/index.js → products (with name, description, features, planMap)
 *   2. If it uses the central IAM platform, add an iamProvisioning block there.
 *   3. Add a new case to the switch below
 *   3. Implement _provision<ProductName>() that returns the normalised shape above
 *   — The IAM check and email logic below apply automatically.
 *
 * @param {string} productId  - Must match a key in config.products
 * @param {object} data       - { name, email, planKey, paymentId?, businessName?, externalId? }
 * @returns {Promise<object>} - Normalised result (always has success: true)
 */
export async function provision(productId, data) {
  const productConfig = config.products?.[productId];

  if (!productConfig) {
    throw new Error(`Unknown product "${productId}". Check config/index.js products section.`);
  }

  logger.info(`Provisioning product: ${productId}`, {
    email: data.email,
    planKey: data.planKey,
    paymentId: data.paymentId,
  });

  const productIamProvisioning = getProductIamProvisioning(productConfig);

  // ── Step 1: Product-specific local provisioning ───────────────────────────
  let result;

  switch (productConfig.provisionType) {
    case 'easydev-communication':
      result = await _provisionCommunication(productConfig, data);
      break;

    // Add further product types here:
    // case 'generic-webhook':
    //   result = await _provisionWebhook(productConfig, data);
    //   break;

    default:
      throw new Error(`Unknown provisionType "${productConfig.provisionType}" for product "${productId}".`);
  }

  // ── Step 2: Shared IAM provisioning + product link ───────────────────────
  let iamProvisionResult = null;
  if (productIamProvisioning) {
    iamProvisionResult = await provisionSharedIamUser({
      productId,
      productName: productConfig.name,
      iamProvisioning: productIamProvisioning,
      customer: {
        name: data.name,
        email: data.email,
        businessName: data.businessName || data.name,
      },
    });

    switch (productConfig.provisionType) {
      case 'easydev-communication':
        await _linkCommunicationIamUser(productConfig, {
          businessId: result.businessId,
          iamUserId: iamProvisionResult.iamUserId,
        });
        break;
      default:
        throw new Error(`IAM linking is not implemented for provisionType "${productConfig.provisionType}".`);
    }

    result = {
      ...result,
      iamUserId: iamProvisionResult.iamUserId,
      ...(iamProvisionResult.temporaryPassword ? { temporaryPassword: iamProvisionResult.temporaryPassword } : {}),
    };
  }

  // ── Step 3: Post-provision emails (all products) ──────────────────────────
  // Only send credentials email for brand-new IAM users.
  if (productIamProvisioning && iamProvisionResult?.isNewUser && iamProvisionResult.temporaryPassword) {
    sendAdminCreatedUser({
      username:          data.name,
      email:             data.email,
      temporaryPassword: iamProvisionResult.temporaryPassword,
      loginUrl:          result.loginUrl,
    }).catch(() => {});
  }

  // Always notify the customer about their new product access.
  sendProductAccessGranted({
    username:           data.name,
    email:              data.email,
    productName:        productConfig.name,
    productDescription: productConfig.description || '',
    productUrl:         result.loginUrl,
    planType:           result.planType || data.planKey,
    accessStartDate:    new Date(),
    accessEndDate:      new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
    features:           productConfig.features || [],
  }).catch(() => {});

  return result;
}

// ─── EasyDev Communication AI ─────────────────────────────────────────────────

/**
 * Provision an EasyDev Communication AI account.
 *
 * Calls POST /onboarding/create-account on the AI Communication NestJS backend.
 * This step creates ONLY the local product records. Shared IAM provisioning is
 * handled afterwards by web-agency-backend-api and linked back to the product.
 *
 * Returns the normalised shape expected by provision():
 *   { success: true, loginUrl, userId, businessId, planType }
 *
 * @param {object} productCfg - config.products['easydev-communication']
 * @param {object} data       - { name, email, planKey, paymentId?, businessName?, externalId? }
 */
async function _provisionCommunication(productCfg, data) {
  if (!productCfg.apiKey) {
    throw new Error(
      'COMMUNICATION_API_KEY is not set. Cannot provision AI Communication account.',
    );
  }

  // Map the EasyDev plan key to the Communication platform plan enum
  const communicationPlan = productCfg.planMap?.[data.planKey?.toLowerCase()] ?? 'growth';

  const payload = {
    name:         data.name,
    email:        data.email,
    plan:         communicationPlan,
    businessName: data.businessName || data.name,
    ...(data.paymentId   ? { paymentId:  data.paymentId   } : {}),
    ...(data.externalId  ? { externalId: data.externalId  } : {}),
  };

  const url = `${productCfg.provisionUrl}/onboarding/create-account`;

  let res;
  try {
    res = await fetch(url, {
      method:  'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Api-Key':    productCfg.apiKey,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(30_000), // 30 s
    });
  } catch (networkErr) {
    logger.error('Communication backend unreachable during provisioning', {
      url,
      message: networkErr.message,
    });
    throw new Error(
      'AI Communication platform is temporarily unavailable. ' +
      'Your payment was successful — we will set up your account shortly.',
    );
  }

  let body;
  try {
    body = await res.json();
  } catch {
    body = {};
  }

  if (!res.ok) {
    // 409 Conflict = account already exists in AI Comm → they already purchased
    if (res.status === 409) {
      logger.warn('Attempted duplicate purchase — AI Communication account already exists', {
        email: data.email,
      });
      throw new AppError(
        'You have already purchased this product. Please log in to access your account.',
        409,
      );
    }

    const msg =
      body?.message ||
      (Array.isArray(body?.errors) ? body.errors.map(e => e.message).join(', ') : null) ||
      `Provisioning failed with status ${res.status}`;

    logger.error('Communication provisioning returned non-OK status', {
      status: res.status,
      message: msg,
    });
    throw new Error(msg);
  }

  // Normalise — backend wraps in { data: {...} } or returns flat
  const raw = body?.data ?? body;

  logger.info('Communication account provisioned', {
    userId:     raw.userId,
    businessId: raw.businessId,
    email:      data.email,
  });

  // Return the normalised shape — provision() handles emails
  return {
    success:           true,
    loginUrl:          raw.loginUrl,
    userId:            raw.userId,
    businessId:        raw.businessId,
    planType:          communicationPlan,
  };
}
