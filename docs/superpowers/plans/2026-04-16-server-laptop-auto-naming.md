# Server Laptop Auto-Naming Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Automatically assign the tester name `"Server Laptop"` to browser sessions running on the server machine (loopback IP), skipping the name prompt; other devices are unchanged.

**Architecture:** A tiny read-only Express endpoint (`GET /api/device/identity`) classifies the request's remote IP as loopback or not. The React `UserProvider` calls this endpoint before its localStorage check; on a loopback response, it auto-sets the user to `"Server Laptop"` and bypasses `NamePrompt`.

**Tech Stack:** Express 5 + TypeScript, React 18 + Vite, Vitest for unit tests.

**Spec:** `docs/superpowers/specs/2026-04-16-server-laptop-auto-naming-design.md`

---

## File Structure

**New files:**
- `frontend/lib/device-identity.ts` — pure helper: `isLoopbackIp(ip: string | undefined): boolean`
- `frontend/app/api/device/identity/route.ts` — Express-style route handler: `GET` returns `{ isServerDevice }`
- `frontend/__tests__/device-identity.test.ts` — unit tests for the helper

**Modified files:**
- `frontend/routes/index.ts` — register the new route
- `frontend/lib/user-context.tsx` — call identity endpoint on mount, auto-set `"Server Laptop"` on loopback

**Files NOT touched:**
- `frontend/components/name-prompt.tsx` — unchanged; still shown for non-server devices

---

### Task 1: IP classification helper with tests

**Files:**
- Create: `frontend/lib/device-identity.ts`
- Create: `frontend/__tests__/device-identity.test.ts`

- [ ] **Step 1: Write the failing test**

Create `frontend/__tests__/device-identity.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { isLoopbackIp } from '@/lib/device-identity'

describe('isLoopbackIp', () => {
  it('returns true for IPv4 loopback', () => {
    expect(isLoopbackIp('127.0.0.1')).toBe(true)
  })

  it('returns true for IPv6 loopback', () => {
    expect(isLoopbackIp('::1')).toBe(true)
  })

  it('returns true for IPv4-mapped IPv6 loopback', () => {
    expect(isLoopbackIp('::ffff:127.0.0.1')).toBe(true)
  })

  it('returns false for LAN IPv4', () => {
    expect(isLoopbackIp('192.168.1.45')).toBe(false)
  })

  it('returns false for public IPv4', () => {
    expect(isLoopbackIp('8.8.8.8')).toBe(false)
  })

  it('returns false for arbitrary IPv6', () => {
    expect(isLoopbackIp('fe80::1')).toBe(false)
  })

  it('returns false for empty string', () => {
    expect(isLoopbackIp('')).toBe(false)
  })

  it('returns false for undefined', () => {
    expect(isLoopbackIp(undefined)).toBe(false)
  })

  it('returns false for null-like string "null"', () => {
    expect(isLoopbackIp('null')).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run __tests__/device-identity.test.ts`
Expected: FAIL — module not found (`Cannot find module '@/lib/device-identity'`).

- [ ] **Step 3: Implement the helper**

Create `frontend/lib/device-identity.ts`:

```typescript
/**
 * Classify a remote IP as a loopback address (same machine as the server).
 * Covers:
 *   - IPv4 loopback (127.0.0.1)
 *   - IPv6 loopback (::1)
 *   - IPv4-mapped IPv6 loopback (::ffff:127.0.0.1)
 *
 * Pure function. Never throws. Treats undefined/empty/unknown as non-loopback.
 */
export function isLoopbackIp(ip: string | undefined | null): boolean {
  if (!ip) return false
  const normalized = ip.trim()
  if (normalized === '') return false
  if (normalized === '127.0.0.1') return true
  if (normalized === '::1') return true
  if (normalized === '::ffff:127.0.0.1') return true
  return false
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run __tests__/device-identity.test.ts`
Expected: PASS — 9 tests passing.

- [ ] **Step 5: Commit**

```bash
cd frontend
git add lib/device-identity.ts __tests__/device-identity.test.ts
git commit -m "feat(device-identity): add isLoopbackIp classifier

Pure helper that identifies loopback IPs (127.0.0.1, ::1, ::ffff:127.0.0.1)
for detecting same-machine requests. Foundation for server-laptop auto-naming."
```

---

