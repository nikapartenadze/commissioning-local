# IO Checkout Tool — Memory Optimization Plan

**Date:** 2026-04-09
**Current RAM Usage:** 250-350 MB
**Target:** Under 150 MB
**Risk Level:** Low (no breaking changes needed for Phase 1-2)

---

## Where the 300MB Goes

| Component | Current | Optimized | Savings |
|-----------|---------|-----------|---------|
| Next.js framework core | 70-90 MB | 70-90 MB | — (framework cost) |
| Build tools in runtime (webpack, esbuild, terser) | 40-60 MB | 0 MB | **40-60 MB** |
| Native libplctag library | 30-50 MB | 30-50 MB | — (required) |
| PLC tags (3700 × 1.75KB) | 10-12 MB | 10-12 MB | — (required) |
| SQLite + WAL + cache | 20-35 MB | 12-20 MB | **8-15 MB** |
| Prepared statements (recreated per-request) | 5-10 MB GC pressure | <1 MB | **4-9 MB** |
| React/React-DOM (server) | 15-20 MB | 15-20 MB | — |
| Node.js module cache | 20-30 MB | 10-15 MB | **10-15 MB** |
| WebSocket + networking | 5-10 MB | 5-10 MB | — |
| Cloud sync services | 5-15 MB | 5-10 MB | **0-5 MB** |
| **TOTAL** | **250-350 MB** | **160-230 MB** | **60-100 MB** |

---

## Phase 1: Quick Wins (No Code Changes) — Save 40-60 MB

### 1.1 Strip Build Tools from Portable Build

**Problem:** webpack (7MB), @esbuild (11MB), terser (1.1MB), caniuse-lite (2.7MB) and 15+ other build-only packages are copied into the portable distribution. They're never used at runtime but Node.js loads module metadata for all packages in `node_modules`.

**Fix:** Add cleanup step to `deploy/BUILD-PORTABLE.bat` after copying standalone:
```batch
REM Remove build-only packages from portable
rmdir /s /q "%OUTPUT_DIR%\app\node_modules\webpack" 2>nul
rmdir /s /q "%OUTPUT_DIR%\app\node_modules\@esbuild" 2>nul
rmdir /s /q "%OUTPUT_DIR%\app\node_modules\terser" 2>nul
rmdir /s /q "%OUTPUT_DIR%\app\node_modules\terser-webpack-plugin" 2>nul
rmdir /s /q "%OUTPUT_DIR%\app\node_modules\caniuse-lite" 2>nul
rmdir /s /q "%OUTPUT_DIR%\app\node_modules\watchpack" 2>nul
rmdir /s /q "%OUTPUT_DIR%\app\node_modules\jest-worker" 2>nul
rmdir /s /q "%OUTPUT_DIR%\app\node_modules\@webassemblyjs" 2>nul
rmdir /s /q "%OUTPUT_DIR%\app\node_modules\acorn" 2>nul
rmdir /s /q "%OUTPUT_DIR%\app\node_modules\webpack-sources" 2>nul
rmdir /s /q "%OUTPUT_DIR%\app\node_modules\neo-async" 2>nul
rmdir /s /q "%OUTPUT_DIR%\app\node_modules\tapable" 2>nul
```

**Effort:** 30 minutes
**Risk:** None — these are never imported at runtime
**Savings:** 21 MB disk, ~40-60 MB RAM (less module metadata loaded)

### 1.2 Set SQLite Cache Size

**Problem:** Default SQLite page cache is 2000 pages × 4KB = 8 MB. For a local app with single-user access patterns, 500 pages is sufficient.

**Fix:** Add to `frontend/lib/db-sqlite.ts`:
```typescript
db.pragma('cache_size = 500')  // 500 pages × 4KB = 2MB (was 8MB)
```

**Effort:** 5 minutes
**Risk:** None — slightly slower queries on cache misses, negligible for this workload
**Savings:** ~6 MB

---

## Phase 2: Prepared Statement Caching — Save 4-9 MB + GC Pressure

### 2.1 Cache Prepared Statements at Module Level

**Problem:** Every API route calls `db.prepare('SELECT ...')` inside request handlers. Each call creates a new prepared statement object (~2-5 KB). At 10 requests/sec, that's 2-5 GB/day in garbage collection pressure.

**Current (bad):**
```typescript
// Inside request handler — recreated on EVERY call
export async function GET() {
  const ios = db.prepare('SELECT * FROM Ios').all()
}
```

**Fixed (good):**
```typescript
// Module level — created once, reused forever
const selectAllIos = db.prepare('SELECT * FROM Ios')

export async function GET() {
  const ios = selectAllIos.all()
}
```

**Affected files:** 30+ API routes in `frontend/app/api/`

**Effort:** 2-4 hours
**Risk:** Low — better-sqlite3 statements are safe to reuse
**Savings:** ~4-9 MB RAM + 80% reduction in GC pressure

---

## Phase 3: Framework Migration (Future) — Save 50-80 MB

### 3.1 Replace Next.js with Express/Fastify + Static React Build

**Problem:** Next.js uses 70-90 MB for features we don't need:
- Server-Side Rendering (SSR) — not needed, app runs on local network
- Module preloading — loads ALL page JS into memory at startup
- Webpack/Turbopack infrastructure — loaded even in production
- App Router overhead — routing for a single-page app

