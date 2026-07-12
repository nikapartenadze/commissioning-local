/**
 * AutoSync telemetry pushers (extracted from auto-sync.ts, behavior-neutral).
 *
 * The ~5s network/estop status pushers + the 60s network-diagnostics pusher.
 * These push live PLC tag booleans / diagnostics batches UP to the cloud and
 * carry NO sync-queue or pull state — the only per-run state they touch is a
 * re-entrancy guard, threaded in via `TelemetryState` so each AutoSyncService
 * instance keeps its own guard (identical to the former private booleans).
 *
 * Behavior is preserved exactly: same config gates, same central/multi-MCM vs
 * legacy single-MCM paths, same disconnected-clobber guards, same endpoints,
 * timeouts, and best-effort error swallowing.
 */

import { db } from '@/lib/db-sqlite'
import { configService } from '@/lib/config'
import { resolveActiveMcms } from '@/lib/cloud/active-mcms'
import { getMcmStatus, getEmbeddedMcmConnection } from '@/lib/mcm-registry'

/** Per-instance re-entrancy guards for the telemetry pushers. */
export interface TelemetryState {
  isPushingNetworkStatus: boolean
  isPushingEstopStatus: boolean
  isPushingNetworkDiagnostics: boolean
}

export async function pushNetworkStatus(state: TelemetryState): Promise<void> {
  if (state.isPushingNetworkStatus) return
  state.isPushingNetworkStatus = true

  try {
    const config = await configService.getConfig()
    const remoteUrl = config.remoteUrl
    const apiPassword = config.apiPassword
    if (!remoteUrl) return

    // ── Central / multi-MCM reporting (2026-06-16 MCM11 incident) ────────
    // The legacy path below only ever reported config.subsystemId via the
    // in-process SINGLETON PLC client. On a central server that (a) runs
    // PLC_MODE=remote (no in-process client at all → singleton.isConnected
    // is always false) and (b) hosts many MCMs, every MCM showed
    // disconnected ("Red") in the cloud even while live. Report each active
    // MCM's OWN state from the mode-agnostic registry status (which reflects
    // the gateway-polled cache in REMOTE mode and the live clients in
    // embedded mode). Guarded so single-MCM tablets are untouched.
    const { active, remoteMode, centralMode } = await resolveActiveMcms()

    if (centralMode && active.length >= 1) {
      for (const m of active) {
        const sid = m.subsystemId
        const sidNum = parseInt(sid, 10)
        if (!Number.isFinite(sidNum)) continue
        // Mode-agnostic per-MCM connection state.
        let connected = getMcmStatus(sid)?.connected ?? false
        // Embedded-mode tags (and a singleton fallback for the configured
        // subsystem) — in REMOTE mode tag values live in the gateway, so we
        // report the connection flag with empty tags (still flips the MCM
        // green; far better than the old all-Red behavior).
        let tags: Record<string, boolean | null> = {}
        if (!remoteMode) {
          const conn = getEmbeddedMcmConnection(sid)
          if (conn) {
            connected = true
            tags = readNetworkTags(sidNum, conn.client)
          }
        }
        // Disconnected-clobber guard (2026-07-08 audit — parity with estop):
        // never push a disconnected/empty status — it would overwrite live
        // data from another tool that IS connected to this MCM. The cloud
        // greys NET by staleness on its own.
        if (!connected) continue
        await postNetworkStatus(remoteUrl, apiPassword, sidNum, connected, tags)
      }
      return
    }

    // ── Legacy single-MCM (singleton) path — unchanged behavior ──────────
    const subsystemId = config.subsystemId
    if (!subsystemId) return

    let connected = false
    let tags: Record<string, boolean | null> = {}
    try {
      const { hasPlcClient, getPlcClient } = await import('@/lib/plc-client-manager')
      if (hasPlcClient() && getPlcClient().isConnected) {
        connected = true
        tags = readNetworkTags(parseInt(String(subsystemId), 10), getPlcClient())
      }
    } catch {
      // PLC not available — skip push (see guard below)
    }

    // Disconnected-clobber guard (2026-07-08 audit — parity with estop):
    // pushing connected=false would overwrite live data from another tool
    // instance that IS connected to the same subsystem. Skip; the cloud
    // greys NET by staleness on its own.
    if (!connected) return

    await postNetworkStatus(
      remoteUrl,
      apiPassword,
      parseInt(String(subsystemId), 10),
      connected,
      tags,
    )
  } catch {
    // Network status push is best-effort — don't log noise
  } finally {
    state.isPushingNetworkStatus = false
  }
}

