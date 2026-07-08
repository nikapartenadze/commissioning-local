/**
 * Recovery-journal uploader — forensics survive tablet loss.
 *
 * The recovery audit log (`audit-YYYY-MM-DD.jsonl`, see lib/logging/recovery-log.ts)
 * is the durable local record of every state-changing sync/test event. But it
 * lives ONLY on the tablet: if the device is lost, stolen, or dies, the forensic
 * trail dies with it. This module ships NEW journal lines to the cloud on a slow
 * cadence so the trail survives the hardware.
 *
 * Contract (cloud side: POST {remoteUrl}/api/sync/journal, X-API-Key auth):
 *   body { day, machineId, subsystemId: null, lines: string[] }
 *   - max 1000 lines per POST (chunked)
 *   - each line <= 4 KB (larger lines are skipped, but still counted as progress)
 *
 * Progress is tracked in `journal-upload-state.json` in the logs dir:
 *   { [filename]: uploadedLineCount }
 * State is advanced ONLY on a 2xx response, so a failed POST re-sends the same
 * lines next run (the cloud side must tolerate replays — lines are append-only
 * JSONL with embedded timestamps, so dedupe is trivial server-side).
 *
 * Best-effort by design: never throws, 15 s timeout per POST, stops at the
 * first failure and resumes where it left off on the next run.
 */

import fs from 'fs'
import path from 'path'
import os from 'os'
import { resolveLogsDirPath } from '@/lib/storage-paths'
import { configService } from '@/lib/config'

const STATE_FILENAME = 'journal-upload-state.json'
const MAX_LINES_PER_POST = 1000
const MAX_LINE_BYTES = 4 * 1024
const POST_TIMEOUT_MS = 15_000

function dayStamp(d: Date): string {
  // Same UTC YYYY-MM-DD convention as recovery-log.ts filenames.
  return d.toISOString().slice(0, 10)
}

function readState(statePath: string): Record<string, number> {
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath, 'utf8'))
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const state: Record<string, number> = {}
      for (const [k, v] of Object.entries(parsed)) {
        if (typeof v === 'number' && Number.isFinite(v) && v > 0) state[k] = Math.floor(v)
      }
      return state
    }
  } catch { /* missing / corrupt state file → start from zero */ }
  return {}
}

function writeState(statePath: string, state: Record<string, number>): void {
  try {
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2))
  } catch { /* best-effort — a lost state file only causes re-upload, never data loss */ }
}

/**
 * Upload new journal lines for today's and yesterday's audit files.
 * Best-effort: never throws.
 */
export async function runJournalUpload(): Promise<void> {
  try {
    const config = await configService.getConfig()
    const remoteUrl = config.remoteUrl
    if (!remoteUrl) return

    const logsDir = resolveLogsDirPath()
    if (!fs.existsSync(logsDir)) return

    const statePath = path.join(logsDir, STATE_FILENAME)
    const state = readState(statePath)
    const machineId = os.hostname()

    const now = new Date()
    const days = [dayStamp(now), dayStamp(new Date(now.getTime() - 24 * 60 * 60 * 1000))]

    for (const day of days) {
      const filename = `audit-${day}.jsonl`
      const filePath = path.join(logsDir, filename)
      if (!fs.existsSync(filePath)) continue

      let content: string
      try {
        content = fs.readFileSync(filePath, 'utf8')
      } catch {
        continue
      }
      const lines = content.split('\n').filter((l) => l.trim() !== '')
      const uploaded = state[filename] ?? 0
      if (lines.length <= uploaded) continue

      const pending = lines.slice(uploaded)
      let progressed = 0
      let failed = false

      for (let i = 0; i < pending.length; i += MAX_LINES_PER_POST) {
        const chunk = pending.slice(i, i + MAX_LINES_PER_POST)
        // Oversized lines are skipped from the payload but still count as
        // progress — otherwise a single fat line would wedge the cursor forever.
        const sendable = chunk.filter((l) => Buffer.byteLength(l, 'utf8') <= MAX_LINE_BYTES)

        if (sendable.length > 0) {
          let resp: globalThis.Response
          try {
            resp = await fetch(`${remoteUrl}/api/sync/journal`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'X-API-Key': config.apiPassword || '' },
              body: JSON.stringify({ day, machineId, subsystemId: null, lines: sendable }),
              signal: AbortSignal.timeout(POST_TIMEOUT_MS),
            })
          } catch {
            failed = true
            break // offline / timeout — resume from the same cursor next run
          }
          if (!resp.ok) {
            failed = true
            break // non-2xx: do NOT advance state; retry this chunk next run
          }
        }

        // 2xx (or nothing sendable in the chunk) → advance and persist progress.
        progressed = i + chunk.length
        state[filename] = uploaded + progressed
        writeState(statePath, state)
      }

      if (progressed > 0) {
        console.log(`[JournalUpload] ${filename}: uploaded ${progressed} new line(s) (cursor now ${uploaded + progressed})`)
      }
      if (failed) break // cloud unreachable — don't hammer it with the other day's file
    }
  } catch (err) {
    // Never let forensics shipping break anything else.
    console.warn('[JournalUpload] failed (non-fatal):', err instanceof Error ? err.message : err)
  }
}
