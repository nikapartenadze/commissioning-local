/**
 * Guided Sequence Service
 *
 * Computes the optimal physical walking order for IO testing based on
 * the network topology: Ring → DPM (Node) → Port → Sub-port → IO.
 *
 * Within each device, IOs are grouped by direction:
 *   1. Digital Inputs (DI)  — tech activates sensors/buttons
 *   2. Digital Outputs (DO) — system fires, tech confirms
 *   3. Analog Inputs (AI)   — tech applies signal
 *   4. Analog Outputs (AO)  — system sets value
 */

import { db } from '@/lib/db-sqlite'

// ── Types ──────────────────────────────────────────────────────────

export interface GuidedSequenceItem {
  ioId: number
  ioName: string
  ioDescription: string | null
  sequenceOrder: number
  ringId: number
  ringName: string
  nodeId: number
  nodeName: string
  nodePosition: number
  portId: number | null
  portNumber: string | null
  deviceName: string | null
  deviceType: string | null
  parentPortId: number | null
  ioDirection: 'input' | 'output' | 'analog_input' | 'analog_output' | 'unknown'
  result: string | null
  comments: string | null
}

export interface GuidedProgress {
  total: number
  tested: number
  passed: number
  failed: number
  skipped: number
  percentComplete: number
  currentIndex: number
}

export interface GuidedSession {
  id: number
  subsystemId: number
  startedAt: string
  completedAt: string | null
  testedBy: string | null
  totalIos: number
  passedCount: number
  failedCount: number
  swapsDetected: number
}

// ── IO Direction Classification ────────────────────────────────────

/**
 * Classify an IO tag name into a direction category.
 * This determines testing order within a device.
 */
export function classifyIoDirection(
  tagName: string | null
): 'input' | 'output' | 'analog_input' | 'analog_output' | 'unknown' {
  if (!tagName) return 'unknown'

  const name = tagName.toUpperCase()

  // Analog outputs: AO patterns
  if (name.includes(':AO.') || name.includes('.AO.') || name.includes('_AO')) {
    return 'analog_output'
  }

  // Analog inputs: AI, PMM analog reads
  if (name.includes(':AI.') || name.includes('.AI.') || name.includes('_AI')) {
    return 'analog_input'
  }

  // Digital outputs: O., SO., DO patterns
  if (
    name.includes(':O.') || name.includes(':SO.') || name.includes('.O.') ||
    name.includes(':O:') || name.includes('.OUTPUTS.') ||
    name.endsWith('.DO') || name.endsWith('_DO') ||
    // FIOM PIN4 is typically the output
    name.includes('.PIN4')
  ) {
    return 'output'
  }

  // Digital inputs: I., SI., DI patterns (default for most tags)
  if (
    name.includes(':I.') || name.includes(':SI.') || name.includes('.I.') ||
    name.includes('.INPUTS.') || name.endsWith('.DI') || name.endsWith('_DI') ||
    // FIOM PIN2 is typically the input
    name.includes('.PIN2')
  ) {
    return 'input'
  }

  // VFD status/control
  if (name.includes(':I.IN_') || name.includes(':I.IO_') || name.includes(':SI.IN')) {
    return 'input'
  }
  if (name.includes(':O.OUT_') || name.includes(':O.IO_') || name.includes(':SO.OUT')) {
    return 'output'
  }

  // Default: treat as input (most common)
  return 'input'
}

/**
 * Direction sort priority — inputs first, then outputs, then analog.
 */
function directionSortOrder(dir: string): number {
  switch (dir) {
    case 'input': return 0
    case 'output': return 1
    case 'analog_input': return 2
    case 'analog_output': return 3
    default: return 4
  }
}

// ── Extract device name from IO tag ────────────────────────────────

/**
 * Extract the parent device name from an IO tag.
 * Must match the logic in db-sqlite.ts extractDeviceName.
 */
