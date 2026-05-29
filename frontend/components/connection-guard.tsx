'use client'

import { usePlcWebSocket } from '@/lib/plc/websocket-client'
import { ConnectionLostOverlay } from '@/components/connection-lost-overlay'
import { ConnectionSlowBanner } from '@/components/connection-slow-banner'

/**
 * App-wide guard for the browser↔frontend-server link.
 *
 * Opens its own lightweight WebSocket purely to track heartbeat health, so the
 * blocking overlay + slow banner cover EVERY route (setup, guide, diagram,
 * commissioning), not just the commissioning page. The per-page WS hooks keep
 * their own connections for IO/data events; this guard only reads connection
 * health and renders the coarse "you can't use the app right now" signal.
 *
 * - lost  → full-screen interaction-blocking overlay (server down / link dead)
 * - slow  → small non-blocking banner (acks late; usually a brief server stall)
 *
 * Both auto-clear when heartbeats resume. A server-version change detected
 * across a reconnect triggers a full page reload from inside the WS client, so
 * an upgrade lands the operator on fresh client assets automatically.
 */
export function ConnectionGuard() {
  const ws = usePlcWebSocket()

  return (
    <>
      <ConnectionLostOverlay visible={ws.isHeartbeatLost} />
      <ConnectionSlowBanner
        visible={ws.connectionHealth === 'slow'}
        lastAckAgeSec={ws.lastAckAgeSec}
      />
    </>
  )
}
