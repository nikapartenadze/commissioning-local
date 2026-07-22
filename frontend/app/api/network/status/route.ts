import { Request, Response } from 'express'
import { db } from '@/lib/db-sqlite'
import { getPlcClient, hasPlcClient } from '@/lib/plc-client-manager'
import { hasMcm } from '@/lib/mcm-registry'
import { readBoolTagsBySubsystem } from '@/lib/plc/read-bool-tags'

// Diagnostic: per-tag last-known value, used to log transitions like
// "X:I.ConnectionFaulted false → true". The IO grid greys out rows whose
// device has ConnectionFaulted=true, but the decision is made client-side
// from this endpoint's response — so the only persistent record of WHY a
// device went grey lives here. Module-level on purpose: resets on service
// restart, which is fine.
//
// Fed ONLY from a completed PLC read (see refreshScope). Cache hits must never
// produce transition lines — they carry no new observation, and degraded-to-
// null serves (see MAX_SERVE_AGE_MS) are a presentation decision, not a
// controller event. Logging those would fabricate "device went grey" entries.
const previousTagValues = new Map<string, boolean | null>()

/**
 * ── Why this endpoint is cached (field incident, see check2/ logs) ───────────
 *
 * This handler used to `await readBoolTagsBySubsystem()` on every request, i.e.
 * a LIVE EtherNet/IP CIP read of every ring/node/port StatusTag per HTTP hit.
 * Two clients poll it every 3 s (the commissioning page's IO grid and the
 * topology view). On a loaded multi-MCM controller that read costs seconds, so
 * production logged this route as SLOW 3,376 times in one day: median 7 s,
 * p90 10 s, max 71 s — while the PLC logs filled with "Read failed: Timeout",
 * "Read failed: Busy" and "ABORTED after 5 consecutive createTag failures (CIP
 * queue likely saturated)".
 *
 * That is a feedback loop, not just slowness: every 3 s poll queued another
 * batch of CIP requests onto a controller that had not finished the previous
 * ones, so the reads got slower, so more requests stacked. The stacked requests
 * then ate the browser's ~6-sockets-per-origin budget and starved the IO grid's
 * own refetch, which is how the grid ended up blank on site.
 *
 * The fix is three layers, all of them about NOT touching the PLC:
 *
 *   1. Short-TTL cache. Values are served from memory; the PLC is only read
 *      when the cached value is older than the TTL. N clients / tabs / rapid
 *      requests collapse to one read.
 *   2. Single-flight. If a read is already running for this scope, additional
 *      requests await THAT promise. Never two concurrent reads of the same tags.
 *   3. Adaptive cooldown. The next read is held off for at least as long as the
 *      previous one took (capped). A saturated controller therefore gets read
 *      LESS often, not more — the loop above runs in reverse.
 *
 * And one layer about not hanging: the handler waits a bounded time for a read
 * and then answers from last-known values regardless. An HTTP request from this
 * route can no longer occupy a socket for 71 s.
 *
 * NOTE on reusing lib/plc/network/poller.ts: it does maintain a background poll,
 * but of a DIFFERENT tag namespace — the per-device `<DEV>_NN` UDT snapshots
 * (link/speed/counters). It never reads the `:I.ConnectionFaulted` StatusTags
 * this route serves, so its snapshots cannot answer this question. Rather than
 * widen the poller (and change what the heartbeat ships), the cache below is
 * demand-driven off the same read path this route already used.
 */

/**
 * Values younger than this are served untouched — no PLC read at all. Set just
 * under the clients' 3 s poll cadence so a steady poll still refreshes each
 * tick on a healthy controller, while bursts and extra tabs cost nothing.
 */
const FRESH_TTL_MS = 2_500

/**
 * Backpressure: after a read completes we refuse to start another until at
 * least min(lastDurationMs, MAX_COOLDOWN_MS) has passed. On a healthy
 * controller reads take ~100 ms and this is a no-op; on the saturated
 * controller from the incident (7-10 s reads) it spaces reads out to roughly
 * one per read-duration instead of one per poll. This is the single most
 * important line for not making a struggling PLC worse.
 */
const MAX_COOLDOWN_MS = 15_000

/**
 * Hard ceiling on how long the HANDLER waits for a PLC read before answering
 * from cache. Deliberately below the commissioning page's 5 s client-side abort
 * so the client gets a real, staleness-labelled response instead of aborting
 * blind. The read is NOT cancelled — it keeps running and populates the cache
 * for the next poll (this also preserves the tag-handle warm-up that
 * app/api/configuration/connect/route.ts relies on this endpoint for).
 */
