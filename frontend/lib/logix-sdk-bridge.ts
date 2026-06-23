/**
 * Bridge to the Rockwell Logix Designer SDK (Python client) for program
 * download / upload / controller mode control.
 *
 * The SDK is Windows-only and requires a licensed Studio 5000 + the Logix
 * Designer SDK (LdSdkServer.exe). We invoke it through an isolated Python venv
 * (`logix-sdk-bridge/.venv`) running `logix-sdk-bridge/bridge.py`, which speaks
 * one JSON command on stdin and emits NDJSON events on stdout.
 *
 * Paths are overridable via env so the same tool can, in the eventual
 * Linux+Windows-VM topology, point at a remote bridge:
 *   LOGIX_SDK_PYTHON   - python executable (default: the bundled venv)
 *   LOGIX_SDK_BRIDGE   - bridge.py path
 *   LOGIX_PROJECTS_DIR - directory scanned for .ACD projects
 */
import { spawn } from 'child_process'
import path from 'path'
import fs from 'fs'
import os from 'os'
import crypto from 'crypto'
import { configService } from '@/lib/config/config-service'
import { uploadFile } from '@/lib/sharepoint/graph-upload'

const BRIDGE_DIR = process.env.LOGIX_SDK_DIR || path.resolve(process.cwd(), 'logix-sdk-bridge')
const PYTHON = process.env.LOGIX_SDK_PYTHON || path.join(BRIDGE_DIR, '.venv', 'Scripts', 'python.exe')
const BRIDGE = process.env.LOGIX_SDK_BRIDGE || path.join(BRIDGE_DIR, 'bridge.py')

export const LOGIX_PROJECTS_DIR =
  process.env.LOGIX_PROJECTS_DIR || path.join(os.homedir(), 'Desktop', 'plc')

/**
 * Confine a requested ACD path to the allow-listed projects directory.
 * Prevents an arbitrary-file-open/copy primitive via the `acd` request field.
 */
export function resolveProject(acd: string): string {
  if (!acd || typeof acd !== 'string') throw new Error('project path required')
  const real = path.resolve(acd)
  const base = path.resolve(LOGIX_PROJECTS_DIR)
  if (real !== base && !real.startsWith(base + path.sep)) throw new Error('project path is outside the projects directory')
  if (!real.toLowerCase().endsWith('.acd')) throw new Error('not an .acd project file')
  if (!fs.existsSync(real)) throw new Error('project file not found')
  return real
}

export interface BridgeEvent {
  type: 'progress' | 'status' | 'error' | 'result'
  [k: string]: any
}

export function bridgeInstalled(): { ok: boolean; python: string; bridge: string; reason?: string } {
  if (!fs.existsSync(PYTHON)) return { ok: false, python: PYTHON, bridge: BRIDGE, reason: 'python venv not found' }
  if (!fs.existsSync(BRIDGE)) return { ok: false, python: PYTHON, bridge: BRIDGE, reason: 'bridge.py not found' }
  return { ok: true, python: PYTHON, bridge: BRIDGE }
}

/** Run one bridge command. Resolves with the final 'result' event. */
export function runBridge(
  cmd: Record<string, any>,
  onEvent?: (e: BridgeEvent) => void,
  timeoutMs = 600_000,
): Promise<BridgeEvent> {
  return new Promise((resolve, reject) => {
    const inst = bridgeInstalled()
    if (!inst.ok) {
      reject(new Error(`Logix SDK bridge not available: ${inst.reason} (${inst.python})`))
      return
    }
    const child = spawn(PYTHON, [BRIDGE], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    let result: BridgeEvent | null = null
    let buf = ''
    let stderr = ''
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL') } catch { /* ignore */ }
      reject(new Error('Logix SDK bridge timed out'))
    }, timeoutMs)

    child.stdout.on('data', (d: Buffer) => {
      buf += d.toString()
      let idx: number
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim()
        buf = buf.slice(idx + 1)
        if (!line) continue
        let evt: BridgeEvent
        try { evt = JSON.parse(line) } catch { continue } // ignore non-JSON noise
        if (evt.type === 'result') result = evt
        try { onEvent?.(evt) } catch { /* ignore */ }
      }
    })
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString() })
    child.on('error', (e) => { clearTimeout(timer); reject(e) })
    child.on('close', (code) => {
      clearTimeout(timer)
      // parse any trailing line left in the buffer (final result without a closing newline)
      if (!result && buf.trim()) {
        try { const e = JSON.parse(buf.trim()); if (e.type === 'result') result = e } catch { /* ignore */ }
      }
      if (result) resolve(result)
      else reject(new Error(`Logix SDK bridge exited (code ${code}) without a result. ${stderr.slice(-600)}`))
    })
    try {
      child.stdin.on('error', () => { /* child died before reading stdin; child 'error'/'close' handles it */ })
      child.stdin.write(JSON.stringify(cmd))
      child.stdin.end()
    } catch { /* ignore — close/error will reject */ }
  })
}

