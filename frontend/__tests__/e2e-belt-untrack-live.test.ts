import { describe, it, expect, beforeAll, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
// eslint-disable-next-line @typescript-eslint/no-require-imports
const bcrypt = require('bcryptjs')

/**
 * CROSS-PROCESS END-TO-END test of the belt-untrack safety loop.
 *
 * WHAT IS REAL (nothing here is a stub except the PLC controller itself):
 *   - a REAL cloud process (battle/cloud:local) + REAL Postgres, stood up via
 *     ../local-cloud.compose.yml, seeded with a project / subsystem "MCM15" /
 *     a VFD device tagged mcm="MCM15" / a Mechanical access key;
 *   - a REAL Mechanical NextAuth session, obtained by driving the cloud's real
 *     access-key credentials login over HTTP (csrf → callback → session cookie);
 *   - the REAL mechanic toggle route (/api/mechanic/belt-tracking/toggle) over
 *     REAL HTTP — the same endpoint the belt-tracking page calls;
 *   - the REAL field pull-l2 handler making a REAL HTTP GET to the cloud's real
 *     /api/sync/l2/[id], applying the cloud→field merge into a REAL in-memory
 *     tool SQLite (the whole cloud-owned-clear path, cb92781);
 *   - the REAL validation writer (syncValidationFlags + runRetractionPass +
 *     runLocalControlRestorePass) reading that same tool SQLite and deciding
 *     every PLC write;
 *   - the REAL server-side write-tag gate handler (/api/vfd-commissioning/
 *     write-tag) reading the tool SQLite.
 *
 * THE ONLY FAKE is the PLC controller: `@/lib/mcm-registry`'s typed-batch FFI
 * boundary (readTypedTagsForMcm / writeTypedTagsForMcm) — the exact seam the
 * writer's own unit tests inject at. It serves STS reads we control and RECORDS
 * every (field, value) written, so PLC writes are asserted without hardware.
 *
 * SKIPS automatically when the local cloud isn't reachable (like
 * e2e-pull-l2-live.test.ts), so it never breaks CI / offline runs. To make it
 * RUN, bring the stack up first (see the runner script header). Up/down:
 *   docker compose -f ../local-cloud.compose.yml up -d      # from frontend/ ..
 *   ...then this test seeds + drives it...
 *   docker compose -f ../local-cloud.compose.yml down -v
 */

const CLOUD = 'http://localhost:13001'
const API_KEY = 'e2e-belt-key'          // Project.apiKey (seed)
// Throwaway fixture credential for the disposable local-cloud DB — not a real
// secret (the key only exists in the seed we insert into the throwaway Postgres).
const ACCESS_KEY = 'proj_9001_belttest' // gitleaks:allow  Mechanical key plaintext (seed)
const SID = 9002                         // subsystem id (name "MCM15")
const DEVICE_ID = 9020                   // cloud L2Device id
const DEVICE_NAME = 'UL15_3_VFD1'
const DB_CONTAINER = 'commissioning-local-cloud-cloud-db-1'

// ── The fake PLC + the in-memory tool DB (hoisted before module imports) ──────
const { memDb, plc } = vi.hoisted(() => {
  // The writer reads process.env.PLC_MODE at module load — force the remote
  // (plc-gateway) path so the ENTIRE writer converges through the mcm-registry
  // typed-batch boundary we fake, with zero libplctag FFI.
  process.env.PLC_MODE = 'remote'
  // Deterministic freshness window (15 min default is fine; pinned for clarity).
  process.env.VFD_BELT_TRACKING_FRESHNESS_MS = String(15 * 60_000)

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const Database = require('better-sqlite3')
  const d = new Database(':memory:')
  d.exec(`
    CREATE TABLE L2Sheets (id INTEGER PRIMARY KEY AUTOINCREMENT, CloudId INTEGER, Name TEXT NOT NULL, DisplayName TEXT, DisplayOrder INTEGER NOT NULL, Discipline TEXT, DeviceCount INTEGER DEFAULT 0);
    CREATE TABLE L2Columns (id INTEGER PRIMARY KEY AUTOINCREMENT, CloudId INTEGER, SheetId INTEGER NOT NULL, Name TEXT NOT NULL, ColumnType TEXT NOT NULL, InputType TEXT, DisplayOrder INTEGER NOT NULL, IsSystem INTEGER DEFAULT 0, IsEditable INTEGER DEFAULT 1, IncludeInProgress INTEGER DEFAULT 0, IsRequired INTEGER DEFAULT 0, Description TEXT, ApplicableMcms TEXT);
    CREATE TABLE L2Devices (id INTEGER PRIMARY KEY AUTOINCREMENT, CloudId INTEGER, SubsystemId INTEGER, SheetId INTEGER NOT NULL, DeviceName TEXT NOT NULL, Mcm TEXT, Subsystem TEXT, DisplayOrder INTEGER NOT NULL, CompletedChecks INTEGER DEFAULT 0, TotalChecks INTEGER DEFAULT 0, PlannedDate TEXT);
    CREATE TABLE L2CellValues (id INTEGER PRIMARY KEY AUTOINCREMENT, CloudCellId INTEGER, DeviceId INTEGER NOT NULL, ColumnId INTEGER NOT NULL, Value TEXT, UpdatedBy TEXT, UpdatedAt TEXT DEFAULT (datetime('now')), Version INTEGER DEFAULT 0, UNIQUE(DeviceId, ColumnId));
    CREATE TABLE L2PendingSyncs (id INTEGER PRIMARY KEY AUTOINCREMENT, CloudDeviceId INTEGER NOT NULL, CloudColumnId INTEGER NOT NULL, Value TEXT, UpdatedBy TEXT, Version INTEGER DEFAULT 0, CreatedAt TEXT DEFAULT (datetime('now')), RetryCount INTEGER DEFAULT 0, LastError TEXT, DeadLettered INTEGER NOT NULL DEFAULT 0, Orphaned INTEGER NOT NULL DEFAULT 0, Resolved INTEGER NOT NULL DEFAULT 0, ResolvedAt TEXT, ResolvedReason TEXT);
    -- deviceName -> owning subsystem, for the writer's multi-MCM routing.
    CREATE TABLE Ios (id INTEGER PRIMARY KEY AUTOINCREMENT, NetworkDeviceName TEXT, SubsystemId INTEGER);
    -- Present so the gate lookup's LEFT JOIN Subsystems compiles.
    CREATE TABLE Subsystems (id INTEGER PRIMARY KEY AUTOINCREMENT, Name TEXT);
    -- Belt-tracking freshness durable cursor.
    CREATE TABLE SyncCursors (SubsystemId INTEGER PRIMARY KEY, UpdatedAt TEXT);
    -- Retraction edge baseline (KV). UpdatedAt is written by kvWriteSet.
    CREATE TABLE SyncMaintenanceFlags (Key TEXT PRIMARY KEY, Value TEXT, UpdatedAt TEXT);
  `)
  // deviceName -> subsystem 9002 so the writer routes it to the remote MCM target.
  d.prepare('INSERT INTO Ios (NetworkDeviceName, SubsystemId) VALUES (?, ?)').run('UL15_3_VFD1', 9002)
  d.prepare('INSERT INTO Subsystems (id, Name) VALUES (?, ?)').run(9002, 'MCM15')

  // The fake controller. `sts` is what STS reads return; `writes` records every
  // CMD write (field + value). CMD reads always return 0 so the assert pass
  // always issues an earned flag (we then assert on what it chose to write).
  const plc = {
    sts: {
      Check_Allowed: 1, Valid_Map: 1, Valid_HP: 1, Belt_Tracking_ON: 0, RVS: 0,
    } as Record<string, number>,
    writes: [] as Array<{ field: string; value: number; name: string }>,
    clear() { this.writes = [] },
    fields() { return this.writes.map(w => w.field) },
  }
  return { memDb: d, plc }
})

// ── Mocks: tool SQLite, config, best-effort helpers, the fake PLC ─────────────
vi.mock('@/lib/db-sqlite', () => ({ db: memDb, extractDeviceName: () => null }))
vi.mock('@/lib/config', () => ({
  configService: { getConfig: vi.fn(async () => ({ remoteUrl: CLOUD, apiPassword: API_KEY, subsystemId: String(SID) })) },
}))
vi.mock('@/lib/logging/recovery-log', () => ({ auditLog: vi.fn() }))
// The belt-tracking freshness gate's LIVE leg: this instance is on the cloud SSE
// hint channel (the real tool holds this connection to the cloud that is up in
// this test). Deterministic "fresh" without depending on wall-clock ordering
// between module load and the durable delta cursor.
vi.mock('@/lib/cloud/cloud-sse-client', () => ({
  getCloudSseClient: () => ({ isConnected: true, lastEventAt: new Date() }),
}))
vi.mock('@/lib/db/backup', () => ({ createBackup: vi.fn(async () => ({ filename: 'e2e-test-backup.db' })) }))

// The FAKE PLC controller. Both the assert pass (runRemoteTargetPass) and the
// retraction / local-control passes converge here in PLC_MODE=remote.
function readMember(name: string): { success: boolean; value?: number | boolean; error?: string } {
  // CBT_<dev>.CTRL.CMD.<field>  → always 0 (unset) so earned flags get written.
  // CBT_<dev>.CTRL.STS.<member> → the value we control, or "bad parameter" when
  //                               absent (mirrors an AOI member not in the program).
  const parts = name.split('.')
  const scope = parts[parts.length - 2] // CMD | STS
  const member = parts[parts.length - 1]
  if (scope === 'CMD') return { success: true, value: 0 }
  if (scope === 'STS') {
    if (member in plc.sts) return { success: true, value: plc.sts[member] }
    return { success: false, error: 'bad parameter' }
  }
  return { success: false, error: 'unknown scope' }
}
vi.mock('@/lib/mcm-registry', () => ({
  listMcms: () => [{ subsystemId: String(SID), ip: '10.0.0.1', path: '1,0', connected: true }],
  getConnectedEmbeddedMcms: () => [],
  hasMcm: (sid: string) => String(sid) === String(SID),
  readTypedTagsForMcm: async (_sid: string, reads: Array<{ name: string }>) => ({
    connected: true,
    results: reads.map(r => readMember(r.name)),
  }),
  writeTypedTagsForMcm: async (_sid: string, writes: Array<{ name: string; value: number }>) => {
    for (const w of writes) {
      const field = w.name.split('.').pop() as string
      plc.writes.push({ field, value: w.value, name: w.name })
    }
    return { connected: true, results: writes.map(() => ({ success: true })) }
  },
}))
// Not used on the hasMcm/remote branches we exercise, but statically imported by
// the write-tag route — fake it so no libplctag/native module loads.
vi.mock('@/lib/plc-client-manager', () => ({
  getPlcClient: () => ({ isConnected: false, writeTypedTag: () => ({ success: false, error: 'no plc' }), readTagCached: () => null }),
  getPlcStatus: () => ({ connectionConfig: null }),
}))
// Keep every writer export REAL, but neutralise the pull's fire-and-forget
// triggerValidationSync() so only OUR explicit writer runs touch the fake PLC.
vi.mock('@/lib/vfd-validation-writer', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/vfd-validation-writer')>()
  return { ...actual, triggerValidationSync: vi.fn() }
})