const WARM_WAIT_MS = 2_500

/**
 * Same bound, but for a cold cache (first request after boot / topology change)
 * where there is nothing to fall back to. Slightly longer so a first page load
 * usually renders real device colours rather than a screen of grey, still
 * comfortably under the 5 s client abort.
 */
const COLD_WAIT_MS = 4_000

/**
 * SAFETY CEILING. Past this age we stop reporting cached booleans at all and
 * report every tag as null (= "unknown", which both clients already render as
 * grey/unknown — it is an existing, handled state, not a new one).
 *
 * Rationale: the two staleness errors are not symmetric. A stale `true` wrongly
 * marks a device faulted — annoying, and it BLOCKS IO testing, so it fails
 * safe. A stale `false` tells the commissioning tech a device is connected and
 * healthy when it may have dropped off the ring minutes ago, and unblocks IO
 * testing against hardware that is not there. That is a safety-relevant
 * misrepresentation on a commissioning tool, so once data is this old we assert
 * nothing in either direction. Set to 30 s: long enough to ride out several
 * slow reads on a saturated controller, short enough that nobody makes a
 * commissioning decision on a minute-old reading believing it is live.
 */
const MAX_SERVE_AGE_MS = 30_000

/**
 * A read that has been in flight this long is presumed wedged (libplctag can
 * sit on a dead socket well past its own timeout) and no longer blocks a new
 * one. Without this, one hung read would pin single-flight forever and the
 * endpoint would serve nulls until the service restarted. Set well above the
 * worst read observed in the field (71 s).
 */
const REFRESH_ABANDON_MS = 120_000

interface ScopeCache {
  /** Last values that came back from an actual PLC read. Empty until the first completes. */
  values: Record<string, boolean | null>
  /** `connected` as reported by that same read. */
  connected: boolean
  /** Completion time of the read that produced `values`; 0 = never completed. */
  asOf: number
  /** Wall time the last read took — drives the adaptive cooldown. */
  lastDurationMs: number
  /** In-flight read, or null. Never rejects (refreshScope catches internally). */
  inFlight: Promise<void> | null
  inFlightStartedAt: number
  /** Monotonic id per started read; a late/abandoned read must not overwrite newer data. */
  generation: number
  committedGeneration: number
}

/**
 * One cache entry per request scope (`?subsystemId=` or the unscoped view).
 * Bounded by the number of subsystems, so no eviction policy is needed.
 */
const scopeCaches = new Map<string, ScopeCache>()

/**
 * Cached booleans describe the state of a PLC link that existed at the time of
 * the read. If the singleton's connection state flips, they describe a link
 * that no longer exists — drop everything rather than serve pre-disconnect
 * values as though the ring were still being observed. (In PLC_MODE=remote the
 * singleton is never connected and never flips, so this is inert there.)
 */
let lastSingletonConnected: boolean | null = null

function getScopeCache(scope: string): ScopeCache {
  let entry = scopeCaches.get(scope)
  if (!entry) {
    entry = {
      values: {},
      connected: false,
      asOf: 0,
      lastDurationMs: 0,
      inFlight: null,
      inFlightStartedAt: 0,
      generation: 0,
      committedGeneration: 0,
    }
    scopeCaches.set(scope, entry)
  }
  return entry
}