function extractDeviceName(tagName: string | null): string | null {
  if (!tagName) return null

  // FIOM sub-port: PDP04_FIOM1_X5.PIN2_DI → PDP04_FIOM1
  const fiomMatch = tagName.match(/^(.+?)_X\d+\./)
  if (fiomMatch) return fiomMatch[1]

  // Colon-separated: NCP1_8_VFD:I.In_0 → NCP1_8_VFD
  const colonIdx = tagName.indexOf(':')
  if (colonIdx > 0) return tagName.substring(0, colonIdx)

  // Dot-separated: SLOT5_IB16.Data.0 → SLOT5_IB16
  const dotIdx = tagName.indexOf('.')
  if (dotIdx > 0) return tagName.substring(0, dotIdx)

  return tagName
}

// ── Sequence Computation ───────────────────────────────────────────

/**
 * Compute the guided testing sequence for a subsystem.
 *
 * Walking order: Ring → Node (by position) → Port (by number) → Sub-port → IO (by direction then Order)
 *
 * IOs that don't map to a network device are appended at the end.
 */
export function computeGuidedSequence(subsystemId: number): GuidedSequenceItem[] {
  // Step 1: Get all IOs for the subsystem
  const ios = db.prepare(`
    SELECT id, Name, Description, Result, Comments, "Order", NetworkDeviceName
    FROM Ios
    WHERE SubsystemId = ?
    ORDER BY "Order" ASC
  `).all(subsystemId) as Array<{
    id: number
    Name: string | null
    Description: string | null
    Result: string | null
    Comments: string | null
    Order: number | null
    NetworkDeviceName: string | null
  }>

  if (ios.length === 0) return []

  // Step 2: Get network topology
  const rings = db.prepare(`
    SELECT id, Name FROM NetworkRings WHERE SubsystemId = ?
  `).all(subsystemId) as Array<{ id: number; Name: string }>

  const nodes = db.prepare(`
    SELECT n.id, n.RingId, n.Name, n.Position
    FROM NetworkNodes n
    JOIN NetworkRings r ON r.id = n.RingId
    WHERE r.SubsystemId = ?
    ORDER BY r.id ASC, n.Position ASC
  `).all(subsystemId) as Array<{ id: number; RingId: number; Name: string; Position: number }>

  const ports = db.prepare(`
    SELECT p.id, p.NodeId, p.PortNumber, p.DeviceName, p.DeviceType, p.ParentPortId
    FROM NetworkPorts p
    JOIN NetworkNodes n ON n.id = p.NodeId
    JOIN NetworkRings r ON r.id = n.RingId
    WHERE r.SubsystemId = ?
    ORDER BY p.NodeId ASC, CAST(p.PortNumber AS INTEGER) ASC
  `).all(subsystemId) as Array<{
    id: number; NodeId: number; PortNumber: string
    DeviceName: string | null; DeviceType: string | null; ParentPortId: number | null
  }>

  // Build lookup maps
  const ringMap = new Map(rings.map(r => [r.id, r]))
  const nodeMap = new Map(nodes.map(n => [n.id, n]))
  const portByDevice = new Map<string, typeof ports[0]>()
  const portMap = new Map<number, typeof ports[0]>()

  for (const port of ports) {
    portMap.set(port.id, port)
    if (port.DeviceName) {
      portByDevice.set(port.DeviceName.toUpperCase(), port)
    }
  }

  // Step 3: Map each IO to its network location
  interface IoWithTopology {
    io: typeof ios[0]
    direction: GuidedSequenceItem['ioDirection']
    ringId: number
    ringName: string
    nodeId: number
    nodeName: string
    nodePosition: number
    portId: number | null
    portNumber: string | null
    deviceName: string | null
    deviceType: string | null
    parentPortId: number | null
    sortKey: string
  }

  const mappedIos: IoWithTopology[] = []
  const unmappedIos: typeof ios[0][] = []

  for (const io of ios) {
    const direction = classifyIoDirection(io.Name)

    // Try to find the network device for this IO
    let deviceName = io.NetworkDeviceName || extractDeviceName(io.Name)
    let port: typeof ports[0] | undefined

    if (deviceName) {
      // Try exact match first, then uppercase
      port = portByDevice.get(deviceName.toUpperCase())

      // For FIOM sub-ports, try parent device (e.g. PDP04_FIOM1 for PDP04_FIOM1_X5)
      if (!port) {
        const fiomParent = deviceName.match(/^(.+?)_X\d+$/)
        if (fiomParent) {
          port = portByDevice.get(fiomParent[1].toUpperCase())
        }
      }
    }

    if (port) {
      const node = nodeMap.get(port.NodeId)
      if (node) {
        const ring = ringMap.get(node.RingId)
        if (ring) {
          // Build sort key: ring.id → node.position → port.number → direction → IO.order
          const portNum = parseInt(port.PortNumber) || 0
          const sortKey = [
            String(ring.id).padStart(4, '0'),
            String(node.Position).padStart(4, '0'),
            String(portNum).padStart(4, '0'),
            String(directionSortOrder(direction)).padStart(2, '0'),
            String(io.Order ?? 9999).padStart(6, '0'),
          ].join('-')

          mappedIos.push({
            io,
            direction,
            ringId: ring.id,
            ringName: ring.Name,
            nodeId: node.id,
            nodeName: node.Name,
            nodePosition: node.Position,
            portId: port.id,
            portNumber: port.PortNumber,
            deviceName: port.DeviceName,
            deviceType: port.DeviceType,
            parentPortId: port.ParentPortId,
            sortKey,
          })
          continue
        }
      }
    }

    // IO has no network mapping
    unmappedIos.push(io)
  }

  // Step 4: Sort mapped IOs by walking order
  mappedIos.sort((a, b) => a.sortKey.localeCompare(b.sortKey))

  // Step 5: Build the final sequence
  const sequence: GuidedSequenceItem[] = []
  let order = 0

  // Mapped IOs first (in walking order)
  for (const item of mappedIos) {
    sequence.push({
      ioId: item.io.id,
      ioName: item.io.Name || `IO-${item.io.id}`,
      ioDescription: item.io.Description,
      sequenceOrder: order++,
      ringId: item.ringId,
      ringName: item.ringName,
      nodeId: item.nodeId,
      nodeName: item.nodeName,
      nodePosition: item.nodePosition,
      portId: item.portId,
      portNumber: item.portNumber,
      deviceName: item.deviceName,
      deviceType: item.deviceType,
      parentPortId: item.parentPortId,
      ioDirection: item.direction,
      result: item.io.Result,
      comments: item.io.Comments,
    })
  }

  // Unmapped IOs at the end (preserve original order)
  for (const io of unmappedIos) {
    sequence.push({
      ioId: io.id,
      ioName: io.Name || `IO-${io.id}`,
      ioDescription: io.Description,
      sequenceOrder: order++,
      ringId: 0,
      ringName: 'Unmapped',
      nodeId: 0,
      nodeName: 'Unknown',
      nodePosition: 9999,
      portId: null,
      portNumber: null,
      deviceName: extractDeviceName(io.Name),
      deviceType: null,
      parentPortId: null,
      ioDirection: classifyIoDirection(io.Name),
      result: io.Result,
      comments: io.Comments,
    })
  }

  return sequence
}

