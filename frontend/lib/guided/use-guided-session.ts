import { useCallback, useEffect, useReducer } from 'react'
import type { Device } from './types'

export interface GuidedState {
  isLoading: boolean
  devices: Device[]
  selectedDevice: string | null
  skippedDevices: Set<string>
  /** Bumped whenever something changes that requires a /api/guided/devices refetch. */
  refreshCounter: number
}

export const initialGuidedState: GuidedState = {
  isLoading: true,
  devices: [],
  selectedDevice: null,
  skippedDevices: new Set(),
  refreshCounter: 0,
}

export type GuidedAction =
  | { type: 'LOAD_START' }
  | { type: 'LOAD_DEVICES'; devices: Device[] }
  | { type: 'OPEN_DEVICE'; deviceName: string }
  | { type: 'CLOSE_DEVICE' }
  | { type: 'SKIP_DEVICE'; deviceName: string }
  | { type: 'UNSKIP_DEVICE'; deviceName: string }
  | { type: 'REFRESH' }

export function guidedReducer(state: GuidedState, action: GuidedAction): GuidedState {
  switch (action.type) {
    case 'LOAD_START':
      return { ...state, isLoading: true }
    case 'LOAD_DEVICES':
      return { ...state, isLoading: false, devices: action.devices }
    case 'OPEN_DEVICE':
      return { ...state, selectedDevice: action.deviceName }
    case 'CLOSE_DEVICE':
      return { ...state, selectedDevice: null }
    case 'SKIP_DEVICE': {
      const next = new Set(state.skippedDevices)
      next.add(action.deviceName)
      return {
        ...state,
        skippedDevices: next,
        selectedDevice: null,
        refreshCounter: state.refreshCounter + 1,
      }
    }
    case 'UNSKIP_DEVICE': {
      const next = new Set(state.skippedDevices)
      next.delete(action.deviceName)
      return { ...state, skippedDevices: next, refreshCounter: state.refreshCounter + 1 }
    }
    case 'REFRESH':
      return { ...state, refreshCounter: state.refreshCounter + 1 }
    default:
      return state
  }
}

/**
 * Hook that owns the guided-session UI state and fetches the device list.
 * Refetches whenever skippedDevices changes (passes them as a query param so
 * the API can stamp `skipped` state correctly).
 */
export function useGuidedSession(subsystemId: number) {
  const [state, dispatch] = useReducer(guidedReducer, initialGuidedState)

  // We intentionally trigger refetch via state.refreshCounter rather than
  // state.skippedDevices: skip/unskip actions both bump the counter, and
  // any future action that needs a refetch should follow the same pattern.
  // (skippedDevices is read inside the effect to build the query string,
  // but is not in the dep array — the counter is the single source of truth
  // for "something changed; reload devices".)
  useEffect(() => {
    let cancelled = false
    dispatch({ type: 'LOAD_START' })

    const skippedParam = Array.from(state.skippedDevices).join(',')
    const url = skippedParam.length > 0
      ? `/api/guided/devices?subsystemId=${subsystemId}&skipped=${encodeURIComponent(skippedParam)}`
      : `/api/guided/devices?subsystemId=${subsystemId}`

    fetch(url)
      .then(r => r.json())
      .then(data => {
        if (!cancelled) dispatch({ type: 'LOAD_DEVICES', devices: data.devices ?? [] })
      })
      .catch(err => {
        console.error('[GuidedSession] Failed to load devices:', err)
        if (!cancelled) dispatch({ type: 'LOAD_DEVICES', devices: [] })
      })

    return () => { cancelled = true }
  }, [subsystemId, state.refreshCounter])

  const openDevice = useCallback((deviceName: string) => dispatch({ type: 'OPEN_DEVICE', deviceName }), [])
  const closeDevice = useCallback(() => dispatch({ type: 'CLOSE_DEVICE' }), [])
  const skipDevice = useCallback((deviceName: string) => dispatch({ type: 'SKIP_DEVICE', deviceName }), [])
  const unskipDevice = useCallback((deviceName: string) => dispatch({ type: 'UNSKIP_DEVICE', deviceName }), [])

  return { state, openDevice, closeDevice, skipDevice, unskipDevice }
}
