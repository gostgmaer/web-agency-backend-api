FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production

# Copy source + pre-installed flat node_modules (no network downloads)
COPY . .

# Recompile any native addons for Alpine
RUN npm rebuild

EXPOSE 3500
CMD ["node", "server.js"]
