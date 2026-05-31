# syntax=docker/dockerfile:1
# ============================================================================
# Commissioning Tool — Centralized Server (Phase 0: containerized monolith)
# ----------------------------------------------------------------------------
# Runtime is Vite (client) + Express 5 (server-express.ts), NOT Next.js.
# This image mirrors deploy/build-portable-auto.ps1 — the proven production
# layout — but for Linux:
#
#   /app/server-express.js   compiled server entry (CMD)
#   /app/dist/               Vite client build  (server does path.join(__dirname,'dist'))
#   /app/lib/startup-backup.js   hand-written JS, required at runtime (not tsc-compiled)
#   /app/libplctag.so        native libplctag, found via __dirname / cwd
#   /app/node_modules/       production deps only (better-sqlite3 + ffi-rs compiled for linux)
#   /data/                   VOLUME — database.db, config.json, logs/, backups/ (never in image)
#
# See ../CENTRAL-SERVER-DEPLOYMENT.md for the deployment & modularity plan.
# ============================================================================

# ---- Stage 1: builder — compile client + server, produce prod node_modules --
# Debian 13 (trixie, glibc 2.41). The prebuilt libplctag.so requires GLIBC_2.38,
# which bookworm (glibc 2.36) does NOT provide — using trixie satisfies it and
# keeps the native better-sqlite3/ffi-rs ABI consistent with the runner stage.
FROM node:20-trixie-slim AS builder
WORKDIR /build

# better-sqlite3 compiles from source; ffi-rs ships prebuilt napi binaries.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# Install deps first for layer caching. prisma/ must be present BEFORE npm ci
# because the postinstall hook runs `prisma generate` against prisma/schema.prisma.
COPY package.json package-lock.json ./
COPY prisma ./prisma/
RUN npm ci

# Build the client bundle (-> dist) and compile the server (-> dist-server).
COPY . .
RUN npm run build \
 && npm run build:server

# Drop devDependencies (vite, typescript, etc). Native modules stay compiled.
RUN npm prune --omit=dev

# ---- Stage 2: runner — minimal runtime image --------------------------------
# Must match the builder's glibc (trixie) for the copied native modules AND so
# libplctag.so's GLIBC_2.38 requirement is satisfied at runtime.
FROM node:20-trixie-slim AS runner
WORKDIR /app

ENV NODE_ENV=production \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    # Absolute path so the /data volume holds DB + config + logs + backups
    # without shadowing the app code under /app (storage-paths.ts derives all
    # of config.json / logs/ / backups/ from the database directory).
    DATABASE_URL=file:/data/database.db

# Compiled server (server-express.js, routes/, lib/, app/api/) + client bundle.
COPY --from=builder /build/dist-server/ ./
COPY --from=builder /build/dist ./dist

# startup-backup.js is a hand-written .js (tsc only emits .ts) — copy it in.
COPY --from=builder /build/lib/startup-backup.js ./lib/startup-backup.js

# Native PLC library (Linux). NOTE: validate against real hardware — see
# CENTRAL-SERVER-DEPLOYMENT.md §5 risk #1 (libplctag-on-Linux / ffi-rs binding).
COPY --from=builder /build/libplctag.so ./libplctag.so

# Production dependencies (better-sqlite3 + ffi-rs already compiled for linux).
COPY --from=builder /build/node_modules ./node_modules

# package.json present so getAppVersion()/heartbeat self-reports the real version.
COPY --from=builder /build/package.json ./package.json

# Data dir is a mount point; create it so first boot can write before a volume
# is attached (compose attaches one regardless).
RUN mkdir -p /data
VOLUME ["/data"]

EXPOSE 3000

# App + WebSocket (/ws upgrade). The internal broadcast API binds 127.0.0.1:3102
# inside the container only — never published.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:3000/',r=>process.exit(r.statusCode<500?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "server-express.js"]
