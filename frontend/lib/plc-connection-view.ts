/**
 * Pure resolver for the PLC connection indicator shown in the config dialog and
 * the per-MCM toolbar. Extracted from plc-config-dialog so the exact decision
 * that once LIED can be unit-tested without rendering React.
 *
 * The lie (fixed 2026-07-16): on a multi-MCM box the badge/buttons derived from
 * the parent `connectionState`, which is a GLOBAL aggregate (anyConnected across
 * ALL MCMs). On a per-MCM (`scoped`) page it reported "Connected" whenever ANY
 * sibling MCM was up, while THIS MCM was down. When scoped, the only per-MCM
 * truth is `liveStatus` (the dialog's own /api/mcm/:id/plc/status fetch); trust
 * it and ignore the global aggregate.
 */

export interface PlcConnectionInputs {
  /** True on a per-MCM page (dialog scoped to one subsystem). */
  scoped: boolean
  /** This MCM's own status fetch. null until first load. */
  liveStatus: { plcConnected?: boolean } | null | undefined
  /** Parent-provided status — GLOBAL aggregate; must not win when scoped. */
  connectionState: {
    isConnected?: boolean
    isReconnecting?: boolean
    hasEverConnected?: boolean
  } | null | undefined
}

export type PlcConnectionPhase =
  | 'connected'
  | 'reconnecting'
  | 'unreachable'
  | 'disconnected'

export interface PlcConnectionView {
  isConnected: boolean
  isReconnecting: boolean
  hasEverConnected: boolean
  phase: PlcConnectionPhase
}

export function resolvePlcConnectionView(input: PlcConnectionInputs): PlcConnectionView {
  const { scoped, liveStatus, connectionState } = input

  // isConnected drives the badge AND both buttons. Scoped → per-MCM truth only.
  const isConnected = scoped
    ? !!liveStatus?.plcConnected
    : (connectionState?.isConnected ?? !!liveStatus?.plcConnected)

  // The scoped status endpoint carries no reconnecting/everConnected; the WS
  // handlers own those per-MCM, so the dialog stays neutral when scoped.
  const isReconnecting = scoped ? false : (connectionState?.isReconnecting ?? false)
  const hasEverConnected = scoped
    ? !!liveStatus?.plcConnected
    : (connectionState?.hasEverConnected ?? false)

  const phase: PlcConnectionPhase = isConnected
    ? 'connected'
    : isReconnecting && hasEverConnected
      ? 'reconnecting'
      : isReconnecting
        ? 'unreachable'
        : 'disconnected'

  return { isConnected, isReconnecting, hasEverConnected, phase }
}
