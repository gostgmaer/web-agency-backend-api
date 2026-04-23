FROM node:20-alpine AS deps
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@latest --activate
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
RUN corepack enable && corepack prepare pnpm@latest --activate
# Copy runtime deps
COPY --from=deps /app/node_modules ./node_modules
# Copy all source (no build step — pure ES module runtime)
COPY . .
EXPOSE 3500
CMD ["node", "server.js"]
