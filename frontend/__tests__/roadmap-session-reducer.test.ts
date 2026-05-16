import { describe, expect, it } from 'vitest'
import { roadmapReducer, initialRoadmapState } from '@/lib/guided/use-roadmap-session'
import type { RoadmapStep } from '@/lib/guided/roadmap-types'

const steps: RoadmapStep[] = [
  { order: 1, kind: 'device', deviceName: 'A', instructionText: 'go to A' },
  { order: 2, kind: 'io', deviceName: 'B', ioName: 'B.IO1', instructionText: 'pull on B' },
  { order: 3, kind: 'device', deviceName: 'C', instructionText: 'finish at C' },
]

describe('roadmapReducer', () => {
  it('START loads steps and goes to currentStepIndex 0', () => {
    const next = roadmapReducer(initialRoadmapState, { type: 'START', roadmapId: 7, steps, path: null })
    expect(next.status).toBe('playing')
    expect(next.roadmapId).toBe(7)
    expect(next.steps).toHaveLength(3)
    expect(next.currentStepIndex).toBe(0)
    expect(next.stepResults).toEqual([
      { result: null }, { result: null }, { result: null },
    ])
  })

  it('ADVANCE moves index forward and records result', () => {
    const start = roadmapReducer(initialRoadmapState, { type: 'START', roadmapId: 1, steps, path: null })
    const next = roadmapReducer(start, { type: 'ADVANCE', result: 'passed' })
    expect(next.currentStepIndex).toBe(1)
    expect(next.stepResults[0]).toEqual({ result: 'passed' })
    expect(next.status).toBe('playing')
  })

  it('ADVANCE on the final step transitions to complete', () => {
    let state = roadmapReducer(initialRoadmapState, { type: 'START', roadmapId: 1, steps, path: null })
    state = roadmapReducer(state, { type: 'ADVANCE', result: 'passed' })
    state = roadmapReducer(state, { type: 'ADVANCE', result: 'passed' })
    state = roadmapReducer(state, { type: 'ADVANCE', result: 'failed' })
    expect(state.status).toBe('complete')
    expect(state.currentStepIndex).toBe(3)
  })

  it('SKIP_CURRENT records skipped and advances', () => {
    const start = roadmapReducer(initialRoadmapState, { type: 'START', roadmapId: 1, steps, path: null })
    const next = roadmapReducer(start, { type: 'SKIP_CURRENT' })
    expect(next.currentStepIndex).toBe(1)
    expect(next.stepResults[0]).toEqual({ result: 'skipped' })
  })

  it('END cancels and clears everything', () => {
    const start = roadmapReducer(initialRoadmapState, { type: 'START', roadmapId: 1, steps, path: null })
    const next = roadmapReducer(start, { type: 'END' })
    expect(next.status).toBe('cancelled')
    expect(next.steps).toEqual([])
    expect(next.currentStepIndex).toBe(0)
  })
})
