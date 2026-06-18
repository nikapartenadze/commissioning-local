/**
 * RustDesk ID probe
 *
 * Reads this laptop's RustDesk ID so the heartbeat can self-report it to the
 * cloud fleet view. The cloud prefers a self-reported ID over its hostname-
 * based guess (commissioning-cloud's GET /api/admin/instances), which is
 * ambiguous whenever several physical laptops reuse one Windows hostname (the
 * shared-image "autstand" problem). It is in fact the ONLY mistake-free way to
 * map a device to its RustDesk ID: the RustDesk server records only the shared
 * public/NAT egress IP per peer, so the cloud cannot disambiguate cloned
 * machines on its own. Reporting the real ID here is what makes the one-click
 * "Remote in" reliable and clears the "pick RustDesk" warning.
 *
 * Why shell out instead of parsing RustDesk.toml: modern RustDesk stores only
 * an ENCRYPTED `enc_id` in the toml — the plaintext ID is not in the file.
 * `rustdesk.exe --get-id` prints it. That GUI binary panics when its stdout is
 * an ordinary pipe ("failed printing to stdout: The pipe is being closed"),
 * so we redirect stdout to a temp file and read it back — which works cleanly.
 *
 * Robustness (why we don't just probe one fixed path): field machines install
 * RustDesk in several layouts — per-machine (Program Files), per-user
 * (LocalAppData\Programs), service installs, and custom dirs. A single hardcoded
 * path missed those, leaving the device permanently unmatched in the fleet. So
 * we collect candidate exes from the known paths AND the Windows uninstall
 * registry (InstallLocation), probe each until one returns a valid ID, and
 * parse the output tolerantly (a version banner or warning line must not
 * suppress a real ID).
 *
 * Caching: the ID is stable per machine, so we probe once and cache it for the
 * process lifetime. While it's still unknown (RustDesk not installed yet, or
 * the probe failed) we re-probe on a throttle so we don't spawn the client on
 * every heartbeat. A reinstall that changes the ID is picked up on the next
 * tool restart.
 */

import os from 'os'
import fs from 'fs'
import path from 'path'
import { spawn, spawnSync } from 'child_process'

// Windows-only feature; field laptops are all Windows. Anywhere else we never
// report an ID and the cloud just falls back to its hostname guess.
const IS_WIN = process.platform === 'win32'

// Throttle re-probes while the ID is still unknown so we don't spawn the
// client on every 30 s heartbeat. ~2 min ≈ "every few heartbeats".
const RETRY_INTERVAL_MS = 2 * 60_000
// Per-exe probe budget. We may try a few candidate exes in one cycle, so keep
// this tight; the whole cycle still finishes well within a heartbeat interval.
const PROBE_TIMEOUT_MS = 5_000

let cachedId: string | null = null
let lastAttemptAt = 0
let inFlight: Promise<string | null> | null = null

// Known install layouts, in priority order. ProgramW6432 covers the 64-bit
// Program Files even when this process is 32-bit (WOW64 redirection).
function knownExePaths(): string[] {
  const pf = process.env['ProgramFiles'] || 'C:\\Program Files'
  const pfW64 = process.env['ProgramW6432'] || ''
  const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)'
  const local = process.env['LOCALAPPDATA'] || ''
  const paths = [
    path.join(pf, 'RustDesk', 'rustdesk.exe'),
    path.join(pf86, 'RustDesk', 'rustdesk.exe'),
  ]
  if (pfW64) paths.push(path.join(pfW64, 'RustDesk', 'rustdesk.exe'))
  if (local) paths.push(path.join(local, 'Programs', 'RustDesk', 'rustdesk.exe'))
  return paths
}

// Ask the Windows uninstall registry where RustDesk was installed. Covers
// custom install dirs and service installs that none of the fixed paths hit.
// Best-effort and fully guarded — any failure just yields no extra paths.
function registryExePaths(): string[] {
  const keys = [
    'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\RustDesk',
    'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\RustDesk',
    'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\RustDesk',
  ]
  const out: string[] = []
  for (const key of keys) {
    try {
      const res = spawnSync('reg', ['query', key, '/v', 'InstallLocation'], {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 3_000,
      })
      if (res.status === 0 && typeof res.stdout === 'string') {
        // Line looks like:  InstallLocation    REG_SZ    C:\Program Files\RustDesk
        const m = res.stdout.match(/InstallLocation\s+REG_\w+\s+(.+?)\s*$/im)
        const dir = m?.[1]?.trim()
        if (dir) out.push(path.join(dir, 'rustdesk.exe'))
      }
    } catch {
      /* reg missing / access denied / timeout — ignore this key */
    }
  }
  return out
}

// Ordered, de-duplicated list of exes to try. Existing files first (cheap to
// confirm), then the bare name resolved via PATH as a last resort.
function candidateExes(): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  const add = (p: string) => {
    const key = p.toLowerCase()
    if (!seen.has(key)) {
      seen.add(key)
      out.push(p)
    }
  }
  for (const p of [...knownExePaths(), ...registryExePaths()]) {
    try {
      if (fs.existsSync(p)) add(p)
    } catch {
      /* ignore and keep looking */
    }
  }
  // Last resort: let spawn resolve it via PATH. If it isn't installed, spawn
  // emits an 'error' event and we treat that candidate as "not found".
  add('rustdesk.exe')
  return out
}