/**
 * Compute progress statistics for a guided session.
 */
export function computeProgress(
  sequence: GuidedSequenceItem[],
  currentIndex: number
): GuidedProgress {
  const total = sequence.length
  const passed = sequence.filter(s => s.result === 'Passed').length
  const failed = sequence.filter(s => s.result === 'Failed').length
  const tested = passed + failed

  return {
    total,
    tested,
    passed,
    failed,
    skipped: 0,
    percentComplete: total > 0 ? Math.round((tested / total) * 100) : 0,
    currentIndex,
  }
}

/**
 * Find the index of the next untested IO in the sequence,
 * starting from the given index.
 */
export function findNextUntestedIndex(
  sequence: GuidedSequenceItem[],
  fromIndex: number = 0
): number {
  // Search forward from current position
  for (let i = fromIndex; i < sequence.length; i++) {
    if (!sequence[i].result) return i
  }
  // Wrap around to beginning
  for (let i = 0; i < fromIndex; i++) {
    if (!sequence[i].result) return i
  }
  // All tested
  return -1
}

// ── Session Management ─────────────────────────────────────────────

/**
 * Initialize the GuidedSessions and SwapDetections tables if needed.
 * Called at module load time to ensure tables exist.
 */
export function initGuidedTables(): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS GuidedSessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      SubsystemId INTEGER NOT NULL,
      StartedAt TEXT NOT NULL,
      CompletedAt TEXT,
      TestedBy TEXT,
      TotalIos INTEGER NOT NULL,
      PassedCount INTEGER DEFAULT 0,
      FailedCount INTEGER DEFAULT 0,
      SwapsDetected INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS SwapDetections (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      SessionId INTEGER,
      ExpectedIoId INTEGER NOT NULL,
      TriggeredIoId INTEGER NOT NULL,
      DetectedAt TEXT NOT NULL,
      Accepted INTEGER DEFAULT 0,
      FOREIGN KEY (ExpectedIoId) REFERENCES Ios(id),
      FOREIGN KEY (TriggeredIoId) REFERENCES Ios(id)
    );
    CREATE INDEX IF NOT EXISTS idx_swapdetections_sessionid ON SwapDetections(SessionId);
  `)
}

// Initialize on import
try { initGuidedTables() } catch { /* table already exists */ }

/**
 * Start a new guided testing session.
 */
export function startSession(
  subsystemId: number,
  testedBy: string | null
): GuidedSession {
  const sequence = computeGuidedSequence(subsystemId)
  const now = new Date().toISOString()

  const result = db.prepare(`
    INSERT INTO GuidedSessions (SubsystemId, StartedAt, TestedBy, TotalIos)
    VALUES (?, ?, ?, ?)
  `).run(subsystemId, now, testedBy, sequence.length)

  return {
    id: Number(result.lastInsertRowid),
    subsystemId,
    startedAt: now,
    completedAt: null,
    testedBy,
    totalIos: sequence.length,
    passedCount: 0,
    failedCount: 0,
    swapsDetected: 0,
  }
}

/**
 * End a guided testing session.
 */
export function endSession(sessionId: number): void {
  const now = new Date().toISOString()

  // Count actual results
  const session = db.prepare(
    'SELECT SubsystemId FROM GuidedSessions WHERE id = ?'
  ).get(sessionId) as { SubsystemId: number } | undefined

  if (!session) return

  const stats = db.prepare(`
    SELECT
      COUNT(CASE WHEN Result = 'Passed' THEN 1 END) as passed,
      COUNT(CASE WHEN Result = 'Failed' THEN 1 END) as failed
    FROM Ios WHERE SubsystemId = ?
  `).get(session.SubsystemId) as { passed: number; failed: number }

  const swaps = (db.prepare(
    'SELECT COUNT(*) as count FROM SwapDetections WHERE SessionId = ?'
  ).get(sessionId) as { count: number }).count

  db.prepare(`
    UPDATE GuidedSessions
    SET CompletedAt = ?, PassedCount = ?, FailedCount = ?, SwapsDetected = ?
    WHERE id = ?
  `).run(now, stats.passed, stats.failed, swaps, sessionId)
}

/**
 * Record a swap detection.
 */
export function recordSwap(
  sessionId: number | null,
  expectedIoId: number,
  triggeredIoId: number,
  accepted: boolean = false
): number {
  const now = new Date().toISOString()
  const result = db.prepare(`
    INSERT INTO SwapDetections (SessionId, ExpectedIoId, TriggeredIoId, DetectedAt, Accepted)
    VALUES (?, ?, ?, ?, ?)
  `).run(sessionId, expectedIoId, triggeredIoId, now, accepted ? 1 : 0)

  return Number(result.lastInsertRowid)
}

/**
 * Accept a previously recorded swap detection.
 */
export function acceptSwap(swapId: number): void {
  db.prepare('UPDATE SwapDetections SET Accepted = 1 WHERE id = ?').run(swapId)
}
