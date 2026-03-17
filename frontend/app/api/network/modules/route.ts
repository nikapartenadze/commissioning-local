export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server'

export async function GET() {
  // Return empty modules list - network diagnostics not yet implemented in Node.js
  return NextResponse.json({
    success: true,
    modules: [],
    timestamp: new Date().toISOString(),
  })
}
