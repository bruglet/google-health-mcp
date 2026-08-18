FROM node:22-bookworm-slim AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build
RUN npm prune --omit=dev

FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production \
    GOOGLE_HEALTH_MCP_TRANSPORT=http \
    GOOGLE_HEALTH_MCP_HOST=0.0.0.0 \
    GOOGLE_HEALTH_MCP_PORT=3000 \
    GOOGLE_HEALTH_PRIVACY_MODE=structured \
    GOOGLE_HEALTH_CACHE=false \
    GOOGLE_HEALTH_TOKEN_PATH=/home/node/.google-health-mcp/tokens.json \
    GOOGLE_HEALTH_SCOPES="https://www.googleapis.com/auth/googlehealth.profile.readonly https://www.googleapis.com/auth/googlehealth.settings.readonly https://www.googleapis.com/auth/googlehealth.activity_and_fitness.readonly https://www.googleapis.com/auth/googlehealth.health_metrics_and_measurements.readonly https://www.googleapis.com/auth/googlehealth.sleep.readonly https://www.googleapis.com/auth/googlehealth.nutrition.readonly"

WORKDIR /app

COPY --from=build --chown=node:node /app/package.json /app/package-lock.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist

RUN mkdir -p /home/node/.google-health-mcp \
    && chown -R node:node /home/node/.google-health-mcp

USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "--input-type=module", "-e", "try { const response = await fetch('http://127.0.0.1:3000/health'); if (!response.ok) process.exit(1); } catch { process.exit(1); }"]

CMD ["node", "dist/index.js"]