// A RustDesk ID is a numeric string (typically 9-10 digits). Parse tolerantly:
// `--get-id` normally prints just the ID, but a stray banner/warning line must
// not stop us from finding it. We first accept a line that is EXACTLY the ID,
// then fall back to a standalone 9-10 digit run anywhere in the output. The
// digit-boundary guards stop us from slicing a longer number (e.g. a PID or a
// timestamp) into something that merely looks like an ID.
function sanitize(raw: string): string | null {
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim()
    if (/^\d{6,12}$/.test(t)) return t
  }
  const m = raw.match(/(?<!\d)\d{9,10}(?!\d)/)
  return m ? m[0] : null
}

/**
 * Spawn `<exe> --get-id` once, redirecting stdout to a temp file (see header
 * for why), and return the sanitized ID or null.
 */
async function probeExe(exe: string): Promise<string | null> {
  const tmp = path.join(os.tmpdir(), `rd-id-${process.pid}-${Date.now()}.txt`)
  let fd: number
  try {
    fd = fs.openSync(tmp, 'w')
  } catch {
    return null
  }

  const readResult = (): string | null => {
    try { fs.closeSync(fd) } catch { /* already closed */ }
    let out = ''
    try { out = fs.readFileSync(tmp, 'utf8') } catch { /* ignore */ }
    try { fs.unlinkSync(tmp) } catch { /* ignore */ }
    return sanitize(out)
  }

  return new Promise<string | null>((resolve) => {
    let settled = false
    let timer: NodeJS.Timeout | undefined
    const finish = () => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      resolve(readResult())
    }

    let child: ReturnType<typeof spawn>
    try {
      child = spawn(exe, ['--get-id'], {
        stdio: ['ignore', fd, 'ignore'],
        windowsHide: true,
      })
    } catch {
      finish()
      return
    }

    timer = setTimeout(() => {
      try { child.kill() } catch { /* ignore */ }
      finish()
    }, PROBE_TIMEOUT_MS)

    // 'error' = exe missing / spawn failed. 'close' = it ran; read whatever
    // landed in the file. Either way finish() reads + sanitizes (or nulls).
    child.on('error', finish)
    child.on('close', finish)
  })
}

// Config tomls that may carry the ID, across user and service-account install
// layouts. A service install keeps its config under the LocalService profile,
// which the tool can read when it runs as a service (LocalSystem).
function configTomlPaths(): string[] {
  const appdata = process.env['APPDATA'] || ''
  const sysroot = process.env['SystemRoot'] || 'C:\\Windows'
  const dirs: string[] = []
  if (appdata) dirs.push(path.join(appdata, 'RustDesk', 'config'))
  dirs.push(path.join(sysroot, 'ServiceProfiles', 'LocalService', 'AppData', 'Roaming', 'RustDesk', 'config'))
  dirs.push(path.join(sysroot, 'ServiceProfiles', 'NetworkService', 'AppData', 'Roaming', 'RustDesk', 'config'))
  const files: string[] = []
  for (const d of dirs) {
    files.push(path.join(d, 'RustDesk2.toml'))
    files.push(path.join(d, 'RustDesk.toml'))
  }
  return files
}

// Fallback ID source: read the plaintext `id = '123456789'` line RustDesk
// writes to its config. Modern clients store only an ENCRYPTED `enc_id` (which
// this regex deliberately won't match — it isn't a bare 6-12 digit run, and
// the line starts with `enc_`), so this only helps older clients or cases where
// the binary won't run --get-id from our context. Best-effort and read-only.
function readIdFromConfig(): string | null {
  for (const file of configTomlPaths()) {
    try {
      const txt = fs.readFileSync(file, 'utf8')
      const m = txt.match(/(?:^|\n)\s*id\s*=\s*['"]?(\d{6,12})['"]?/)
      if (m) return m[1]
    } catch {
      /* not present / unreadable (e.g. LocalService ACL) — try next */
    }
  }
  return null
}

/**
 * Try each candidate exe until one yields a valid ID, then fall back to reading
 * the ID straight from RustDesk's config. Returns the first hit, or null if
 * every source failed (RustDesk not installed / not responding).
 */
async function probeAll(): Promise<string | null> {
  for (const exe of candidateExes()) {
    const id = await probeExe(exe)
    if (id) return id
  }
  return readIdFromConfig()
}

/**
 * Best-effort RustDesk ID for this machine, or null if not yet known.
 *
 * Non-blocking: returns the current cached value immediately and kicks the
 * probe off in the background. So the heartbeat that triggers the first probe
 * reports null, and the next tick (once the probe resolves) carries the real
 * ID. Once found, it's cached for the process lifetime; while unknown,
 * re-probes are throttled to RETRY_INTERVAL_MS.
 */
export function getRustDeskId(): string | null {
  if (!IS_WIN) return null
  if (cachedId) return cachedId

  const now = Date.now()
  if (!inFlight && now - lastAttemptAt >= RETRY_INTERVAL_MS) {
    lastAttemptAt = now
    inFlight = probeAll()
      .then((id) => {
        if (id) cachedId = id
        return id
      })
      .catch(() => null)
      .finally(() => { inFlight = null })
  }

  return cachedId
}
