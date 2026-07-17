/**
 * Pure summary of the unified parked-queue rows for the Cloud Sync dialog.
 *
 * The dialog previously showed only an FV-only list from an ad-hoc endpoint, so
 * it never matched the toolbar's red badge (which counts IO + FV + blocker +
 * e-stop + guided). This groups the unified /api/sync/queue?status=parked rows
 * by kind for a concise "what's stuck" header, so the modal reflects the same
 * truth as Sync Center + the badge.
 */
export const PARKED_KIND_LABEL: Record<string, string> = {
  io: 'I/O',
  l2: 'FV',
  blocker: 'VFD blocker',
  estop: 'E-stop',
  guided: 'Guided',
}

export function summarizeParked(
  items: ReadonlyArray<{ kind: string }>,
): { total: number; byKind: Record<string, number>; summaryLine: string } {
  const byKind: Record<string, number> = {}
  for (const it of items) byKind[it.kind] = (byKind[it.kind] ?? 0) + 1
  const summaryLine = Object.entries(byKind)
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `${n} ${PARKED_KIND_LABEL[k] ?? k}`)
    .join(' · ')
  return { total: items.length, byKind, summaryLine }
}
