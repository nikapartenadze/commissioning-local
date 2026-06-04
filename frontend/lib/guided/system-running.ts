/**
 * "System started, all conveyors running" derivation (committee decision D4).
 *
 * Every functional check lists "System started, all conveyors running" as a
 * precondition. The committee chose Option A — read the PLC tags and gate,
 * with a "Start the system" prompt when stopped. No consolidated "system
 * running" tag exists yet (one may be added by Controls later), so this scans
 * the live tag cache for run-indicating tags:
 *
 *   - explicit run bits:   <dev>:O.Run, <dev>.Run_Fwd, ..._RUN, .Running, …
 *   - run-up / run mode:   ..._RunUp, .Run_Up, RunMode…
 *
 * Verdict:
 *   - any run tag TRUE            → running  (true)
 *   - run tags known, all FALSE   → stopped  (false)
 *   - no run tag in the cache     → unknown  (null — never blocks; matches
 *                                   the pool's null semantics elsewhere)
 *
 * Pure module so the rule is unit-testable; the snapshot feeds it the cache.
 */

export interface LiveTag {
  name?: string
  state?: string
}

/** Matches a run/running/run-up token bounded by `_ . :` or string edges. */
const RUN_TOKEN = /(^|[_.:])RUN(NING|_?UP|_?FWD|_?REV|_?CMD|_?MODE)?([_.:0-9]|$)/i

/** Tags that contain RUN tokens but do NOT indicate conveyor run state. */
const RUN_FALSE_POSITIVE = /OVERRIDE|FAULT|ERR|TIME|TMR|HOUR|REQUEST|REQ([_.:0-9]|$)/i

export function isRunIndicatorTag(name: string | null | undefined): boolean {
  const n = name ?? ''
  if (!n) return false
  if (RUN_FALSE_POSITIVE.test(n)) return false
  return RUN_TOKEN.test(n)
}

/**
 * Derive the system-running verdict from the live tag cache.
 * Only BOOL-ish states participate ("TRUE"/"FALSE"); anything else is ignored.
 */
export function deriveSystemRunning(tags: LiveTag[]): boolean | null {
  let sawKnown = false
  for (const t of tags) {
    if (!isRunIndicatorTag(t.name)) continue
    if (t.state === 'TRUE') return true
    if (t.state === 'FALSE') sawKnown = true
  }
  return sawKnown ? false : null
}
