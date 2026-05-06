/**
 * routes/job-agent-portal.js
 *
 * Gateway routes consumed by the standalone AI Job Agent frontend (port 3307).
 *
 * Auth model: the job-agent backend issues a `ja_session` httpOnly cookie
 * (a JWT signed with the shared JWT_SECRET) during SSO exchange.  This router
 * validates that cookie on every request, enforces rate limits, then proxies
 * transparently to the backend — preserving the raw body stream so multipart
 * file uploads (resume upload) work correctly.
 *
 * Mounted in app.js WITHOUT jsonParser so createProxyMiddleware can stream
 * binary/multipart bodies unmodified.
 *
 * Routes (all under /api/job-agent/portal):
 *   POST /api/v1/auth/sso/exchange  — public (sets the ja_session cookie)
 *   ALL  /*                         — requires valid ja_session cookie
 */

import express from "express";
import { createProxyMiddleware } from "http-proxy-middleware";
import jwt from "jsonwebtoken";
import rateLimit from "express-rate-limit";
import axios from "axios";
import { JWT_SECRET } from "../config/jwt.js";
import logger from "../utils/logger.js";

const router = express.Router();

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Extract the job-agent backend host (protocol + host + port only).
 * JOB_AGENT_URL is typically "http://localhost:3306/api/v1" or just
 * "http://localhost:3306".  createProxyMiddleware needs only the host.
 */
function getJobAgentTarget() {
  const raw = process.env.JOB_AGENT_URL;
  if (!raw) return null;
  try {
    const u = new URL(raw.trim().replace(/\/+$/, ""));
    return `${u.protocol}//${u.host}`;
  } catch {
    return raw.trim().replace(/\/api.*$/, "").replace(/\/+$/, "");
  }
}

/**
 * Parse a single named cookie from the raw Cookie header string.
 * Avoids a cookie-parser dependency.
 */
function extractCookie(cookieHeader, name) {
  if (!cookieHeader) return null;
  const re = new RegExp(`(?:^|;\\s*)${name}=([^;]+)`);
  const m = String(cookieHeader).match(re);
  return m ? decodeURIComponent(m[1]) : null;
}

// ── Middleware: validate ja_session cookie ────────────────────────────────────

/**
 * Verifies the `ja_session` httpOnly cookie issued by the job-agent backend.
 * The cookie is a JWT signed with the shared JWT_SECRET (same key as IAM).
 * On success attaches req.user = { id, email, role, tenantId }.
 */
function authenticateJobAgentCookie(req, res, next) {
  const sessionToken = extractCookie(req.headers.cookie ?? "", "ja_session");
  if (!sessionToken) {
    return res.status(401).json({
      success: false,
      message:
        "No active session. Please open the app from your EasyDev dashboard.",
    });
  }
  try {
    const decoded = jwt.verify(sessionToken, JWT_SECRET);
    req.user = {
      id: decoded.sub,
      email: decoded.email,
      role: Array.isArray(decoded.roles) ? decoded.roles[0] : decoded.role,
      tenantId: decoded.tenantId ?? "",
    };
    req.headers["x-tenant-id"] = req.user.tenantId;
    next();
  } catch {
    return res.status(401).json({
      success: false,
      message:
        "Session expired. Please re-open the app from your EasyDev dashboard.",
    });
  }
}

// ── Rate limiter ──────────────────────────────────────────────────────────────

const portalRateLimit = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 300,            // 300 req/min per IP — generous for a product dashboard
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: "Too many requests. Please slow down." },
  // In development allow unlimited to avoid interrupting dev workflow
  skip: () => process.env.NODE_ENV !== "production",
});

// ── POST /api/v1/auth/sso/exchange — public ───────────────────────────────────
//
// The frontend calls this first (from /sso page) to exchange the short-lived
// IAM SSO token for a `ja_session` cookie.  No cookie auth is required.
// We proxy to the backend via axios so we can intercept the Set-Cookie header
// and forward it — the browser will then store `ja_session` against the
// gateway origin (3301) rather than the backend origin (3306).

router.post(
  "/api/v1/auth/sso/exchange",
  express.json({ limit: "1mb" }), // parse the JSON body for this route only
  async (req, res, next) => {
    const target = getJobAgentTarget();
    if (!target) {
      return res.status(503).json({
        success: false,
        message: "AI Job Agent service is not configured.",
      });
    }
    try {
      const response = await axios.post(
        `${target}/api/v1/auth/sso/exchange`,
        req.body ?? {},
        {
          headers: {
            "Content-Type": "application/json",
            "x-request-id": req.requestId ?? "",
            "x-forwarded-for": req.ip ?? "",
          },
          timeout: 15_000,
          validateStatus: () => true,
        },
      );

      // Forward Set-Cookie so the browser stores ja_session on the gateway
      // origin — all subsequent portal calls will include it automatically.
      const setCookies = response.headers["set-cookie"];
      if (setCookies) res.setHeader("Set-Cookie", setCookies);

      return res.status(response.status).json(response.data);
    } catch (err) {
      next(err);
    }
  },
);

// ── Transparent proxy for all other portal routes ─────────────────────────────
//
// createProxyMiddleware streams the raw body, preserving binary/multipart
// payloads (e.g. resume file upload).  authenticateJobAgentCookie runs first.
//
// Path mapping:
//   Gateway mount:   /api/job-agent/portal
//   Frontend calls:  /api/job-agent/portal/api/v1/profile
//   Express strips mount → router sees:  /api/v1/profile
//   Proxy forwards to backend:           http://localhost:3306/api/v1/profile

function buildPortalProxy() {
  const target = getJobAgentTarget();
  if (!target) {
    // Return a 503 handler when the backend URL is not configured
    return (_req, res) =>
      res.status(503).json({
        success: false,
        message: "AI Job Agent service is not configured.",
      });
  }

  return createProxyMiddleware({
    target,
    changeOrigin: true,
    on: {
      proxyReq(proxyReq, req) {
        // Only forward the ja_session cookie — strip all other browser cookies
        const jaSession = extractCookie(req.headers.cookie ?? "", "ja_session");
        if (jaSession) {
          proxyReq.setHeader("Cookie", `ja_session=${jaSession}`);
        } else {
          proxyReq.removeHeader("Cookie");
        }
        // Propagate tenant context and tracing headers
        proxyReq.setHeader("x-tenant-id", req.user?.tenantId ?? "");
        proxyReq.setHeader("x-request-id", req.requestId ?? "");
        proxyReq.setHeader("x-forwarded-for", req.ip ?? "");
      },
      error(err, _req, res) {
        logger.error("Job Agent portal proxy error:", { message: err.message });
        if (!res.headersSent) {
          res.status(502).json({
            success: false,
            message: "AI Job Agent service is currently unavailable.",
          });
        }
      },
    },
  });
}

const portalProxy = buildPortalProxy();

router.use(portalRateLimit, authenticateJobAgentCookie, portalProxy);

export default router;
