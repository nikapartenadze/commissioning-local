import { Request, Response } from 'express'
import { db } from '@/lib/db-sqlite'

export async function GET(req: Request, res: Response) {
  try {
    const rawOutputs = db.prepare('SELECT * FROM SafetyOutputs ORDER BY Tag ASC').all() as any[]
    const outputs = rawOutputs.map((o: any) => ({ id: o.id, subsystemId: o.SubsystemId, tag: o.Tag, description: o.Description, outputType: o.OutputType }))
    return res.json({ success: true, outputs })
  } catch (error) {
    return res.status(500).json({ success: false, error: 'Failed to fetch safety outputs' })
  }
}
