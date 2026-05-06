import "dotenv/config";
import app from "./app.js";
import { connectDatabase, disconnectDatabase } from "./config/database.js";
import logger from "./utils/logger.js";
import { config } from "./config/index.js";
import { startScheduler } from "./services/leadSchedulerService.js";
import {
  setRuntimeTenantFallback,
  getRuntimeTenantFallback,
} from "./utils/tenantFallback.js";
import { warmIamProvisioningCache } from "./utils/iamProvisioner.js";

const PORT = config.app.port || 3000;
const REQUEST_TIMEOUT = Number(config.performance.requestTimeout) || 30000;
const SHUTDOWN_TIMEOUT = Number(config.performance.shutdownTimeout) || 10000;
const STARTUP_ATTEMPTS_PER_CYCLE = 5;
const STARTUP_CYCLE_WINDOW_MS = 90_000; // 1.5 minutes total for quick retries
const STARTUP_RETRY_PAUSE_MS = 5 * 60_000; // 5 minutes between retry cycles

let server;
let isShuttingDown = false;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function syncDefaultTenantFromIam() {
  const iamBase = config.iam?.serviceUrl;
  if (!iamBase) {
    throw new Error("IAM service URL is not configured");
  }

  const configuredTenantRef = config.tenantRef || null;
  if (!configuredTenantRef) {
    throw new Error("TENANT environment variable is required");
  }

  try {
    const response = await fetch(
      `${iamBase}/api/v1/iam/tenants/resolve/public?ref=${encodeURIComponent(configuredTenantRef)}`,
      {
        method: "GET",
        signal: AbortSignal.timeout(8000),
      },
    );

    if (!response.ok) {
      throw new Error(
        `Configured TENANT could not be resolved by IAM (status=${response.status})`,
      );
    }

    const body = await response.json().catch(() => ({}));
    const payload = body?.data ?? body;

    const tenantId = payload?.internalId || payload?.id || null;
    const tenantSlug = payload?.slug || null;

    if (!tenantId) {
      throw new Error("Configured TENANT resolved without a tenant id");
    }

    setRuntimeTenantFallback({ tenantId, tenantSlug });
    logger.info("Runtime tenant fallback resolved from configured tenant ref", {
      configuredTenantRef,
      tenantId,
      tenantSlug,
    });
  } catch (error) {
    logger.error("Unable to resolve configured TENANT from IAM", {
      configuredTenantRef,
      error: error?.message,
    });
    throw new Error(`Tenant verification failed: ${error?.message || "Unknown error"}`);
  }
}

async function waitForStartupDependencies() {
  const retryDelayMs = Math.floor(
    STARTUP_CYCLE_WINDOW_MS / Math.max(STARTUP_ATTEMPTS_PER_CYCLE - 1, 1),
  );
  let cycle = 0;

  while (!isShuttingDown) {
    cycle += 1;

    for (let attempt = 1; attempt <= STARTUP_ATTEMPTS_PER_CYCLE; attempt += 1) {
      try {
        await syncDefaultTenantFromIam();
        await warmIamProvisioningCache();
        logger.info("Startup dependencies are ready", {
          cycle,
          attempt,
        });
        return;
      } catch (error) {
        logger.error("Startup dependency check failed", {
          cycle,
          attempt,
          maxAttempts: STARTUP_ATTEMPTS_PER_CYCLE,
          retryDelayMs,
          error: error?.message,
        });

        const isLastAttempt = attempt === STARTUP_ATTEMPTS_PER_CYCLE;
        if (!isLastAttempt && !isShuttingDown) {
          await sleep(retryDelayMs);
        }
      }
    }

    if (isShuttingDown) {
      break;
    }

    logger.warn("Startup dependencies unavailable after retry cycle; pausing before next cycle", {
      cycle,
      pauseMs: STARTUP_RETRY_PAUSE_MS,
    });
    await sleep(STARTUP_RETRY_PAUSE_MS);
  }

  throw new Error("Server shutdown requested while waiting for startup dependencies");
}

/**
 * Graceful shutdown handler
 */
const gracefulShutdown = async (signal) => {
  if (isShuttingDown) {
    logger.warn("Shutdown already in progress...");
    return;
  }

  isShuttingDown = true;
  logger.info(`${signal} received. Starting graceful shutdown...`);

  // Stop accepting new connections
  if (server) {
    server.close(async (err) => {
      if (err) {
        logger.error("Error closing server", { error: err.message });
      } else {
        logger.info("HTTP server closed");
      }
    });
  }

  // Give ongoing requests time to complete
  const shutdownTimer = setTimeout(() => {
    logger.warn("Shutdown timeout reached, forcing exit");
    process.exit(1);
  }, SHUTDOWN_TIMEOUT);

  try {
    // Close database connection
    await disconnectDatabase();
    logger.info("Database connections closed");

    clearTimeout(shutdownTimer);
    logger.info("Graceful shutdown completed");
    process.exit(0);
  } catch (error) {
    logger.error("Error during shutdown", { error: error.message });
    clearTimeout(shutdownTimer);
    process.exit(1);
  }
};

/**
 * Handle uncaught exceptions
 */
process.on("uncaughtException", (error) => {
  logger.error("Uncaught Exception", {
    error: error.message,
    stack: error.stack,
  });

  // Give time for logging before exit
  setTimeout(() => process.exit(1), 1000);
});

/**
 * Handle unhandled promise rejections
 */
process.on("unhandledRejection", (reason) => {
  logger.error("Unhandled Promise Rejection", {
    reason: reason?.message || reason,
    stack: reason?.stack,
  });
});

// Graceful shutdown signals
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));

/**
 * Start the server
 */
const startServer = async () => {
  try {
    await waitForStartupDependencies();
    const runtimeTenant = getRuntimeTenantFallback();

    logger.info("Gateway tenant startup config", {
      iamServiceUrl: config.iam?.serviceUrl,
      runtimeFallbackTenantId: runtimeTenant.tenantId,
      runtimeFallbackTenantSlug: runtimeTenant.tenantSlug,
    });

    // Connect to database with retry
    await connectDatabase();

    // Start lead cron jobs
    startScheduler();

    // Start HTTP server
    server = app.listen(PORT, () => {
      logger.info(`Server running on port ${PORT}`, {
        pid: process.pid,
        environment: config.app.nodeEnv || "development",
        apiDocs: `http://localhost:${PORT}/api-docs`,
      });
    });

    // Set server timeout
    server.timeout = REQUEST_TIMEOUT;
    server.keepAliveTimeout = 65000; // Slightly higher than ALB timeout
    server.headersTimeout = 66000; // Slightly higher than keepAliveTimeout
  } catch (error) {
    logger.error("Failed to start server", { error: error.message });
    process.exit(1);
  }
};

startServer();
