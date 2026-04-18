import { Request, Response } from 'express'
import { db } from '@/lib/db-sqlite'
import { doesFVColumnCountForProgress, getFVOverviewGroup } from '@/lib/fv-utils'

/**
 * GET /api/l2/overview
 * Returns a progress matrix for the L2 Cover/Overview dashboard.
 * Rows = sheet names (VFD, APF, TPE, etc.)
 * Columns = unique MCM values
 * Each cell = { completed, total, percent, lastTester, lastTestedAt }
 */
export async function GET(req: Request, res: Response) {
  try {
    const sheets = db.prepare('SELECT id, Name, DisplayName FROM L2Sheets ORDER BY DisplayOrder').all() as any[]
    const devices = db.prepare('SELECT id, SheetId, DeviceName, Mcm, CompletedChecks, TotalChecks FROM L2Devices ORDER BY Mcm, DeviceName').all() as any[]
    const columns = db.prepare('SELECT id, SheetId, ColumnType, InputType, IncludeInProgress FROM L2Columns').all() as any[]

    if (sheets.length === 0) {
      return res.json({ hasData: false, sheets: [], mcms: [], matrix: {}, totals: {} })
    }

    // Get unique MCMs sorted
    const mcmSet = new Set<string>()
    for (const d of devices) {
      const groupKey = getFVOverviewGroup(d, sheets.find((sheet) => sheet.id === d.SheetId)?.Name)
      if (groupKey) mcmSet.add(groupKey)
    }
    const mcms = Array.from(mcmSet).sort((a, b) => {
      // Sort MCM01, MCM02, ... naturally
      const numA = parseInt(a.replace(/\D/g, '')) || 0
      const numB = parseInt(b.replace(/\D/g, '')) || 0
      return numA - numB
    })

    // Get check column IDs per sheet
    const checkColsBySheet = new Map<number, number[]>()
    for (const col of columns) {
      if (doesFVColumnCountForProgress(col)) {
        const arr = checkColsBySheet.get(col.SheetId) || []
        arr.push(col.id)
        checkColsBySheet.set(col.SheetId, arr)
      }
    }

    // Get all cell values for check columns
    const allCheckColIds = Array.from(checkColsBySheet.values()).flat()
    let cellValues: any[] = []
    if (allCheckColIds.length > 0) {
      // Query in batches if too many
      cellValues = db.prepare(
        `SELECT cv.DeviceId, cv.ColumnId, cv.Value, cv.UpdatedBy, cv.UpdatedAt
         FROM L2CellValues cv
         WHERE cv.ColumnId IN (${allCheckColIds.join(',')})
         AND cv.Value IS NOT NULL AND cv.Value != ''`
      ).all() as any[]
    }

    // Index cells by deviceId
    const cellsByDevice = new Map<number, any[]>()
    for (const cv of cellValues) {
      const arr = cellsByDevice.get(cv.DeviceId) || []
      arr.push(cv)
      cellsByDevice.set(cv.DeviceId, arr)
    }

    // Build matrix: matrix[sheetName][mcm] = { completed, total, percent, lastTester, lastTestedAt }
    const matrix: Record<string, Record<string, {
      completed: number
      total: number
      percent: number
      lastTester: string | null
      lastTestedAt: string | null
    }>> = {}

    // Sheet totals (row totals)
    const sheetTotals: Record<string, { completed: number; total: number; percent: number }> = {}
    // MCM totals (column totals)
    const mcmTotals: Record<string, { completed: number; total: number; percent: number }> = {}

    for (const mcm of mcms) {
      mcmTotals[mcm] = { completed: 0, total: 0, percent: 0 }
    }

    for (const sheet of sheets) {
      const sheetName = sheet.Name as string
      matrix[sheetName] = {}
      const checkCols = checkColsBySheet.get(sheet.id) || []
      const checkColCount = checkCols.length

      let sheetCompleted = 0
      let sheetTotal = 0

      for (const mcm of mcms) {
        // Devices in this sheet + MCM
        const mcmDevices = devices.filter((d: any) => d.SheetId === sheet.id && getFVOverviewGroup(d, sheet.Name) === mcm)
        const total = mcmDevices.length * checkColCount
        let completed = 0
        let lastTester: string | null = null
        let lastTestedAt: string | null = null

        for (const dev of mcmDevices) {
          const devCells = cellsByDevice.get(dev.id) || []
          // Count completed check cells for this device
          const checkCellsCompleted = devCells.filter((c: any) => checkCols.includes(c.ColumnId))
          completed += checkCellsCompleted.length

          // Track latest tester
          for (const c of checkCellsCompleted) {
            if (c.UpdatedAt && (!lastTestedAt || c.UpdatedAt > lastTestedAt)) {
              lastTestedAt = c.UpdatedAt
              lastTester = c.UpdatedBy
            }
          }
        }

        const percent = total > 0 ? Math.round((completed / total) * 100) : 0
        matrix[sheetName][mcm] = { completed, total, percent, lastTester, lastTestedAt }

        sheetCompleted += completed
        sheetTotal += total
        mcmTotals[mcm].completed += completed
        mcmTotals[mcm].total += total
      }

      sheetTotals[sheetName] = {
        completed: sheetCompleted,
        total: sheetTotal,
        percent: sheetTotal > 0 ? Math.round((sheetCompleted / sheetTotal) * 100) : 0,
      }
    }

    // Compute MCM total percentages
    for (const mcm of mcms) {
      const t = mcmTotals[mcm]
      t.percent = t.total > 0 ? Math.round((t.completed / t.total) * 100) : 0
    }

    // Grand total
    const grandCompleted = Object.values(sheetTotals).reduce((s, t) => s + t.completed, 0)
    const grandTotal = Object.values(sheetTotals).reduce((s, t) => s + t.total, 0)

    return res.json({
      hasData: true,
      sheets: sheets.map((s: any) => ({ name: s.Name, displayName: s.DisplayName })),
      mcms,
      matrix,
      sheetTotals,
      mcmTotals,
      grandTotal: {
        completed: grandCompleted,
        total: grandTotal,
        percent: grandTotal > 0 ? Math.round((grandCompleted / grandTotal) * 100) : 0,
      },
    })
  } catch (error) {
    console.error('[L2 Overview] Error:', error)
    return res.json({ hasData: false, sheets: [], mcms: [], matrix: {}, totals: {} })
  }
}
