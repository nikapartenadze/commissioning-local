/**
 * Log retention — size cap for daily-rotating files (lib/logging/file-log).
 *
 * Regression guard for the unbounded single-day blowup found 2026-06-24: the
 * daily logger rotated by DAY and pruned by AGE (14 days), but a single day's
 * file had NO size cap. A runaway error/log loop on one day grew app-2026-06-20
 * to 127 MB and errors-2026-06-20 to another 127 MB — ~244 MB total — while
 * staying entirely inside the 14-day retention window. appendDailyLog must cap
 * each dated file's size and keep only a bounded number of size-rolls, so the
 * log dir stays bounded even within a single day.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

let tmp: string
let logDir: string
const today = new Date().toISOString().slice(0, 10)

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'logret-'))
  logDir = path.join(tmp, 'logs')
  fs.mkdirSync(logDir, { recursive: true })
  delete process.env.LOG_MAX_FILE_BYTES
  delete process.env.LOG_MAX_ROLLS
  // Caps are read once at module load — reset so each test's env takes effect.
  vi.resetModules()
})

afterEach(() => {
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* ignore */ }
  delete process.env.LOG_MAX_FILE_BYTES
  delete process.env.LOG_MAX_ROLLS
})

describe('appendDailyLog size cap', () => {
  it('rolls the dated file once it exceeds LOG_MAX_FILE_BYTES so no single file grows unbounded', async () => {
    process.env.LOG_MAX_FILE_BYTES = '1024' // 1 KB cap for the test
    process.env.LOG_MAX_ROLLS = '3'
    const { appendDailyLog } = await import('@/lib/logging/file-log')
    const base = path.join(logDir, 'app.log')
    const active = path.join(logDir, `app-${today}.log`)

    // Write well past the cap (~10 KB) in 200-byte lines.
    const line = 'x'.repeat(200)
    for (let i = 0; i < 50; i++) appendDailyLog(base, line)

    // The active dated file must be bounded near the cap, not 10 KB.
    expect(fs.statSync(active).size).toBeLessThanOrEqual(1024 + 400)

    // Size-rolls exist (app-<day>.log.1, .2, ...) and are bounded in count.
    const rolls = fs.readdirSync(logDir).filter((f) => /^app-.*\.log\.\d+$/.test(f))
    expect(rolls.length).toBeGreaterThan(0)
    expect(rolls.length).toBeLessThanOrEqual(3)
  })

  it('keeps at most LOG_MAX_ROLLS rolled files, deleting the oldest', async () => {
    process.env.LOG_MAX_FILE_BYTES = '512'
    process.env.LOG_MAX_ROLLS = '2'
    const { appendDailyLog } = await import('@/lib/logging/file-log')
    const base = path.join(logDir, 'errors.log')

    const line = 'e'.repeat(200)
    for (let i = 0; i < 80; i++) appendDailyLog(base, line) // many rolls

    const rolls = fs.readdirSync(logDir).filter((f) => /^errors-.*\.log\.\d+$/.test(f))
    expect(rolls.length).toBeLessThanOrEqual(2)
  })

  it('prunes old size-rolls (app-<oldday>.log.N) past the retention window, not just the plain dated file', async () => {
    process.env.LOG_RETENTION_DAYS = '14'
    const { appendDailyLog } = await import('@/lib/logging/file-log')
    const base = path.join(logDir, 'app.log')
    const oldDay = new Date(Date.now() - 20 * 24 * 3600 * 1000).toISOString().slice(0, 10)
    const oldRoll = path.join(logDir, `app-${oldDay}.log.1`)
    const oldPlain = path.join(logDir, `app-${oldDay}.log`)
    fs.writeFileSync(oldRoll, 'old roll')
    fs.writeFileSync(oldPlain, 'old plain')

    // A fresh append triggers the once-per-day prune sweep.
    appendDailyLog(base, 'new line')

    expect(fs.existsSync(oldRoll)).toBe(false)  // size-roll pruned
    expect(fs.existsSync(oldPlain)).toBe(false) // plain dated file pruned
    expect(fs.existsSync(path.join(logDir, `app-${today}.log`))).toBe(true) // today kept
    delete process.env.LOG_RETENTION_DAYS
  })

  it('never throws and still appends when no cap env is set (default cap is generous)', async () => {
    const { appendDailyLog } = await import('@/lib/logging/file-log')
    const base = path.join(logDir, 'app.log')
    expect(() => appendDailyLog(base, 'hello')).not.toThrow()
    const active = path.join(logDir, `app-${today}.log`)
    expect(fs.readFileSync(active, 'utf8')).toContain('hello')
  })
})
