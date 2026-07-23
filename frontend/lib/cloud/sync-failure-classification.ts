/**
 * Classifies a failed cloud push: did the cloud app give a definitive
 * verdict on this payload, or did the attempt die somewhere in transit?
 *
 * Born from the 2026-06-04 TPA8/MCM08 incident: the PendingSyncs retry cap
 * (10 strikes → row deleted) counted plain network failures as strikes, so
 * a site with no internet silently emptied its sync queue in ~100 seconds
 * per row. The manual-pull guard then saw 0 pending rows and allowed a
 * destructive pull that wiped 818 unsynced results.
 *
 * The retry cap exists to clear rows the CLOUD refuses (version mismatch /
 * updatedCount=0) so they don't block catch-up pulls forever. It must never
 * fire for failures where the cloud never ruled on the payload.
 */
export interface SyncFailureShape {
  /** True when fetch threw (DNS, connect timeout, aborted, conn refused). */
  thrown?: boolean
  /** HTTP status when a response was received. Undefined = no HTTP attempt (offline short-circuit, missing config). */
  httpStatus?: number
}

/**
 * Returns true when the failure is network-level / environmental — the row
 * is still good and must NOT have its RetryCount incremented:
 * - fetch threw, or no HTTP attempt was made (offline / no remote URL)
 * - HTTP 401: auth/config problem on the tool, not a verdict on the row
 * - HTTP 403: auth/project-key MISMATCH — the tool's apiPassword doesn't match
 *   the record's project (validateApiKeyForIo fail in the cloud's
 *   /api/sync/update). Same category as 401 (a config problem on the tool), NOT
 *   a verdict that the record was removed. It self-heals once the config/key is
 *   fixed. Classing 403 as a permanent REMOVAL (as it was until 2026-07-17)
 *   fired orphan() → Ios.CloudRemoved=1, silently tombstoning genuinely-unsynced
 *   local work and DISARMING the pull-guard for it — a data-loss vector on the
 *   exact project-mismatch incident this tool has hit before. Genuine record
 *   removal on that route is a 200-body rejected:[{permanent:true}], not a 403.
 * - HTTP 429: rate limited — the cloud REFUSED to process the row (no verdict
 *   on its value), it just throttled. Retrying after the window succeeds.
 * - HTTP 5xx: cloud app or reverse proxy down/overloaded
 *
 * Returns false when the cloud actually processed the request and said no
 * (2xx body verdicts like updatedCount=0, and non-401/429 4xx — the latter are
 * treated as permanent rejections by the caller and deleted immediately).
 *
 * The 429 case is bug B1 from the 2026-06-05 MCM11 incident: the cloud
 * rate-limits push at 300/min/key and a flaky link's retry flood trips it.
 * Before this, 429 was classed as a permanent 4xx and the result was DELETED
 * on the first throttle — silent field-data loss. 429 is transient.
 */
export function isNetworkLevelFailure(failure: SyncFailureShape): boolean {
  if (failure.thrown) return true
  if (failure.httpStatus === undefined) return true
  if (failure.httpStatus === 401) return true
  if (failure.httpStatus === 403) return true // auth/project-key mismatch, not a record verdict (see note above)
  if (failure.httpStatus === 429) return true
  if (failure.httpStatus >= 500) return true
  return false
}

/**
 * True when the failure is specifically an AUTH failure: HTTP 401 (missing/bad
 * credential) or 403 (the tablet's API key doesn't match THIS record's project —
 * validateApiKeyForIo fail in the cloud's /api/sync/update).
 *
 * This is a STRICT SUBSET of isNetworkLevelFailure, and it deliberately changes
 * NOTHING about retry behaviour: an auth failure stays network-level for the
 * drain, so it burns no retry-cap strike, never parks, never orphans, and keeps
 * retrying — it self-heals the instant the key is corrected. Retry-forever is
 * correct and must stay (see the 429 / TPA8 incidents above). This predicate
 * exists ONLY so the operator surface + telemetry can tell an auth failure APART
 * from a generic connectivity blip, because the two demand OPPOSITE things of a
 * human:
 *   - a plain network failure (offline / timeout / 5xx) fixes ITSELF when the
 *     link returns — nobody has to do anything;
 *   - a 401/403 is DETERMINISTIC and never recovers until someone fixes the cloud
 *     key in Settings. Folding it into the generic "temporary — nothing to do"
 *     bucket is a lie that leaves a tablet silently unable to sync for as long as
 *     the wrong key sits there.
 *
 * So: retry cadence unchanged (still isNetworkLevelFailure ⇒ no strike); this is
 * a SURFACING signal, not a routing one. The queue-inspector mirrors it on the
 * stored LastError string via authStatusFromError() for the display layer.
 */
