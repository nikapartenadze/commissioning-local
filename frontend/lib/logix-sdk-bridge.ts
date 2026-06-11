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

/**
 * Run a project op (status / mode / comm_path) against a temp COPY of the ACD,
 * so a project open in the Studio 5000 GUI never locks us and the source file
 * is never mutated. For long download/upload ops use startJob().
 */
export async function runProjectOp(
  cmd: { op: string; acd: string; comm?: string; mode?: string },
  timeoutMs = 180_000,
): Promise<BridgeEvent> {
  if (!fs.existsSync(cmd.acd)) throw new Error(`project file not found: ${cmd.acd}`)
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'logix-op-'))
  const tmp = path.join(tmpDir, path.basename(cmd.acd))
  try {
    fs.copyFileSync(cmd.acd, tmp)
    return await runBridge({ ...cmd, acd: tmp }, undefined, timeoutMs)
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch { /* ignore */ }
  }
}

// ---- async job store (download/upload run for ~20s+ with progress) ----

export interface SdkJob {
  id: string
  op: string
  acd: string
  comm?: string
  status: 'running' | 'done' | 'error'
  percent: number
  statusText: string
  logs: { t: number; level: string; msg: string }[]
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

/** List .ACD projects available for download. */
export function listProjects(): { name: string; path: string; sizeBytes: number; modified: number }[] {
  const dir = LOGIX_PROJECTS_DIR
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir)
    .filter((f) => f.toLowerCase().endsWith('.acd'))
    // hide Studio auto-backup files (e.g. Project.<user>.BAK001.acd)
    .filter((f) => !/\.bak\d+\.acd$/i.test(f))
    .map((f) => {
      const p = path.join(dir, f)
      const st = fs.statSync(p)
      return { name: f, path: p, sizeBytes: st.size, modified: st.mtimeMs }
    })
    .sort((a, b) => b.modified - a.modified)
}
