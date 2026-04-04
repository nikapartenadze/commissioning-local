export const dynamic = 'force-dynamic'

import { NextResponse } from 'next/server'
import { db } from '@/lib/db-sqlite'

export async function GET() {
  try {
    const rawOutputs = db.prepare('SELECT * FROM SafetyOutputs ORDER BY Tag ASC').all() as any[]
    const outputs = rawOutputs.map((o: any) => ({
      id: o.id,
      subsystemId: o.SubsystemId,
      tag: o.Tag,
      description: o.Description,
      outputType: o.OutputType,
    }))
    return NextResponse.json({ success: true, outputs })
  } catch (error) {
    return NextResponse.json({ success: false, error: 'Failed to fetch safety outputs' }, { status: 500 })
  }
}
