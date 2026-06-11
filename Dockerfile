# ═══════════════════════════════════════════════════════════════════════════
# Gateway — web-agency-backend-api
#
# Cross-compilation: builder runs on CI-native arch (x86_64) to avoid
# QEMU crashes during pnpm install.  Runner stage targets ARM64.
# No native modules in this service — deps are arch-independent JS.
# ═══════════════════════════════════════════════════════════════════════════

FROM --platform=$BUILDPLATFORM node:20-alpine AS builder

# Enable corepack (ships with Node 16.10+) and activate pnpm@10.
# corepack enable creates shims; corepack prepare downloads + pins the version.
RUN corepack enable && \
    for i in 1 2 3; do \
      corepack prepare pnpm@10 --activate && break || \
      (echo "corepack prepare attempt $i failed, retrying..." && sleep 3); \
    done && pnpm --version

WORKDIR /app

# Copy manifest + lockfile first for Docker layer caching
COPY package.json pnpm-lock.yaml ./

# Install production deps only (no devDependencies needed at runtime)
RUN pnpm install --prod

# Copy application source (node_modules excluded via .dockerignore)
COPY . .


# ── Production runner (target platform) ──────────────────────────────────────
FROM node:20-alpine AS runner

WORKDIR /app

# No native modules — copy everything from builder (JS-only deps are portable)
COPY --from=builder /app ./

# Runtime does not need package managers; remove them to reduce attack surface
# and avoid npm/corepack/pnpm node-pkg CVEs in image scans.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack && \
  rm -f /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/pnpm /usr/local/bin/pnpx

# Patch OpenSSL CVE-2026-45447 (heap use-after-free in PKCS7_verify)
RUN apk upgrade --no-cache libcrypto3 libssl3

EXPOSE 3300

CMD ["node", "server.js"]

