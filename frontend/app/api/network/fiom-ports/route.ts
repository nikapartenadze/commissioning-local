import { Request, Response } from 'express'
import { db } from '@/lib/db-sqlite'

export async function GET(req: Request, res: Response) {
  try {
    const fiomName = req.query.fiomName as string | undefined
    const subsystemId = req.query.subsystemId as string | undefined

    if (!fiomName) {
      return res.status(400).json({ error: 'fiomName required' })
    }

    const prefix = `${fiomName}_X%`
    let ios: { Name: string; Description: string | null }[]

    if (subsystemId) {
      ios = db.prepare('SELECT Name, Description FROM Ios WHERE Name LIKE ? AND SubsystemId = ? ORDER BY Name ASC').all(prefix, parseInt(subsystemId, 10)) as any[]
    } else {
      ios = db.prepare('SELECT Name, Description FROM Ios WHERE Name LIKE ? ORDER BY Name ASC').all(prefix) as any[]
    }

    const portMap = new Map<number, { portNum: number; pins: { pin: number; type: string; ioName: string; description: string }[] }>()

    for (const io of ios) {
      const match = (io.Name ?? '').match(/_X(\d+)\.PIN(\d+)_(D[IO])$/)
      if (!match) continue
      const portNum = parseInt(match[1]), pinNum = parseInt(match[2]), pinType = match[3]
      if (!portMap.has(portNum)) portMap.set(portNum, { portNum, pins: [] })
      portMap.get(portNum)!.pins.push({ pin: pinNum, type: pinType, ioName: io.Name ?? '', description: io.Description || 'SPARE' })
    }

    const ports = Array.from(portMap.values()).sort((a, b) => a.portNum - b.portNum)

    return res.json({ success: true, fiomName, totalPorts: ports.length, ports })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    return res.status(500).json({ success: false, error: message })
  }
}
