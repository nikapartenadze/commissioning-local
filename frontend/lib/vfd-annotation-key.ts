/**
 * Key for the VFD Commissioning view's per-device blocked/addressed annotation
 * map — scoped by MCM, not by device name alone.
 *
 * The VFD tab intentionally aggregates VFD/APF devices from ALL subsystems/MCMs
 * into one grid (see fv-validation-view "VFD mode scopes by SHEET, not
 * subsystem"). Device names are only unique WITHIN an MCM — copy-templated L2
 * sheets reuse the same belt names across MCMs (e.g. two MCMs each have a
 * "BYCB_1_VFD"). Keying the annotation map by deviceName alone therefore lets
 * one MCM's blocker/addressed badge paint (or silently hide) another MCM's
 * same-named device — the cross-MCM leakage class already fixed once for live
 * STS reads. Both the annotation source (GET /api/vfd-commissioning/state,
 * per-row `mcm`) and the grid device rows (FVDevice.Mcm) carry the same
 * L2Devices.Mcm value, so scoping the key by MCM disambiguates them.
 *
 * A single-MCM tablet has one MCM (or blank Mcm on legacy rows) → no collision
 * either way; a multi-MCM central box has Mcm populated → correct isolation.
 */
export function vfdAnnotationKey(mcm: string | null | undefined, deviceName: string): string {
  return `${(mcm ?? '').trim()}::${(deviceName ?? '').trim()}`
}