/** Run one real PLC read for this scope and commit it to the cache. Never rejects. */
async function refreshScope(
  entry: ScopeCache,
  input: Parameters<typeof readBoolTagsBySubsystem>[0],
  statusTags: Set<string>,
): Promise<void> {
  const gen = ++entry.generation
  const startedAt = Date.now()
  entry.inFlightStartedAt = startedAt
  try {
    const { values, anyConnected } = await readBoolTagsBySubsystem(input)
    // A read that was abandoned as wedged (REFRESH_ABANDON_MS) may land after a
    // newer one already committed. Older data must never win.
    if (gen < entry.committedGeneration) return

    entry.committedGeneration = gen
    entry.connected = anyConnected || input.singletonConnected
    entry.asOf = Date.now()
    entry.lastDurationMs = entry.asOf - startedAt

    // Merge rather than replace: a tag the caller did not ask for this time
    // (different ?subsystemId scope is a different entry, but topology edits
    // can shrink the set) keeps its last value until it ages out normally.
    for (const tag of Array.from(statusTags)) {
      entry.values[tag] = values[tag] ?? null
    }

    // Log every transition (false↔true↔null). Catches the "device went red
    // right when operator did X" question without spamming logs during steady
    // state. Skips the first observation of a tag so we don't dump every tag
    // on first boot. Only reached on a completed read, so the line always
    // reflects something the controller actually reported.
    for (const tagName of Array.from(statusTags)) {
      const next = values[tagName] ?? null
      if (!previousTagValues.has(tagName)) {
        previousTagValues.set(tagName, next)
        continue
      }
      const prev = previousTagValues.get(tagName)
      if (prev !== next) {
        previousTagValues.set(tagName, next)
        const prevStr = prev === null ? 'null' : String(prev)
        const nextStr = next === null ? 'null' : String(next)
        console.log(`[NetworkStatus] ${tagName} ${prevStr} → ${nextStr}`)
      }
    }
  } catch (err) {
    // Swallow: a failed read must not reject the promise that other requests
    // are awaiting, and must not commit anything. The previous values simply
    // keep ageing, and will be degraded to null by the staleness ceiling if the
    // failure persists.
    if (gen >= entry.committedGeneration) {
      entry.lastDurationMs = Date.now() - startedAt
    }
    console.warn(
      `[NetworkStatus] PLC read failed: ${err instanceof Error ? err.message : String(err)}`,
    )
  } finally {
    // Only the newest read clears the slot — an abandoned one must not free
    // single-flight for the read that superseded it.
    if (gen === entry.generation) {
      entry.inFlight = null
      entry.inFlightStartedAt = 0
    }
  }
}

/** Resolves true if `p` settled within `ms`, false on timeout. Never rejects. */
function settledWithin(p: Promise<unknown>, ms: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), ms)
    const done = () => {
      clearTimeout(timer)
      resolve(true)
    }
    p.then(done, done)
  })
}

/**
 * GET /api/network/status — ring/node/port StatusTag values, served from a
 * short-TTL cache of live PLC reads (see the cache rationale above).
 *
 * Mode-aware (multi-MCM / central server): each NetworkRing's StatusTags are
 * bucketed by the ring's SubsystemId. Rings whose subsystem is a registry MCM
 * are read through the typed batch ops — in-process when embedded, via the
 * plc-gateway when PLC_MODE=remote. Unregistered subsystems keep the legacy
 * singleton cached-read path (single-MCM field tablets).
 *
 * Previously the whole endpoint gated on `hasPlcClient() && isConnected` and
 * read every StatusTag via the singleton; in PLC_MODE=remote the singleton is
 * never connected, so the entire fleet's topology view rendered all-grey.
 *
 * Response adds staleness metadata alongside the original `tags` map:
 *   asOf   — epoch ms of the read that produced these values, or null if none
 *   ageMs  — how old they are, or null
 *   stale  — true when the values are older than the refresh TTL
 *   degraded — true when they exceeded MAX_SERVE_AGE_MS and every tag has been
 *              forced to null rather than presented as live
 * `tags` keeps its exact previous shape (tag → true | false | null), so clients
 * that ignore the new fields behave as before.
 */
