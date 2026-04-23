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
import { sendAiCommunicationWelcome } from './email.js';

// ─── Public entry point ────────────────────────────────────────────────────────

/**
 * Provision a product account after a successful payment.
 *
 * @param {string} productId  - Must match a key in config.products
 * @param {object} data       - { name, email, planKey, paymentId?, businessName?, externalId? }
 * @returns {Promise<object>} - Product-specific result (always has success: true)
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

  switch (productConfig.provisionType) {
    case 'easydev-communication':
      return _provisionCommunication(productConfig, data);

    // Add further product types here:
    // case 'generic-webhook':
    //   return _provisionWebhook(productConfig, data);

    default:
      throw new Error(`Unknown provisionType "${productConfig.provisionType}" for product "${productId}".`);
  }
}

// ─── EasyDev Communication AI ─────────────────────────────────────────────────

/**
 * Provision an EasyDev Communication AI account.
 *
 * Calls POST /onboarding/create-account on the AI Communication NestJS backend.
 * Returns { loginUrl, userId, businessId, temporaryPassword }.
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
  const communicationPlan = productCfg.planMap?.[data.planKey?.toLowerCase()] ?? 'pro';

  const payload = {
    name:         data.name,
    email:        data.email,
    plan:         communicationPlan,
    businessName: data.businessName || data.name,
    ...(data.paymentId   ? { paymentId:  data.paymentId   } : {}),
    ...(data.externalId  ? { externalId: data.externalId  } : {}),
  };

  const url = `${productCfg.apiUrl}/onboarding/create-account`;

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
    // 409 Conflict = account already exists (idempotent — treat as success)
    if (res.status === 409) {
      logger.warn('Communication account already exists — returning existing account info', {
        email: data.email,
      });
      // Return a partial result — caller should redirect to login
      return {
        alreadyExists: true,
        message: body?.message || 'Account already exists.',
      };
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
  const result = body?.data ?? body;

  logger.info('Communication account provisioned', {
    userId:     result.userId,
    businessId: result.businessId,
    email:      data.email,
  });

  // Send welcome email with login instructions (fire-and-forget — non-fatal)
  sendAiCommunicationWelcome({
    name:              data.name,
    email:             data.email,
    loginUrl:          result.loginUrl,
    temporaryPassword: result.temporaryPassword,
    planName:          communicationPlan,
  }).catch(() => {}); // errors already logged inside sendAiCommunicationWelcome

  return {
    loginUrl:          result.loginUrl,
    userId:            result.userId,
    businessId:        result.businessId,
    temporaryPassword: result.temporaryPassword,
  };
}
