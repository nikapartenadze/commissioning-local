export const dynamic = 'force-dynamic'

import { NextResponse } from 'next/server'
import { db } from '@/lib/db-sqlite'

export async function GET() {
  try {
    const outputs = db.prepare('SELECT * FROM SafetyOutputs ORDER BY Tag ASC').all()
    return NextResponse.json({ success: true, outputs })
  } catch (error) {
    return NextResponse.json({ success: false, error: 'Failed to fetch safety outputs' }, { status: 500 })
  }
}
