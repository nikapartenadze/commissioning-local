/**
 * Tag state-change log — a stored, human-readable trail of *what the PLC did*
 * ("UL21_3_VFD:I.In_0  0→1"), i.e. the read-side events that matter (a device
 * triggering), without logging every individual poll (which would be millions
 * of lines/hour).
 *
 * PERFORMANCE: recordTagEvent() is O(1) — it only pushes to an in-memory ring
 * buffer. A single timer flushes the whole buffer to today's
 * `tag-events-YYYY-MM-DD.log` with ONE batched append every FLUSH_MS, so even a
 * burst of hundreds of simultaneous changes costs one I/O, never one-per-change.
 * The reader's hot path never blocks on disk. Buffer is capped so a runaway
 * flapping tag can't grow memory unbounded.
 */
import path from 'path'
import { appendDailyLog } from '@/lib/logging/file-log'
import { resolveLogsDirPath } from '@/lib/storage-paths'

const FLUSH_MS = 2000
const MAX_BUFFER = 5000 // drop oldest beyond this between flushes (flap guard)

let buffer: string[] = []
let dropped = 0
let timer: ReturnType<typeof setInterval> | null = null

function hhmmss(): string {
  // local wall-clock HH:MM:SS — date is in the filename.
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

function ensureTimer(): void {
  if (timer) return
  timer = setInterval(flush, FLUSH_MS)
  // never hold the process open just for the flush timer
  ;(timer as unknown as { unref?: () => void }).unref?.()
}

function flush(): void {
  if (buffer.length === 0) return
  const batch = buffer
  buffer = []
  const note = dropped > 0 ? ` (+${dropped} more dropped — high change rate)` : ''
  dropped = 0
  try {
    const base = path.join(resolveLogsDirPath(), 'tag-events.log')
    appendDailyLog(base, batch.join('\n') + note)
  } catch {
    /* never throw into the reader */
  }
}

/**
 * Record a single tag transition. Cheap; safe to call from the read loop.
 * `mcm` is optional (the owning subsystemId, when known) for context.
 */
export function recordTagEvent(name: string, oldVal: number, newVal: number, mcm?: string): void {
  if (buffer.length >= MAX_BUFFER) {
    dropped++
    return
  }
  const tag = mcm ? `[MCM ${mcm}] ${name}` : name
  buffer.push(`${hhmmss()}  ${tag}  ${oldVal ? 1 : 0}→${newVal ? 1 : 0}`)
  ensureTimer()
}
