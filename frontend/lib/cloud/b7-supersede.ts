/**
 * B7 reconcile — "is this stuck pending row genuinely SUPERSEDED by a newer
 * pending row?" — op-kind-aware.
 *
 * A pending push carries exactly ONE field forward depending on its op kind:
 *  - a RESULT op   (Passed / Failed / Cleared)                 → carries the test result
 *  - a COMMENT op  (Comment Added/Modified/Removed/Updated)    → carries only the comment
 *
 * The B7 reconcile deletes a stuck row when a NEWER active pending row exists
 * for the same IO ("superseded — the newer row carries the value"). That is only
 * true when the newer row is the SAME KIND: a newer comment-only row does NOT
 * carry a stuck test RESULT (and a newer result row does not carry a stuck
 * comment). Deleting a stuck result row because a comment-only edit came after
 * it silently LOSES the result — it never reaches the cloud. So match kinds
 * before superseding; a row that is NOT superseded falls through to the rebase
 * branch, which re-validates it against the live Ios value and re-pushes it if
 * it is still the local truth.
 */

/** True for the comment-only op kinds (Comment Added/Modified/Removed/Updated). */
export function isCommentOp(testResult: string | null | undefined): boolean {
  return /comment/i.test(testResult || '')
}

/**
 * True when at least one of `newerOps` is the SAME op kind as `stuckOp` — i.e.
 * a newer pending row that actually carries the same field forward, so the
 * stuck row is genuinely obsolete and safe to drop. Returns false when the only
 * newer rows are a different kind (their push would not carry the stuck row's
 * field, so dropping it would lose that field).
 */
export function isSupersededBySameKind(
  stuckOp: string | null | undefined,
  newerOps: ReadonlyArray<string | null | undefined>,
): boolean {
  const stuckIsComment = isCommentOp(stuckOp)
  return newerOps.some((op) => isCommentOp(op) === stuckIsComment)
}
