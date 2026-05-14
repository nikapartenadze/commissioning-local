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