// ── Warm session for the quick interactive ops (comm_path / status / mode) ──
// Holds ONE resident bridge.py process with the project open + online, and feeds
// it successive commands so only the FIRST op pays the ~20s open/connect cost;
// every op after is ~1-2s. The project is opened against a temp COPY of the ACD
// (same safety as before: the Studio 5000 GUI never locks us, the source is
// never mutated). The session is released after WARM_IDLE_MS of inactivity, on a
// project switch, on any op timeout, and before any download/upload job — so we
// never hold two online connections to one controller.
const WARM_IDLE_MS = 60_000

interface WarmPending {
  resolve: (e: BridgeEvent) => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout>
}
interface WarmSession {
  proc: ReturnType<typeof spawn>
  sourceAcd: string
  tempDir: string
  tempAcd: string
  buf: string
  stderr: string
  pending: WarmPending | null
  idleTimer: ReturnType<typeof setTimeout> | null
  chain: Promise<unknown>
  alive: boolean
}
let warm: WarmSession | null = null

/** Release the warm session: shut the project, kill the process, delete temp. */
export function teardownWarmSession(): void {
  const w = warm
  warm = null
  if (!w) return
  w.alive = false
  if (w.idleTimer) { clearTimeout(w.idleTimer); w.idleTimer = null }
  if (w.pending) { clearTimeout(w.pending.timer); const p = w.pending; w.pending = null; p.reject(new Error('warm session released')) }
  try { w.proc.stdin?.write(JSON.stringify({ op: 'shutdown' }) + '\n') } catch { /* ignore */ }
  try { w.proc.stdin?.end() } catch { /* ignore */ }
  // Force-kill if it doesn't exit promptly after closing the project.
  const proc = w.proc
  setTimeout(() => { try { if (proc.exitCode === null) proc.kill() } catch { /* ignore */ } }, 4000)
}

function startWarmSession(sourceAcd: string): WarmSession {
  const inst = bridgeInstalled()
  if (!inst.ok) throw new Error(`Logix SDK bridge not available: ${inst.reason} (${inst.python})`)
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'logix-warm-'))
  const tempAcd = path.join(tempDir, path.basename(sourceAcd))
  fs.copyFileSync(sourceAcd, tempAcd)
  const proc = spawn(PYTHON, [BRIDGE], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
  const w: WarmSession = { proc, sourceAcd, tempDir, tempAcd, buf: '', stderr: '', pending: null, idleTimer: null, chain: Promise.resolve(), alive: true }

  proc.stdout.on('data', (d: Buffer) => {
    w.buf += d.toString()
    let idx: number
    while ((idx = w.buf.indexOf('\n')) >= 0) {
      const line = w.buf.slice(0, idx).trim()
      w.buf = w.buf.slice(idx + 1)
      if (!line) continue
      let evt: BridgeEvent
      try { evt = JSON.parse(line) } catch { continue }
      const pend = w.pending
      if (!pend) continue
      if (evt.type === 'result') { clearTimeout(pend.timer); w.pending = null; pend.resolve(evt) }
      // progress/status/error events between commands are advisory; the warm
      // ops (status/mode/comm_path) are short, so we don't surface them.
    }
  })
  proc.stderr.on('data', (d: Buffer) => { w.stderr += d.toString() })
  const die = (err: Error) => {
    w.alive = false
    if (warm === w) warm = null
    if (w.idleTimer) { clearTimeout(w.idleTimer); w.idleTimer = null }
    if (w.pending) { clearTimeout(w.pending.timer); const p = w.pending; w.pending = null; p.reject(err) }
    try { fs.rmSync(w.tempDir, { recursive: true, force: true }) } catch { /* ignore */ }
  }
  proc.on('error', (e) => die(e instanceof Error ? e : new Error(String(e))))
  proc.on('close', (code) => die(new Error(`warm bridge exited (code ${code})${w.stderr ? ': ' + w.stderr.slice(-300) : ''}`)))
  return w
}

