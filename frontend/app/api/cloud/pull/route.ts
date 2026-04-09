export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server'
import { db, extractDeviceName } from '@/lib/db-sqlite'
import { getWsBroadcastUrl } from '@/lib/plc-client-manager'
import { createBackup } from '@/lib/db/backup'
import type { CloudPullResponse } from '@/lib/cloud/types'

// ── Prepared statements (created once at module load) ──────────────────
const pullStmts = {
  pendingCount: db.prepare('SELECT COUNT(*) as cnt FROM PendingSyncs'),
  ioCount: db.prepare('SELECT COUNT(*) as cnt FROM Ios'),
  getProject: db.prepare('SELECT id FROM Projects WHERE id = ?'),
  insertProject: db.prepare('INSERT INTO Projects (id, Name) VALUES (?, ?)'),
  getSubsystem: db.prepare('SELECT id FROM Subsystems WHERE id = ?'),
  insertSubsystem: db.prepare('INSERT INTO Subsystems (id, ProjectId, Name) VALUES (?, ?, ?)'),
  deleteAllIos: db.prepare('DELETE FROM Ios'),
  upsertIo: db.prepare(`
    INSERT INTO Ios (id, Name, Description, SubsystemId, Result, Comments, Timestamp, TestedBy, IoNumber, InstallationStatus, InstallationPercent, PoweredUp, TagType, Version, Trade, ClarificationNote, NetworkDeviceName, PunchlistStatus)
    VALUES (@id, @Name, @Description, @SubsystemId, @Result, @Comments, @Timestamp, @TestedBy, @IoNumber, @InstallationStatus, @InstallationPercent, @PoweredUp, @TagType, @Version, @Trade, @ClarificationNote, @NetworkDeviceName, @PunchlistStatus)
    ON CONFLICT(id) DO UPDATE SET
      Name = @Name, Description = @Description, SubsystemId = @SubsystemId,
      Result = CASE WHEN Ios.Result IS NOT NULL AND Ios.Result != '' THEN Ios.Result ELSE @Result END,
      Comments = CASE WHEN Ios.Comments IS NOT NULL AND Ios.Comments != '' THEN Ios.Comments ELSE @Comments END,
      Timestamp = CASE WHEN Ios.Timestamp IS NOT NULL THEN Ios.Timestamp ELSE @Timestamp END,
      TestedBy = CASE WHEN Ios.TestedBy IS NOT NULL AND Ios.TestedBy != '' THEN Ios.TestedBy ELSE @TestedBy END,
      IoNumber = @IoNumber, InstallationStatus = @InstallationStatus,
      InstallationPercent = @InstallationPercent, PoweredUp = @PoweredUp,
      TagType = CASE WHEN @TagType IS NOT NULL THEN @TagType ELSE Ios.TagType END,
      Version = @Version, Trade = @Trade, ClarificationNote = @ClarificationNote,
      NetworkDeviceName = @NetworkDeviceName,
      PunchlistStatus = CASE WHEN @PunchlistStatus IS NOT NULL THEN @PunchlistStatus ELSE Ios.PunchlistStatus END
  `),
  getIosWithoutDevice: db.prepare('SELECT id, Name FROM Ios WHERE NetworkDeviceName IS NULL'),
  updateDeviceName: db.prepare('UPDATE Ios SET NetworkDeviceName = ? WHERE id = ?'),
  deleteHistories: db.prepare('DELETE FROM TestHistories'),
  insertHistory: db.prepare(`INSERT OR IGNORE INTO TestHistories (IoId, Result, TestedBy, Comments, FailureMode, State, Timestamp, Source)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`),
  getUntypedIos: db.prepare('SELECT id, Description FROM Ios WHERE TagType IS NULL AND Description IS NOT NULL'),
  updateTagType: db.prepare('UPDATE Ios SET TagType = ? WHERE id = ?'),
  updateProjectName: db.prepare('UPDATE Projects SET Name = ? WHERE id = (SELECT ProjectId FROM Subsystems WHERE id = ?)'),
  updateSubsystemName: db.prepare('UPDATE Subsystems SET Name = ? WHERE id = ?'),
  // Network
  deleteNetworkRings: db.prepare('DELETE FROM NetworkRings WHERE SubsystemId = ?'),
  insertRing: db.prepare('INSERT INTO NetworkRings (SubsystemId, Name, McmName, McmIp, McmTag) VALUES (?, ?, ?, ?, ?)'),
  insertNode: db.prepare('INSERT INTO NetworkNodes (RingId, Name, Position, IpAddress, CableIn, CableOut, StatusTag, TotalPorts) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'),
  insertPort: db.prepare('INSERT INTO NetworkPorts (NodeId, PortNumber, CableLabel, DeviceName, DeviceType, DeviceIp, StatusTag, ParentPortId) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'),
  updatePortParent: db.prepare('UPDATE NetworkPorts SET ParentPortId = ? WHERE id = ?'),
  // EStop
  insertEStopZone: db.prepare('INSERT INTO EStopZones (SubsystemId, Name) VALUES (?, ?)'),
  insertEpc: db.prepare('INSERT INTO EStopEpcs (ZoneId, Name, CheckTag) VALUES (?, ?, ?)'),
  insertIoPoint: db.prepare('INSERT INTO EStopIoPoints (EpcId, Tag) VALUES (?, ?)'),
  insertVfd: db.prepare('INSERT INTO EStopVfds (EpcId, Tag, StoTag, MustStop) VALUES (?, ?, ?, ?)'),
  // Safety
  insertSafetyZone: db.prepare('INSERT INTO SafetyZones (SubsystemId, BssTag, StoSignal, ZoneName) VALUES (?, ?, ?, ?)'),
  insertSafetyDrive: db.prepare('INSERT INTO SafetyZoneDrives (ZoneId, DriveName) VALUES (?, ?)'),
  // Punchlists
  deletePunchlists: db.prepare('DELETE FROM Punchlists WHERE SubsystemId = ?'),
  cleanOrphanPunchlistItems: db.prepare('DELETE FROM PunchlistItems WHERE PunchlistId NOT IN (SELECT id FROM Punchlists)'),
  insertPunchlist: db.prepare('INSERT OR REPLACE INTO Punchlists (id, Name, SubsystemId) VALUES (?, ?, ?)'),
  insertPunchlistItem: db.prepare('INSERT OR IGNORE INTO PunchlistItems (PunchlistId, IoId) VALUES (?, ?)'),
  // L2
  insertL2Sheet: db.prepare('INSERT INTO L2Sheets (CloudId, Name, DisplayName, DisplayOrder, Discipline, DeviceCount) VALUES (?, ?, ?, ?, ?, ?)'),
  insertL2Col: db.prepare('INSERT INTO L2Columns (CloudId, SheetId, Name, ColumnType, DisplayOrder, IsRequired, Description) VALUES (?, ?, ?, ?, ?, ?, ?)'),
  insertL2Dev: db.prepare('INSERT INTO L2Devices (CloudId, SheetId, DeviceName, Mcm, Subsystem, DisplayOrder, CompletedChecks, TotalChecks) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'),
  insertL2Cell: db.prepare('INSERT OR REPLACE INTO L2CellValues (CloudCellId, DeviceId, ColumnId, Value, UpdatedBy, UpdatedAt, Version) VALUES (?, ?, ?, ?, ?, ?, ?)'),
}

