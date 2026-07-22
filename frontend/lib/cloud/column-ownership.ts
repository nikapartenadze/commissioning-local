/**
 * L2 column OWNERSHIP — which side of the sync owns a column's VALUES.
 *
 * The two-layer model (see pull-l2/route.ts) says: the cloud owns STRUCTURE,
 * the FIELD owns VALUES. Every cloud→field L2 path therefore refuses to apply
 * an EMPTY incoming value, because a blank arriving from the cloud is normally
 * just "the cloud has no opinion yet" — applying it would blank operator-entered
 * test data. That protection is correct for operator columns and WRONG for the
 * handful of columns the CLOUD authors.
 *
 * "Belt Tracked" is cloud-authored end to end: mech ticks it on the cloud
 * belt-tracking page, it syncs DOWN, and the field wizard/PLC writer reads it
 * ('Yes' ⇒ assert Tracking_Finished). Track syncing down but UNTRACK not
 * syncing down is an asymmetry with teeth: on 2026-07-22 a coordinator untracked
 * belts at 12:37 (cloud wrote value=''), every tablet discarded the empty value,
 * kept asserting Tracking_Finished into the PLC, and mechanics could not change
 * belt direction from the keypad for four hours. For a cloud-owned column an
 * EMPTY cloud value is a real instruction — "clear this" — not missing data.
 *
 * Ownership is asked ONE way, here, so the three cloud→field L2 sites (pull,
 * live SSE, and the orphan reconciler that would otherwise push the stale local
 * value back UP and re-track the belt) can never drift apart. Today ownership is
 * decided by column NAME; when the cloud grows a real per-column ownership flag,
 * replace this function's BODY and every call site keeps working unchanged.
 */

/**
 * Cloud-owned column names, lower-cased for case-insensitive matching.
 *
 * PINNED to the writer's constant at the TYPE level on purpose: a plain runtime
 * `import { BELT_TRACKED_COLUMN_NAME } from '@/lib/vfd-validation-writer'` would
 * drag that module's static `@/lib/plc` libplctag FFI import into the pull route,
 * the SSE client and the reconciler — which is exactly why the pull route loads
 * the writer via `await import()` instead. `typeof import(...)` is erased at
 * compile time, so this costs nothing at runtime while still failing `tsc` if
 * the writer ever renames the column.
 */
const BELT_TRACKED_COLUMN_NAME: typeof import('@/lib/vfd-validation-writer')['BELT_TRACKED_COLUMN_NAME'] = 'Belt Tracked'

const CLOUD_OWNED_COLUMN_NAMES: ReadonlySet<string> = new Set([
  BELT_TRACKED_COLUMN_NAME.toLowerCase(),
])

/**
 * True when the cloud — not the field operator — owns this column's value.
 *
 * Call sites use it to mean: an EMPTY value arriving from the cloud is
 * authoritative and MUST clear the local cell, instead of being skipped by the
 * "never blank operator data" guard.
 *
 * Unknown / missing column names are treated as FIELD-owned (the safe default:
 * keep the operator's data).
 */
export function isCloudOwnedColumn(columnName: string | null | undefined): boolean {
  if (columnName == null) return false
  return CLOUD_OWNED_COLUMN_NAMES.has(String(columnName).trim().toLowerCase())
}