/** Read every network StatusTag value for a subsystem from a connected client. */
function readNetworkTags(
  subsystemIdNum: number,
  client: { readTagCached: (name: string) => boolean | null },
): Record<string, boolean | null> {
  const tags: Record<string, boolean | null> = {}
  const rings = db.prepare('SELECT * FROM NetworkRings WHERE SubsystemId = ?').all(subsystemIdNum) as any[]
  for (const ring of rings) {
    if (ring.McmTag) tags[ring.McmTag] = client.readTagCached(ring.McmTag)
    const nodes = db.prepare('SELECT * FROM NetworkNodes WHERE RingId = ?').all(ring.id) as any[]
    for (const node of nodes) {
      if (node.StatusTag) tags[node.StatusTag] = client.readTagCached(node.StatusTag)
      const ports = db.prepare('SELECT * FROM NetworkPorts WHERE NodeId = ?').all(node.id) as any[]
      for (const port of ports) {
        if (port.StatusTag) tags[port.StatusTag] = client.readTagCached(port.StatusTag)
      }
    }
  }
  return tags
}

/** POST one subsystem's live network status to the cloud (best-effort). */
async function postNetworkStatus(
  remoteUrl: string,
  apiPassword: string | undefined,
  subsystemId: number,
  connected: boolean,
  tags: Record<string, boolean | null>,
): Promise<void> {
  try {
    await fetch(`${remoteUrl}/api/sync/network-status`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': apiPassword || '',
      },
      body: JSON.stringify({
        subsystemId,
        connected,
        tags,
        timestamp: new Date().toISOString(),
      }),
      signal: AbortSignal.timeout(5000),
    })
  } catch {
    // best-effort — don't log noise
  }
}

export async function pushEstopStatus(state: TelemetryState): Promise<void> {
  if (state.isPushingEstopStatus) return
  state.isPushingEstopStatus = true

  try {
    const config = await configService.getConfig()
    const remoteUrl = config.remoteUrl
    const apiPassword = config.apiPassword
    if (!remoteUrl) return

    // ── Central / multi-MCM reporting (2026-06-16 MCM11 incident) ────────
    // Mirrors pushNetworkStatus(): the legacy path below only ever reported
    // config.subsystemId via the in-process SINGLETON PLC client, reading
    // EStopZones UNSCOPED. On a central server (PLC_MODE=remote → no
    // singleton, singleton.isConnected always false; and N hosted MCMs) the
    // disconnected-status guard short-circuited and pushed NOTHING, so every
    // MCM read "Red" in the cloud even while live. Report each active MCM's
    // OWN estop state, scoped to its subsystem, from the mode-agnostic
    // registry. Guarded so single-MCM tablets are untouched.
    const { active, remoteMode, centralMode } = await resolveActiveMcms()

    if (centralMode && active.length >= 1) {
      for (const m of active) {
        const sid = m.subsystemId
        const sidNum = parseInt(sid, 10)
        if (!Number.isFinite(sidNum)) continue
        // Mode-agnostic per-MCM connection state.
        let connected = getMcmStatus(sid)?.connected ?? false
        // Embedded-mode tags (and a singleton fallback is unnecessary here —
        // the registry owns every MCM on a central server). In REMOTE mode
        // estop tag values live in the gateway, so we report the connection
        // flag with empty tags (still flips the MCM out of all-Red).
        let tags: Record<string, boolean | null> = {}
        if (!remoteMode) {
          const conn = getEmbeddedMcmConnection(sid)
          if (conn) {
            connected = true
            tags = readEstopTags(sidNum, conn.client)
          }
        }
        // Preserve the per-MCM "don't push disconnected status" intent — a
        // disconnected push would clobber live data from a tool that IS
        // connected to this MCM.
        if (!connected) continue
        await postEstopStatus(remoteUrl, apiPassword, sidNum, connected, tags)
      }
      return
    }

    // ── Legacy single-MCM (singleton) path — unchanged behavior ──────────
    const subsystemId = config.subsystemId
    if (!subsystemId) return

    // Only push estop status when PLC is actually connected.
    // If PLC is not connected, skip entirely — avoids overwriting
    // live data from another tool instance on the same subsystem.
    let connected = false
    let tags: Record<string, boolean | null> = {}

    try {
      const { hasPlcClient, getPlcClient } = await import('@/lib/plc-client-manager')
      if (hasPlcClient() && getPlcClient().isConnected) {
        connected = true
        // Read estop tags scoped to the configured subsystem.
        tags = readEstopTags(parseInt(String(subsystemId), 10), getPlcClient())
      }
    } catch {
      // PLC not available — skip push
    }

    // Don't send disconnected status to cloud — it would overwrite
    // live data from a tool that IS connected to the PLC
    if (!connected) return

    await postEstopStatus(
      remoteUrl,
      apiPassword,
      parseInt(String(subsystemId), 10),
      connected,
      tags,
    )
  } catch {
    // Estop status push is best-effort — don't log noise
  } finally {
    state.isPushingEstopStatus = false
  }
}

