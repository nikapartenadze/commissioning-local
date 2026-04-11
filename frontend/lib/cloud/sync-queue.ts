/**
 * Per-key sync queue — guarantees only one in-flight push per cell/IO at a time.
 *
 * Solves the rapid-edit race condition:
 *   - User edits same cell twice quickly
 *   - Both pushes fire async
 *   - HTTP requests can arrive out of order at the cloud
 *   - Cloud has version conflict checks → second push gets rejected
 *   - User's last edit is lost (until background sync retries)
 *
 * Pattern (per Notion/Linear/Figma): "single-flight with dirty bit"
 *   - When a push is requested for key K:
 *     - If no push running for K: start one, mark running=true
 *     - If a push is already running for K: mark dirty=true, return immediately
 *   - When the running push completes:
 *     - If dirty=true: clear dirty, fire another push (which reads latest state from DB)
 *     - Else: mark running=false, remove from map
 *
 * The push function should ALWAYS read the latest local state when it runs —
 * not capture stale snapshots from when the request was queued.
 */

interface QueueEntry {
  running: boolean
  dirty: boolean
}

const queue = new Map<string, QueueEntry>()

/**
 * Enqueue a push for a given key. Guarantees serial execution per key.
 *
 * @param key Unique key (e.g. `io:123` or `l2cell:456-789`)
 * @param pushFn Async function that performs the push. Should read latest state from DB internally.
 */
export function enqueueSyncPush(key: string, pushFn: () => Promise<void>): void {
  const existing = queue.get(key)

  if (existing?.running) {
    // A push is already running for this key — mark dirty so a follow-up push fires
    existing.dirty = true
    return
  }

  // Start a new push for this key
  const entry: QueueEntry = { running: true, dirty: false }
  queue.set(key, entry)

  // Run async, don't await
  void runPushLoop(key, entry, pushFn)
}

async function runPushLoop(key: string, entry: QueueEntry, pushFn: () => Promise<void>): Promise<void> {
  try {
    do {
      entry.dirty = false
      try {
        await pushFn()
      } catch (err) {
        console.warn(`[SyncQueue] Push for ${key} threw:`, err instanceof Error ? err.message : err)
      }
      // If another edit came in while we were pushing, run again with the latest state
    } while (entry.dirty)
  } finally {
    entry.running = false
    queue.delete(key)
  }
}

/**
 * Returns true if there is currently a push running or queued for this key.
 * Useful for diagnostics — not for control flow.
 */
export function isSyncPending(key: string): boolean {
  return queue.has(key)
}
