import { Request, Response } from 'express'
import { db } from '@/lib/db-sqlite'

export async function GET(req: Request, res: Response) {
  try {
    const subsystemId = parseInt(req.params.subsystemId as string)

    if (isNaN(subsystemId)) {
      return res.status(400).json({ error: 'Invalid subsystem ID' })
    }

    const ios = db.prepare('SELECT * FROM Ios WHERE SubsystemId = ? ORDER BY "Order" ASC, Name ASC').all(subsystemId) as any[]

    const transformedIos = ios.map(io => ({
      Id: io.id, Name: io.Name, Description: io.Description, State: null,
      Result: io.Result, Timestamp: io.Timestamp, Comments: io.Comments,
      Order: io.Order, Version: io.Version, SubsystemId: io.SubsystemId
    }))

    return res.json({ Ios: transformedIos })
  } catch (error) {
    console.error('Error fetching subsystem IOs:', error)
    return res.status(500).json({ error: 'Failed to fetch subsystem IOs' })
  }
}