export async function GET(req: Request, res: Response) {
  try {
    const subsystemId = parseInt(req.query.subsystemId as string || '')

    const singletonConnected = hasPlcClient() && getPlcClient().isConnected
    if (lastSingletonConnected !== null && lastSingletonConnected !== singletonConnected) {
      scopeCaches.clear()
      console.log(
        `[NetworkStatus] PLC singleton ${singletonConnected ? 'connected' : 'disconnected'} — dropping cached tag values`,
      )
    }
    lastSingletonConnected = singletonConnected

    const rings = !isNaN(subsystemId)
      ? db.prepare('SELECT * FROM NetworkRings WHERE SubsystemId = ?').all(subsystemId) as any[]
      : db.prepare('SELECT * FROM NetworkRings').all() as any[]

    for (const ring of rings) {
      ring.nodes = db.prepare('SELECT * FROM NetworkNodes WHERE RingId = ?').all(ring.id) as any[]
      for (const node of ring.nodes) {
        node.ports = db.prepare('SELECT * FROM NetworkPorts WHERE NodeId = ?').all(node.id) as any[]
      }
    }

    // Fallback: a port row may have a DeviceName but NULL StatusTag — this
    // happens when topology was seeded from CSV/older import without the
    // explicit fault-tag column. Default to <DeviceName>:I.ConnectionFaulted,
    // the standard Allen-Bradley EtherNet/IP module fault tag (VSU_SEW,
    // FIOM, POINT_IO, etc. all use this). Mutate the port object so the
    // response in `result` later picks up the resolved tag too.
    for (const ring of rings) {
      for (const node of ring.nodes) {
        for (const port of node.ports) {
          if (!port.StatusTag && port.DeviceName) {
            port.StatusTag = `${port.DeviceName}:I.ConnectionFaulted`
          }
        }
      }
    }

    // Bucket every StatusTag by its owning ring's SubsystemId. Rings whose
    // subsystem is a registry MCM read through the mode-aware typed batch
    // (embedded in-process, or the plc-gateway in PLC_MODE=remote); everything
    // else keeps the legacy singleton cached-read path (field tablets).
    const statusTags = new Set<string>()
    const registryTagsBySid = new Map<string, Set<string>>()
    const legacyTags = new Set<string>()
    const addTag = (ringSubsystemId: unknown, tag: string) => {
      statusTags.add(tag)
      const sid = ringSubsystemId != null ? String(ringSubsystemId) : ''
      if (sid && hasMcm(sid)) {
        const set = registryTagsBySid.get(sid) ?? new Set<string>()
        set.add(tag)
        registryTagsBySid.set(sid, set)
      } else {
        legacyTags.add(tag)
      }
    }
    for (const ring of rings) {
      if (ring.McmTag) addTag(ring.SubsystemId, ring.McmTag)
      for (const node of ring.nodes) {
        if (node.StatusTag) addTag(ring.SubsystemId, node.StatusTag)
        for (const port of node.ports) {
          if (port.StatusTag) addTag(ring.SubsystemId, port.StatusTag)
        }
      }
    }

    if (statusTags.size === 0) {
      return res.json({
        success: true,
        connected: singletonConnected,
        tags: {},
        asOf: null,
        ageMs: null,
        stale: false,
        degraded: false,
      })
    }

    const scope = isNaN(subsystemId) ? '__all__' : String(subsystemId)
    const entry = getScopeCache(scope)
    const now = Date.now()
    const age = entry.asOf === 0 ? Infinity : now - entry.asOf

    // Start a read only if the cached values are past the TTL AND the adaptive
    // cooldown has elapsed — the cooldown is what stops a slow controller from
    // being read back-to-back forever.
    const cooldown = Math.min(entry.lastDurationMs, MAX_COOLDOWN_MS)
    const dueForRefresh = age > Math.max(FRESH_TTL_MS, cooldown)

    if (entry.inFlight && now - entry.inFlightStartedAt > REFRESH_ABANDON_MS) {
      console.warn(
        `[NetworkStatus] Read for scope ${scope} has been in flight ${Math.round((now - entry.inFlightStartedAt) / 1000)}s — presumed wedged, allowing a new one.`,
      )
      entry.inFlight = null
    }

    if (dueForRefresh && !entry.inFlight) {
      // Kick off exactly one read; concurrent requests below await this same
      // promise instead of queueing more CIP traffic (single-flight).
      entry.inFlight = refreshScope(
        entry,
        { registryTagsBySid, legacyTags, singletonConnected },
        statusTags,
      )
    }

    if (entry.inFlight) {
      // Bounded wait. On timeout we answer from cache and leave the read
      // running — the request can never hang on the PLC.
      await settledWithin(entry.inFlight, entry.asOf === 0 ? COLD_WAIT_MS : WARM_WAIT_MS)
    }

    const servedAge = entry.asOf === 0 ? Infinity : Date.now() - entry.asOf
    const degraded = servedAge > MAX_SERVE_AGE_MS

    // Answer with the tags THIS request asked for, so a topology change never
    // leaks tags from a previous shape. A tag we have no reading for is null
    // (unknown), which is exactly what it is.
    const tags: Record<string, boolean | null> = {}
    for (const tag of Array.from(statusTags)) {
      tags[tag] = degraded ? null : (entry.values[tag] ?? null)
    }

    return res.json({
      success: true,
      // Past the safety ceiling we are not observing the ring at all, so we do
      // not claim the read path is connected — only what we can still say
      // without touching the PLC.
      connected: degraded ? singletonConnected : entry.connected,
      tags,
      asOf: entry.asOf === 0 ? null : entry.asOf,
      ageMs: Number.isFinite(servedAge) ? servedAge : null,
      stale: servedAge > FRESH_TTL_MS,
      degraded,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    return res.status(500).json({ success: false, error: message })
  }
}
