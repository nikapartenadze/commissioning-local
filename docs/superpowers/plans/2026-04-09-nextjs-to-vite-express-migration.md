# Next.js to Vite + Express Migration Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Next.js (70-90MB RAM) with Vite (static React build) + Express (API server), preserving all functionality while halving memory usage.

**Architecture:** Vite builds React frontend as static files served by Express. All 72 API routes migrate from Next.js `route.ts` exports to Express route handlers with identical logic. WebSocket server, broadcast API, PLC communication, and cloud sync remain unchanged.

**Tech Stack:** Vite 6, React 18, React Router 6, Express 4, TypeScript, Tailwind CSS, better-sqlite3, ffi-rs, ws

---

## File Structure

### New Files to Create

| File | Responsibility |
|------|---------------|
| `frontend/vite.config.ts` | Vite build config: React plugin, path aliases, env var injection, native module externals |
| `frontend/index.html` | Vite entry point HTML (replaces Next.js auto-generated HTML) |
| `frontend/src/main.tsx` | React app entry: mounts App component to DOM |
| `frontend/src/App.tsx` | Root component: providers (Theme, User, Error) + React Router |
| `frontend/src/router.tsx` | Route definitions for 5 pages |
| `frontend/server-express.ts` | Express server: static files + API routes + WebSocket + broadcast |
| `frontend/routes/index.ts` | Express API route registrar: maps all 72 routes to Express |
| `frontend/routes/middleware.ts` | Express auth middleware (withAuth, withAdmin, requireAuth) |
| `frontend/routes/helpers.ts` | Shared route helpers: parseParams, parseQuery, jsonResponse |

### Files to Modify

| File | Change |
|------|--------|
| `frontend/package.json` | Remove `next`, add `vite`, `express`, `react-router-dom`; update scripts |
| `frontend/tsconfig.json` | Remove Next.js plugin, update jsx/include |
| `frontend/tailwind.config.ts` | Add `index.html` to content paths |
| `frontend/app/commissioning/[id]/page.tsx` | Replace `useParams`/`useRouter` from next/navigation with react-router-dom |
| `frontend/app/commissioning/page.tsx` | Replace `useRouter` with `useNavigate` |
| `frontend/app/setup/page.tsx` | Replace `useRouter` with `useNavigate` |
| `frontend/app/guide/page.tsx` | Replace `next/link` with react-router-dom Link |
| `frontend/components/theme-provider.tsx` | No change needed (next-themes works standalone) |
| `frontend/components/navigation-breadcrumb.tsx` | Replace `next/link` |
| `frontend/components/plc-toolbar.tsx` | Replace `next/link` |
| `frontend/lib/auth/middleware.ts` | Keep as-is (Express middleware wraps it) |
| `frontend/deploy/BUILD-PORTABLE.bat` | Replace `next build` with `vite build`, update copy steps |
| `frontend/server.js` | Replace with `server-express.ts` (or adapt in-place) |

### Files to Delete

| File | Reason |
|------|--------|
| `frontend/next.config.mjs` | Next.js config, replaced by vite.config.ts |
| `frontend/middleware.ts` | Next.js middleware (currently disabled/passthrough) |
| `frontend/next-env.d.ts` | Next.js type declarations |
| `frontend/app/layout.tsx` | Replaced by src/App.tsx |
| `frontend/app/page.tsx` | Root redirect, handled by React Router |
| `frontend/app/loading.tsx` | Next.js loading state, not needed |
| `frontend/app/project/[id]/loading.tsx` | Next.js loading state |

---

## Task 1: Create Vite Config + Entry Point

**Files:**
- Create: `frontend/vite.config.ts`
- Create: `frontend/index.html`
- Create: `frontend/src/main.tsx`

- [ ] **Step 1: Create vite.config.ts**