### Task 2: Device identity API route

**Files:**
- Create: `frontend/app/api/device/identity/route.ts`

- [ ] **Step 1: Implement the route handler**

Create `frontend/app/api/device/identity/route.ts`:

```typescript
import { Request, Response } from 'express'
import { isLoopbackIp } from '@/lib/device-identity'

/**
 * GET /api/device/identity
 *
 * Classifies the requesting device as the server machine (loopback) or a remote device.
 * Used by the React UserProvider to decide whether to auto-name the session
 * "Server Laptop" or prompt the user.
 *
 * No auth — called before the user is established.
 */
export async function GET(req: Request, res: Response) {
  // Express sets req.ip from socket.remoteAddress (trust proxy is off by default).
  // Fall back to socket.remoteAddress in case req.ip is not populated.
  const ip = (req.ip && req.ip.length > 0 ? req.ip : req.socket?.remoteAddress) || ''
  const isServerDevice = isLoopbackIp(ip)
  return res.json({ isServerDevice })
}
```

- [ ] **Step 2: Commit**

```bash
cd frontend
git add app/api/device/identity/route.ts
git commit -m "feat(api): add /api/device/identity endpoint

Returns { isServerDevice: boolean } based on loopback IP classification.
Unauthenticated — called before user session is established."
```

---

### Task 3: Register the route

**Files:**
- Modify: `frontend/routes/index.ts`

- [ ] **Step 1: Add import**

Open `frontend/routes/index.ts`. In the import block (after the last `import * as ...` line that imports a route handler, e.g. `import * as vfdState`), add:

```typescript
import * as deviceIdentity from '@/app/api/device/identity/route'
```

- [ ] **Step 2: Register the route**

In `createApiRouter()`, add a new section (after the VFD Commissioning block, before `return router`):

```typescript
  // ── Device Identity ───────────────────────────────────────────
  router.get('/api/device/identity', asyncHandler(deviceIdentity.GET))
```

- [ ] **Step 3: Verify the route responds**

Start the server:

```bash
cd frontend && npm run dev
```

In a second terminal, call the endpoint:

```bash
curl -s http://localhost:3000/api/device/identity
```

Expected: `{"isServerDevice":true}` (curl is on the same machine → loopback).

From another device on the LAN (tablet browser, etc.), navigate to `http://<server-ip>:3000/api/device/identity`. Expected body: `{"isServerDevice":false}`.

- [ ] **Step 4: Commit**

```bash
cd frontend
git add routes/index.ts
git commit -m "feat(routes): register /api/device/identity route"
```

---

### Task 4: Auto-name `Server Laptop` in `UserProvider`

**Files:**
- Modify: `frontend/lib/user-context.tsx`

- [ ] **Step 1: Replace the localStorage-only effect with an identity-first effect**

Open `frontend/lib/user-context.tsx`. Find the effect that currently loads `tester-name` from localStorage (lines 35-47 in the existing file):

```typescript
  // Load tester name from localStorage on mount
  useEffect(() => {
    if (!isMounted) return

    const name = localStorage.getItem('tester-name')
    if (name) {
      setCurrentUserState({
        fullName: name,
        isAdmin: true,
        loginTime: new Date()
      })
    }
    setIsLoading(false)
  }, [isMounted])
```

Replace that block with:

```typescript
  // Resolve the session identity on mount.
  // Server machine (loopback IP) is auto-named "Server Laptop" and bypasses
  // the NamePrompt entirely. All other devices fall through to the normal
  // localStorage + NamePrompt flow.
  useEffect(() => {
    if (!isMounted) return

    let cancelled = false

    const resolveIdentity = async () => {
      let isServerDevice = false
      try {
        const res = await fetch('/api/device/identity', { cache: 'no-store' })
        if (res.ok) {
          const data = (await res.json()) as { isServerDevice?: boolean }
          isServerDevice = data.isServerDevice === true
        }
      } catch {
        // Network error — degrade gracefully to the existing flow.
      }

      if (cancelled) return

      if (isServerDevice) {
        // Force the canonical name regardless of what the user typed previously.
        const SERVER_NAME = 'Server Laptop'
        localStorage.setItem('tester-name', SERVER_NAME)
        localStorage.removeItem('tester-name-previous')
        setCurrentUserState({
          fullName: SERVER_NAME,
          isAdmin: true,
          loginTime: new Date()
        })
      } else {
        const stored = localStorage.getItem('tester-name')
        if (stored) {
          setCurrentUserState({
            fullName: stored,
            isAdmin: true,
            loginTime: new Date()
          })
        }
      }
      setIsLoading(false)
    }

    resolveIdentity()

    return () => {
      cancelled = true
    }
  }, [isMounted])
```

