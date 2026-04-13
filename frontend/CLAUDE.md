# CLAUDE.md

This file provides guidance for working on the local commissioning tool in `frontend/`.

## Project Overview

Industrial I/O checkout tool for commissioning PLC systems in the field.

Technicians use this app on tablets or laptops to:

- pull subsystem I/O definitions from the cloud
- connect to a PLC over Ethernet/IP
- read tag states continuously
- mark I/O points pass/fail during testing
- work offline against a local SQLite database
- sync results back to the central cloud app

## Current Runtime

This app is no longer a pure Next.js runtime.

- Client: Vite + React 18 + React Router
- Server: Express 5 + TypeScript
- Database: `better-sqlite3` runtime access
- PLC: `ffi-rs` -> `libplctag`
- Realtime: WebSocket on the same app port, internal broadcast HTTP API on `3102`

The code still preserves a Next-style directory layout in places:

- page components remain under `app/`
- API handlers remain under `app/api/**/route.ts`
- Express mounts those route handlers through `routes/index.ts`

## Commands

```bash
cd frontend

npm run dev            # Vite client + tsx watch server
npm run build          # Build client bundle
npm run build:server   # Compile Express server TypeScript
npm run start          # Run compiled Express server
npm run lint           # ESLint
npm run test           # Vitest
npm run test:watch     # Vitest watch
npm run test:plc       # Full PLC test script
npm run test:plc:simple
npm run seed:diagnostics
npm run seed:network
npm run seed:estop
```

## Architecture

### Request Flow

```text
Browser
  -> Vite-built React app
  -> Express server on :3000
  -> API router in routes/index.ts
  -> handlers under app/api/**/route.ts
  -> SQLite / PLC / sync services
```

### Realtime Flow

```text
PLC tag reader
  -> plc-client-manager broadcasts event
  -> POST http://127.0.0.1:3102/broadcast
  -> WebSocket clients on ws://host:3000/ws
  -> React state updates in browser
```

### Data Flow

- Local runtime data is stored in `database.db` through `better-sqlite3`.
- `lib/db-sqlite.ts` initializes schema and acts as the runtime DB layer.
- `lib/prisma.ts` is only a compatibility re-export for older imports.
- `prisma/schema.prisma` is still useful as a schema reference and for seed scripts, but runtime access is not Prisma client based.

## Key Directories

```text
frontend/
  app/
    commissioning/[id]/page.tsx   # main operator UI
    setup/page.tsx                # setup flow
    guide/                        # operator guide pages
    api/                          # route handlers
  src/
    main.tsx                      # client entry
    router.tsx                    # React Router
    App.tsx                       # providers + app shell
  routes/
    index.ts                      # Express API mount table
    middleware.ts                 # auth/admin wrappers
  lib/
    db-sqlite.ts                  # runtime DB + schema bootstrap
    plc-client-manager.ts         # singleton PLC client + WS broadcast
    plc/                          # plc bindings, client, tag reader
    cloud/                        # cloud sync and auto-sync services
    config/                       # config.json loader/watcher
    auth/                         # JWT + auth helpers
  components/
    enhanced-io-data-grid.tsx     # main testing grid
    plc-toolbar.tsx               # top toolbar / quick actions
    network-topology-view.tsx
    estop-check-view.tsx
    safety-io-view.tsx
    l2-validation-view.tsx
  server-express.ts               # production server
```

## Key Behaviors

### Offline-First Field Operation

- Local writes happen first.
- Cloud sync is attempted immediately after a result/comment/reset change.
- Background sync retries keep pending work moving when connectivity returns.

See `../SYNC-ARCHITECTURE.md` for the full cross-system behavior.

### PLC Lifecycle

- The PLC client is managed as a singleton through `lib/plc-client-manager.ts`.
- `libplctag` is initialized lazily.
- Auto-reconnect is enabled with a 5 second retry interval.
- Testing UI depends heavily on live WebSocket events and cached tag states.

### Config

- Runtime config resolves beside the active SQLite database unless `CONFIG_PATH` overrides it.
- `lib/config/config-service.ts` watches the file for external changes.
- Cloud URL, API password, subsystem, and PLC connection settings are loaded from there.

## Auth Notes

There is some auth transition history in the codebase.

- Server-side JWT/PIN auth routes still exist under `app/api/auth`.
- Client-side operator identity is also persisted in `localStorage` through `lib/user-context.tsx`.

When changing auth, inspect both sides before assuming one model is authoritative.

## Testing Notes

- There is a real unit test setup here with Vitest under `__tests__/`.
- There are also manual PLC connectivity scripts for field verification.
- For sync, PLC, or data safety changes, prefer reading the tests before editing behavior.

## Working Guidance

- Prefer the actual code over older root docs when there is a conflict.
- If a change affects sync contracts, inspect `../commissioning-cloud/` too.
- If a change affects shared project/install data assumptions, inspect `../installation-tracker/` too.
