/**
 * Pure device-discovery: turn what we know about the network into a deduped
 * list of CIP nodes to probe for their Identity Object.
 *
 * Phase-1 reachability without a program export:
 *   - the controller (its configured connection path),
 *   - Ethernet bridge modules whose name encodes a backplane slot
 *     (SLOTn_EN4TR/EN2TR — same convention as network/dlr.ts#deriveDlrPath),
 *   - the DLR ring supervisor (if a path is configured),
 *   - a best-effort blind backplane slot scan.
 *
 * Networked drives/IO behind those bridges need their full routing path, which
 * comes from the program export later. That export feeds in via `explicitTargets`
 * — the same probe list, no rewrite.
 *
 * Side-effect-free; unit-tested in __tests__/firmware-discovery.test.ts.
 */

/** A single CIP node to probe: a display label + its libplctag routing path. */
export interface ProbeTarget {
  label: string
  /** Routing path passed to libplctag, e.g. "1,0" or "1,2,A,192.168.1.50,1,0". */
  path: string
}

export interface DiscoveryInput {
  /** Controller connection path from config (e.g. "1,0"). */
  controllerPath: string
  /** Device names discovered by the network poller (SLOTn_ENxTR, VFDs, …). */
  discoveredDeviceNames?: readonly string[]
  /** Backplane path to the DLR supervisor, if configured/derived. */
  dlrSupervisorPath?: string
  /** Explicit device→path targets (the program-export seam). */
  explicitTargets?: readonly ProbeTarget[]
  /**
   * Blind backplane slot scan. `{ port, maxSlot }` probes `<port>,0` …
   * `<port>,maxSlot`. Pass `null` to disable (e.g. in tests, or when the
   * discovered/explicit targets are known to be complete).
   */
  backplaneSlotScan?: { port: number; maxSlot: number } | null
}

/** Default blind scan: backplane port 1, slots 0..13 (covers typical chassis). */
export const DEFAULT_SLOT_SCAN = { port: 1, maxSlot: 13 } as const

const SLOT_RE = /(?:^|_)SLOT(\d+)_EN[24]TR/i

/**
 * Derive a backplane routing path ("1,n") from a device name that encodes a
 * slot, e.g. "SLOT2_EN4TR_NN" → "1,2". Returns null when the name carries no
 * slot (a remote drive/DPM — needs an explicit path).
 */
export function slotPathForDevice(name: string): string | null {
  const m = SLOT_RE.exec(name)
  return m ? `1,${parseInt(m[1], 10)}` : null
}

/**
 * Build the deduped probe list. Order of precedence (first to claim a path
 * keeps its label): controller → named slot modules → DLR supervisor →
 * explicit targets → blind slot scan. Dedup is by exact path string, so a
 * named module always wins over an anonymous "Slot n" scan entry.
 */
export function buildProbeList(input: DiscoveryInput): ProbeTarget[] {
  const out: ProbeTarget[] = []
  const seen = new Set<string>()
  const add = (label: string, path: string) => {
    if (seen.has(path)) return
    seen.add(path)
    out.push({ label, path })
  }

  add('Controller', input.controllerPath)

  for (const name of input.discoveredDeviceNames ?? []) {
    const p = slotPathForDevice(name)
    if (p) add(name, p)
  }

  if (input.dlrSupervisorPath) add('DLR supervisor', input.dlrSupervisorPath)

  for (const t of input.explicitTargets ?? []) add(t.label, t.path)

  const scan = input.backplaneSlotScan === undefined ? DEFAULT_SLOT_SCAN : input.backplaneSlotScan
  if (scan) {
    for (let slot = 0; slot <= scan.maxSlot; slot++) add(`Slot ${slot}`, `${scan.port},${slot}`)
  }

  return out
}
