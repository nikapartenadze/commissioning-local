/**
 * Stable Machine ID
 *
 * Resolves a per-laptop UUID that survives restarts and reinstalls
 * (as long as the data directory is preserved). Used as the primary
 * key for fleet-visibility heartbeats on the cloud side.
 *
 * Lives beside the SQLite database (see lib/storage-paths.ts), so
 * it follows the same portable-mode / installer-mode rules as the
 * database and config.json.
 */

import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { resolveStorageRootPath } from '@/lib/storage-paths'

const MACHINE_ID_FILENAME = 'machine.id'

// Module-scope cache — first call hits the disk, subsequent calls are O(1).
let cachedMachineId: string | null = null

function machineIdFilePath(): string {
  return path.join(resolveStorageRootPath(), MACHINE_ID_FILENAME)
}

/**
 * Read the machine ID from disk if present, otherwise generate a new
 * UUID v4, persist it, and return it. Cached after the first call.
 *
 * Never throws: if disk IO fails we fall back to an in-memory UUID so
 * the heartbeat can still go out (just won't be stable across restarts
 * in that degraded mode). The error is logged.
 */
export function getMachineId(): string {
  if (cachedMachineId) return cachedMachineId

  const filePath = machineIdFilePath()

  try {
    if (fs.existsSync(filePath)) {
      const contents = fs.readFileSync(filePath, 'utf-8').trim()
      // Defensive: only accept a sane-looking value (8–64 chars, no newlines).
      // Anything weird in the file — regenerate.
      if (contents.length >= 8 && contents.length <= 64 && !/\s/.test(contents)) {
        cachedMachineId = contents
        return cachedMachineId
      }
      console.warn('[Heartbeat] machine.id contents invalid, regenerating')
    }
  } catch (err) {
    console.warn('[Heartbeat] Failed to read machine.id:', err instanceof Error ? err.message : err)
  }

  const fresh = crypto.randomUUID()
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    fs.writeFileSync(filePath, fresh, 'utf-8')
    console.log(`[Heartbeat] Generated new machineId at ${filePath}`)
  } catch (err) {
    // Disk full / permission denied — keep the UUID in memory so the
    // current process still has a stable ID for this run.
    console.warn(
      '[Heartbeat] Failed to persist machine.id, using in-memory id for this run:',
      err instanceof Error ? err.message : err,
    )
  }

  cachedMachineId = fresh
  return cachedMachineId
}
