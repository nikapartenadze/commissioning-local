import type { Request, Response } from 'express'
import { db } from '@/lib/db-sqlite'
import { loadSnapshot } from '@/lib/guided/task-pool/snapshot'
import { buildTaskPool } from '@/lib/guided/task-pool/task-builder'
import {
  buildSteps,
  buildVfdSteps,
  buildFunctionalSteps,
  buildEstopSteps,
} from '@/lib/guided/task-pool/steps'
import type { StepIo, VfdColumn, FunctionalColumn } from '@/lib/guided/task-pool/steps'
import type { Task } from '@/lib/guided/task-pool/types'

/**
 * GET /api/guided/tasks/steps?subsystemId=N&taskId=...
 *
 * Returns the fully-built ordered Steps for a single task, with all data the
 * runner needs baked in (IO ids, VFD/functional columns + cell ids, e-stop
 * EPCs). Centralising step construction here keeps the client a pure renderer
 * and means VFD/functional/e-stop flows reuse the same snapshot the pool is
 * built from. If taskId is omitted, the pool's recommended next task is used.
 */
export async function GET(req: Request, res: Response) {
  const sidRaw = req.query.subsystemId
  const subsystemId = typeof sidRaw === 'string' ? parseInt(sidRaw, 10) : NaN
  if (!subsystemId || isNaN(subsystemId) || subsystemId <= 0) {
    return res.status(400).json({ error: 'Valid subsystemId query param is required' })
  }
  const taskId = typeof req.query.taskId === 'string' ? req.query.taskId : null

  const snapshot = await loadSnapshot(subsystemId)
  const pool = buildTaskPool(snapshot)
  const task: Task | undefined = taskId
    ? pool.tasks.find((t) => t.id === taskId)
    : pool.tasks.find((t) => t.id === pool.nextTaskId)
  if (!task) return res.status(404).json({ error: 'Task not found' })

  let steps = task.steps
  try {
    if (task.type === 'io_check_safety' || task.type === 'io_check_nonsafety') {
      const dev = snapshot.devices.find((d) => d.deviceName === task.deviceName)
      const ios: StepIo[] = (dev?.ios ?? []).map((io) => ({
        id: io.id,
        name: io.name,
        description: io.description,
        result: io.result,
        isOutput: io.isOutput,
      }))
      steps = buildSteps(task, ios)
    } else if (task.type === 'vfd_setup') {
      steps = buildVfdSteps(task, vfdColumns(task.deviceName ?? ''))
    } else if (task.type === 'functional_check') {
      // D1: pure prompt & response — no live-signal watch / auto-assist.
      const { deviceId, columns } = functionalColumns(task)
      steps = deviceId
        ? buildFunctionalSteps(task, deviceId, columns)
        : buildSteps(task)
    } else if (task.type === 'estop_verification') {
      const zone = snapshot.estopZones.find((z) => z.zoneName === task.id.split(':').slice(1).join(':'))
        ?? snapshot.estopZones.find((z) => task.title.includes(z.zoneName))
      steps = zone
        ? buildEstopSteps(task, zone.zoneName, zone.epcs)
        : buildSteps(task)
    } else if (task.type === 'network_loop') {
      // Auto-verify assist: surface the live DLR ring verdict + DPM comms so
      // the runner can auto-pass a healthy ring (still manual-confirmable).
      steps = buildSteps(task, [], {
        ringVerdict: snapshot.ringHealth,
        dpmsCommunicating: snapshot.allNetworkedCommunicating,
      })
    } else {
      steps = buildSteps(task)
    }
  } catch (e) {
    console.warn('[guided tasks/steps] build error, falling back:', e instanceof Error ? e.message : e)
    steps = buildSteps(task)
  }

  return res.json({ task: { ...task, steps }, steps })
}

// ── L2 lookups ─────────────────────────────────────────────────────────────

interface ColRow {
  id: number
  Name: string
  ColumnType: string | null
  InputType: string | null
}

function inputTypeOf(c: ColRow): 'pass_fail' | 'number' | 'text' {
  const t = (c.InputType || c.ColumnType || '').toLowerCase()
  if (t.includes('number')) return 'number'
  if (t.includes('pass') || t.includes('check')) return 'pass_fail'
  return 'text'
}

/** VFD wizard columns (IncludeInProgress, editable) + current values. */
function vfdColumns(deviceName: string): VfdColumn[] {
  if (!deviceName) return []
  const sheet = db
    .prepare(
      `SELECT id FROM L2Sheets WHERE UPPER(Name) LIKE '%VFD%' OR UPPER(Name) LIKE '%APF%'
        OR UPPER(COALESCE(DisplayName,'')) LIKE '%VFD%' ORDER BY DisplayOrder LIMIT 1`,
    )
    .get() as { id: number } | undefined
  if (!sheet) return []
  const dev = db
    .prepare('SELECT id FROM L2Devices WHERE SheetId = ? AND DeviceName = ? COLLATE NOCASE')
    .get(sheet.id, deviceName) as { id: number } | undefined
  const cols = db
    .prepare(
      `SELECT id, Name, ColumnType, InputType FROM L2Columns
        WHERE SheetId = ? AND IncludeInProgress = 1 AND IsEditable = 1 ORDER BY DisplayOrder`,
    )
    .all(sheet.id) as ColRow[]
  return cols.map((c) => ({
    name: c.Name,
    inputType: inputTypeOf(c),
    value: dev ? cellValue(dev.id, c.id) : null,
  }))
}

/** Functional sheet columns + the device's L2Devices.id for the cell write. */
function functionalColumns(task: Task): { deviceId: number | null; columns: FunctionalColumn[] } {
  const deviceName = task.deviceName ?? ''
  // id = functional_check:<sheetName>:<deviceName>
  const key = task.id.slice('functional_check:'.length)
  const sheetName = deviceName && key.endsWith(':' + deviceName)
    ? key.slice(0, key.length - deviceName.length - 1)
    : key
  const sheet = db
    .prepare('SELECT id FROM L2Sheets WHERE Name = ? COLLATE NOCASE LIMIT 1')
    .get(sheetName) as { id: number } | undefined
  if (!sheet) return { deviceId: null, columns: [] }
  const dev = db
    .prepare('SELECT id FROM L2Devices WHERE SheetId = ? AND DeviceName = ? COLLATE NOCASE')
    .get(sheet.id, deviceName) as { id: number } | undefined
  if (!dev) return { deviceId: null, columns: [] }
  const cols = db
    .prepare(
      `SELECT id, Name, ColumnType, InputType FROM L2Columns
        WHERE SheetId = ? AND IncludeInProgress = 1 AND IsEditable = 1 ORDER BY DisplayOrder`,
    )
    .all(sheet.id) as ColRow[]
  return {
    deviceId: dev.id,
    columns: cols.map((c) => ({
      columnId: c.id,
      name: c.Name,
      inputType: inputTypeOf(c),
      value: cellValue(dev.id, c.id),
    })),
  }
}

function cellValue(deviceId: number, columnId: number): string | null {
  const row = db
    .prepare('SELECT Value FROM L2CellValues WHERE DeviceId = ? AND ColumnId = ?')
    .get(deviceId, columnId) as { Value: string | null } | undefined
  return row?.Value ?? null
}