```typescript
// frontend/vite.config.ts
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'
import { execSync } from 'child_process'

// Git build info (same logic as next.config.mjs)
let gitHash = 'dev'
let gitTag = ''
let buildDate = new Date().toISOString()
try {
  gitHash = execSync('git rev-hash --short HEAD', { encoding: 'utf8' }).trim()
  gitTag = execSync('git describe --tags --abbrev=0 2>/dev/null || echo ""', { encoding: 'utf8' }).trim()
} catch {}

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, '.'),
    },
  },
  define: {
    'import.meta.env.VITE_BUILD_HASH': JSON.stringify(gitHash),
    'import.meta.env.VITE_BUILD_DATE': JSON.stringify(buildDate),
    'import.meta.env.VITE_BUILD_VERSION': JSON.stringify(gitTag || `build-${gitHash}`),
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
  },
  server: {
    proxy: {
      '/api': 'http://localhost:3000',
      '/ws': { target: 'ws://localhost:3000', ws: true },
    },
  },
})
```

- [ ] **Step 2: Create index.html**

```html
<!-- frontend/index.html -->
<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>IO Checkout Tool - Commissioning</title>
    <link rel="icon" href="/favicon.ico" />
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 3: Create src/main.tsx**

```tsx
// frontend/src/main.tsx
import React from 'react'
import ReactDOM from 'react-dom/client'
import { App } from './App'
import '../app/globals.css'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
```

- [ ] **Step 4: Verify Vite starts (frontend only)**

Run: `cd frontend && npx vite --open`
Expected: Vite dev server starts, shows blank page (App component not yet created)

- [ ] **Step 5: Commit**

```bash
git add frontend/vite.config.ts frontend/index.html frontend/src/main.tsx
git commit -m "chore: add Vite config and entry point"
```

---

## Task 2: Create React Router + App Shell

**Files:**
- Create: `frontend/src/App.tsx`
- Create: `frontend/src/router.tsx`

- [ ] **Step 1: Create src/router.tsx with all 5 page routes**

```tsx
// frontend/src/router.tsx
import { createBrowserRouter, Navigate } from 'react-router-dom'
import { lazy, Suspense } from 'react'

// Lazy-load pages for code splitting
const CommissioningRedirect = lazy(() => import('../app/commissioning/page'))
const CommissioningPage = lazy(() => import('../app/commissioning/[id]/page'))
const SetupPage = lazy(() => import('../app/setup/page'))
const GuidePage = lazy(() => import('../app/guide/page'))
const GuideScreenshots = lazy(() => import('../app/guide/screenshots/page'))

function Loading() {
  return (
    <div className="flex items-center justify-center h-screen text-muted-foreground">
      Loading...
    </div>
  )
}

function LazyPage({ Component }: { Component: React.LazyExoticComponent<any> }) {
  return (
    <Suspense fallback={<Loading />}>
      <Component />
    </Suspense>
  )
}

export const router = createBrowserRouter([
  { path: '/', element: <Navigate to="/commissioning/_" replace /> },
  { path: '/commissioning', element: <LazyPage Component={CommissioningRedirect} /> },
  { path: '/commissioning/:id', element: <LazyPage Component={CommissioningPage} /> },
  { path: '/setup', element: <LazyPage Component={SetupPage} /> },
  { path: '/guide', element: <LazyPage Component={GuidePage} /> },
  { path: '/guide/screenshots', element: <LazyPage Component={GuideScreenshots} /> },
])
```

- [ ] **Step 2: Create src/App.tsx with providers**

```tsx
// frontend/src/App.tsx
import { RouterProvider } from 'react-router-dom'
import { ThemeProvider } from '@/components/theme-provider'
import { UserProvider } from '@/lib/user-context'
import { Toaster } from '@/components/ui/toaster'
import { ErrorBoundary } from '@/components/error-boundary'
import { router } from './router'

