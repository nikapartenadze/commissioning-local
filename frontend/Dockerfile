# Frontend Dockerfile - Next.js with custom server for WebSocket proxy
FROM node:20-slim AS builder
WORKDIR /app

# Install OpenSSL for Prisma
RUN apt-get update && apt-get install -y openssl libssl-dev && rm -rf /var/lib/apt/lists/*

# Copy package files
COPY package*.json ./
COPY prisma ./prisma/

# Install dependencies
RUN npm ci

# Copy source
COPY . .

# Build Next.js (standalone mode)
RUN npm run build

# Production image
FROM node:20-slim AS runner
WORKDIR /app

# Install OpenSSL for Prisma runtime
RUN apt-get update && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# Copy standalone build
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public

# Install http-proxy for WebSocket proxying (standalone doesn't include it)
RUN npm install http-proxy@1.18.1

# Copy custom server that wraps standalone + handles WebSocket proxy
COPY --from=builder /app/server.js ./custom-server.js

EXPOSE 3000

# Use custom server for WebSocket proxy support
CMD ["node", "custom-server.js"]
