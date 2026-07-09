/**
 * Shared bool-tag reader for the live status endpoints (estop / safety /
 * network). Extracted from the three near-identical read blocks those routes
 * carried (D5b) so a change lands once instead of three times.
 *
 * Behavior is preserved EXACTLY: same registry-MCM vs legacy-singleton
 * bucketing, same value semantics (BOOL → true/1), same reset-on-reconnect of
 * the tag-handle caches. Each caller derives its own response shape from the
 * returned `values` map (estop additionally uses `diag`/`errors`/`connectedSids`).
 *
 * The one intentional change (R9): a tag whose libplctag handle FAILS to create
 * is no longer pinned to null until the next full PLC reconnect. Its failure
 * entry now ages out after FAILED_TAG_TTL_MS, so a transient CIP-saturation
 * failure is retried on a later poll instead of leaving safety/network views
 * showing a stale false forever.
 */
import { getPlcClient } from '@/lib/plc-client-manager'
import { readTypedTagsForMcm } from '@/lib/mcm-registry'

/** How a single tag read resolved — the estop route surfaces non-ok ones. */
export type TagReadStatus = 'ok' | 'not_found' | 'read_error' | 'mcm_disconnected'

/**
 * A creation failure is retried once its cached entry is older than this. The
 * old behavior pinned a failed tag to null until a full PLC reconnect cleared
 * the whole cache (R9); this bounds that stickiness to a short window so a
 * transient failure self-heals on the next poll.
 */
export const FAILED_TAG_TTL_MS = 30_000

// Tag-handle caches, shared across the three status routes and keyed to the ONE
// singleton PlcClient they all read through. Module-level on purpose: they
// mirror the singleton's live handle set and are cleared when it reconnects.
let createdTags = new Set<string>()
let failedTags = new Map<string, number>() // tagName -> epoch ms of last create failure
let lastConnectedState = false

/**
 * Classify a libplctag read/create failure as a NAME MISMATCH ("no such tag" —
 * the most common real E-Stop problem) vs a generic read error, so the tester
 * gets an honest reason for a blank value instead of a silent null.
 */
export function isNotFoundError(msg?: string): boolean {
  if (!msg) return false
  return /not.?found|no such|unknown tag|bad.?param|ERR_NOT_FOUND|0x0?4\b|0x0?5\b/i.test(msg)
}

export interface ReadBoolTagsInput {
  /** Tags whose owning subsystem is a registry MCM, bucketed by subsystem id. */
  registryTagsBySid: Map<string, Set<string>>
  /** Tags read via the legacy singleton (field tablets / unregistered subsystems). */
  legacyTags: Set<string>
  /** hasPlcClient() && getPlcClient().isConnected — computed by the caller. */
  singletonConnected: boolean
}

export interface ReadBoolTagsResult {
  /** tag -> bool value, or null when read but unresolved. Absent when unread. */
  values: Record<string, boolean | null>
  /** Per-tag read status (estop surfaces the non-ok ones as tagIssues). */
  diag: Record<string, TagReadStatus>
  /** Per-tag error text for read_error / not_found tags. */
  errors: Record<string, string>
  /** Registry subsystem ids whose batch read reported connected. */
  connectedSids: Set<string>
  /** True if any registry batch OR the legacy singleton produced a read. */
  anyConnected: boolean
}

/**
 * Read a bucketed set of BOOL tags: registry MCMs via the mode-aware typed
 * batch, everything else via the legacy singleton cached-read path.
 */
export async function readBoolTagsBySubsystem(input: ReadBoolTagsInput): Promise<ReadBoolTagsResult> {
  const { registryTagsBySid, legacyTags, singletonConnected } = input

  // Reset-on-reconnect: when the singleton drops we mark disconnected; on the
  // first read after it comes back we clear the stale handle caches (the create
  // path re-establishes handles). Shared across the three routes — the first to
  // observe the reconnect clears it, later reads in the same window keep it.
  if (!singletonConnected) {
    lastConnectedState = false
  } else if (!lastConnectedState) {
    createdTags = new Set<string>()
    failedTags = new Map<string, number>()
    lastConnectedState = true
    console.log('[ReadBoolTags] PLC (re)connected, resetting tag handles')
  }

  const values: Record<string, boolean | null> = {}
  const diag: Record<string, TagReadStatus> = {}
  const errors: Record<string, string> = {}
  const connectedSids = new Set<string>()
  let anyConnected = false

  // Registry MCM buckets: one mode-aware typed batch per subsystem (embedded
  // in-process, or via the plc-gateway in PLC_MODE=remote).
  for (const [sid, tags] of Array.from(registryTagsBySid.entries())) {
    try {
      const batch = await readTypedTagsForMcm(
        sid,
        Array.from(tags).map((name) => ({ name, dataType: 'BOOL' as const })),
      )
      if (!batch.connected) {
        for (const name of Array.from(tags)) diag[name] = 'mcm_disconnected'
        continue
      }
      anyConnected = true
      connectedSids.add(sid)
      for (const r of batch.results) {
        if (r.success) {
          values[r.name] = r.value === true || r.value === 1
          diag[r.name] = 'ok'
        } else {
          values[r.name] = null
          diag[r.name] = isNotFoundError(r.error) ? 'not_found' : 'read_error'
          if (r.error) errors[r.name] = r.error
        }
      }
    } catch (err) {
      // Whole-batch failure (e.g. gateway RPC threw) — record WHY rather than
      // leaving these tags indistinguishable from a clean "no data".
      for (const name of Array.from(tags)) {
        diag[name] = 'read_error'
        errors[name] = err instanceof Error ? err.message : String(err)
      }
    }
  }

  // Legacy singleton bucket (field tablets / unregistered subsystems).
  if (singletonConnected && legacyTags.size > 0) {
    anyConnected = true
    const client = getPlcClient()
    const now = Date.now()
    // R9: age out create-failure entries so a transiently-failed tag is retried
    // instead of pinned to null until the next reconnect.
    for (const [name, at] of Array.from(failedTags.entries())) {
      if (now - at >= FAILED_TAG_TTL_MS) failedTags.delete(name)
    }
    const tagsToCreate: string[] = []
    for (const tagName of Array.from(legacyTags)) {
      if (!createdTags.has(tagName) && !failedTags.has(tagName) && !client.hasTag(tagName)) {
        tagsToCreate.push(tagName)
      }
    }
    if (tagsToCreate.length > 0) {
      const tagReader = (client as any).tagReader
      if (tagReader) {
        const created = await tagReader.createTags(tagsToCreate)
        for (const name of created.successful) {
          createdTags.add(name)
          failedTags.delete(name)
        }
        for (const f of created.failed) failedTags.set(f.name, now)
      }
    }
    for (const tagName of Array.from(legacyTags)) {
      if (failedTags.has(tagName)) {
        values[tagName] = null
        diag[tagName] = 'not_found'
        continue
      }
      const v = client.readTagCached(tagName)
      values[tagName] = v
      // null here = handle exists but the poll loop hasn't produced a value
      // (transient on first read) or the read is erroring — surface it.
      diag[tagName] = v === null ? 'read_error' : 'ok'
    }
  } else if (legacyTags.size > 0) {
    // Singleton not connected — these tags can't be read at all right now.
    for (const tagName of Array.from(legacyTags)) diag[tagName] = 'mcm_disconnected'
  }

  return { values, diag, errors, connectedSids, anyConnected }
}