// REAL handlers + the REAL writer (spread mock returns the genuine impls).
import { POST as pullL2 } from '@/app/api/cloud/pull-l2/route'
import { POST as writeTag } from '@/app/api/vfd-commissioning/write-tag/route'
import {
  syncValidationFlags,
  runRetractionPass,
  runLocalControlRestorePass,
  resetLocalControlBackoff,
  type WriteTarget,
} from '@/lib/vfd-validation-writer'

// ── HTTP helpers ─────────────────────────────────────────────────────────────
function parseCookies(setCookie: string[] | undefined, jar: Map<string, string>) {
  for (const line of setCookie ?? []) {
    const [pair] = line.split(';')
    const eq = pair.indexOf('=')
    if (eq > 0) jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim())
  }
}
function cookieHeader(jar: Map<string, string>): string {
  return Array.from(jar.entries()).map(([k, v]) => `${k}=${v}`).join('; ')
}
function getSetCookie(res: Response): string[] | undefined {
  const anyHeaders = res.headers as any
  if (typeof anyHeaders.getSetCookie === 'function') return anyHeaders.getSetCookie()
  const single = res.headers.get('set-cookie')
  return single ? [single] : undefined
}

/** Drive the cloud's real access-key credentials login → Mechanical session cookie jar. */
async function loginMechanical(): Promise<Map<string, string>> {
  const jar = new Map<string, string>()
  const csrfRes = await fetch(`${CLOUD}/api/auth/csrf`)
  parseCookies(getSetCookie(csrfRes), jar)
  const { csrfToken } = await csrfRes.json()
  const body = new URLSearchParams({ csrfToken, accessKey: ACCESS_KEY, json: 'true' })
  const loginRes = await fetch(`${CLOUD}/api/auth/callback/access-key`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookieHeader(jar) },
    body,
    redirect: 'manual',
  })
  parseCookies(getSetCookie(loginRes), jar)
  return jar
}

