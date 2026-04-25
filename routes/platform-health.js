/**
 * Platform Health Aggregator
 *
 * GET /api/platform-health
 *
 * Pings all registered services and, when an auth token is provided,
 * also pings every registered product application that has a healthCheckUrl.
 * Returns a combined status report suitable for the Platform Overview dashboard.
 */

import express from "express";
import { config } from "../config/index.js";
import logger from "../utils/logger.js";

const router = express.Router();

const PING_TIMEOUT_MS = 8_000;

/**
 * Ping a single URL and return a health summary object.
 * Never throws — unreachable services are returned with status "unreachable".
 */
async function pingUrl(url, name) {
  const start = Date.now();
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PING_TIMEOUT_MS);
    let res;
    try {
      res = await fetch(url, { signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
    const latencyMs = Date.now() - start;
    let body = null;
    try { body = await res.json(); } catch { /* non-JSON response — that's fine */ }
    // Some services (IAM NestJS) wrap their response in a ResponseInterceptor envelope:
    // { success, data: { status, checks, ... }, message, timestamp }
    // Others (comm service) return the raw health object directly.
    const payload = body?.data && typeof body.data === "object" && !Array.isArray(body.data) ? body.data : body;
    // Normalise checks: some services use { checks: {...} }, others use { info: {...} } or { details: {...} }
    // We prefer `checks`, then fall back to `info`, then `details`.
    // Convert { key: { status: "up" } } → { key: "up" } for display consistency.
    let checks = payload?.checks ?? payload?.info ?? payload?.details ?? undefined;
    if (checks && typeof checks === "object" && !Array.isArray(checks)) {
      // Normalise { key: { status: "up"|"ok" } } → { key: "ok"|<value> }
      checks = Object.fromEntries(
        Object.entries(checks).map(([k, v]) => {
          const raw = typeof v === "object" && v !== null && "status" in v ? v.status : v;
          return [k, raw === "up" ? "ok" : raw];
        }),
      );
    }
    // Also normalise root status: "up" → "ok"
    const normalisedStatus = res.ok ? ((payload?.status === "up" ? "ok" : payload?.status) ?? "ok") : "error";
    return {
      name,
      status: normalisedStatus,
      checks,
      latencyMs,
      timestamp: payload?.timestamp ?? body?.timestamp ?? new Date().toISOString(),
    };
  } catch (err) {
    return {
      name,
      status: "unreachable",
      latencyMs: Date.now() - start,
      timestamp: new Date().toISOString(),
    };
  }
}

router.get("/", async (req, res, next) => {
  try {
    const services = [];

    // ── 1. Auth service (IAM Platform) ─────────────────────────────────────
    const authServiceUrl = config.auth?.serviceUrl;
    if (authServiceUrl) {
      services.push(await pingUrl(`${authServiceUrl}/api/v1/iam/health`, "IAM Platform"));
    }

    // ── 2. Payment Microservice ───────────────────────────────────────────────
    const paymentServiceUrl = config.payment?.serviceUrl;
    if (paymentServiceUrl) {
      services.push(await pingUrl(`${paymentServiceUrl}/api/v1/health`, "Payment Service"));
    }

    // ── 3. Notification service ─────────────────────────────────────────────
    const notificationHealthUrl = config.notification?.healthUrl;
    if (notificationHealthUrl) {
      services.push(await pingUrl(notificationHealthUrl, "Notification Service"));
    }

    // ── 4. Product applications (requires forwarded auth token) ────────────
    const products = [];
    const authHeader = req.headers["authorization"];
    if (authHeader && authServiceUrl) {
      try {
        const appsRes = await fetch(
          `${authServiceUrl}/api/v1/iam/apps?limit=100`,
          {
            headers: { Authorization: authHeader },
            signal: AbortSignal.timeout(10_000),
          },
        );
        if (appsRes.ok) {
          const appsBody = await appsRes.json();
          // The IAM service wraps responses: { success, data: [...], meta: {...} }
          const apps = Array.isArray(appsBody?.data) ? appsBody.data : [];
          const appsWithHealth = apps.filter((a) => a.healthCheckUrl);
          const pingResults = await Promise.allSettled(
            appsWithHealth.map((a) => pingUrl(a.healthCheckUrl, a.name)),
          );
          for (let i = 0; i < pingResults.length; i++) {
            const r = pingResults[i];
            const app = appsWithHealth[i];
            products.push({
              publicId: app.publicId,
              name: app.name,
              isActive: app.isActive,
              healthCheckUrl: app.healthCheckUrl,
              ...(r.status === "fulfilled"
                ? r.value
                : { status: "unreachable", latencyMs: 0, timestamp: new Date().toISOString() }),
            });
          }
          // Also list apps without a healthCheckUrl as "unknown"
          for (const app of apps.filter((a) => !a.healthCheckUrl)) {
            products.push({
              publicId: app.publicId,
              name: app.name,
              isActive: app.isActive,
              healthCheckUrl: null,
              status: "unknown",
              latencyMs: null,
              timestamp: new Date().toISOString(),
            });
          }
        }
      } catch (err) {
        logger.warn("platform-health: failed to fetch app list from IAM", {
          message: err.message,
        });
      }
    }

    // ── Derive overall status ───────────────────────────────────────────────
    const allItems = [...services, ...products.filter((p) => p.status !== "unknown")];
    const overallStatus =
      allItems.length === 0
        ? "unknown"
        : allItems.every((s) => s.status === "ok")
        ? "ok"
        : allItems.some((s) => s.status === "degraded")
        ? "degraded"
        : allItems.every((s) => s.status !== "ok")
        ? "error"
        : "degraded";

    // Wrap in `data` so the gateway envelope doesn't overwrite our `status` field.
    return res.json({
      success: true,
      data: {
        healthStatus: overallStatus,
        services,
        products,
        checkedAt: new Date().toISOString(),
      },
    });
  } catch (err) {
    logger.error("platform-health: unexpected error", { message: err.message });
    return next(err);
  }
});

export default router;
