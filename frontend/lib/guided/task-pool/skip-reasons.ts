/**
 * Preset skip reasons (committee decision D9, Option B): the tester picks a
 * preset and may add an optional note — better reporting than free text.
 *
 * The stored reason string is `<preset>` or `<preset>: <note>` so the existing
 * GuidedTaskState contract (a single Reason column, ≤500 chars) is unchanged
 * and reporting can still aggregate on the preset head.
 */

export const SKIP_REASONS = [
  'Not installed',
  'Damaged',
  'Access blocked',
  '3rd-party dependency',
  'Out of scope',
  'Other',
] as const

export type SkipReason = (typeof SKIP_REASONS)[number]

/** Compose the stored reason from a preset + optional note. */
export function composeSkipReason(preset: SkipReason, note?: string): string {
  const n = (note ?? '').trim()
  // "Other" carries no information by itself — the note is the reason.
  if (preset === 'Other') return n
  return n ? `${preset}: ${n}` : preset
}
