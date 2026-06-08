import { Request, Response } from 'express'
import fs from 'fs'
import path from 'path'
import { resolveLogsDirPath } from '@/lib/storage-paths'

/**
 * GET /api/logs/tail?source=app|errors|gateway&lines=N
 *
 * Returns the last N lines of a log file for the in-UI log viewer. Read-only
 * and cheap: it reads only the final ~512 KB of the file (not the whole thing),
 * so polling it every few seconds puts no measurable load on the server and
 * never touches the PLC/sync paths. Path is locked to the logs directory —
 * `source` is an allow-list, never a user-supplied path.
 */
const MAX_LINES = 2000
const TAIL_BYTES = 512 * 1024 // only read the last chunk of large daily logs

function todaysDated(dir: string, base: string): string | null {
  // base like "app" → app-YYYY-MM-DD.log; fall back to the most recent dated file.
  const today = new Date().toISOString().slice(0, 10)
  const exact = path.join(dir, `${base}-${today}.log`)
  if (fs.existsSync(exact)) return exact
  try {
    const matches = fs
      .readdirSync(dir)
      .filter((f) => f.startsWith(`${base}-`) && f.endsWith('.log'))
      .sort()
    return matches.length ? path.join(dir, matches[matches.length - 1]) : null
  } catch {
    return null
  }
}

function resolveSource(dir: string, source: string): { file: string | null; label: string } {
  switch (source) {
    case 'gateway':
      return { file: path.join(dir, 'gateway.log'), label: 'gateway.log' }
    case 'gateway-error':
      return { file: path.join(dir, 'gateway-error.log'), label: 'gateway-error.log' }
    case 'tags':
      return { file: todaysDated(dir, 'tag-events'), label: 'tag changes (today)' }
    case 'errors':
      return { file: todaysDated(dir, 'errors'), label: 'errors (today)' }
    case 'app':
    default:
      return { file: todaysDated(dir, 'app'), label: 'app (today)' }
  }
}

function tailFile(file: string, maxLines: number): { lines: string[]; size: number } {
  const stat = fs.statSync(file)
  const start = Math.max(0, stat.size - TAIL_BYTES)
  const fd = fs.openSync(file, 'r')
  try {
    const len = stat.size - start
    const buf = Buffer.alloc(len)
    fs.readSync(fd, buf, 0, len, start)
    let text = buf.toString('utf8')
    if (start > 0) {
      // drop a partial first line so we don't show a mid-line fragment
      const nl = text.indexOf('\n')
      if (nl >= 0) text = text.slice(nl + 1)
    }
    const all = text.split(/\r?\n/).filter((l) => l.length > 0)
    return { lines: all.slice(-maxLines), size: stat.size }
  } finally {
    fs.closeSync(fd)
  }
}

export async function GET(req: Request, res: Response) {
  try {
    const dir = resolveLogsDirPath()
    const source = String(req.query.source ?? 'app')
    let lines = parseInt(String(req.query.lines ?? '300'), 10)
    if (!Number.isFinite(lines) || lines < 1) lines = 300
    lines = Math.min(lines, MAX_LINES)

    const { file, label } = resolveSource(dir, source)
    if (!file || !fs.existsSync(file)) {
      return res.json({ success: true, source, label, lines: [], note: `no ${label} log yet` })
    }
    const { lines: out, size } = tailFile(file, lines)
    return res.json({ success: true, source, label, file: path.basename(file), sizeBytes: size, lines: out })
  } catch (error) {
    return res.status(500).json({ success: false, error: error instanceof Error ? error.message : 'log read failed' })
  }
}