/**
 * Run a quick project op (status / mode / comm_path) on the warm session.
 * The first call against a given ACD opens it (slow); subsequent calls reuse the
 * open/online project (~1-2s). Commands are serialized (one LdSdkServer). Switching
 * to a different ACD transparently tears down the old session and starts a new one.
 */
export async function runProjectOp(
  cmd: { op: string; acd: string; comm?: string; mode?: string },
  timeoutMs = 180_000,
): Promise<BridgeEvent> {
  if (!fs.existsSync(cmd.acd)) throw new Error(`project file not found: ${cmd.acd}`)

  // (Re)establish the session if missing, dead, or pointed at another project.
  if (!warm || !warm.alive || warm.sourceAcd !== cmd.acd || warm.proc.exitCode !== null) {
    if (warm) teardownWarmSession()
    warm = startWarmSession(cmd.acd)
  }
  const w = warm

  const run = () => new Promise<BridgeEvent>((resolve, reject) => {
    if (w !== warm || !w.alive) { reject(new Error('warm session was replaced')); return }
    if (w.idleTimer) { clearTimeout(w.idleTimer); w.idleTimer = null }
    const timer = setTimeout(() => {
      // A wedged op means the session is suspect — tear it down so the next op
      // starts fresh rather than reusing a stuck connection.
      reject(new Error('Logix SDK bridge timed out'))
      teardownWarmSession()
    }, timeoutMs)
    w.pending = { resolve, reject, timer }
    const line = JSON.stringify({ op: cmd.op, acd: w.tempAcd, comm: cmd.comm, mode: cmd.mode }) + '\n'
    try { w.proc.stdin?.write(line) } catch (e) { clearTimeout(timer); w.pending = null; reject(e instanceof Error ? e : new Error(String(e))) }
  }).finally(() => {
    // Restart the idle countdown after each op (releases the controller when unused).
    if (w === warm && w.alive) {
      if (w.idleTimer) clearTimeout(w.idleTimer)
      w.idleTimer = setTimeout(() => teardownWarmSession(), WARM_IDLE_MS)
    }
  })

  // Serialize commands on the session so two ops never interleave on one stdin.
  const result = w.chain.then(run, run)
  w.chain = result.then(() => undefined, () => undefined)
  return result
}

// ---- async job store (download/upload run for ~20s+ with progress) ----

export interface BatchUploadItem {
  subsystemId: string
  name: string
  comm: string
  out?: string
  status: 'pending' | 'running' | 'done' | 'error'
  percent: number
  statusText: string
  error?: string
  /** Optional SharePoint push sub-status for this uploaded .acd. */
  sharepoint?: {
    status: 'pending' | 'uploading' | 'done' | 'error' | 'skipped'
    webUrl?: string
    error?: string
  }
}

export interface SdkJob {
  id: string
  op: 'download' | 'upload' | 'upload_batch'
  acd: string
  comm?: string
  status: 'running' | 'done' | 'error'
  percent: number
  statusText: string
  logs: { t: number; level: string; msg: string }[]
  /** Per-controller progress for op === 'upload_batch'. */
  items?: BatchUploadItem[]
  result?: any
  error?: string
  startedAt: number
  finishedAt?: number
}

const jobs = new Map<string, SdkJob>()

export function getJob(id: string): SdkJob | undefined {
  return jobs.get(id)
}

/** A single LdSdkServer drives all SDK jobs — only one download/upload at a time. */
export function hasRunningJob(): boolean {
  return [...jobs.values()].some((j) => j.status === 'running')
}

function pruneJobs() {
  // keep at most 50, drop oldest finished ones
  if (jobs.size <= 50) return
  const finished = [...jobs.values()].filter((j) => j.status !== 'running').sort((a, b) => (a.finishedAt || 0) - (b.finishedAt || 0))
  for (const j of finished.slice(0, jobs.size - 50)) jobs.delete(j.id)
}

/**
 * Start a long-running download/upload job. For downloads we operate on a
 * temp COPY of the ACD so we never lock or mutate the user's source project,
 * and so a project open in the Studio 5000 GUI does not block us.
 */
