/**
 * routes/job-agent.js
 *
 * Gateway routes for EasyDev AI Job Agent product.
 *
 * POST /api/job-agent/provision   — provision a new job-agent account
 * POST /api/job-agent/launch      — generate SSO launch URL for dashboard
 * ALL  /api/job-agent/proxy/*     — authenticated proxy to job-agent-service
 */

import express from "express";
import axios from "axios";
import jwt from "jsonwebtoken";
import { provision } from "../utils/productProvisioner.js";
import { resolveApplicationId, resolveTenantId } from "../utils/iamProvisioner.js";
import { AppError } from "../utils/errors.js";
import { config } from "../config/index.js";
import { authenticate } from "../middleware/auth.js";
import logger from "../utils/logger.js";
import { addGatewaySignatureHeaders, getPathFromUrl } from "../utils/gatewayHmac.js";

const router = express.Router();

function getJobAgentApiBase() {
  const raw = process.env.JOB_AGENT_URL;
  if (!raw) throw new AppError("AI Job Agent service is not configured.", 503);
  return raw.trim().replace(/\/+$/, "");
}

function getBearerAuthorization(req) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith("Bearer ")) {
    throw new AppError("A valid Bearer access token is required.", 401);
  }
  return auth;
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/job-agent/provision
// ─────────────────────────────────────────────────────────────────────────────
router.post("/provision", authenticate, async (req, res, next) => {
  try {
    const { name, email, planKey, paymentId, externalId } = req.body;
    const requestedPlanKey =
      typeof planKey === "string" ? planKey.toLowerCase().trim() : "";
    const productConfig = config.products?.["easydev-job-agent"];
    const planMap = productConfig?.planMap ?? {};
    const normalizedPlan = planMap[requestedPlanKey] ?? null;

    if (!name || typeof name !== "string" || !name.trim()) {
      throw new AppError("name is required.", 400);
    }
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new AppError("A valid email is required.", 400);
    }
    if (!requestedPlanKey || !normalizedPlan) {
      throw new AppError(
        "planKey is required. Supported: free, starter, premium, growth, pro, enterprise.",
        400,
      );
    }

    const normalizedEmail = email.toLowerCase().trim();
    const actorRole = String(req.user?.role ?? "").toLowerCase();
    const actorEmail = String(req.user?.email ?? "").toLowerCase().trim();
    const isPrivilegedActor = [
      "admin", "super_admin", "tenant_admin", "support", "finance",
    ].includes(actorRole);

    if (!isPrivilegedActor && actorEmail !== normalizedEmail) {
      throw new AppError("You can only provision your own account.", 403);
    }

    const tenantId = await resolveTenantId(config.tenantRef);
    const applicationId = await resolveApplicationId(
      "easydev-job-agent",
      tenantId,
    );

    const result = await provision({
      name: name.trim(),
      email: normalizedEmail,
      plan: normalizedPlan,
      tenantId,
      applicationId,
      paymentId,
      externalId,
      productConfig,
      iamConfig: config.iam,
    });

    logger.info({
      event: "job_agent.provisioned",
      email: normalizedEmail,
      plan: normalizedPlan,
      paymentId,
    });

    return res.status(201).json({
      success: true,
      message: "AI Job Agent account created successfully.",
      data: result,
    });
  } catch (err) {
    next(err);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/job-agent/launch
// ─────────────────────────────────────────────────────────────────────────────
router.post("/launch", authenticate, async (req, res, next) => {
  try {
    const authHeader = getBearerAuthorization(req);
    const iamBase = String(config.iam?.serviceUrl ?? "").replace(/\/+$/, "");

    // Request SSO launch token from IAM
    const ssoRes = await axios.post(
      `${iamBase}/api/v1/iam/sso/launch`,
      { applicationSlug: "easydev-job-agent" },
      {
        headers: addGatewaySignatureHeaders({ Authorization: authHeader }, {
          method: "POST",
          path: getPathFromUrl(`${iamBase}/api/v1/iam/sso/launch`),
          tenantId: req.user?.tenantId || req.headers["x-tenant-id"] || "",
          requestId: req.requestId,
          secret: config.gateway?.hmacSecret,
        }),
        timeout: 10_000,
      },
    );

    const ssoToken = ssoRes.data?.data?.token ?? ssoRes.data?.token;
    if (!ssoToken) {
      throw new AppError("Failed to obtain SSO launch token from IAM.", 502);
    }

    const frontendUrl = String(
      process.env.JOB_AGENT_FRONTEND_URL ?? config.app.frontendUrl,
    ).replace(/\/+$/, "");

    // ── Sync subscription plan to job-agent backend ──────────────────────────
    // Best-effort: decode the user's JWT to get tenantId, then look up their
    // job-agent profile in the backend and update the plan from the payment
    // service. Failures are logged but must NOT block the launch.
    try {
      const jobAgentBase = getJobAgentApiBase();
      const jobAgentApiKey = process.env.JOB_AGENT_API_KEY;
      const paymentBase = String(process.env.PAYMENT_SERVICE_URL ?? "").replace(/\/+$/, "");

      if (jobAgentApiKey && paymentBase && req.user?.id) {
        // Fetch the user's active subscription for the job-agent product.
        // The query string is baked into the URL (not axios `params`) so the
        // signed path matches exactly what payment-microservice's
        // GatewayHmacGuard reconstructs, and the signed tenantId/requestId are
        // also sent as headers for the same reason.
        const subTenantId = req.user?.tenantId || req.headers["x-tenant-id"] || "";
        const subUrl = `${paymentBase}/api/v1/subscriptions/active?productId=easydev-job-agent`;
        const subRes = await axios.get(
          subUrl,
          {
            headers: addGatewaySignatureHeaders({
              Authorization: authHeader,
              "x-tenant-id": subTenantId,
              ...(req.requestId ? { "x-request-id": req.requestId } : {}),
            }, {
              method: "GET",
              path: getPathFromUrl(subUrl),
              tenantId: subTenantId,
              requestId: req.requestId,
              secret: config.gateway?.hmacSecret,
            }),
            timeout: 5_000,
            validateStatus: (s) => s < 500,
          },
        );

        const sub = subRes.data?.data ?? subRes.data;
        const rawPlan = (sub?.plan ?? sub?.planKey ?? "free").toLowerCase();
        const plan = rawPlan === "premium" ? "PREMIUM" : "FREE";
        const status = sub?.status ?? "active";

        if (subRes.status === 200 && sub) {
          // Resolve the user's profileId from the job-agent backend
          const meRes = await axios.get(
            `${jobAgentBase}/auth/me`,
            {
              headers: addGatewaySignatureHeaders({ Authorization: authHeader }, {
                method: "GET",
                path: getPathFromUrl(`${jobAgentBase}/auth/me`),
                tenantId: req.user?.tenantId || req.headers["x-tenant-id"] || "",
                requestId: req.requestId,
                secret: config.gateway?.hmacSecret,
              }),
              timeout: 5_000,
              validateStatus: (s) => s < 500,
            },
          );

          const profileId = meRes.data?.data?.profileId ?? null;
          const tenantId = req.user?.tenantId ?? "";

          if (profileId) {
            await axios.post(
              `${jobAgentBase}/admin/sync-subscription`,
              { profileId, tenantId, plan, status },
              {
                headers: addGatewaySignatureHeaders({
                  "x-api-key": jobAgentApiKey,
                  "Content-Type": "application/json",
                }, {
                  method: "POST",
                  path: getPathFromUrl(`${jobAgentBase}/admin/sync-subscription`),
                  tenantId,
                  requestId: req.requestId,
                  secret: config.gateway?.hmacSecret,
                }),
                timeout: 5_000,
                validateStatus: (s) => s < 500,
              },
            );
            logger.info({ event: "job_agent.subscription_synced", profileId, plan, status });
          }
        }
      }
    } catch (syncErr) {
      // Non-blocking: log but continue with launch
      logger.warn({ event: "job_agent.subscription_sync_failed", error: syncErr?.message });
    }
    // ─────────────────────────────────────────────────────────────────────────

    const launchUrl = `${frontendUrl}/sso?token=${encodeURIComponent(ssoToken)}&slug=easydev-job-agent`;

    return res.json({ success: true, data: { launchUrl, token: ssoToken } });
  } catch (err) {
    next(err);
  }
});

// /api/job-agent/proxy/* is handled by proxy.js (no jsonParser, createProxyMiddleware)
// See routes/proxy.js → router.use('/job-agent/proxy', authenticate, buildProxy(...))

export default router;
