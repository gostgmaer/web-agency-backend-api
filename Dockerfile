FROM node:20-alpine

# No native modules in this service — no build tools needed

# Retry pnpm install up to 3 times — Docker Desktop TLS can be flaky
RUN for i in 1 2 3; do \
    npm install -g pnpm@9 --quiet && break || \
    (echo "pnpm install attempt $i failed, retrying..." && sleep 3); \
  done && pnpm --version

WORKDIR /app

# Copy manifest + lockfile first for Docker layer caching
COPY package.json pnpm-lock.yaml ./

# Install production deps only (no devDependencies needed at runtime)
RUN pnpm install --prod

# Copy application source (node_modules excluded via .dockerignore)
COPY . .

EXPOSE 3500

CMD ["node", "server.js"]

CMD ["node", "server.js"]

