import { db } from '@/lib/db-sqlite'
import { parseDeviceIdsFromSvg } from '@/lib/guided/svg-parser'
import { readBundledSvg } from '@/app/api/maps/subsystem/[id]/route'
import { isOutputIo, isSafetyOutput } from '@/lib/io-classification'
import { classifyIoCircuit } from '@/lib/guided/io-check-sequence'
import { deriveSystemRunning } from '@/lib/guided/system-running'
import type {
  DataSnapshot,
  ManualTaskStatus,
  SnapshotDevice,
  SnapshotEstopZone,
  SnapshotFunctional,
  SnapshotIo,
  SnapshotVfd,
} from './snapshot-types'

/**
 * Impure loader: reads SQLite (+ best-effort live PLC state) and produces the
 * DataSnapshot consumed by the pure buildTaskPool(). Keep all DB/PLC access in
 * here so the engine stays unit-testable.
 */

interface SubRow { Name: string | null }
interface IoRow {
  id: number
  Name: string | null
  Description: string | null
  Result: string | null
  TagType: string | null
  NetworkDeviceName: string | null
  InstallationStatus: string | null
  InstallationPercent: number | null
}

/** Live PLC tag cache — best-effort, never throws into the snapshot.
 *  Mode-aware (Phase 1.1): unions across registry MCMs (embedded or via the
 *  gateway-state cache in PLC_MODE=remote); singleton fallback on tablets. */
function liveTags(): { name?: string; state?: string }[] {
  try {
    // Lazy require so unit tests / non-PLC contexts don't pull the FFI stack.
    const { getLiveTagsUnion } = require('@/lib/plc-live-tags') as typeof import('@/lib/plc-live-tags')
    return getLiveTagsUnion()
  } catch {
    return []
  }
}

/** DLR ring health — best-effort, 'unknown' when the poller is off (D5). */
function ringHealthNow(): 'healthy' | 'degraded' | 'unknown' | null {
  try {
    const { getLatestRingStatus } = require('@/lib/plc-client-manager') as typeof import('@/lib/plc-client-manager')
    return getLatestRingStatus()?.state ?? null
  } catch {
    return null
  }
}

