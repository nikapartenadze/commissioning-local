# Dev-mode commissioning-cloud — battle `delta` scenario ONLY. Throwaway, never prod.
#
# Runs `next dev` with DEV_BYPASS_AUTH=true so the cloud-mutator can drive the
# REAL admin API (POST/DELETE /api/admin/ios, imports) via the dev-admin
# NextAuth credentials provider. That fires the in-process recordChange +
# broadcastSubsystemChanged SSE hint — the exact production path the prod battle
# image cannot exercise (its NODE_ENV is baked to production by `next build`,
# which disables the dev-admin provider).
#
# Build context = the sibling commissioning-cloud repo:
#   docker build -t battle/cloud-dev:local -f battle/cloud-dev/Dockerfile ../commissioning-cloud
FROM node:20-bookworm-slim
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npx prisma generate
ENV NODE_ENV=development \
    DEV_BYPASS_AUTH=true \
    NEXT_TELEMETRY_DISABLED=1
EXPOSE 3000
# -H 0.0.0.0 so sibling containers (mutator, tool) can reach cloud:3000.
CMD ["npx", "next", "dev", "-p", "3000", "-H", "0.0.0.0"]