/** Classify IO description into a tagType for diagnostic steps */
function classifyDescription(desc: string | null): string | null {
  if (!desc) return null
  const dl = desc.toLowerCase()
  if (dl.includes('beacon')) return 'BCN 24V Segment 1'
  if (dl.includes('pushbutton light') || dl.includes('pb_lt') || dl.includes('pblt') || (dl.includes('button') && dl.includes('light')))
    return 'Button Light'
  if (dl.includes('pushbutton') || dl.includes('push button'))
    return 'Button Press'
  if (dl.includes('photoeye') || dl.includes('tpe'))
    return 'TPE Dark Operated'
  if (dl.includes('vfd') || dl.includes('motor'))
    return 'Motor/VFD'
  if (dl.includes('disconnect'))
    return 'Disconnect Switch'
  if (dl.includes('light') || dl.includes('lamp') || dl.includes('indicator'))
    return 'Indicator Light'
  if (dl.includes('sensor') || dl.includes('prox'))
    return 'Sensor'
  if (dl.includes('valve') || dl.includes('solenoid'))
    return 'Valve/Solenoid'
  if (dl.includes('safety') || dl.includes('e-stop') || dl.includes('estop'))
    return 'Safety Device'
  return null
}

/**
 * POST /api/cloud/pull
 *
 * Pull IOs from cloud PostgreSQL server and store in local SQLite.
 * Uses upsert to preserve existing test data (results, timestamps, comments).
 * Auto-backs up the database before making changes.
 */
