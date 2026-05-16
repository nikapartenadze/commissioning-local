import { describe, expect, it } from 'vitest'
import { RoadmapStepSchema, RoadmapSchema } from '@/lib/guided/roadmap-types'

describe('RoadmapStepSchema', () => {
  it('accepts a device-kind step without ioName', () => {
    const r = RoadmapStepSchema.safeParse({
      order: 1, kind: 'device', deviceName: 'A', instructionText: 'go'
    })
    expect(r.success).toBe(true)
  })
  it('accepts an io-kind step with ioName', () => {
    const r = RoadmapStepSchema.safeParse({
      order: 1, kind: 'io', deviceName: 'A', ioName: 'A.IO1', instructionText: 'pull'
    })
    expect(r.success).toBe(true)
  })
  it('rejects an io-kind step missing ioName', () => {
    const r = RoadmapStepSchema.safeParse({
      order: 1, kind: 'io', deviceName: 'A', instructionText: 'pull'
    })
    expect(r.success).toBe(false)
  })
  it('rejects order < 1', () => {
    const r = RoadmapStepSchema.safeParse({
      order: 0, kind: 'device', deviceName: 'A', instructionText: 'go'
    })
    expect(r.success).toBe(false)
  })
})

describe('RoadmapSchema', () => {
  it('parses a full roadmap row', () => {
    const r = RoadmapSchema.safeParse({
      id: 1, projectId: 1, mcm: 'MCM09', name: 'walk',
      stepsJson: [{ order: 1, kind: 'device', deviceName: 'A', instructionText: 'go' }],
      isPublished: true,
    })
    expect(r.success).toBe(true)
  })
  it('rejects when stepsJson contains invalid step', () => {
    const r = RoadmapSchema.safeParse({
      id: 1, projectId: 1, mcm: 'MCM09', name: 'walk',
      stepsJson: [{ order: 1, kind: 'io', deviceName: 'A', instructionText: 'go' }],
      isPublished: true,
    })
    expect(r.success).toBe(false)
  })
})