export async function loadSnapshot(subsystemId: number): Promise<DataSnapshot> {
  const sub = db.prepare('SELECT Name FROM Subsystems WHERE id = ?').get(subsystemId) as
    | SubRow
    | undefined
  const mcm = sub?.Name ?? null

  // ── SVG device ordering ──────────────────────────────────────────────
  let svg: string | null = null
  if (mcm) {
    const row = db.prepare('SELECT SvgContent FROM McmDiagrams WHERE McmName = ?').get(mcm) as
      | { SvgContent: string }
      | undefined
    if (row?.SvgContent) svg = row.SvgContent
  }
  if (svg === null) svg = await readBundledSvg()
  const orderedIds = svg ? parseDeviceIdsFromSvg(svg) : []

  // ── IOs (non-spare) ──────────────────────────────────────────────────
  const ios = db
    .prepare(
      `SELECT id, Name, Description, Result, TagType, NetworkDeviceName,
              InstallationStatus, InstallationPercent
         FROM Ios
        WHERE SubsystemId = ?
          AND (Description IS NULL OR UPPER(Description) NOT LIKE '%SPARE%')`,
    )
    .all(subsystemId) as IoRow[]

  // ── safety-tag set (for classifying IOs) ─────────────────────────────
  const safetyTags = new Set<string>()
  const collect = (sql: string, col: string) => {
    try {
      for (const r of db.prepare(sql).all(subsystemId) as Record<string, string | null>[]) {
        const v = r[col]
        if (v) safetyTags.add(v)
      }
    } catch {
      /* table may be empty/missing — ignore */
    }
  }
  // EStop* tables aren't subsystem-scoped via FK to Subsystems in every case;
  // pull broadly — a tag match is conservative (marks a device safety).
  collect('SELECT Tag FROM EStopIoPoints WHERE 1=1 OR ? IS NULL', 'Tag')
  collect('SELECT StoTag AS Tag FROM EStopVfds WHERE 1=1 OR ? IS NULL', 'Tag')
  collect('SELECT Tag FROM EStopRelatedEpcs WHERE 1=1 OR ? IS NULL', 'Tag')
  collect('SELECT CheckTag AS Tag FROM EStopEpcs WHERE 1=1 OR ? IS NULL', 'Tag')
  collect('SELECT StoSignal AS Tag FROM SafetyZones WHERE SubsystemId = ?', 'Tag')
  collect('SELECT BssTag AS Tag FROM SafetyZones WHERE SubsystemId = ?', 'Tag')
  collect('SELECT Tag FROM SafetyOutputs WHERE SubsystemId = ?', 'Tag')

  const isSafetyIo = (r: IoRow): boolean => {
    const n = r.Name ?? ''
    if (isSafetyOutput(n)) return true
    if (safetyTags.has(n)) return true
    if (n.startsWith('STD_')) return true
    const tt = (r.TagType ?? '').toLowerCase()
    if (/safety|e-?stop|epc|pull/.test(tt)) return true
    return false
  }

  // ── device assembly (mirror /api/guided/devices matching rules) ──────
  const live = liveTags()
  const liveStateByName = new Map<string, 'TRUE' | 'FALSE'>()
  const faultTrue = new Set<string>()
  const faultKnown = new Set<string>()
  for (const t of live) {
    const name = t.name ?? ''
    if (name && (t.state === 'TRUE' || t.state === 'FALSE')) {
      liveStateByName.set(name, t.state)
    }
    const m = name.match(/^(.+):I\.ConnectionFaulted$/)
    if (m) {
      faultKnown.add(m[1])
      if (t.state === 'TRUE') faultTrue.add(m[1])
    }
  }
  const networkDeviceNames = new Set<string>()
  try {
    for (const r of db.prepare('SELECT DISTINCT DeviceName FROM NetworkPorts').all() as {
      DeviceName: string | null
    }[]) {
      if (r.DeviceName) networkDeviceNames.add(r.DeviceName)
    }
  } catch {
    /* ignore */
  }

  const devices: SnapshotDevice[] = orderedIds.map((deviceName, order) => {
    const exactSpace = deviceName + ' '
    const underscoreSub = deviceName + '_'
    const pdAlias = deviceName + '_PD'
    const matched: SnapshotIo[] = []
    let installComplete: boolean | null = null
    let anyInstall = false
    let allInstall = true
    for (const r of ios) {
      const ndn = r.NetworkDeviceName
      const matchesNDN = ndn === deviceName || ndn === pdAlias
      let matchesDesc = false
      if (!matchesNDN && r.Description) {
        matchesDesc = r.Description.startsWith(exactSpace) || r.Description.startsWith(underscoreSub)
      }
      if (!matchesNDN && !matchesDesc) continue
      const safety = isSafetyIo(r)
      matched.push({
        id: r.id,
        name: r.Name ?? '',
        description: r.Description,
        result: r.Result === 'Passed' ? 'Passed' : r.Result === 'Failed' ? 'Failed' : null,
        tagType: r.TagType,
        isOutput: isOutputIo(r.Name, r.Description),
        isSafety: safety,
        circuit: classifyIoCircuit(r.Name, r.Description),
        liveState: r.Name ? liveStateByName.get(r.Name) ?? null : null,
      })
      // install rollup
      const complete =
        r.InstallationStatus === 'complete' ||
        (typeof r.InstallationPercent === 'number' && r.InstallationPercent >= 1)
      const hasData = r.InstallationStatus != null || r.InstallationPercent != null
      if (hasData) {
        anyInstall = true
        if (!complete) allInstall = false
      }
    }
    if (anyInstall) installComplete = allInstall

    let networked: boolean | null = null
    if (networkDeviceNames.has(deviceName) || faultKnown.has(deviceName)) {
      if (faultKnown.has(deviceName)) networked = !faultTrue.has(deviceName)
    }

    return {
      deviceName,
      order,
      ios: matched,
      isSafety: matched.some((io) => io.isSafety),
      installComplete,
      networked,
    }
  })

  // ── e-stop zones + results ───────────────────────────────────────────
  const estopZones: SnapshotEstopZone[] = []
  try {
    const zones = db
      .prepare('SELECT id, Name FROM EStopZones WHERE SubsystemId = ? ORDER BY id')
      .all(subsystemId) as { id: number; Name: string }[]
    const checkRows = db
      .prepare('SELECT ZoneName, CheckTag, Result FROM EStopEpcChecks WHERE SubsystemId = ?')
      .all(subsystemId) as { ZoneName: string; CheckTag: string; Result: string | null }[]
    const resultFor = (zone: string, tag: string): 'pass' | 'fail' | null => {
      const m = checkRows.find((c) => c.ZoneName === zone && c.CheckTag === tag)
      if (m?.Result === 'pass') return 'pass'
      if (m?.Result === 'fail') return 'fail'
      return null
    }
    const deviceNameSet = new Set(devices.map((d) => d.deviceName))
    // Map a PLC tag to one of THIS subsystem's SVG device names, if possible.
    // Tags look like "UL17_19_VFD:SI.In0Data" or "PE1:I.Pulled"; the device
    // prefix is everything before the first ':' / '.'. We only keep matches
    // that are real devices in this subsystem so gating stays accurate.
    const deviceOf = (tag: string | null): string | null => {
      if (!tag) return null
      const base = tag.split(/[:.]/)[0]
      if (deviceNameSet.has(base)) return base
      if (deviceNameSet.has(base + '_PD')) return base + '_PD'
      return null
    }
    for (const z of zones) {
      const epcs = db
        .prepare('SELECT id, Name, CheckTag FROM EStopEpcs WHERE ZoneId = ? ORDER BY id')
        .all(z.id) as { id: number; Name: string; CheckTag: string }[]
      const zoneDevices = new Set<string>()
      for (const e of epcs) {
        const tags: (string | null)[] = []
        try {
          for (const r of db.prepare('SELECT Tag, StoTag FROM EStopVfds WHERE EpcId = ?').all(e.id) as {
            Tag: string | null
            StoTag: string | null
          }[]) {
            tags.push(r.Tag, r.StoTag)
          }
          for (const r of db.prepare('SELECT Tag FROM EStopIoPoints WHERE EpcId = ?').all(e.id) as {
            Tag: string | null
          }[]) {
            tags.push(r.Tag)
          }
        } catch {
          /* ignore */
        }
        for (const t of tags) {
          const dn = deviceOf(t)
          if (dn) zoneDevices.add(dn)
        }
      }
      estopZones.push({
        zoneName: z.Name,
        epcs: epcs.map((e) => ({
          name: e.Name,
          checkTag: e.CheckTag,
          result: resultFor(z.Name, e.CheckTag),
        })),
        safetyDeviceNames: [...zoneDevices],
      })
    }
  } catch {
    /* no e-stop data */
  }

  // ── L2: VFD setup + functional checks + belt tracking ────────────────
  const vfds: SnapshotVfd[] = []
  const functional: SnapshotFunctional[] = []
  let beltsTracked: boolean | null = null
  try {
    interface SheetRow { id: number; Name: string; DisplayName: string | null }
    const sheets = db
      .prepare('SELECT id, Name, DisplayName FROM L2Sheets ORDER BY DisplayOrder')
      .all() as SheetRow[]
    // The VFD sheet ships as name "APF" with display "Variable Frequency Drive".
    const isVfdSheet = (s: SheetRow) =>
      /vfd|apf/i.test(s.Name) || /vfd|variable frequency/i.test(s.DisplayName ?? '')

    // Belt tracking: any "Belt Tracked" column value across all sheets.
    const beltCells = db
      .prepare(
        `SELECT lcv.Value AS Value
           FROM L2CellValues lcv
           JOIN L2Columns lc ON lcv.ColumnId = lc.id
          WHERE lc.Name = 'Belt Tracked'`,
      )
      .all() as { Value: string | null }[]
    if (beltCells.length > 0) {
      beltsTracked = beltCells.every((c) => /pass|yes|true/i.test(c.Value ?? ''))
    }

    const controlsVerified = new Set<string>()
    try {
      for (const r of db.prepare('SELECT deviceName FROM VfdControlsVerified').all() as {
        deviceName: string
      }[]) {
        controlsVerified.add(r.deviceName)
      }
    } catch {
      /* ignore */
    }

    for (const sheet of sheets) {
      const cols = db
        .prepare(
          'SELECT id, Name, IncludeInProgress FROM L2Columns WHERE SheetId = ? ORDER BY DisplayOrder',
        )
        .all(sheet.id) as { id: number; Name: string; IncludeInProgress: number }[]
      const progressCols = cols.filter((c) => c.IncludeInProgress === 1)
      const devs = db
        .prepare(
          `SELECT id, DeviceName, DisplayOrder, CompletedChecks, TotalChecks
             FROM L2Devices
            WHERE SheetId = ? AND (Mcm = ? OR Subsystem = ? OR ? IS NULL)
            ORDER BY DisplayOrder`,
        )
        .all(sheet.id, mcm, mcm, mcm) as {
        id: number
        DeviceName: string
        DisplayOrder: number
        CompletedChecks: number
        TotalChecks: number
      }[]

      for (const d of devs) {
        if (isVfdSheet(sheet)) {
          const cells = db
            .prepare(
              `SELECT lc.Name AS Name, lcv.Value AS Value
                 FROM L2Columns lc
                 LEFT JOIN L2CellValues lcv ON lcv.ColumnId = lc.id AND lcv.DeviceId = ?
                WHERE lc.SheetId = ? AND lc.IncludeInProgress = 1
                ORDER BY lc.DisplayOrder`,
            )
            .all(d.id, sheet.id) as { Name: string; Value: string | null }[]
          vfds.push({
            deviceName: d.DeviceName,
            order: d.DisplayOrder,
            steps: cells.map((c) => ({ name: c.Name, value: c.Value })),
            controlsVerified: controlsVerified.has(d.DeviceName),
          })
        } else {
          functional.push({
            sheetName: sheet.Name,
            displayName: sheet.DisplayName ?? sheet.Name,
            deviceName: d.DeviceName,
            order: d.DisplayOrder,
            completedChecks: d.CompletedChecks ?? 0,
            totalChecks: d.TotalChecks ?? progressCols.length,
          })
        }
      }
    }
  } catch {
    /* no L2 data */
  }

  // ── network ──────────────────────────────────────────────────────────
  let hasRings = false
  try {
    const ring = db
      .prepare('SELECT 1 FROM NetworkRings WHERE SubsystemId = ? LIMIT 1')
      .get(subsystemId)
    hasRings = !!ring
  } catch {
    /* ignore */
  }
  // dpmsAllInstalled rolled up from device install state.
  let dpmsAllInstalled: boolean | null = null
  {
    const states = devices.map((d) => d.installComplete)
    if (states.some((s) => s === false)) dpmsAllInstalled = false
    else if (states.some((s) => s === true)) dpmsAllInstalled = true
  }

  // allNetworkedCommunicating from live fault tags.
  let allNetworkedCommunicating: boolean | null = null
  if (faultKnown.size > 0) allNetworkedCommunicating = faultTrue.size === 0

  // ── manual task status ───────────────────────────────────────────────
  const manualTaskStatus: Record<string, ManualTaskStatus> = {}
  try {
    const rows = db
      .prepare('SELECT TaskId, Status, Reason FROM GuidedTaskState WHERE SubsystemId = ?')
      .all(subsystemId) as { TaskId: string; Status: string; Reason: string | null }[]
    for (const r of rows) {
      if (r.Status === 'skipped' || r.Status === 'completed') {
        manualTaskStatus[r.TaskId] = {
          status: r.Status,
          reason: r.Reason ?? undefined,
        }
      }
    }
  } catch {
    /* table created on startup; ignore if missing */
  }

  return {
    subsystemId,
    mcm,
    devices,
    estopZones,
    vfds,
    functional,
    network: { hasRings, dpmsAllInstalled },
    beltsTracked,
    allNetworkedCommunicating,
    systemRunning: deriveSystemRunning(live),
    ringHealth: ringHealthNow(),
    manualTaskStatus,
  }
}
