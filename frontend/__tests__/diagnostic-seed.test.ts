import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

describe('seed-diagnostics required rows', () => {
  const src = readFileSync(
    join(__dirname, '..', 'lib', 'db', 'seed-diagnostics.ts'),
    'utf8',
  )

  it('seeds an EPC -> Needs proper tension entry', () => {
    expect(src).toMatch(/tagType:\s*'EPC',\s*failureMode:\s*'Needs proper tension'/)
  })

  it('seeds a TPE Dark Operated -> Needs alignment entry', () => {
    expect(src).toMatch(/tagType:\s*'TPE Dark Operated',\s*failureMode:\s*'Needs alignment'/)
  })

  it('seeds an EPC -> Other entry so the diagnostic dialog has a guide for the Other choice', () => {
    expect(src).toMatch(/tagType:\s*'EPC',\s*failureMode:\s*'Other'/)
  })
})

import Database from 'better-sqlite3'

describe('ensureRequiredDiagnosticRows', () => {
  function makeDb() {
    const d = new Database(':memory:')
    d.exec(`
      CREATE TABLE TagTypeDiagnostics (
        TagType TEXT NOT NULL,
        FailureMode TEXT NOT NULL,
        DiagnosticSteps TEXT NOT NULL,
        CreatedAt TEXT DEFAULT (datetime('now')),
        UpdatedAt TEXT,
        PRIMARY KEY (TagType, FailureMode)
      );
    `)
    return d
  }

  it('inserts the EPC and TPE rows when the table is non-empty but missing them', async () => {
    const d = makeDb()
    d.prepare(
      "INSERT INTO TagTypeDiagnostics (TagType, FailureMode, DiagnosticSteps) VALUES ('Button Press', 'No response', 'existing')",
    ).run()

    const { ensureRequiredDiagnosticRowsOn } = await import('../lib/db/seed-diagnostics')
    ensureRequiredDiagnosticRowsOn(d)

    const epc = d
      .prepare("SELECT 1 FROM TagTypeDiagnostics WHERE TagType = 'EPC' AND FailureMode = 'Needs proper tension'")
      .get()
    const tpe = d
      .prepare("SELECT 1 FROM TagTypeDiagnostics WHERE TagType = 'TPE Dark Operated' AND FailureMode = 'Needs alignment'")
      .get()
    expect(epc).toBeTruthy()
    expect(tpe).toBeTruthy()
  })

  it('is idempotent (calling twice does not create duplicates or error)', async () => {
    const d = makeDb()
    const { ensureRequiredDiagnosticRowsOn } = await import('../lib/db/seed-diagnostics')
    ensureRequiredDiagnosticRowsOn(d)
    ensureRequiredDiagnosticRowsOn(d)

    const count = d
      .prepare(
        "SELECT COUNT(*) as c FROM TagTypeDiagnostics WHERE TagType = 'EPC' AND FailureMode = 'Needs proper tension'",
      )
      .get() as { c: number }
    expect(count.c).toBe(1)
  })

  it('does not overwrite customised diagnostic text for existing matching rows', async () => {
    const d = makeDb()
    d.prepare(
      "INSERT INTO TagTypeDiagnostics (TagType, FailureMode, DiagnosticSteps) VALUES ('TPE Dark Operated', 'Needs alignment', 'CUSTOM SITE TEXT')",
    ).run()

    const { ensureRequiredDiagnosticRowsOn } = await import('../lib/db/seed-diagnostics')
    ensureRequiredDiagnosticRowsOn(d)

    const row = d
      .prepare(
        "SELECT DiagnosticSteps FROM TagTypeDiagnostics WHERE TagType = 'TPE Dark Operated' AND FailureMode = 'Needs alignment'",
      )
      .get() as { DiagnosticSteps: string }
    expect(row.DiagnosticSteps).toBe('CUSTOM SITE TEXT')
  })
})