async function toggle(jar: Map<string, string>, tracked: boolean) {
  const res = await fetch(`${CLOUD}/api/mechanic/belt-tracking/toggle`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookieHeader(jar) },
    body: JSON.stringify({ deviceId: DEVICE_ID, tracked, mechanicName: 'E2E Bob' }),
  })
  return { status: res.status, body: await res.json() }
}

/** Express-style adapter for the field tool's real route handlers. */
async function callRoute(handler: (req: any, res: any) => Promise<any>, body: any) {
  const res: any = {
    statusCode: 200, body: undefined,
    status(c: number) { this.statusCode = c; return this },
    json(o: any) { this.body = o; return this },
  }
  await handler({ body }, res)
  return res
}

function freshenCursor() {
  const utc = new Date().toISOString().slice(0, 19).replace('T', ' ')
  memDb.prepare('INSERT INTO SyncCursors (SubsystemId, UpdatedAt) VALUES (?, ?) ON CONFLICT(SubsystemId) DO UPDATE SET UpdatedAt = excluded.UpdatedAt').run(SID, utc)
}

function beltTrackedCell(): { Value: string | null; Version: number } | undefined {
  return memDb.prepare(`
    SELECT cv.Value AS Value, cv.Version AS Version
    FROM L2CellValues cv
    JOIN L2Columns c ON c.id = cv.ColumnId
    JOIN L2Devices d ON d.id = cv.DeviceId
    WHERE d.DeviceName = ? AND c.Name = 'Belt Tracked'
  `).get(DEVICE_NAME) as any
}

