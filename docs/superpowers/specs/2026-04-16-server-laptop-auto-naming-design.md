# Server Laptop Auto-Naming

**Date:** 2026-04-16
**Scope:** Local commissioning tool (`frontend/`)

## Problem

The local commissioning tool prompts every user for a name the first time they open the app. This name is attached to test results and comments. The machine running the Express server is not supposed to be used for testing — testing should happen from tablets and other laptops connected to the server.

Today there is no way to tell whether a given browser session is running on the server machine or a remote device. If someone tests from the server machine, their results look identical to results from a legitimate tablet. When issues are investigated after the fact, we cannot confirm or rule out that the server machine was used.

## Goal

Automatically name any browser session on the server machine `"Server Laptop"` and skip the name prompt. All other devices keep the current name-prompt flow. Any appearance of `"Server Laptop"` in test results is then a clear signal that someone used the server machine directly, which can be followed up on.

## Approach

Detect device identity on the server side by inspecting the HTTP request's remote IP. When a client loads the React app, it calls a small identity endpoint before deciding whether to show the name prompt. A loopback IP (`127.0.0.1`, `::1`, `::ffff:127.0.0.1`) means the request came from the same machine that runs the server; anything else is a remote device.

This is deterministic — a remote device physically cannot present a loopback IP to the server, so there is no spoofing concern for this use case.

## Components

### 1. New API route — device identity

**Path:** `frontend/app/api/device/identity/route.ts`
**Method:** `GET`
**Auth:** None (called before the user is established)

Handler inspects the Express request's remote address. Returns:

```json
{ "isServerDevice": true }
```

or

```json
{ "isServerDevice": false }
```

Loopback IPs that count as the server device:

- `127.0.0.1`
- `::1`
- `::ffff:127.0.0.1` (IPv4-mapped IPv6 form)

Any other IP returns `isServerDevice: false`.

The remote address comes from Express's `req.ip` (with `trust proxy` left at its default — this tool runs behind no reverse proxy in practice) or `req.socket.remoteAddress` as a fallback.

### 2. Router registration

**Path:** `frontend/routes/index.ts`

Add the handler import and mount under the existing IO/config/etc. routes. No middleware — intentionally public.

### 3. Client — `UserProvider` auto-naming

**Path:** `frontend/lib/user-context.tsx`

Before the existing localStorage check, call `GET /api/device/identity`. Flow:

1. On mount, `fetch('/api/device/identity')`
2. If response is `{ isServerDevice: true }`:
   - Call `setCurrentUser({ fullName: 'Server Laptop', isAdmin: true, loginTime: new Date() })`
   - This writes `"Server Laptop"` into `localStorage.tester-name` via the existing setter, so the name persists
   - Skip the name-prompt gating entirely
3. If response is `{ isServerDevice: false }` (or the call fails): fall through to the existing localStorage check and name-prompt flow

If a user on the server machine had previously entered a different name, the auto-naming overwrites it. This is intentional — the server machine should always be identified as `"Server Laptop"`, not whatever a human typed.

### 4. Name-prompt component

**Path:** `frontend/components/name-prompt.tsx`

No changes. The component is still shown for non-server devices exactly as today.

## Data Flow

```
Browser loads app
  |
  v
UserProvider mounts
  |
  v
GET /api/device/identity ------> Express (remote IP inspection)
  |                                |
  |<-- { isServerDevice: bool } ---+
  |
  +-- true  --> setCurrentUser("Server Laptop"), skip prompt
  |
  +-- false --> check localStorage.tester-name
                 |
                 +-- exists   --> set user from storage
                 |
                 +-- missing  --> show NamePrompt modal
```

## Error Handling

- If `GET /api/device/identity` fails (network error, 500, etc.): treat as `isServerDevice: false` and fall through to the normal flow. The feature degrades gracefully — at worst the server machine gets the name prompt, which is the current behavior.
- If the IP cannot be read (very unusual): treat as non-server.

## Testing

- Unit test the IP classification helper (`isLoopbackIp(ip: string): boolean`) for `127.0.0.1`, `::1`, `::ffff:127.0.0.1`, `192.168.x.x`, empty string, `undefined`.
- Manual verification:
  1. Run the server, open `http://localhost:3000` on the same machine → name auto-set to `"Server Laptop"`, no prompt
  2. Open `http://<SERVER_LAN_IP>:3000` from a tablet/other laptop → name prompt appears as today
  3. Clear localStorage on the server machine and reload → still auto-set to `"Server Laptop"`

## Out of Scope

- Fire-output tracking / audit logs (explicitly dropped from scope)
- Per-device filtering of IOs
- Device fingerprinting beyond loopback detection
- Blocking the server machine from testing (only detecting it)

## Files Touched

1. `frontend/app/api/device/identity/route.ts` — new
2. `frontend/routes/index.ts` — register route
3. `frontend/lib/user-context.tsx` — call identity endpoint on mount, auto-set `"Server Laptop"` when applicable
4. Optional: small test file for the IP classification helper