export function startJob(op: 'download' | 'upload', opts: { acd: string; comm?: string }): SdkJob {
  // Release any warm interactive session first so we don't hold two online
  // connections to the same controller during the download/upload.
  teardownWarmSession()
  const id = crypto.randomUUID()
  const job: SdkJob = {
    id, op, acd: opts.acd, comm: opts.comm,
    status: 'running', percent: 0, statusText: 'Starting…',
    logs: [], startedAt: Date.now(),
  }
  jobs.set(id, job)
  pruneJobs()

  let workAcd = opts.acd
  let tempAcd: string | null = null
  try {
    if (op === 'download') {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'logix-dl-'))
      tempAcd = path.join(tmpDir, path.basename(opts.acd))
      fs.copyFileSync(opts.acd, tempAcd)
      workAcd = tempAcd
    }
  } catch (e) {
    job.status = 'error'
    job.error = `Failed to stage project: ${e instanceof Error ? e.message : e}`
    job.finishedAt = Date.now()
    return job
  }

  const cmd = { op, acd: workAcd, comm: opts.comm }
  runBridge(cmd, (e) => {
    if (e.type === 'progress' && typeof e.percent === 'number') job.percent = e.percent
    else if (e.type === 'status') { job.statusText = e.msg; job.logs.push({ t: Date.now(), level: 'status', msg: e.msg }) }
    else if (e.type === 'error') job.logs.push({ t: Date.now(), level: 'error', msg: e.msg })
  })
    .then((res) => {
      if (res.ok) {
        job.status = 'done'; job.percent = 100; job.statusText = 'Completed'; job.result = res
      } else {
        job.status = 'error'; job.error = res.error || 'failed'; job.statusText = 'Failed'
      }
    })
    .catch((err) => {
      job.status = 'error'; job.error = err instanceof Error ? err.message : String(err); job.statusText = 'Failed'
    })
    .finally(() => {
      job.finishedAt = Date.now()
      if (tempAcd) { try { fs.rmSync(path.dirname(tempAcd), { recursive: true, force: true }) } catch { /* ignore */ } }
    })

  return job
}

/** Filesystem-safe controller name for an output filename. Mirrors batch_upload.py's safe(). */
function safe(name: string): string {
  const s = name.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '')
  return s.slice(0, 40) || 'controller'
}

/**
 * Start a batch upload job: for each target controller, upload its RUNNING
 * program into a NEW .acd (LogixProject.upload_to_new_project) under
 * LOGIX_PROJECTS_DIR/uploads. Runs the controllers SEQUENTIALLY (one
 * LdSdkServer ⇒ one op at a time) and is resilient — one controller failing
 * never aborts the rest. Not awaited; poll the job for progress.
 *
 * Deliberately NOT routed through startJob(): that hardcodes {op,acd,comm} and
 * stages a temp ACD copy, which is wrong for upload_new (no input project).
 */