export function isAuthFailure(httpStatus: number | undefined): boolean {
  return httpStatus === 401 || httpStatus === 403
}

/**
 * DEFINITIVELY-PERMANENT cloud rejection statuses: the target row was REMOVED
 * on the cloud (deleted IO / device / column / subsystem), so every retry
 * returns the same 404/410 forever. There is nothing to reconcile — the
 * queue row must be PARKED (DeadLettered=1) on the FIRST such response instead
 * of burning the whole retry cap over many minutes on a doomed row.
 *
 * 403 is deliberately EXCLUDED (was here until 2026-07-17): the cloud returns
 * 403 for an auth/project-key mismatch, NOT a confirmed removal — treating it as
 * removal tombstoned unsynced work (see isNetworkLevelFailure note). 403 is
 * transient (retry, self-heal on config fix).
 *
 * Deliberately NARROW, and disjoint from both:
 *  - the TRANSIENT set (401/403/429/5xx/thrown — isNetworkLevelFailure above), which
 *    keeps its no-strike retry/backoff behaviour untouched; and
 *  - the version-conflict / `updatedCount=0` case, which is usually an
 *    at-least-once GHOST the B7 reconcile heals against cloud truth — parking it
 *    on sight would risk losing genuinely-unsynced field work, so it is NOT
 *    included here.
 */
export function isPermanentRejectionStatus(httpStatus: number | undefined): boolean {
  return httpStatus === 404 || httpStatus === 410
}

/**
 * Human-readable LastError for a row parked because its cloud target was
 * removed (see isPermanentRejectionStatus). Written verbatim into the queue
 * row's LastError so the Sync Center shows an honest, self-explanatory reason.
 */
export function permanentRejectionReason(httpStatus: number): string {
  return `HTTP ${httpStatus} — target no longer exists on cloud (removed); parked without further retries`
}

/**
 * MACHINE-READABLE rejection codes the cloud's /api/sync/update puts on each
 * `rejected[]` entry (added 2026-07-22 alongside the existing English `reason`).
 *
 * Why this exists: a DELETED IO never comes back as an HTTP 404. The route
 * answers HTTP **200** with `rejected: [{ id, reason: 'IO not found',
 * permanent: true }]`, so isPermanentRejectionStatus (which only knows 404/410)
 * never fired and the row fell through to deadLetter() — the "a human must look
 * at this" bucket — and sat there forever. That was the bulk of the standing
 * backlog. Classifying on the English string is how this breaks again; the code
 * is the contract.
 */
export type CloudRejectionCode =
  | 'io_not_found'       // the IO row does not exist (deleted on cloud)
  | 'io_wrong_project'   // the IO belongs to another project (API-key misconfig)
  | 'io_disappeared'     // vanished mid-transaction
  | 'version_conflict'   // stale version

/**
 * True when the code means the cloud target is CONFIRMED GONE — the same
 * verdict a 404/410 carries, so the row must ORPHAN (self-healing, auto-requeues
 * if the IO reappears via a delta upsert), not dead-letter.
 *
 * `io_wrong_project` is deliberately EXCLUDED: it is an API-key/project
 * misconfiguration on the tool, not a removal. Orphaning it would tombstone
 * genuinely-unsynced local work (Ios.CloudRemoved=1) and hide it from the
 * attention surface — the exact class of silent loss the 403 handling above was
 * fixed for on 2026-07-17. It stays PARKED so a human sees it.
 *
 * Unknown/absent codes return false so an OLDER cloud (which sends no `code`)
 * keeps EXACTLY today's behaviour — field tablets run against it for weeks.
 */
export function isRemovedOnCloudCode(code: string | null | undefined): boolean {
  return code === 'io_not_found' || code === 'io_disappeared'
}

/**
 * Human-readable LastError for a row orphaned/parked on a coded rejection.
 * Keeps the cloud's own `reason` text so the Sync Center shows what it said.
 */
export function rejectionCodeReason(code: string, reason: string | undefined): string {
  const said = reason ? ` (cloud said: ${reason})` : ''
  return isRemovedOnCloudCode(code)
    ? `${code} — IO no longer exists on cloud (removed)${said}; orphaned, auto-restores if it reappears`
    : `${code} — cloud permanently rejected this row${said}`
}
