# Frontend Dockerfile - Standalone Node.js application
# No external backend required - fully self-contained
FROM node:20-slim AS builder
WORKDIR /app

# Install OpenSSL for Prisma and build dependencies
RUN apt-get update && apt-get install -y openssl libssl-dev python3 make g++ && rm -rf /var/lib/apt/lists/*

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

# Copy database file if exists
COPY --from=builder /app/prisma ./prisma

EXPOSE 3000

# Use Next.js standalone server directly
CMD ["node", "server.js"]
