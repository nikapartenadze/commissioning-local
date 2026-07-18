/**
 * Extra manual-pull sections — the cloud→field data classes that
 * runConfigSidePulls does NOT cover, so that pressing "Pull IOs from Cloud"
 * refreshes ALL of them and not just IO / network / estop / safety / punchlist.
 *
 * Covered here (each subsystem-scoped by ARGUMENT, never by ambient config):
 *   - VFD blockers   (lib/cloud/vfd-blockers-pull)   — importable helper
 *   - VFD addressed  (lib/cloud/vfd-addressed-pull)  — importable helper
 *   - Roadmap        (POST /api/cloud/pull-roadmap)  — HTTP self-call
 *   - MCM diagram    (POST /api/cloud/pull-mcm-diagram) — HTTP self-call
 *
 * The roadmap / mcm-diagram routes own the cloud fetch + DB write and now honor
 * a `subsystemId` in the POST body (falling back to the ambient config), so the
 * self-calls target the exact MCM being pulled — critical on a central /
 * multi-MCM tool where the ambient config subsystem is a different MCM. The
 * self-call pattern mirrors pull-core's pullL2SelfCall.
 *
 * Change requests are intentionally NOT here: their status pull-back is keyed by
 * cloud id (not subsystem-scoped) and already refreshes via auto-sync's
 * pullFromCloud, so folding it into the per-MCM manual pull would be both
 * mis-scoped and redundant.
 *
 * Every section is independent and best-effort: a failure yields 0 for that
 * section and never aborts the others (mirrors runConfigSidePulls). All deps are
 * injectable so this composes without booting the DB or the HTTP server in tests.
 */

type CloudCfg = { remoteUrl?: string | null; apiPassword?: string | null }
type SectionPull = (subsystemId: number, config: CloudCfg) => Promise<number>

export interface ExtraSectionsResult {
  vfdBlockersPulled: number
  vfdAddressedPulled: number
  roadmapPulled: number
  mcmDiagramPulled: number
}

export interface ExtraSectionsDeps {
  pullVfdBlockers?: SectionPull
  pullVfdAddressed?: SectionPull
  pullRoadmap?: SectionPull
  pullMcmDiagram?: SectionPull
}

async function roadmapSelfCall(subsystemId: number): Promise<number> {
  const port = process.env.PORT || '3000'
  const res = await fetch(`http://127.0.0.1:${port}/api/cloud/pull-roadmap`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ subsystemId }),
    signal: AbortSignal.timeout(30_000),
  })
  const data = (await res.json().catch(() => ({}))) as { count?: number }
  return res.ok ? data.count || 0 : 0
}

async function mcmDiagramSelfCall(subsystemId: number): Promise<number> {
  const port = process.env.PORT || '3000'
  const res = await fetch(`http://127.0.0.1:${port}/api/cloud/pull-mcm-diagram`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ subsystemId }),
    signal: AbortSignal.timeout(30_000),
  })
  const data = (await res.json().catch(() => ({}))) as { updated?: boolean }
  return res.ok && data.updated ? 1 : 0
}

export async function pullExtraSections(
  subsystemId: number,
  remoteUrl: string,
  apiPassword: string,
  deps: ExtraSectionsDeps = {},
): Promise<ExtraSectionsResult> {
  const cfg: CloudCfg = { remoteUrl, apiPassword }
  // `??` keeps the right side lazy: when a dep is injected (tests), the default
  // — a dynamic import of a DB-coupled module, or an HTTP self-call — never runs.
  const vfdBlockers = deps.pullVfdBlockers ?? (await import('@/lib/cloud/vfd-blockers-pull')).pullVfdBlockers
  const vfdAddressed = deps.pullVfdAddressed ?? (await import('@/lib/cloud/vfd-addressed-pull')).pullVfdAddressed
  const roadmap = deps.pullRoadmap ?? ((sid: number) => roadmapSelfCall(sid))
  const mcmDiagram = deps.pullMcmDiagram ?? ((sid: number) => mcmDiagramSelfCall(sid))

  const settle = async (fn: () => Promise<number>): Promise<number> => {
    try { return await fn() } catch { return 0 }
  }

  const [vfdBlockersPulled, vfdAddressedPulled, roadmapPulled, mcmDiagramPulled] = await Promise.all([
    settle(() => vfdBlockers(subsystemId, cfg)),
    settle(() => vfdAddressed(subsystemId, cfg)),
    settle(() => roadmap(subsystemId, cfg)),
    settle(() => mcmDiagram(subsystemId, cfg)),
  ])

  return { vfdBlockersPulled, vfdAddressedPulled, roadmapPulled, mcmDiagramPulled }
}