/** One remote MCM WriteTarget, matching what syncValidationFlags builds. */
function remoteTargets(): WriteTarget[] {
  return [{
    kind: 'remote', label: `mcm-${SID}`, ip: '10.0.0.1', path: '1,0', subsystemId: String(SID),
    isConnected: () => true, readTagCached: () => null,
    devices: [{ deviceName: DEVICE_NAME, writes: [], polarityRaw: null, hasDirection: false }],
  }]
}
const FRESH = () => new Map([[String(SID), true]])
const SUB_BY_DEVICE = () => new Map([[DEVICE_NAME, String(SID)]])
const UNTRACKED = () => new Set([DEVICE_NAME])

// ── Bring-up check + seed ────────────────────────────────────────────────────
let cloudUp = false
let jar: Map<string, string>

beforeAll(async () => {
  try {
    const r = await fetch(`${CLOUD}/api/health`, { signal: AbortSignal.timeout(2500) })
    cloudUp = r.ok
  } catch { cloudUp = false }
  if (!cloudUp) {
    console.warn(`[e2e] local cloud ${CLOUD} not reachable — skipping belt-untrack live test`)
    return
  }
  // Re-seed the throwaway cloud DB to a known state (idempotent) so the test is
  // re-runnable regardless of a prior run's mutations.
  // Compute the access-key bcrypt hash at RUNTIME (compatible with the cloud's
  // bcryptjs.compare) so no hash literal is committed. Substitute it into the seed.
  const keyHash = bcrypt.hashSync(ACCESS_KEY, 10)
  // split/join, not String.replace: replaces ALL occurrences of the placeholder,
  // and treats the bcrypt hash literally (a hash contains '$', which is a special
  // pattern — $1/$&/$$ — in a String.replace replacement string).
  const seed = readFileSync(path.join(__dirname, 'fixtures', 'belt-untrack-seed.sql'), 'utf8')
    .split('__KEYHASH__').join(keyHash)
  execFileSync('docker', ['exec', '-i', DB_CONTAINER, 'psql', '-U', 'local', '-d', 'commissioning', '-v', 'ON_ERROR_STOP=1'], { input: seed, stdio: ['pipe', 'ignore', 'pipe'] })
  jar = await loginMechanical()
})