/**
 * Read every EStop status tag for ONE subsystem from a connected client.
 * Scoped via EStopZones.SubsystemId so a central server reads only the
 * MCM's own zones → epcs → ioPoints/vfds/relatedEpcs (the legacy path read
 * EStopZones unscoped, which on multi-MCM mixed every MCM's tags together).
 */
function readEstopTags(
  subsystemIdNum: number,
  client: { readTagCached: (name: string) => boolean | null },
): Record<string, boolean | null> {
  const tags: Record<string, boolean | null> = {}
  const zones = db.prepare('SELECT * FROM EStopZones WHERE SubsystemId = ?').all(subsystemIdNum) as any[]

  for (const zone of zones) {
    // Zone-level <ZONE>_Nominal_OK — the single bit the cloud needs to
    // roll a zone (and the whole MCM) up to nominal/fault. The DB zone
    // Name carries the MCM prefix (MCM02_ZONE_01_01) for grouping, but
    // the PLC tag lives at controller scope as ZONE_01_01_Nominal_OK,
    // so strip the leading MCM##_ to match what's on the PLC. Same
    // derivation as app/api/estop/status/route.ts.
    const zm = /^([A-Z]+\d+)_(.+)$/.exec(zone.Name)
    const zoneLabel = zm ? zm[2] : zone.Name
    const nominalOkTag = `${zoneLabel}_Nominal_OK`
    tags[nominalOkTag] = client.readTagCached(nominalOkTag)

    const epcs = db.prepare('SELECT * FROM EStopEpcs WHERE ZoneId = ?').all(zone.id) as any[]
    for (const epc of epcs) {
      if (epc.CheckTag) tags[epc.CheckTag] = client.readTagCached(epc.CheckTag)

      const ioPoints = db.prepare('SELECT * FROM EStopIoPoints WHERE EpcId = ?').all(epc.id) as any[]
      for (const ioPoint of ioPoints) {
        if (ioPoint.Tag) tags[ioPoint.Tag] = client.readTagCached(ioPoint.Tag)
      }

      const vfds = db.prepare('SELECT * FROM EStopVfds WHERE EpcId = ?').all(epc.id) as any[]
      for (const vfd of vfds) {
        if (vfd.StoTag) tags[vfd.StoTag] = client.readTagCached(vfd.StoTag)
      }

      // 2026 Zone Matrix: include the cross-EPC dependency tags
      // (ESTOPs_Must_Drop / ESTOPs_Must_Stay_OK) so the cloud
      // view can render their live state. Guarded for older
      // databases that don't yet have the table.
      try {
        const related = db.prepare('SELECT * FROM EStopRelatedEpcs WHERE EpcId = ?').all(epc.id) as any[]
        for (const rel of related) {
          if (rel.Tag) tags[rel.Tag] = client.readTagCached(rel.Tag)
        }
      } catch { /* table absent on pre-migration DBs */ }
    }
  }
  return tags
}

/** POST one subsystem's live EStop status to the cloud (best-effort). */
async function postEstopStatus(
  remoteUrl: string,
  apiPassword: string | undefined,
  subsystemId: number,
  connected: boolean,
  tags: Record<string, boolean | null>,
): Promise<void> {
  try {
    await fetch(`${remoteUrl}/api/sync/estop-status`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': apiPassword || '',
      },
      body: JSON.stringify({
        subsystemId,
        connected,
        tags,
        timestamp: new Date().toISOString(),
      }),
      signal: AbortSignal.timeout(5000),
    })
  } catch {
    // best-effort — don't log noise
  }
}

/**
 * Push the latest UDT_NETWORK_NODE_DATA snapshot batch to the cloud
 * (commissioning-cloud /api/sync/network-diagnostics). Used by the cloud
 * network page's Diagnostics modal to show the same per-port view the
 * local tool has. Runs once a minute; skips silently when:
 *   - cloud isn't configured (no remoteUrl / subsystemId)
 *   - the PLC isn't connected (no snapshots in the cache)
 *   - the network poller is disabled (snapshots map stays empty)
 *
 * Stale cleanup: getLatestNetworkDeviceSnapshots() already filters out
 * snapshots older than STALE_SNAPSHOT_MS (60s) at the poller layer, so
 * a dead device won't keep being shipped to cloud after the PLC restarts.
 */