export function startBatchUploadJob(
  targets: { subsystemId: string; name: string; comm: string }[],
  opts?: { pushToSharePoint?: boolean },
): SdkJob {
  // Release any warm interactive session first (single LdSdkServer; avoid
  // colliding with an open online project while uploading).
  teardownWarmSession()
  const id = crypto.randomUUID()
  const items: BatchUploadItem[] = targets.map((t) => ({
    subsystemId: t.subsystemId,
    name: t.name,
    comm: t.comm,
    status: 'pending',
    percent: 0,
    statusText: 'Queued',
  }))
  const job: SdkJob = {
    id, op: 'upload_batch', acd: '',
    status: 'running', percent: 0, statusText: 'Starting…',
    logs: [], items, startedAt: Date.now(),
  }
  jobs.set(id, job)
  pruneJobs()

  const total = targets.length || 1
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19)
  const outDir = path.join(LOGIX_PROJECTS_DIR, 'uploads')

  ;(async () => {
    try { fs.mkdirSync(outDir, { recursive: true }) } catch { /* ignore — runBridge will surface a write error */ }
    let completed = 0
    let failures = 0
    for (let i = 0; i < targets.length; i++) {
      const item = items[i]
      const out = path.join(outDir, `upload_${i}_${safe(item.name)}_${stamp}.acd`)
      item.out = out
      item.status = 'running'
      item.statusText = 'Uploading…'
      item.percent = 0
      job.statusText = `Uploading ${item.name} (${i + 1}/${total})`
      console.log(`[Upload ${item.name}] starting — comm=${item.comm} -> ${out}`)

      try {
        const res = await runBridge(
          { op: 'upload_new', comm: item.comm, out },
          (e) => {
            if (e.type === 'progress' && typeof e.percent === 'number') {
              item.percent = e.percent
              job.percent = ((completed + (e.percent || 0) / 100) / total) * 100
            } else if (e.type === 'status') {
              item.statusText = e.msg
              job.logs.push({ t: Date.now(), level: 'status', msg: `[${item.name}] ${e.msg}` })
              console.log(`[Upload ${item.name}] ${e.msg}`)
            } else if (e.type === 'error') {
              job.logs.push({ t: Date.now(), level: 'error', msg: `[${item.name}] ${e.msg}` })
              console.warn(`[Upload ${item.name}] SDK error: ${e.msg}`)
            }
          },
          240_000, // 4-min cap per controller — fail fast on an unreachable comm path instead of hanging 10 min
        )
        if (res.ok) {
          item.status = 'done'; item.percent = 100; item.statusText = 'Uploaded'
          console.log(`[Upload ${item.name}] DONE -> ${out}`)
        } else {
          item.status = 'error'; item.error = res.error || 'failed'; item.statusText = 'Failed'
          failures++
          console.warn(`[Upload ${item.name}] FAILED: ${res.error || 'unknown'}`)
        }
      } catch (err) {
        // Never let one controller abort the batch.
        item.status = 'error'
        item.error = err instanceof Error ? err.message : String(err)
        item.statusText = 'Failed'
        failures++
        console.warn(`[Upload ${item.name}] FAILED: ${item.error}`)
      }

      // Optional SharePoint push — runs ONLY after a successful local upload.
      // A SharePoint failure NEVER fails the local item (the .acd is already
      // saved on disk); it is recorded in item.sharepoint only.
      if (opts?.pushToSharePoint && item.status === 'done' && item.out) {
        if (!configService.isSharePointConfigured()) {
          item.sharepoint = { status: 'skipped' }
        } else {
          item.sharepoint = { status: 'uploading' }
          job.logs.push({ t: Date.now(), level: 'status', msg: `[${item.name}] Pushing to SharePoint…` })
          try {
            const sp = await uploadFile(configService.getSharePointConfig(), item.out, path.basename(item.out))
            if (sp.ok) {
              item.sharepoint = { status: 'done', webUrl: sp.webUrl }
              job.logs.push({ t: Date.now(), level: 'status', msg: `[${item.name}] SharePoint upload OK` })
            } else {
              item.sharepoint = { status: 'error', error: sp.error || 'SharePoint upload failed' }
              job.logs.push({ t: Date.now(), level: 'error', msg: `[${item.name}] SharePoint: ${sp.error || 'failed'}` })
            }
          } catch (spErr) {
            item.sharepoint = { status: 'error', error: spErr instanceof Error ? spErr.message : String(spErr) }
            job.logs.push({ t: Date.now(), level: 'error', msg: `[${item.name}] SharePoint: ${item.sharepoint.error}` })
          }
        }
      }

      completed++
      job.percent = (completed / total) * 100
    }
    job.percent = 100
    job.finishedAt = Date.now()
    if (failures >= total) { job.status = 'error'; job.statusText = 'All uploads failed' }
    else { job.status = 'done'; job.statusText = failures ? `${total - failures} uploaded, ${failures} failed` : 'All uploaded' }
  })().catch((err) => {
    job.status = 'error'
    job.error = err instanceof Error ? err.message : String(err)
    job.statusText = 'Failed'
    job.finishedAt = Date.now()
  })

  return job
}

/** List .ACD projects available for download. */
export function listProjects(): { name: string; path: string; sizeBytes: number; modified: number }[] {
  const dir = LOGIX_PROJECTS_DIR
  if (!fs.existsSync(dir)) return []
  // Scan the projects root AND the uploads/ subfolder (where batch uploads land),
  // so a freshly uploaded controller program shows up in the selector.
  const scanDirs = [dir, path.join(dir, 'uploads')]
  const out: { name: string; path: string; sizeBytes: number; modified: number }[] = []
  for (const d of scanDirs) {
    if (!fs.existsSync(d)) continue
    for (const f of fs.readdirSync(d)) {
      if (!f.toLowerCase().endsWith('.acd')) continue
      // hide Studio auto-backup files (e.g. Project.<user>.BAK001.acd)
      if (/\.bak\d+\.acd$/i.test(f)) continue
      const p = path.join(d, f)
      const st = fs.statSync(p)
      // Label uploads so they're distinguishable from hand-placed projects.
      const name = d === dir ? f : `uploads/${f}`
      out.push({ name, path: p, sizeBytes: st.size, modified: st.mtimeMs })
    }
  }
  return out.sort((a, b) => b.modified - a.modified)
}
