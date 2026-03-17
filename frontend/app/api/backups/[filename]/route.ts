export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server'
import fs from 'fs'
import path from 'path'
import { getBackupDbPath, deleteBackup } from '@/lib/db/backup'

interface RouteParams {
  params: Promise<{ filename: string }>
}

/**
 * GET /api/backups/[filename] — Download a backup file
 */
export async function GET(_request: NextRequest, { params }: RouteParams) {
  try {
    const { filename } = await params

    // Validate filename
    if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
      return NextResponse.json({ success: false, error: 'Invalid filename' }, { status: 400 })
    }

    const backupsDir = getBackupDbPath()
    const filePath = path.join(backupsDir, filename)

    // Verify path is within backups dir
    const resolved = path.resolve(filePath)
    if (!resolved.startsWith(path.resolve(backupsDir))) {
      return NextResponse.json({ success: false, error: 'Invalid filename' }, { status: 400 })
    }

    if (!fs.existsSync(filePath)) {
      return NextResponse.json({ success: false, error: 'Backup not found' }, { status: 404 })
    }

    const fileBuffer = fs.readFileSync(filePath)
    const stats = fs.statSync(filePath)

    return new NextResponse(fileBuffer, {
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Content-Length': stats.size.toString(),
      },
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    return NextResponse.json({ success: false, error: message }, { status: 500 })
  }
}

/**
 * DELETE /api/backups/[filename] — Delete a backup
 */
export async function DELETE(_request: NextRequest, { params }: RouteParams) {
  try {
    const { filename } = await params
    await deleteBackup(filename)
    return NextResponse.json({ success: true })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    const status = message === 'Backup not found' ? 404 : message.includes('Invalid') ? 400 : 500
    return NextResponse.json({ success: false, error: message }, { status })
  }
}
