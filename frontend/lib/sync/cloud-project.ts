import { getSyncFlag, setSyncFlag } from '@/lib/sync/backlog-readjudication'

/**
 * WHICH CLOUD PROJECT DOES THIS TABLET'S WORK BELONG TO?
 *
 * The heartbeat's held-back telemetry reports a `projectId` per queue row so the
 * cloud can attribute stuck field work to the right project EXACTLY, instead of
 * inferring it from `tool_instances.current_project_id` (which is simply wrong
 * for every row queued before an operator switched projects mid-day).
 *
 * WHY NOT `Subsystems.ProjectId` — IT IS NOT THE CLOUD'S PROJECT ID
 *
 * The local schema has Projects/Subsystems with a real FK, so it LOOKS like the
 * join exists. It does not. The only live writer is pull-core.ts, which does:
 *
 *     INSERT INTO Projects (id, Name) VALUES (1, 'Default Project')
 *     INSERT INTO Subsystems (id, ProjectId, Name) VALUES (?, 1, ?)
 *
 * — ProjectId is the literal 1 for every subsystem on every tablet ever synced.
 * (app/api/cloud/pull/route.ts prepares a parameterised insertProject/
 * insertSubsystem pair that WOULD carry a real id, but nothing calls them.)
 * Shipping that column as `projectId` would hand the cloud a confidently-wrong
 * answer, which is strictly worse than the inference it was meant to replace:
 * the cloud cannot tell a real id from a placeholder 1, and project 1 is a real
 * project on the cloud. So the local join is not used at all.
 *
 * THE ONE TRUTHFUL SOURCE
 *
 * The cloud itself answers it: GET /api/sync/subsystems, authenticated with the
 * tablet's per-project X-API-Key, replies { projectId, projectName, ... }. That
 * is the project the key actually unlocks — determined by the cloud, not guessed
 * locally. We bank it the moment any existing caller observes it. No new network
 * traffic is introduced; this only remembers an answer already being fetched.
 *
 * THE BINDING WINDOW — WHY A TIMESTAMP IS PART OF THE TRUTH
 *
 * A tablet holds ONE API key, so it knows ONE project at a time. Re-keying it to
 * a different project would silently re-label every row already sitting in the
 * queue — the exact mid-day-switch bug this telemetry exists to eliminate, just
 * moved one layer down. So the bound-at instant is stored alongside the id and
 * RESET whenever the observed id changes. A queue row created before the current
 * binding began is reported as projectId: null — genuinely unknown — never as
 * the current project. Under-claiming is recoverable; mis-attribution is not.
 *
 * The complete fix is to stamp the project onto each queue row at enqueue time
 * (an additive nullable column on the five *PendingSyncs tables). That is not
 * done here. Until it is, the binding window is what keeps every non-null
 * `projectId` this module emits sound.
 */

/** SyncMaintenanceFlags keys. Both hold opaque scalars — never field data. */
const FLAG_PROJECT_ID = 'cloud_project_id'
const FLAG_PROJECT_BOUND_AT = 'cloud_project_bound_at'

export interface CloudProjectBinding {
  /** Cloud project id the configured API key resolves to; null until observed. */
  projectId: number | null
  /**
   * ISO instant this binding was first observed. Queue rows created BEFORE it
   * cannot be attributed to `projectId` and must report null.
   */
  boundAt: string | null
}

/**
 * Remember the cloud project id reported by /api/sync/subsystems.
 *
 * Idempotent for a stable key: re-observing the same id leaves the bound-at
 * instant alone, so the attributable window keeps growing backwards-compatibly.
 * Observing a DIFFERENT id means the tablet was re-keyed to another project —
 * the window restarts from now, and every row older than that instant drops to
 * unattributed rather than being silently relabelled.
 *
 * Never throws: called from cloud fetch paths that must not fail on telemetry.
 */
export function noteCloudProjectId(projectId: unknown): void {
  const id = Number(projectId)
  if (!Number.isInteger(id) || id <= 0) return
  try {
    const current = getSyncFlag(FLAG_PROJECT_ID)
    if (current === String(id) && getSyncFlag(FLAG_PROJECT_BOUND_AT)) return
    setSyncFlag(FLAG_PROJECT_ID, String(id))
    setSyncFlag(FLAG_PROJECT_BOUND_AT, new Date().toISOString())
    if (current != null && current !== String(id)) {
      console.log(
        `[CloudProject] API key now resolves to project ${id} (was ${current}) — ` +
          'queue rows older than this instant are reported as unattributed',
      )
    }
  } catch {
    // Telemetry bookkeeping only. Never break a cloud fetch over it.
  }
}

/** The banked binding. Both fields null on a tablet that has never observed one. */
export function getCloudProjectBinding(): CloudProjectBinding {
  try {
    const raw = getSyncFlag(FLAG_PROJECT_ID)
    const id = raw == null ? NaN : Number(raw)
    return {
      projectId: Number.isInteger(id) && id > 0 ? id : null,
      boundAt: getSyncFlag(FLAG_PROJECT_BOUND_AT),
    }
  } catch {
    return { projectId: null, boundAt: null }
  }
}

/**
 * Attribute one queue row, given its CreatedAt.
 *
 * Returns the banked project id ONLY when the row demonstrably belongs to the
 * current binding. Unparseable or missing timestamps return null: a row whose
 * age we cannot establish is a row whose project we cannot establish.
 *
 * Accepts both stored shapes — ISO ('2026-07-22T10:00:00.000Z') and SQLite
 * datetime('now') ('2026-07-22 10:00:00', UTC, no zone marker) — because both
 * are written by different repositories and they do not compare as strings.
 */
export function attributeProjectId(
  createdAt: string | null | undefined,
  binding: CloudProjectBinding,
): number | null {
  if (binding.projectId == null) return null
  if (!binding.boundAt) return null
  const created = parseUtc(createdAt)
  const bound = Date.parse(binding.boundAt)
  if (created == null || !Number.isFinite(bound)) return null
  return created >= bound ? binding.projectId : null
}

/** Parse either stored timestamp shape as UTC. Returns null if unreadable. */
function parseUtc(value: string | null | undefined): number | null {
  if (!value) return null
  let s = String(value).trim()
  if (!s) return null
  if (!s.includes('T') && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(s)) s = s.replace(' ', 'T')
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(s) && !/[zZ]|[+-]\d{2}:?\d{2}$/.test(s)) s += 'Z'
  const t = Date.parse(s)
  return Number.isNaN(t) ? null : t
}
