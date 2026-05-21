/**
 * Heartbeat Command Result Queue
 *
 * In-memory queue of command results waiting to be shipped to the
 * cloud on the next heartbeat. The flow is:
 *
 *   1. Heartbeat response arrives with commands -> executeCommand() ->
 *      enqueueResult().
 *   2. Next heartbeat tick calls drainResults() while building its
 *      request body and ships the lot.
 *   3. If that POST fails (network/timeout/non-2xx), the caller calls
 *      requeue() so we try again on the following tick instead of
 *      dropping evidence on the floor.
 *
 * Single process, single tool instance — a plain module-scope array
 * is enough for v1. If a laptop crashes between executing a command
 * and shipping its result, the result is lost; the cloud already
 * accepts that trade because it marks commands `sent` as soon as it
 * hands them out.
 *
 * // TODO persist to SQLite if v1 reliability not enough
 */

import type { CommandResult } from './command-handler'

const pendingResults: CommandResult[] = []

/**
 * Append a result to the queue. Used by the heartbeat response
 * handler after each executeCommand() resolves.
 */
export function enqueueResult(r: CommandResult): void {
  pendingResults.push(r)
}

/**
 * Return the current queued results AND clear the queue in one shot.
 * Caller is then responsible for either successfully shipping them or
 * calling requeue() to put them back.
 */
export function drainResults(): CommandResult[] {
  if (pendingResults.length === 0) return []
  const out = pendingResults.slice()
  pendingResults.length = 0
  return out
}

/**
 * Put items back at the front of the queue, preserving their original
 * order. Used when a heartbeat POST failed so the drained results
 * aren't lost — they retry on the next tick alongside any new results
 * that accumulated in the meantime.
 */
export function requeue(items: CommandResult[]): void {
  if (items.length === 0) return
  pendingResults.unshift(...items)
}

/**
 * Test/diagnostic helper. Production code shouldn't need this.
 */
export function _pendingCount(): number {
  return pendingResults.length
}
