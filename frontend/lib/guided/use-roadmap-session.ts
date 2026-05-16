import { useReducer, useCallback } from 'react'
import type { RoadmapStep, RoadmapPath } from './roadmap-types'

export interface RoadmapSessionState {
  status: 'idle' | 'playing' | 'complete' | 'cancelled'
  roadmapId: number | null
  steps: RoadmapStep[]
  path: RoadmapPath | null
  currentStepIndex: number
  stepResults: Array<{ result: 'passed' | 'failed' | 'skipped' | null }>
}

export const initialRoadmapState: RoadmapSessionState = {
  status: 'idle', roadmapId: null, steps: [], path: null,
  currentStepIndex: 0, stepResults: [],
}

export type RoadmapAction =
  | { type: 'START'; roadmapId: number; steps: RoadmapStep[]; path: RoadmapPath | null }
  | { type: 'ADVANCE'; result: 'passed' | 'failed' }
  | { type: 'SKIP_CURRENT' }
  | { type: 'END' }

export function roadmapReducer(state: RoadmapSessionState, action: RoadmapAction): RoadmapSessionState {
  switch (action.type) {
    case 'START':
      return {
        status: 'playing', roadmapId: action.roadmapId, steps: action.steps, path: action.path,
        currentStepIndex: 0,
        stepResults: action.steps.map(() => ({ result: null })),
      }
    case 'ADVANCE': {
      if (state.status !== 'playing') return state
      const nextResults = state.stepResults.slice()
      nextResults[state.currentStepIndex] = { result: action.result }
      const nextIdx = state.currentStepIndex + 1
      return {
        ...state,
        currentStepIndex: nextIdx,
        stepResults: nextResults,
        status: nextIdx >= state.steps.length ? 'complete' : 'playing',
      }
    }
    case 'SKIP_CURRENT': {
      if (state.status !== 'playing') return state
      const nextResults = state.stepResults.slice()
      nextResults[state.currentStepIndex] = { result: 'skipped' }
      const nextIdx = state.currentStepIndex + 1
      return {
        ...state,
        currentStepIndex: nextIdx,
        stepResults: nextResults,
        status: nextIdx >= state.steps.length ? 'complete' : 'playing',
      }
    }
    case 'END':
      return { ...initialRoadmapState, status: 'cancelled' }
    default:
      return state
  }
}

export function useRoadmapSession() {
  const [state, dispatch] = useReducer(roadmapReducer, initialRoadmapState)
  const start = useCallback((roadmapId: number, steps: RoadmapStep[], path: RoadmapPath | null) =>
    dispatch({ type: 'START', roadmapId, steps, path }), [])
  const advance = useCallback((result: 'passed' | 'failed') =>
    dispatch({ type: 'ADVANCE', result }), [])
  const skipCurrent = useCallback(() => dispatch({ type: 'SKIP_CURRENT' }), [])
  const end = useCallback(() => dispatch({ type: 'END' }), [])
  return { state, start, advance, skipCurrent, end }
}
