# Migration from C# Backend to Node.js

This document describes the migration from the original C#/.NET backend architecture to a fully standalone Node.js application.

## Overview

The application has been migrated from a two-service architecture (C# backend + Next.js frontend) to a single Node.js application. The Next.js frontend now handles all backend functionality directly, eliminating the need for the C# backend service.

## What Changed

### Architecture

**Before (C# + Next.js):**
```
Browser -> Next.js (port 3020) -> C# Backend (port 5000) -> SQLite/PLC
                                         |
                              SignalR WebSocket Hub
```

**After (Node.js only):**
```
Browser -> Next.js (port 3020) -> Next.js API Routes -> SQLite/PLC
                    |
           WebSocket Server (integrated)
```

### Files Modified

1. **`next.config.mjs`**
   - Removed `/api/backend/*` proxy rewrite to C# backend
   - The rewrite is commented out for reference

2. **`lib/api-config.ts`**
   - Removed `backendPort` from RuntimeConfig
   - Removed `getBackendUrl()` function (no longer needed)
   - Updated `getSignalRHubUrl()` and `getSignalRWsUrl()` to use `getWebSocketUrl()` (deprecated, kept for compatibility)
   - Added `getWebSocketUrl()` for the new WebSocket implementation
   - Updated `getPorts()` to only return frontend port
   - All API endpoints now use `/api/*` directly (no `/api/backend/*` prefix)

3. **`.env.local`**
   - Removed `BACKEND_URL` environment variable

4. **`Dockerfile`**
   - Simplified to run Next.js standalone server directly
   - Removed http-proxy dependency (no SignalR proxy needed)
   - Removed custom-server.js reference

5. **`app/api/backend/[...path]/route.ts`**
   - This proxy route is now unused but kept for reference
   - Can be safely deleted once migration is complete

### Files That Can Be Removed

The following files/directories are no longer needed and can be deleted:

- `app/api/backend/[...path]/route.ts` - C# backend proxy (unused)
- `server.js` - Custom server for SignalR proxy (unused in new architecture)

## How to Run

### Development

```bash
cd frontend
npm install
npm run dev
```

The application will be available at http://localhost:3020

### Production (Docker)

```bash
cd frontend
docker build -t io-checkout-frontend .
docker run -p 3000:3000 io-checkout-frontend
```

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `DATABASE_URL` | SQLite database path | `file:./database.db` |
| `JWT_SECRET_KEY` | Secret for JWT signing | (required) |
| `JWT_ISSUER` | JWT issuer claim | `io-checkout-tool` |
| `JWT_AUDIENCE` | JWT audience claim | `io-checkout-frontend` |
| `JWT_EXPIRATION_HOURS` | Token expiration | `8` |
| `PORT` | Server port (production) | `3000` |

## C# Backend is No Longer Required

The following C# backend components are replaced by Next.js API routes:

| C# Component | Node.js Replacement |
|--------------|---------------------|
| Controllers/ApiController | `app/api/*` routes |
| SignalR Hub | WebSocket server in `lib/websocket-server.ts` |
| PlcCommunicationService | `lib/plc/plc-client.ts` |
| Entity Framework/SQLite | Prisma ORM |
| JWT Authentication | `lib/auth/*` with jsonwebtoken |

## API Endpoints

All API endpoints remain at the same paths, just without the `/backend` prefix:

- `/api/ios` - I/O management
- `/api/auth/login` - Authentication
- `/api/configuration/*` - Configuration management
- `/api/users/*` - User management
- `/api/simulator/*` - PLC simulator
- `/ws` - WebSocket for real-time updates (replaces SignalR `/hub`)

## Notes

- PLC communication now uses `ffi-rs` (native FFI) instead of P/Invoke
- The WebSocket implementation uses native `ws` package instead of SignalR
- Database migrations are handled by Prisma instead of EF Core
- The application is fully self-contained and can run without any external dependencies (except the PLC hardware for production use)
