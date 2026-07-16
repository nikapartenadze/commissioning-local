import { describe, it, expect } from 'vitest'
import { resolvePlcConnectionView } from '@/lib/plc-connection-view'

/**
 * The connection-indicator lie (fixed 2026-07-16): on a multi-MCM box the PLC
 * config dialog showed "Connected" / enabled "Disconnect" whenever ANY sibling
 * MCM was up, because it trusted the parent's GLOBAL aggregate over this MCM's
 * own scoped status. This is the unit test that would have caught it — the exact
 * class of bug the battle rig can't see because nothing renders the UI.
 */
describe('resolvePlcConnectionView', () => {
  it('THE LIE: scoped page must NOT show connected when only a sibling MCM is up', () => {
    const view = resolvePlcConnectionView({
      scoped: true,
      liveStatus: { plcConnected: false }, // THIS MCM is down
      connectionState: { isConnected: true, hasEverConnected: true }, // a sibling is up (global aggregate)
    })
    expect(view.isConnected).toBe(false)
    expect(view.phase).toBe('disconnected')
  })

  it('scoped page shows connected when THIS MCM is actually connected', () => {
    const view = resolvePlcConnectionView({
      scoped: true,
      liveStatus: { plcConnected: true },
      connectionState: { isConnected: false }, // aggregate irrelevant when scoped
    })
    expect(view.isConnected).toBe(true)
    expect(view.phase).toBe('connected')
  })

  it('unscoped (legacy single-connection) still honors the parent connectionState', () => {
    const connected = resolvePlcConnectionView({
      scoped: false,
      liveStatus: null,
      connectionState: { isConnected: true, hasEverConnected: true },
    })
    expect(connected.isConnected).toBe(true)

    const reconnecting = resolvePlcConnectionView({
      scoped: false,
      liveStatus: null,
      connectionState: { isConnected: false, isReconnecting: true, hasEverConnected: true },
    })
    expect(reconnecting.phase).toBe('reconnecting')
  })

  it('scoped with no liveStatus yet reads as disconnected, never the aggregate', () => {
    const view = resolvePlcConnectionView({
      scoped: true,
      liveStatus: null,
      connectionState: { isConnected: true },
    })
    expect(view.isConnected).toBe(false)
  })
})