export async function POST(request: NextRequest): Promise<NextResponse<CloudPullResponse>> {
  try {
    const body = await request.json()
    const { remoteUrl, apiPassword } = body
    const subsystemId = typeof body.subsystemId === 'string'
      ? parseInt(body.subsystemId, 10)
      : body.subsystemId

    // Validate required fields
    if (!remoteUrl) {
      return NextResponse.json(
        { success: false, error: 'Remote URL is required' },
        { status: 400 }
      )
    }

    if (!subsystemId || isNaN(subsystemId) || subsystemId <= 0) {
      return NextResponse.json(
        { success: false, error: 'Valid subsystem ID is required' },
        { status: 400 }
      )
    }

    console.log(`[CloudPull] Starting pull for subsystem ${subsystemId} from ${remoteUrl}`)
    console.log(`[CloudPull] API Password provided: ${apiPassword ? 'yes (' + apiPassword.length + ' chars)' : 'no'}`)

    // Check for un-synced data
    const pendingRow = pullStmts.pendingCount.get() as { cnt: number }
    const pendingCount = pendingRow.cnt
    const forceFlag = body.force === true
    if (pendingCount > 0 && !forceFlag) {
      return NextResponse.json(
        { success: false, error: `${pendingCount} test results have not been synced to cloud yet. Sync first, or use force=true to proceed anyway.` },
        { status: 409 }
      )
    }

    // Auto-backup before destructive operation
    try {
      const backup = await createBackup('pre-pull')
      console.log(`[CloudPull] Auto-backup created: ${backup.filename}`)
    } catch (backupErr) {
      console.error('[CloudPull] Backup failed:', backupErr)
      // Continue anyway — backup failure shouldn't block the pull
    }

    // Direct fetch to cloud API
    const cloudUrl = `${remoteUrl}/api/sync/subsystem/${subsystemId}`
    console.log(`[CloudPull] Fetching from: ${cloudUrl}`)

    const cloudResponse = await fetch(cloudUrl, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': apiPassword || '',
      },
    })

    console.log(`[CloudPull] Cloud response status: ${cloudResponse.status}`)

    if (cloudResponse.status === 401) {
      return NextResponse.json(
        { success: false, error: 'Cloud authentication failed - check API password' },
        { status: 403 }
      )
    }

    if (!cloudResponse.ok) {
      const errorText = await cloudResponse.text()
      console.log(`[CloudPull] Cloud error: ${errorText}`)
      return NextResponse.json(
        { success: false, error: `Cloud server error: ${cloudResponse.status}` },
        { status: 502 }
      )
    }

    const cloudData = await cloudResponse.json()
    console.log(`[CloudPull] Cloud response keys: ${Object.keys(cloudData)}`)

    // Extract IOs from response (handle both ios and Ios)
    const cloudIos = cloudData.ios || cloudData.Ios || []
    console.log(`[CloudPull] IOs extracted: ${cloudIos.length}`)

    if (!cloudIos || cloudIos.length === 0) {
      return NextResponse.json({
        success: true,
        message: `No IOs found for subsystem ${subsystemId}`,
        iosCount: 0,
        ioCount: 0,
        debug: {
          apiPasswordProvided: !!apiPassword,
          apiPasswordLength: apiPassword?.length || 0,
          cloudStatus: cloudResponse.status,
          cloudResponseKeys: Object.keys(cloudData),
        }
      })
    }

    console.log(`[CloudPull] Retrieved ${cloudIos.length} IOs from cloud, upserting to local database...`)

    // Safety check: warn if cloud has significantly fewer IOs than local
    const localCountRow = pullStmts.ioCount.get() as { cnt: number }
    const localIoCount = localCountRow.cnt
    let pullWarning: string | undefined
    if (localIoCount > 0 && cloudIos.length < localIoCount) {
      const reduction = ((localIoCount - cloudIos.length) / localIoCount) * 100
      if (reduction > 50) {
        pullWarning = `Cloud returned ${cloudIos.length} IOs but local has ${localIoCount} (${reduction.toFixed(0)}% fewer). Proceeding as requested.`
        console.warn(`[CloudPull] WARNING: ${pullWarning}`)
      }
    }

    // Upsert IOs in a transaction
    const result = db.transaction(() => {
      // Ensure default project exists
      const existingProject = pullStmts.getProject.get(1)
      if (!existingProject) {
        pullStmts.insertProject.run(1, 'Default Project')
      }

      // Ensure subsystem exists
      const existingSubsystem = pullStmts.getSubsystem.get(subsystemId)
      if (!existingSubsystem) {
        pullStmts.insertSubsystem.run(
          subsystemId, 1, `Subsystem ${subsystemId}`
        )
      }
      console.log(`[CloudPull] Ensured subsystem ${subsystemId} exists`)

      // Clear ALL existing data before pulling fresh — ensures no stale data from previous subsystem
      const beforeCount = (pullStmts.ioCount.get() as any).cnt
      const deleteResult = pullStmts.deleteAllIos.run()
      console.log(`[CloudPull] DELETE FROM Ios: had ${beforeCount}, deleted ${deleteResult.changes}`)
      const afterCount = (pullStmts.ioCount.get() as any).cnt
      console.log(`[CloudPull] After delete: ${afterCount} IOs remaining`)
      db.exec('DELETE FROM EStopIoPoints')
      db.exec('DELETE FROM EStopVfds')
      db.exec('DELETE FROM EStopEpcs')
      db.exec('DELETE FROM EStopZones')
      db.exec('DELETE FROM SafetyZoneDrives')
      db.exec('DELETE FROM SafetyZones')
      db.exec('DELETE FROM SafetyOutputs')
      db.exec('DELETE FROM NetworkPorts')
      db.exec('DELETE FROM NetworkNodes')
      db.exec('DELETE FROM NetworkRings')
      db.exec('DELETE FROM Punchlists')
      db.exec('DELETE FROM PunchlistItems')
      db.exec('DELETE FROM L2CellValues')
      db.exec('DELETE FROM L2Devices')
      db.exec('DELETE FROM L2Columns')
      db.exec('DELETE FROM L2Sheets')
      console.log('[CloudPull] Cleared all related data (safety, network, punchlists, L2)')

      // Prepare the upsert statement
      const upsertStmt = pullStmts.upsertIo

      let upsertedCount = 0

      for (const cloudIo of cloudIos) {
        if (!cloudIo.name || cloudIo.id <= 0) {
          console.warn(`[CloudPull] Skipping invalid IO: id=${cloudIo.id}, name=${cloudIo.name}`)
          continue
        }

        try {
          upsertStmt.run(
            cloudIo.id,
            subsystemId,
            cloudIo.name,
            cloudIo.description ?? null,
            cloudIo.order ?? null,
            Number(cloudIo.version) || 0,
            cloudIo.tagType ?? null,
            cloudIo.result ?? null,
            cloudIo.timestamp ?? null,
            cloudIo.comments ?? null,
            cloudIo.networkDeviceName ?? null,
            cloudIo.installationStatus ?? null,
            cloudIo.installationPercent ?? null,
            cloudIo.poweredUp === true ? 1 : cloudIo.poweredUp === false ? 0 : null,
          )
          upsertedCount++
        } catch (error) {
          console.error(`[CloudPull] Failed to upsert IO ${cloudIo.id}:`, error)
        }
      }

      // Auto-populate networkDeviceName from tag name for any IOs still missing it
      // extractDeviceName imported at top of file
      const iosWithoutDevice = pullStmts.getIosWithoutDevice.all() as { id: number; Name: string }[]

      const updateDeviceStmt = pullStmts.updateDeviceName
      for (const io of iosWithoutDevice) {
        const deviceName = extractDeviceName(io.Name)
        if (deviceName) {
          updateDeviceStmt.run(deviceName, io.id)
        }
      }

      // Don't delete PendingSyncs — they should persist until actually synced

      return upsertedCount
    })()

    console.log(`[CloudPull] Successfully upserted ${result} IOs to local database`)

    // Pull test histories from cloud response
    const cloudHistories = cloudData.testHistories || []
    let historiesPulled = 0
    if (cloudHistories.length > 0) {
      try {
        db.transaction(() => {
          // Clear existing test histories for the pulled IOs
          pullStmts.deleteHistories.run()

          const insertHistoryStmt = pullStmts.insertHistory

          for (const h of cloudHistories) {
            if (!h.ioId || !h.timestamp) continue
            try {
              insertHistoryStmt.run(
                h.ioId,
                h.result ?? null,
                h.timestamp,
                h.comments ?? null,
                h.testedBy ?? null,
                h.state ?? null,
              )
              historiesPulled++
            } catch {
              // Skip individual history records that fail (e.g. FK constraint if IO was filtered)
            }
          }
        })()
        console.log(`[CloudPull] Pulled ${historiesPulled} test history records from cloud`)
      } catch (e) {
        console.error('[CloudPull] Test history pull failed:', e)
      }
    }

    // Auto-assign tagType from descriptions for IOs that don't have one
    try {
      const untyped = pullStmts.getUntypedIos.all() as { id: number; Description: string | null }[]

      let assigned = 0
      const updateTagTypeStmt = pullStmts.updateTagType
      for (const io of untyped) {
        const tagType = classifyDescription(io.Description)
        if (tagType) {
          updateTagTypeStmt.run(tagType, io.id)
          assigned++
        }
      }
      if (assigned > 0) {
        console.log(`[CloudPull] Auto-assigned tagType to ${assigned} IOs based on descriptions`)
      }
    } catch (error) {
      console.error('[CloudPull] Error assigning tag types:', error)
    }

    // Persist cloud config to disk so it survives restarts
    try {
      const { configService } = await import('@/lib/config')
      await configService.saveConfig({
        remoteUrl: remoteUrl,
        apiPassword: apiPassword,
        subsystemId: String(subsystemId),
      })
      console.log('[CloudPull] Cloud config saved to config.json')
    } catch (e) {
      console.warn('[CloudPull] Failed to save config:', e)
    }

    // Fetch real project + subsystem names from cloud and update local DB
    try {
      const infoUrl = `${remoteUrl}/api/sync/subsystem-info/${subsystemId}`
      const infoRes = await fetch(infoUrl, {
        headers: { 'X-API-Key': apiPassword || '' },
      })
      if (infoRes.ok) {
        const info = await infoRes.json()
        if (info.projectName) {
          pullStmts.updateProjectName.run(info.projectName, subsystemId)
        }
        if (info.subsystemName) {
          pullStmts.updateSubsystemName.run(info.subsystemName, subsystemId)
        }
        console.log(`[CloudPull] Updated names: ${info.projectName} / ${info.subsystemName}`)
      }
    } catch (e) {
      // Non-critical — names just stay as placeholders
    }

    // Mark CloudSyncService as connected (it reads config from configService on demand)
    try {
      const { getCloudSyncService } = await import('@/lib/cloud/cloud-sync-service')
      const syncService = getCloudSyncService()
      syncService.setConnectionState('connected')
    } catch (e) {
      console.warn('[CloudPull] Failed to update sync service state:', e)
    }

    // Mark manual pull so auto-sync doesn't overwrite with stale subsystem data
    try {
      const { startAutoSync, getAutoSyncService } = await import('@/lib/cloud/auto-sync')
      const service = getAutoSyncService()
      if (service) {
        service.markManualPull()
      }
      if (!service?.running) {
        startAutoSync()
        console.log('[CloudPull] Auto-sync started after successful pull')
      }
    } catch (e) {
      console.warn('[CloudPull] Failed to start auto-sync:', e)
    }

    // Broadcast to all clients to reload their IO data
    console.log('[CloudPull] Broadcasting IO update to WebSocket clients...')
    try {
      await fetch(getWsBroadcastUrl(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'IOsUpdated', count: result }),
        signal: AbortSignal.timeout(5000),
      })
      console.log('[CloudPull] Broadcast sent')
    } catch (e) {
      console.log('[CloudPull] Broadcast skipped:', (e as Error).message)
    }

    console.log('[CloudPull] Starting network/estop/safety/punchlist pull...')
    // Also pull network + estop data alongside IOs (non-blocking, direct DB writes — no self-referential HTTP)
    let networkPulled = 0
    let estopPulled = 0

    // Pull network topology directly
    try {
      const netUrl = `${remoteUrl}/api/network?subsystemId=${subsystemId}`
      console.log(`[CloudPull] Fetching network from: ${netUrl}`)
      const netRes = await fetch(netUrl, {
        headers: { 'Content-Type': 'application/json', 'X-API-Key': apiPassword || '' },
        signal: AbortSignal.timeout(15000),
      })
      console.log(`[CloudPull] Network response: ${netRes.status}`)
      if (netRes.ok) {
        const netData = await netRes.json()
        console.log(`[CloudPull] Network data: success=${netData.success}, rings=${netData.rings?.length || 0}`)
        if (netData.success && netData.rings?.length > 0) {
          // Clear existing network data for this subsystem
          pullStmts.deleteNetworkRings.run(subsystemId)

          const insertRingStmt = pullStmts.insertRing
          const insertNodeStmt = pullStmts.insertNode
          const insertPortStmt = pullStmts.insertPort

          for (const ring of netData.rings) {
            const ringResult = insertRingStmt.run(subsystemId, ring.name, ring.mcmName, ring.mcmIp || null, ring.mcmTag || null)
            const ringId = ringResult.lastInsertRowid

            for (const node of (ring.nodes || [])) {
              const nodeResult = insertNodeStmt.run(ringId, node.name, node.position, node.ipAddress || null, node.cableIn || null, node.cableOut || null, node.statusTag || null, node.totalPorts || 28)
              const nodeId = nodeResult.lastInsertRowid

              // First pass: insert ports without parentPortId
              const portIdMap = new Map<string, number>()
              for (const port of (node.ports || [])) {
                const portResult = insertPortStmt.run(nodeId, port.portNumber, port.cableLabel || null, port.deviceName || null, port.deviceType || null, port.deviceIp || null, port.statusTag || null, null)
                if (port.deviceName) portIdMap.set(port.deviceName, Number(portResult.lastInsertRowid))
              }

              // Second pass: link sub-ports to parent FIOM ports
              for (const port of (node.ports || [])) {
                if (port.parentDeviceName && portIdMap.has(port.parentDeviceName)) {
                  const childId = portIdMap.get(port.deviceName)
                  const parentId = portIdMap.get(port.parentDeviceName)
                  if (childId && parentId) {
                    pullStmts.updatePortParent.run(parentId, childId)
                  }
                }
              }
            }
          }
          networkPulled = netData.rings.length
          console.log(`[CloudPull] Network: ${networkPulled} rings pulled directly`)
        }
      }
    } catch (e) {
      console.log('[CloudPull] Network pull failed (non-critical):', (e as Error).message)
    }

    // Pull estop data directly
    try {
      const estopRes = await fetch(`${remoteUrl}/api/sync/estop?subsystemId=${subsystemId}`, {
        headers: { 'Content-Type': 'application/json', 'X-API-Key': apiPassword || '' },
        signal: AbortSignal.timeout(15000),
      })
      if (estopRes.ok) {
        const estopData = await estopRes.json()
        if (estopData.success && estopData.zones?.length > 0) {
          // Already cleared at start of pull
          const insertZoneStmt = pullStmts.insertEStopZone
          const insertEpcStmt = pullStmts.insertEpc
          const insertIoPointStmt = pullStmts.insertIoPoint
          const insertVfdStmt = pullStmts.insertVfd

          for (const zone of estopData.zones) {
            const zoneResult = insertZoneStmt.run(subsystemId, zone.name)
            const zoneId = zoneResult.lastInsertRowid
            for (const epc of (zone.epcs || [])) {
              const epcResult = insertEpcStmt.run(zoneId, epc.name, epc.checkTag)
              const epcId = epcResult.lastInsertRowid
              for (const io of (epc.ioPoints || [])) {
                insertIoPointStmt.run(epcId, io.tag)
              }
              for (const vfd of (epc.vfds || [])) {
                insertVfdStmt.run(epcId, vfd.tag, vfd.stoTag, vfd.mustStop ? 1 : 0)
              }
            }
          }
          estopPulled = estopData.zones.length
          console.log(`[CloudPull] EStop: ${estopPulled} zones pulled directly`)
        }
      }
    } catch (e) {
      console.log('[CloudPull] EStop pull failed (non-critical):', (e as Error).message)
    }

    // Pull safety data
    try {
      const safetyRes = await fetch(`${remoteUrl}/api/sync/safety?subsystemId=${subsystemId}&apiKey=${apiPassword}`)
      if (safetyRes.ok) {
        const safetyData = await safetyRes.json()
        if (safetyData.success) {
          // Already cleared at start of pull

          const insertZoneStmt = pullStmts.insertSafetyZone
          const insertDriveStmt = pullStmts.insertSafetyDrive
          for (const zone of (safetyData.zones || [])) {
            const zoneResult = insertZoneStmt.run(subsystemId, zone.name, zone.stoSignal, zone.bssTag)
            const zoneId = zoneResult.lastInsertRowid
            for (const d of (zone.drives || [])) {
              insertDriveStmt.run(zoneId, d.name)
            }
          }

          if (safetyData.outputs?.length > 0) {
            const insertOutputStmt = db.prepare(
              'INSERT INTO SafetyOutputs (SubsystemId, Tag, Description, OutputType) VALUES (?, ?, ?, ?)'
            )
            for (const o of safetyData.outputs) {
              insertOutputStmt.run(subsystemId, o.tag, o.description, o.outputType)
            }
          }
          console.log(`[Pull] Safety: ${safetyData.zones?.length || 0} zones, ${safetyData.outputs?.length || 0} outputs`)
        }
      }
    } catch (e) {
      console.log('[Pull] Safety data pull failed (non-blocking)')
    }

    // Pull punchlists (non-blocking)
    let punchlistsPulled = 0
    try {
      const plRes = await fetch(`${remoteUrl}/api/sync/punchlists?subsystemId=${subsystemId}`, {
        headers: { 'Content-Type': 'application/json', 'X-API-Key': apiPassword || '' },
        signal: AbortSignal.timeout(10000),
      })
      if (plRes.ok) {
        const plData = await plRes.json()
        if (plData.punchlists && plData.punchlists.length > 0) {
          pullStmts.deletePunchlists.run(subsystemId)
          // Also clean up orphaned PunchlistItems for deleted punchlists
          pullStmts.cleanOrphanPunchlistItems.run()
          const insertPl = pullStmts.insertPunchlist
          const insertItem = pullStmts.insertPunchlistItem
          for (const pl of plData.punchlists) {
            insertPl.run(pl.id, pl.name, subsystemId)
            for (const ioId of pl.ioIds) {
              insertItem.run(pl.id, ioId)
            }
            punchlistsPulled++
          }
          console.log(`[CloudPull] Pulled ${punchlistsPulled} punchlists`)
        }
      }
    } catch {
      console.log('[CloudPull] Punchlist pull skipped or failed (non-blocking)')
    }

    // Pull L2 Functional Validation data (non-blocking)
    let l2Pulled = 0
    try {
      const l2Res = await fetch(`${remoteUrl}/api/sync/l2/${subsystemId}`, {
        headers: { 'Content-Type': 'application/json', 'X-API-Key': apiPassword || '' },
        signal: AbortSignal.timeout(15000),
      })
      if (l2Res.ok) {
        const l2Data = await l2Res.json()
        if (l2Data.success && l2Data.sheets?.length > 0) {
          // Clear and re-insert L2 data
          db.exec('DELETE FROM L2CellValues')
          db.exec('DELETE FROM L2Devices')
          db.exec('DELETE FROM L2Columns')
          db.exec('DELETE FROM L2Sheets')

          const sheetIdMap = new Map<number, number>()
          const columnIdMap = new Map<number, number>()
          const deviceIdMap = new Map<number, number>()

          const insertSheet = pullStmts.insertL2Sheet
          const insertCol = pullStmts.insertL2Col
          const insertDev = pullStmts.insertL2Dev
          const insertCell = pullStmts.insertL2Cell

          for (const sheet of l2Data.sheets) {
            const sr = insertSheet.run(sheet.id, sheet.name, sheet.displayName, sheet.displayOrder, sheet.discipline, sheet.deviceCount || 0)
            sheetIdMap.set(sheet.id, sr.lastInsertRowid as number)
            if (sheet.columns) {
              for (const col of sheet.columns) {
                const cr = insertCol.run(col.id, sr.lastInsertRowid, col.name, col.columnType, col.displayOrder, col.isRequired ? 1 : 0, col.description || null)
                columnIdMap.set(col.id, cr.lastInsertRowid as number)
              }
            }
          }
          for (const dev of (l2Data.devices || [])) {
            const localSheetId = sheetIdMap.get(dev.sheetId)
            if (!localSheetId) continue
            const dr = insertDev.run(dev.id, localSheetId, dev.deviceName, dev.mcm, dev.subsystem, dev.displayOrder, dev.completedChecks || 0, dev.totalChecks || 0)
            deviceIdMap.set(dev.id, dr.lastInsertRowid as number)
            l2Pulled++
          }
          for (const cell of (l2Data.cellValues || [])) {
            const ld = deviceIdMap.get(cell.deviceId)
            const lc = columnIdMap.get(cell.columnId)
            if (ld && lc) insertCell.run(cell.id, ld, lc, cell.value, cell.updatedBy, cell.updatedAt, Number(cell.version) || 0)
          }
          console.log(`[CloudPull] Pulled L2 data: ${l2Data.sheets.length} sheets, ${l2Pulled} devices`)
        }
      }
    } catch {
      console.log('[CloudPull] L2 pull skipped or failed (non-blocking)')
    }

    return NextResponse.json({
      success: true,
      message: `Successfully pulled ${result} IOs from cloud`,
      iosCount: result,
      ioCount: result,
      networkPulled,
      estopPulled,
      punchlistsPulled,
      l2Pulled,
      historiesPulled,
      ...(pullWarning ? { warning: pullWarning } : {}),
      debug: {
        cloudIosLength: cloudIos.length,
        cloudResponseKeys: Object.keys(cloudData),
        firstIoId: cloudIos[0]?.id,
        firstIoName: cloudIos[0]?.name,
      }
    })
  } catch (error) {
    console.error('[CloudPull] Error pulling IOs from cloud:', error)

    const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred'

    if (errorMessage.includes('Authentication failed') || errorMessage.includes('401')) {
      return NextResponse.json(
        { success: false, error: 'Cloud authentication failed - check API password' },
        { status: 403 }
      )
    }

    return NextResponse.json(
      { success: false, error: errorMessage },
      { status: 500 }
    )
  }
}
