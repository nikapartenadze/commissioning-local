/**
 * Key for the VFD Commissioning view's per-device blocked/addressed annotation
 * map — scoped by the owning subsystem, not by device name alone.
 *
 * Device names are only unique WITHIN an MCM — copy-templated L2 sheets reuse
 * the same belt names across MCMs (e.g. two MCMs each have a "BYCB_1_VFD").
 * Keying the annotation map by deviceName alone lets one MCM's blocker/addressed
 * badge paint (or silently hide) another MCM's same-named device.
 *
 * The scope is SubsystemId, not the Mcm label. The label is not unique: a box
 * carrying rows from two projects has two distinct subsystems both labelled
 * "MCM02" (ids 38 and 79 on CDW5), so an Mcm-keyed map still collides between
 * them. SubsystemId is the identity the blocker/addressed mirrors are keyed on
 * cloud-side, so matching on it end-to-end is what makes the merge correct.
 *
 * Legacy rows with no SubsystemId (single-MCM tablets, pre-migration) fall back
 * to the Mcm label so nothing stops matching before a scoped pull re-stamps
 * them; on such a box there is one MCM and no collision either way.
 */
export function vfdAnnotationKey(
  subsystemId: number | null | undefined,
  mcm: string | null | undefined,
  deviceName: string,
): string {
  const scope =
    typeof subsystemId === 'number' && Number.isFinite(subsystemId) && subsystemId > 0
      ? String(subsystemId)
      : (mcm ?? '').trim()
  return `${scope}::${(deviceName ?? '').trim()}`
}