describe('Belt-untrack safety loop — cross-process E2E (cloud + HTTP + tool SQLite + writer + gate)', () => {
  it('runs the full loop: track → pull → assert → untrack → pull-clears → retract+restore → gate', async () => {
    if (!cloudUp) { console.warn('[e2e] SKIPPED (cloud down)'); return }

    // ── STEP 1 — TRACK on the cloud via the real mechanic toggle ─────────────
    const track = await toggle(jar, true)
    expect(track.status).toBe(200)
    expect(track.body.success).toBe(true)
    expect(track.body.propagatedToField).toBe(true) // mcm "MCM15" resolved a field cursor
    console.log('[STEP 1 GREEN] TRACK toggle:', JSON.stringify(track.body))

    // ── STEP 2 — PULL to the tool over real HTTP; local cell becomes 'Yes' ───
    const pull1 = await callRoute(pullL2, { subsystemId: SID })
    expect(pull1.statusCode).toBe(200)
    expect(pull1.body.success).toBe(true)
    const afterTrack = beltTrackedCell()
    expect(afterTrack?.Value).toBe('Yes')
    console.log('[STEP 2 GREEN] pull landed Belt Tracked =', JSON.stringify(afterTrack))

    // ── STEP 3 — WRITER (tracked): the REAL orchestrator asserts Tracking_Finished ──
    freshenCursor()
    plc.sts = { Check_Allowed: 1, Valid_Map: 1, Valid_HP: 1, Belt_Tracking_ON: 0, RVS: 0 }
    plc.clear()
    await syncValidationFlags('e2e-tracked')
    const trackedWrites = plc.fields()
    expect(trackedWrites).toContain('Tracking_Finished')
    expect(trackedWrites).toContain('Valid_Map')
    expect(trackedWrites).toContain('Valid_HP')
    expect(trackedWrites).not.toContain('Invalidate_Tracking_Finished')
    console.log('[STEP 3 GREEN] writer asserted:', trackedWrites.join(', '))

    // ── STEP 4 — UNTRACK on the cloud ────────────────────────────────────────
    const untrack = await toggle(jar, false)
    expect(untrack.status).toBe(200)
    expect(untrack.body.success).toBe(true)
    expect(untrack.body.version).toBe(2) // advanced past the track (v1)
    console.log('[STEP 4 GREEN] UNTRACK toggle:', JSON.stringify(untrack.body))

    // ── STEP 5 — PULL to the tool; the cloud-owned EMPTY value CLEARS the cell (cb92781) ──
    const beforeVer = beltTrackedCell()?.Version
    const pull2 = await callRoute(pullL2, { subsystemId: SID })
    expect(pull2.statusCode).toBe(200)
    const afterUntrack = beltTrackedCell()
    expect(String(afterUntrack?.Value ?? '')).toBe('') // local cell now EMPTY
    expect(Number(afterUntrack?.Version)).toBeGreaterThan(Number(beforeVer)) // version advanced
    console.log(`[STEP 5 GREEN] pull cleared Belt Tracked: ${JSON.stringify(afterUntrack)} (was v${beforeVer})`)

    // ── STEP 7 — WRITER (untracked, RUNNING): retraction + restore DEFER ─────
    //   Executed BEFORE step 6: the retraction/local-control state machine
    //   requires the drive to be proven STOPPED before it may act (rung-7
    //   hazard), so the running sweep must come first (it registers the untrack
    //   edge, defers, and leaves the retraction owed). Same real pass functions
    //   syncValidationFlags calls; invoked directly so we can drive STS per
    //   scenario without the orchestrator's 5 s throttle. The tool DB, the
    //   untrack edge (KV baseline seeded by step 3), the freshness gate, the
    //   ladder decision and the fake PLC are all real.
    freshenCursor()
    plc.sts = { Check_Allowed: 1, Valid_Map: 1, Valid_HP: 1, Belt_Tracking_ON: 1, RVS: 30 }
    plc.clear()
    const retractRunning = await runRetractionPass(remoteTargets(), FRESH())
    const restoreRunning = await runLocalControlRestorePass(remoteTargets(), FRESH(), UNTRACKED(), SUB_BY_DEVICE(), Date.now())
    expect(retractRunning.every(o => o.action === 'defer')).toBe(true)
    expect(restoreRunning.every(o => o.action === 'defer')).toBe(true)
    expect(plc.fields()).toEqual([]) // NOTHING written while the belt moves
    console.log('[STEP 7 GREEN] running belt → retract/restore DEFERRED, zero writes')

    // ── STEP 6 — WRITER (untracked, STOPPED, fresh): retract + restore keypad ─
    //   Step 6 decomposes into TWO real controller snapshots, because the two
    //   behaviours it asks for cannot coexist in one STS reading:
    //     6a  keypad ALREADY enabled (STS.Valid_HP=1) — the pending untrack edge
    //         is RETRACTED: Normal_Polarity → Invalidate_Direction →
    //         Invalidate_Tracking_Finished (AOI rung 3's unlatch is gated on
    //         Valid_HP=1, so retraction can only run here);
    //     6b  keypad DEAD (STS.Valid_HP=0, Valid_Map=0) — retraction correctly
    //         SKIPS (the gated rung would no-op) and the LEVEL-based local-control
    //         restore instead re-enables the keypad: Valid_Map → Valid_HP →
    //         Invalidate_Tracking_Finished.
    //   Together they cover exactly what step 6 specifies. Neither ever re-asserts
    //   tracking authority, and neither ever disables the keypad.

    // 6a — retraction order (keypad enabled, latch still owned by the tool)
    resetLocalControlBackoff()
    freshenCursor()
    plc.sts = { Check_Allowed: 1, Valid_Map: 1, Valid_HP: 1, Belt_Tracking_ON: 0, RVS: 0 }
    plc.clear()
    const retract6a = await runRetractionPass(remoteTargets(), FRESH())
    const restore6a = await runLocalControlRestorePass(remoteTargets(), FRESH(), UNTRACKED(), SUB_BY_DEVICE(), Date.now())
    const w6a = plc.fields()
    expect(retract6a.some(o => o.action === 'retract')).toBe(true)
    expect(restore6a.some(o => o.action === 'restore')).toBe(true)
    expect(w6a).toContain('Normal_Polarity')
    expect(w6a).toContain('Invalidate_Direction')
    expect(w6a).toContain('Invalidate_Tracking_Finished')
    const iNP = w6a.indexOf('Normal_Polarity')
    const iID = w6a.indexOf('Invalidate_Direction')
    const iIT = w6a.indexOf('Invalidate_Tracking_Finished')
    expect(iNP).toBeLessThan(iID)
    expect(iID).toBeLessThan(iIT)              // ladder-mandated order
    expect(w6a).not.toContain('Tracking_Finished')   // never re-asserts authority
    expect(w6a).not.toContain('Valid_Direction')
    expect(w6a).not.toContain('Invalidate_HP')       // never disables the keypad
    expect(w6a).not.toContain('Invalidate_Map')
    console.log('[STEP 6a GREEN] stopped, keypad-enabled → retracted in order:', w6a.join(', '))

    // 6b — keypad restore (STS shows the keypad DEAD on an untracked belt)
    resetLocalControlBackoff()
    freshenCursor()
    plc.sts = { Check_Allowed: 1, Valid_Map: 0, Valid_HP: 0, Belt_Tracking_ON: 0, RVS: 0 }
    plc.clear()
    const restore6b = await runLocalControlRestorePass(remoteTargets(), FRESH(), UNTRACKED(), SUB_BY_DEVICE(), Date.now())
    const w6b = plc.fields()
    expect(restore6b.some(o => o.action === 'restore')).toBe(true)
    expect(w6b).toContain('Valid_Map')          // keypad enable restored …
    expect(w6b).toContain('Valid_HP')
    expect(w6b).toContain('Invalidate_Tracking_Finished')
    expect(w6b.indexOf('Valid_Map')).toBeLessThan(w6b.indexOf('Valid_HP')) // rung-1 order
    expect(w6b).not.toContain('Tracking_Finished')
    expect(w6b).not.toContain('Valid_Direction')
    expect(w6b).not.toContain('Invalidate_HP')  // … but never disables it
    expect(w6b).not.toContain('Invalidate_Map')
    console.log('[STEP 6b GREEN] stopped, keypad-dead → keypad restored:', w6b.join(', '))

    // ── STEP 8 — GATE: the real write-tag handler enforces the untracked gate ─
    const gTracking = await callRoute(writeTag, { deviceName: DEVICE_NAME, field: 'Tracking_Finished', value: 1, dataType: 'BOOL', subsystemId: SID })
    expect(gTracking.statusCode).toBe(409)
    expect(gTracking.body.code).toBe('belt_not_tracked')

    const gValidHp = await callRoute(writeTag, { deviceName: DEVICE_NAME, field: 'Valid_HP', value: 1, dataType: 'BOOL', subsystemId: SID })
    expect(gValidHp.statusCode).not.toBe(409) // pre-gate — passes the gate (reaches the fake PLC)
    expect(gValidHp.body.code).not.toBe('belt_not_tracked')

    const gInvalidate = await callRoute(writeTag, { deviceName: DEVICE_NAME, field: 'Invalidate_Tracking_Finished', value: 1, dataType: 'BOOL', subsystemId: SID })
    expect(gInvalidate.statusCode).not.toBe(409) // retraction — always allowed
    expect(gInvalidate.body.code).not.toBe('belt_not_tracked')
    console.log(`[STEP 8 GREEN] gate: Tracking_Finished→409(${gTracking.body.code}); Valid_HP→${gValidHp.statusCode}; Invalidate_Tracking_Finished→${gInvalidate.statusCode}`)
  }, 60_000)
})
