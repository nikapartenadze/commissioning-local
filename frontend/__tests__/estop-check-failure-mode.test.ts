import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'

function buildSchema(d: Database.Database) {
  d.exec(`
    CREATE TABLE EStopEpcChecks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      SubsystemId INTEGER NOT NULL,
      ZoneName TEXT NOT NULL,
      CheckTag TEXT NOT NULL,
      Result TEXT,
      Comments TEXT,
      TestedBy TEXT,
      TestedAt TEXT,
      Version INTEGER NOT NULL DEFAULT 1,
      CreatedAt TEXT DEFAULT (datetime('now')),
      UpdatedAt TEXT,
      UNIQUE(SubsystemId, ZoneName, CheckTag)
    );
  `)
}

function applyMigrations(d: Database.Database, sqls: string[]) {
  for (const sql of sqls) {
    try { d.exec(sql) } catch { /* column exists */ }
  }
}

describe('EStopEpcChecks.FailureMode migration', () => {
  it('adds the column on an existing DB without FailureMode', () => {
    const d = new Database(':memory:')
    buildSchema(d)
    applyMigrations(d, ['ALTER TABLE EStopEpcChecks ADD COLUMN FailureMode TEXT'])
    const cols = d.prepare('PRAGMA table_info(EStopEpcChecks)').all() as { name: string }[]
    expect(cols.map(c => c.name)).toContain('FailureMode')
  })

  it('is idempotent (running twice does not throw)', () => {
    const d = new Database(':memory:')
    buildSchema(d)
    applyMigrations(d, [
      'ALTER TABLE EStopEpcChecks ADD COLUMN FailureMode TEXT',
      'ALTER TABLE EStopEpcChecks ADD COLUMN FailureMode TEXT',
    ])
    const cols = d.prepare('PRAGMA table_info(EStopEpcChecks)').all() as { name: string }[]
    expect(cols.filter(c => c.name === 'FailureMode').length).toBe(1)
  })
})