**Alternative:** Build React as static files (Vite), serve via Express or Fastify:

| | Next.js | Express + Static | Fastify + Static |
|---|---------|------------------|-----------------|
| **Baseline RAM** | 70-90 MB | 30-40 MB | 20-30 MB |
| **With SQLite + WS** | 100-120 MB | 50-60 MB | 40-50 MB |
| **SSR** | Yes (unused) | No | No |
| **Build tooling in runtime** | Yes | No | No |
| **Cold start** | 2-5s | <1s | <1s |

**Migration path:**
1. Build React frontend with Vite → outputs static HTML/JS/CSS to `dist/`
2. Create Express/Fastify server that:
   - Serves `dist/` as static files
   - Hosts all API routes (same code, different router)
   - Handles WebSocket upgrades
   - Runs SSE client + auto-sync
3. Remove Next.js dependency entirely

**Effort:** 2-3 weeks
**Risk:** Medium — significant refactor, but API logic stays the same
**Savings:** 50-80 MB RAM, 2-4x faster cold start

### 3.2 Why NOT Bun

**Bun would save 25-35% RAM** but has a **critical blocker**: `ffi-rs` (used for libplctag PLC communication) is not compatible with Bun's runtime. `bun:ffi` exists but is not production-ready.

**Recommendation:** Do not migrate to Bun runtime until `bun:ffi` matures or `ffi-rs` officially supports Bun. Can use Bun as package manager (`bun install`) for faster installs — no runtime change needed.

---

## Phase 4: Advanced Optimizations (Optional)

### 4.1 Node.js Memory Flags

Add to server startup:
```bash
node --max-old-space-size=256 --optimize-for-size server.js
```
- `--max-old-space-size=256` — caps V8 heap at 256MB, forces earlier GC
- `--optimize-for-size` — V8 trades speed for memory efficiency

**Effort:** 5 minutes
**Risk:** Very low — may slightly slow GC-heavy operations
**Savings:** 10-30 MB (forces V8 to be more aggressive with cleanup)

### 4.2 Offline Queue Size Limits

**Problem:** `CloudSyncService.offlineQueue` grows unbounded during network outages.

**Fix:** Cap at 5000 items, drop oldest when full:
```typescript
private readonly MAX_OFFLINE_QUEUE = 5000

addToOfflineQueue(item) {
  if (this.offlineQueue.size >= this.MAX_OFFLINE_QUEUE) {
    const oldest = this.offlineQueue.keys().next().value
    this.offlineQueue.delete(oldest)
  }
  this.offlineQueue.set(item.id, item)
}
```

**Effort:** 15 minutes
**Risk:** None — items already persisted in SQLite PendingSyncs table
**Savings:** Prevents unbounded growth (up to 4MB in edge cases)

### 4.3 Stream Large Cloud Pulls

**Problem:** `pullFromCloud()` downloads all 3700 IOs as a single JSON response (~2-5 MB), holds entire array in memory during upsert.

**Fix:** Process in batches of 500 instead of all at once:
```typescript
for (let i = 0; i < cloudIos.length; i += 500) {
  const batch = cloudIos.slice(i, i + 500)
  db.transaction(() => {
    for (const io of batch) { upsertStmt.run(...) }
  })()
}
cloudIos.length = 0 // Release memory
```

**Effort:** 30 minutes
**Risk:** None
**Savings:** 2-5 MB peak reduction

---

## Implementation Priority

| Phase | Effort | Savings | Risk | When |
|-------|--------|---------|------|------|
| **1.1** Strip build tools | 30 min | 40-60 MB | None | Now |
| **1.2** SQLite cache size | 5 min | 6 MB | None | Now |
| **2.1** Prepared statements | 2-4 hours | 4-9 MB + GC | Low | This week |
| **4.1** Node.js flags | 5 min | 10-30 MB | Very low | Now |
| **4.2** Queue limits | 15 min | Prevents leak | None | Now |
| **4.3** Batch pulls | 30 min | 2-5 MB | None | This week |
| **3.1** Replace Next.js | 2-3 weeks | 50-80 MB | Medium | Next quarter |

**Phase 1 + 4.1 alone (35 minutes of work) saves 55-95 MB — brings usage to ~180-250 MB.**

---

## PLC Tag Memory (Not Optimizable)

3700 IO tags use ~10-12 MB total:
- JavaScript heap: 3.3 MB (tag state maps)
- Native libplctag: 3.5-7 MB (C library handles)
- Dual-reader overhead: ~3 MB

This is **the minimum cost** for real-time PLC communication with 3700 tags. The 75ms read loop is allocation-efficient — no persistent per-cycle growth.

---

## Monitoring

Add to `server.js` for production memory tracking:
```javascript
setInterval(() => {
  const mem = process.memoryUsage()
  console.log(`[Memory] RSS: ${Math.round(mem.rss / 1048576)}MB, Heap: ${Math.round(mem.heapUsed / 1048576)}/${Math.round(mem.heapTotal / 1048576)}MB`)
}, 60000)
```

This logs memory every 60 seconds so you can track trends and catch leaks.