export async function pushNetworkDiagnostics(state: TelemetryState): Promise<void> {
  if (state.isPushingNetworkDiagnostics) return
  state.isPushingNetworkDiagnostics = true

  try {
    const config = await configService.getConfig()
    const remoteUrl = config.remoteUrl
    const apiPassword = config.apiPassword
    if (!remoteUrl) return

    // ── Central / multi-MCM reporting (2026-06-16 MCM11 incident) ────────
    // Mirrors pushNetworkStatus()/pushEstopStatus(): the legacy path below
    // only ever reported config.subsystemId via the in-process SINGLETON
    // (getLatestNetworkDeviceSnapshots()), so on a central server hosting N
    // MCMs the cloud Diagnostics modal showed data for at most one MCM. Use
    // the registry's getAllNetworkSnapshots() — each snapshot is decorated
    // with its owning `subsystemId` — group by subsystem, and POST one batch
    // per subsystem. Guarded so single-MCM tablets are untouched.
    const { active, remoteMode, centralMode } = await resolveActiveMcms()

    // Controller Identity folded into the batch so the cloud's fleet firmware
    // compliance sees the PLC itself (not a network node). Cached after the
    // first read → no recurring CIP load. Tagged isController so the cloud's
    // per-port topology view filters it out.
    const { getControllerPushSnapshots } = await import('@/lib/plc/identity/firmware-service')

    if (centralMode) {
      const { getAllNetworkSnapshots } = await import('@/lib/mcm-registry')
      const all = getAllNetworkSnapshots()
      const allArr = Array.isArray(all) ? all : []
      const controllerSnaps = await getControllerPushSnapshots()
      if (allArr.length === 0 && controllerSnaps.length === 0) return

      // Group snapshots by their decorated subsystemId.
      const bySubsystem = new Map<number, any[]>()
      const addToSubsystem = (sidNum: number, rest: any) => {
        const list = bySubsystem.get(sidNum)
        if (list) list.push(rest)
        else bySubsystem.set(sidNum, [rest])
      }
      for (const snap of allArr) {
        const sidNum = parseInt(String(snap.subsystemId), 10)
        if (!Number.isFinite(sidNum)) continue
        // Strip the routing-only `subsystemId` field — the cloud receives it
        // as the top-level batch key, not per-snapshot.
        const { subsystemId: _drop, ...rest } = snap
        addToSubsystem(sidNum, rest)
      }
      for (const cs of controllerSnaps) {
        const sidNum = parseInt(String(cs.subsystemId), 10)
        if (!Number.isFinite(sidNum)) continue
        const { subsystemId: _drop, ...rest } = cs
        addToSubsystem(sidNum, rest)
      }

      for (const [sidNum, snapshots] of bySubsystem) {
        if (snapshots.length === 0) continue
        await postNetworkDiagnostics(remoteUrl, apiPassword, sidNum, snapshots)
      }
      return
    }

    // ── Legacy single-MCM (singleton) path — unchanged behavior ──────────
    const subsystemId = config.subsystemId
    if (!subsystemId) return

    // Only push when PLC is up — same gate as pushEstopStatus, for the
    // same reason: a snapshot batch from a tool that isn't actually
    // connected would race a live tool on the same subsystem and clobber
    // its data.
    const { hasPlcClient, getPlcClient, getLatestNetworkDeviceSnapshots } = await import('@/lib/plc-client-manager')
    if (!hasPlcClient() || !getPlcClient().isConnected) return

    const snapshots = getLatestNetworkDeviceSnapshots()
    // Append the controller so the cloud sees the PLC's firmware too.
    const controllerSnaps = await getControllerPushSnapshots()
    const batch = [...(Array.isArray(snapshots) ? snapshots : []), ...controllerSnaps]
    if (batch.length === 0) return

    await postNetworkDiagnostics(
      remoteUrl,
      apiPassword,
      parseInt(String(subsystemId), 10),
      batch,
    )
  } catch (err) {
    // Best-effort; don't spam logs on every transient HTTP failure.
    const msg = err instanceof Error ? err.message : String(err)
    if (!msg.includes('fetch failed') && !msg.includes('ECONNREFUSED') && !msg.includes('TimeoutError')) {
      console.warn('[AutoSync] Network diagnostics push error:', msg)
    }
  } finally {
    state.isPushingNetworkDiagnostics = false
  }
}

/** POST one subsystem's network-diagnostics snapshot batch to the cloud (best-effort). */
async function postNetworkDiagnostics(
  remoteUrl: string,
  apiPassword: string | undefined,
  subsystemId: number,
  snapshots: any[],
): Promise<void> {
  await fetch(`${remoteUrl}/api/sync/network-diagnostics`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': apiPassword || '',
    },
    body: JSON.stringify({
      subsystemId,
      snapshots,
      timestamp: new Date().toISOString(),
    }),
    signal: AbortSignal.timeout(15_000),
  })
}