export function App() {
  return (
    <ErrorBoundary>
      <UserProvider>
        <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange={false} storageKey="io-checkout-theme">
          <RouterProvider router={router} />
          <Toaster />
        </ThemeProvider>
      </UserProvider>
    </ErrorBoundary>
  )
}
```

- [ ] **Step 3: Commit**

```bash
git add frontend/src/App.tsx frontend/src/router.tsx
git commit -m "feat: add React Router app shell with lazy-loaded pages"
```

---

## Task 3: Adapt Page Components for React Router

**Files:**
- Modify: `frontend/app/commissioning/page.tsx`
- Modify: `frontend/app/commissioning/[id]/page.tsx`
- Modify: `frontend/app/setup/page.tsx`
- Modify: `frontend/app/guide/page.tsx`
- Modify: `frontend/components/navigation-breadcrumb.tsx`
- Modify: `frontend/components/plc-toolbar.tsx`

- [ ] **Step 1: Replace next/navigation in commissioning/page.tsx**

Replace:
```tsx
import { useRouter } from "next/navigation"
```
With:
```tsx
import { useNavigate } from "react-router-dom"
```

Replace all `router.replace(` with `navigate(`, adding `{ replace: true }` as second arg.
Add `export default` to the component if it uses named export.

- [ ] **Step 2: Replace next/navigation in commissioning/[id]/page.tsx**

Replace:
```tsx
import { useParams, useRouter } from "next/navigation"
```
With:
```tsx
import { useParams, useNavigate } from "react-router-dom"
```

Replace `router.push(` with `navigate(`.
Replace `router.replace(` with `navigate(path, { replace: true })`.

Replace `NEXT_PUBLIC_BUILD_VERSION` / `NEXT_PUBLIC_BUILD_HASH` / `NEXT_PUBLIC_BUILD_DATE`:
```tsx
// Before
process.env.NEXT_PUBLIC_BUILD_HASH
// After
import.meta.env.VITE_BUILD_HASH
```

Add `export default` if needed.

- [ ] **Step 3: Replace next/navigation in setup/page.tsx**

Same pattern: `useRouter` → `useNavigate`, `router.push` → `navigate`.

- [ ] **Step 4: Replace next/link in guide/page.tsx and components**

In guide/page.tsx, navigation-breadcrumb.tsx, plc-toolbar.tsx:
```tsx
// Before
import Link from "next/link"
<Link href="/path">
// After
import { Link } from "react-router-dom"
<Link to="/path">
```

Note: React Router's Link uses `to` prop, not `href`.

- [ ] **Step 5: Type-check**

Run: `cd frontend && npx tsc --noEmit`
Expected: No errors (React Router types are compatible)

- [ ] **Step 6: Commit**

```bash
git add frontend/app/ frontend/components/navigation-breadcrumb.tsx frontend/components/plc-toolbar.tsx
git commit -m "refactor: replace Next.js navigation with React Router"
```

---

## Task 4: Create Express Route Helpers + Auth Middleware

**Files:**
- Create: `frontend/routes/helpers.ts`
- Create: `frontend/routes/middleware.ts`

- [ ] **Step 1: Create routes/helpers.ts**

```typescript
// frontend/routes/helpers.ts
import { Request, Response } from 'express'

/** Parse dynamic route params (mirrors Next.js params) */
export function getParam(req: Request, name: string): string {
  return req.params[name] || ''
}

/** Parse query string params (mirrors request.nextUrl.searchParams) */
export function getQuery(req: Request, name: string): string | null {
  const val = req.query[name]
  if (typeof val === 'string') return val
  if (Array.isArray(val)) return val[0] as string
  return null
}

/** Send JSON response with optional status (mirrors NextResponse.json) */
export function jsonResponse(res: Response, data: any, status = 200): void {
  res.status(status).json(data)
}
```

- [ ] **Step 2: Create routes/middleware.ts**

```typescript
// frontend/routes/middleware.ts
import { Request, Response, NextFunction, RequestHandler } from 'express'

// Re-use existing auth logic
import { verifyAuth, type DecodedToken } from '@/lib/auth/middleware'

// Extend Express Request to carry auth user
declare global {
  namespace Express {
    interface Request {
      user?: DecodedToken
    }
  }
}

/** Express middleware: verify auth token, attach user to req */
export const authMiddleware: RequestHandler = (req, res, next) => {
  // Reuse existing verifyAuth logic (currently returns anonymous user)
  const result = verifyAuth(req as any)
  if (!result.success) {
    return res.status(401).json({ error: result.error || 'Unauthorized' })
  }
  req.user = result.user!
  next()
}

/** Express middleware: verify admin role */
export const adminMiddleware: RequestHandler = (req, res, next) => {
  authMiddleware(req, res, () => {
    if (!req.user?.isAdmin) {
      return res.status(403).json({ error: 'Forbidden' })
    }
    next()
  })
}

/** Wrapper: creates Express handler from a function that receives (req, user) */
export function withAuth(handler: (req: Request, user: DecodedToken, res: Response) => Promise<void>): RequestHandler[] {
  return [authMiddleware, async (req, res, next) => {
    try { await handler(req, req.user!, res) } catch (e) { next(e) }
  }]
}

export function withAdmin(handler: (req: Request, user: DecodedToken, res: Response) => Promise<void>): RequestHandler[] {
  return [adminMiddleware, async (req, res, next) => {
    try { await handler(req, req.user!, res) } catch (e) { next(e) }
  }]
}
```

- [ ] **Step 3: Commit**

```bash
git add frontend/routes/helpers.ts frontend/routes/middleware.ts
git commit -m "feat: add Express route helpers and auth middleware"
```

---

## Task 5: Convert API Routes to Express (Batch 1 — Core)

**Files:**
- Modify: All 72 files in `frontend/app/api/**/route.ts`
- Create: `frontend/routes/index.ts`

This is the biggest task. Each route file needs mechanical conversion:

**Conversion pattern for every route:**

```typescript
// BEFORE (Next.js)
import { NextRequest, NextResponse } from 'next/server'
export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const query = request.nextUrl.searchParams.get('filter')
  const body = await request.json() // POST only
  return NextResponse.json({ data }, { status: 200 })
}

// AFTER (Express)
import { Request, Response } from 'express'

export async function GET(req: Request, res: Response) {
  const id = req.params.id
  const query = req.query.filter as string | undefined
  const body = req.body // POST only (express.json() middleware)
  res.json({ data })
}
```

- [ ] **Step 1: Create routes/index.ts route registrar**

```typescript
// frontend/routes/index.ts
import { Router } from 'express'

export function createApiRouter(): Router {
  const router = Router()

  // Health
  router.get('/api/health', (await import('@/app/api/health/route')).GET)

  // Auth
  router.post('/api/auth/login', (await import('@/app/api/auth/login/route')).POST)
  router.get('/api/auth/verify', (await import('@/app/api/auth/verify/route')).GET)

  // Configuration
  router.get('/api/configuration', (await import('@/app/api/configuration/route')).GET)
  router.put('/api/configuration', (await import('@/app/api/configuration/route')).PUT)
  // ... register all 72 routes ...

  // Dynamic param routes
  router.get('/api/ios/:id', (await import('@/app/api/ios/[id]/route')).GET)
  router.put('/api/ios/:id', (await import('@/app/api/ios/[id]/route')).PUT)
  router.post('/api/ios/:id/test', (await import('@/app/api/ios/[id]/test/route')).POST)
  router.post('/api/ios/:id/reset', (await import('@/app/api/ios/[id]/reset/route')).POST)
  // ... etc ...

  return router
}
```

- [ ] **Step 2: Convert route files in batches**

Convert each `route.ts` file using the mechanical pattern above. Priority order:
1. `/api/health` (simplest — verify pattern works)
2. `/api/auth/*` (2 routes)
3. `/api/configuration/*` (5 routes)
4. `/api/ios/*` (10 routes)
5. `/api/plc/*` (8 routes)
6. `/api/cloud/*` (8 routes)
7. `/api/l2/*` (2 routes)
8. All remaining routes

For each file:
- Remove `import { NextRequest, NextResponse } from 'next/server'`
- Remove `export const dynamic = 'force-dynamic'`
- Change function signature to `(req: Request, res: Response)`
- Replace `NextResponse.json(data, { status })` with `res.status(status).json(data)` or `res.json(data)`
- Replace `request.nextUrl.searchParams.get('x')` with `req.query.x as string`
- Replace `await params` with `req.params`
- Replace `await request.json()` with `req.body`
- For `withAdmin`/`withAuth` wrapped routes: use Express middleware version

- [ ] **Step 3: Type-check after each batch**

Run: `cd frontend && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 4: Commit after each batch**

```bash
git commit -m "refactor: convert {batch-name} API routes to Express"
```

---

## Task 6: Create Express Server

**Files:**
- Create: `frontend/server-express.ts`
- Modify: `frontend/server.js` (keep as reference, replace content)

- [ ] **Step 1: Create server-express.ts**

This merges the existing `server.js` logic (WebSocket, broadcast, logging, backup) with Express static serving:

```typescript
// frontend/server-express.ts
import express from 'express'
import http from 'http'
import path from 'path'
import { WebSocketServer, WebSocket } from 'ws'
import { createApiRouter } from './routes'

const app = express()
const PORT = parseInt(process.env.PORT || '3000')
const WS_BROADCAST_PORT = PORT + 102 // 3102

// Body parsing
app.use(express.json({ limit: '10mb' }))

// API routes
app.use(createApiRouter())

// Static files (Vite build output)
app.use(express.static(path.join(__dirname, 'dist')))

// SPA fallback — serve index.html for all non-API routes
app.get('*', (req, res) => {
  if (!req.path.startsWith('/api/')) {
    res.sendFile(path.join(__dirname, 'dist', 'index.html'))
  }
})

// HTTP server
const server = http.createServer(app)

// WebSocket server (same logic as current server.js)
const wss = new WebSocketServer({ noServer: true })
const clients = new Set<WebSocket>()

server.on('upgrade', (req, socket, head) => {
  if (req.url === '/ws') {
    wss.handleUpgrade(req, socket, head, (ws) => {
      clients.add(ws)
      ws.on('close', () => clients.delete(ws))
      // ... heartbeat logic from server.js ...
    })
  } else {
    socket.destroy()
  }
})

// Broadcast HTTP API (same logic as current server.js)
const broadcastServer = http.createServer((req, res) => {
  // ... same broadcast logic from server.js lines 227-289 ...
})
broadcastServer.listen(WS_BROADCAST_PORT, '127.0.0.1')

// Start
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on http://0.0.0.0:${PORT}`)
})

// Graceful shutdown (same as server.js)
process.on('SIGTERM', () => { /* ... */ })
process.on('SIGINT', () => { /* ... */ })
```

Note: The full implementation will copy WebSocket heartbeat, broadcast API, logging, and startup backup logic verbatim from the existing `server.js`.

- [ ] **Step 2: Commit**

```bash
git add frontend/server-express.ts
git commit -m "feat: add Express server with static serving + WebSocket + broadcast"
```

---

## Task 7: Update Build Config + Package.json

**Files:**
- Modify: `frontend/package.json`
- Modify: `frontend/tsconfig.json`
- Modify: `frontend/tailwind.config.ts`
- Delete: `frontend/next.config.mjs`
- Delete: `frontend/middleware.ts`
- Delete: `frontend/next-env.d.ts`

- [ ] **Step 1: Update package.json**

```json
{
  "scripts": {
    "dev": "concurrently \"vite\" \"tsx server-express.ts\"",
    "build": "vite build && tsc -p tsconfig.server.json",
    "start": "node dist-server/server-express.js",
    "lint": "eslint . --ext .ts,.tsx",
    "preview": "vite preview"
  }
}
```

Remove from dependencies: `next`, `next-auth`
Add to dependencies: `express`, `react-router-dom`
Add to devDependencies: `vite`, `@types/express`

- [ ] **Step 2: Update tsconfig.json**

Remove:
- `"plugins": [{ "name": "next" }]`
- `"next-env.d.ts"` from include
- `".next/types/**/*.ts"` from include

Change: `"jsx": "preserve"` → `"jsx": "react-jsx"`
Add: `"src/vite-env.d.ts"` to include

- [ ] **Step 3: Update tailwind.config.ts content paths**

Add `'./index.html'` and `'./src/**/*.{ts,tsx}'` to content array.

- [ ] **Step 4: Delete Next.js files**

```bash
rm frontend/next.config.mjs frontend/middleware.ts frontend/next-env.d.ts
rm frontend/app/layout.tsx frontend/app/page.tsx frontend/app/loading.tsx
rm -rf frontend/.next
```

- [ ] **Step 5: Verify full build**

Run: `cd frontend && npm run build`
Expected: Vite builds successfully, outputs to `dist/`

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "chore: switch from Next.js to Vite + Express build"
```

---

## Task 8: Update BUILD-PORTABLE.bat + Docker

**Files:**
- Modify: `frontend/deploy/BUILD-PORTABLE.bat`
- Modify: `frontend/docker/Dockerfile` (if exists)

- [ ] **Step 1: Update BUILD-PORTABLE.bat**

Replace `npm run build` (which called `next build`) with `npm run build` (now calls `vite build`).

Remove the standalone output copy logic (`.next/standalone`).
Instead copy `dist/` (Vite output) + `dist-server/` (compiled Express server) + `node_modules/` (only runtime deps).

The portable folder structure becomes:
```
portable/
  node/          (bundled Node.js)
  app/
    dist/        (Vite static files)
    dist-server/ (compiled Express server)
    node_modules/ (runtime only: express, better-sqlite3, ws, etc.)
    server.js    (entry point)
  START.bat
```

- [ ] **Step 2: Verify portable build**

Run: `deploy\BUILD-PORTABLE.bat`
Expected: Builds successfully, portable folder works with `START.bat`

- [ ] **Step 3: Commit**

```bash
git add deploy/BUILD-PORTABLE.bat
git commit -m "chore: update portable build for Vite + Express"
```

---

## Task 9: Integration Test + Cleanup

- [ ] **Step 1: Start full stack and test**

```bash
cd frontend
npm run build
npm start
```

Test manually:
- Login page loads at http://localhost:3000
- PLC connect/disconnect works
- IO grid loads and updates in real-time
- Cloud pull works
- L2 tab loads with descriptions
- WebSocket updates appear (test with two browser tabs)
- Build hash shows in header

- [ ] **Step 2: Verify memory usage**

```bash
node --max-old-space-size=256 --optimize-for-size dist-server/server-express.js
```

After 30 seconds of use, check memory:
```bash
# In another terminal
node -e "const http = require('http'); http.get('http://localhost:3000/api/health', r => { let d = ''; r.on('data', c => d += c); r.on('end', () => console.log(d)) })"
```

Expected: RSS < 150MB (down from 250-350MB)

- [ ] **Step 3: Remove dead files**

```bash
rm -rf frontend/.next
rm frontend/app/layout.tsx frontend/app/page.tsx frontend/app/loading.tsx
rm frontend/app/project/[id]/loading.tsx
rm frontend/server.dev.js
rm frontend/scripts/plc-websocket-server.js
```

- [ ] **Step 4: Update CLAUDE.md**

Update the project overview, commands, and architecture sections to reflect Vite + Express.

- [ ] **Step 5: Final commit**

```bash
git add -A
git commit -m "feat: complete Next.js to Vite + Express migration"
```

---

## Risk Mitigations

| Risk | Detection | Recovery |
|------|-----------|----------|
| API route conversion error | Type-check after each batch | Fix the specific route, patterns are mechanical |
| WebSocket not connecting | Test with two browser tabs | Compare server.js ws logic line-by-line |
| Path alias (@/) not resolving | Vite build fails | Check vite.config.ts resolve.alias |
| Native modules fail to load | Server crashes on start | Add to Vite external, check require paths |
| Static files not served | Blank page on load | Check express.static path + SPA fallback |
| Auth tokens stop working | API returns 401 | JWT logic is unchanged, check header extraction |

## Execution Notes

- **The 72 API route conversions (Task 5) are the bulk of the work.** Each file is a mechanical transformation. They can be done by a subagent with the conversion pattern and type-checked after each batch.
- **Tasks 1-4 and 6-7 can be done first** to set up the new architecture, then Task 5 fills in the routes.
- **The existing `server.js` is the reference** for WebSocket, broadcast, logging, and startup logic. Copy it section by section into `server-express.ts`.
- **`next-themes` does NOT need to change.** Despite the name, it's a standalone React library that works without Next.js.
