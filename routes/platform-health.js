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
import mongoose from "mongoose";

const router = express.Router();

const PING_TIMEOUT_MS = 8_000;

function normalizeCheckStatus(value) {
  if (typeof value === "boolean") return value ? "ok" : "error";

  const raw = String(value ?? "").trim().toLowerCase();
  if (!raw) return "unknown";

  if (["ok", "up", "healthy", "connected", "ready", "alive", "running", "success"].includes(raw)) {
    return "ok";
  }
  if (["error", "down", "unhealthy", "disconnected", "failed", "fail", "unreachable"].includes(raw)) {
    return "error";
  }
  if (["degraded", "warning", "warn"].includes(raw)) {
    return "degraded";
  }
  if (["disabled", "inactive", "off", "none", "n/a", "na"].includes(raw)) {
    return "disabled";
  }

  return raw;
}

function normalizeTopLevelStatus(value) {
  const status = normalizeCheckStatus(value);
  if (status === "unknown") return "ok";
  if (status === "disabled") return "ok";
  return status;
}

function normaliseChecks(rawChecks) {
  if (!rawChecks || typeof rawChecks !== "object" || Array.isArray(rawChecks)) return undefined;

  return Object.fromEntries(
    Object.entries(rawChecks).map(([k, v]) => {
      const raw = typeof v === "object" && v !== null && "status" in v ? v.status : v;
      return [k, normalizeCheckStatus(raw)];
    }),
  );
}

function extractInfraChecks(payload, baseChecks = {}) {
  const checks = { ...(baseChecks || {}) };
  const aliases = {
    database: ["database", "db"],
    redis: ["redis"],
    kafka: ["kafka"],
  };

  for (const [targetKey, keys] of Object.entries(aliases)) {
    if (checks[targetKey]) continue;
    for (const key of keys) {
      if (!(key in (payload || {}))) continue;
      const value = payload[key];
      const raw = typeof value === "object" && value !== null && "status" in value ? value.status : value;
      checks[targetKey] = normalizeCheckStatus(raw);
      break;
    }
  }

  return checks;
}

async function getGatewayServiceHealth() {
  const checks = {
    database: mongoose.connection.readyState === 1 ? "ok" : "error",
    redis: config.redis?.enabled ? "unknown" : "disabled",
    kafka: process.env.ENABLE_KAFKA === "true" ? "unknown" : "disabled",
  };

  if (config.redis?.enabled && config.redis?.url) {
    try {
      const { default: Redis } = await import("ioredis");
      const redis = new Redis(config.redis.url, {
        lazyConnect: true,
        maxRetriesPerRequest: 1,
        connectTimeout: 2_000,
      });
      try {
        await redis.connect();
        const pong = await redis.ping();
        checks.redis = normalizeCheckStatus(pong);
      } finally {
        await redis.quit().catch(() => {});
      }
    } catch {
      checks.redis = "error";
    }
  }

  const status = checks.database === "error" || checks.redis === "error" || checks.kafka === "error"
    ? "degraded"
    : "ok";

  return {
    name: "Gateway Service",
    status,
    checks,
    latencyMs: 0,
    timestamp: new Date().toISOString(),
  };
}

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
    const sourceChecks = payload?.checks ?? payload?.info ?? payload?.details ?? undefined;
    const checks = extractInfraChecks(payload, normaliseChecks(sourceChecks));
    const normalisedStatus = res.ok ? normalizeTopLevelStatus(payload?.status) : "error";
    return {
      name,
      status: normalisedStatus,
      checks: Object.keys(checks).length ? checks : undefined,
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

    services.push(await getGatewayServiceHealth());

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

    // ── 4. File upload service ─────────────────────────────────────────────
    const fileUploadHealthUrl = config.fileUpload?.healthUrl;
    if (fileUploadHealthUrl) {
      services.push(await pingUrl(fileUploadHealthUrl, "File Upload Service"));
    }

    // ── 5. AI Communication backend ────────────────────────────────────────
    const communicationTarget = config.communication?.proxyTarget;
    const communicationPath = config.communication?.proxyPath;
    if (communicationTarget && communicationPath) {
      services.push(await pingUrl(`${communicationTarget}${communicationPath}/health`, "AI Communication Service"));
    }

    // ── 6. Product applications (requires forwarded auth token) ────────────
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
