FROM node:20-alpine

# No native modules in this service — no build tools needed

# Enable corepack (ships with Node 16.10+) and activate pnpm@9.
# corepack enable creates shims; corepack prepare downloads + pins the version.
RUN corepack enable && \
    for i in 1 2 3; do \
      corepack prepare pnpm@9 --activate && break || \
      (echo "corepack prepare attempt $i failed, retrying..." && sleep 3); \
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