- [ ] **Step 2: Verify behavior manually — server machine**

Start the server: `cd frontend && npm run dev`.

Open `http://localhost:3000/` in a browser on the server machine.
Expected:
- No name prompt appears.
- Open devtools → Application → Local Storage. `tester-name` should equal `"Server Laptop"`.
- Any UI element that shows the current tester name should show `"Server Laptop"`.

Clear localStorage (`localStorage.clear()` in the console) and reload.
Expected: no prompt appears; `tester-name` is re-set to `"Server Laptop"` automatically.

Now set a different name manually: `localStorage.setItem('tester-name', 'Alice')` and reload.
Expected: name is overwritten back to `"Server Laptop"` (this is intentional per spec — server machine is always canonical).

- [ ] **Step 3: Verify behavior manually — remote device**

From another device on the LAN (tablet, other laptop), open `http://<server-lan-ip>:3000/`.
Expected:
- `NamePrompt` modal appears as today.
- After entering a name, localStorage `tester-name` is set to that typed name.
- Reloading does not overwrite it with `"Server Laptop"`.

- [ ] **Step 4: Verify network failure fallback**

Back on the server machine, stop the dev server. Cache a stale version of the page (or simulate the identity fetch failing by blocking `/api/device/identity` in devtools Network conditions → Block URL pattern). Reload.
Expected: the app degrades to the existing flow — reads localStorage, shows `NamePrompt` if empty. No crash. No console error that breaks rendering.

- [ ] **Step 5: Commit**

```bash
cd frontend
git add lib/user-context.tsx
git commit -m "feat(user-context): auto-name 'Server Laptop' on loopback devices

On mount, UserProvider calls /api/device/identity before checking localStorage.
Server-machine sessions (loopback IP) are auto-named 'Server Laptop' and skip
the NamePrompt. All other devices fall through to the existing flow.
Network failures degrade to the existing localStorage + prompt path."
```

---

### Task 5: End-to-end verification

- [ ] **Step 1: Run the full test suite**

```bash
cd frontend && npm run test
```

Expected: all tests pass, including the new `device-identity.test.ts` file.

- [ ] **Step 2: Run lint**

```bash
cd frontend && npm run lint
```

Expected: no new lint errors introduced by the new files.

- [ ] **Step 3: Build server and client**

```bash
cd frontend && npm run build && npm run build:server
```

Expected: both builds succeed.

- [ ] **Step 4: Smoke-test production build**

```bash
cd frontend && NODE_ENV=production npm run start
```

On the server machine, open `http://localhost:3000/` → no prompt, name is `Server Laptop`.
From another device, open `http://<server-ip>:3000/` → prompt appears.

- [ ] **Step 5: Confirmation checklist**

Confirm each item before considering the feature complete:

- [ ] `GET /api/device/identity` returns `{"isServerDevice":true}` from localhost
- [ ] `GET /api/device/identity` returns `{"isServerDevice":false}` from a different device
- [ ] Server-machine browser never shows `NamePrompt`
- [ ] Server-machine `localStorage.tester-name` is exactly `"Server Laptop"`
- [ ] Remote-device `NamePrompt` still works as today
- [ ] A remote user's typed name is NOT overwritten on reload
- [ ] Identity endpoint failure falls through to the existing flow without errors
- [ ] Unit tests pass (9 assertions)
- [ ] Build and lint pass

---

## Self-Review Notes

- **Spec coverage:** Every section of the spec (identity endpoint, route registration, UserProvider change, error handling, manual tests) is covered by a task.
- **Placeholders:** None. All code blocks are final.
- **Type consistency:** `isLoopbackIp` signature matches in test, helper, and route handler. The `tester-name` localStorage key matches the existing setter in `user-context.tsx`.
- **Testing:** Unit tests for the helper (the only pure logic). Route handler and UserProvider verified manually because they depend on Express and the browser runtime respectively — not worth the setup cost for this scope.
