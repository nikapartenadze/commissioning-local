/**
 * Single source of truth for the internal broadcast seam's port + URL.
 *
 * The broadcast LISTENER (server-express.ts) binds `PLC_WS_PORT + 100`, and
 * every broadcast CLIENT falls back to that same port when WS_BROADCAST_URL is
 * unset. These used to be derived independently — the listener from PLC_WS_PORT,
 * the clients from a hardcoded `:3102` literal scattered across many files — so
 * changing PLC_WS_PORT moved the listener but left the client fallbacks pinned
 * to the old port, silently sending broadcasts into the void. Deriving both from
 * here removes that drift hazard. At the default ports (PLC_WS_PORT=3002 →
 * broadcast 3102) behavior is unchanged.
 */

const DEFAULT_WS_PORT = 3002
const BROADCAST_PORT_OFFSET = 100

/**
 * The port the broadcast HTTP receiver binds and clients POST to: PLC_WS_PORT
 * (default 3002) + 100. Falls back to the default if PLC_WS_PORT is unparseable.
 */
export function getBroadcastPort(): number {
  const wsPort = parseInt(process.env.PLC_WS_PORT || String(DEFAULT_WS_PORT), 10)
  return (Number.isFinite(wsPort) ? wsPort : DEFAULT_WS_PORT) + BROADCAST_PORT_OFFSET
}

/**
 * The URL broadcast posters should POST to. Honors an explicit WS_BROADCAST_URL
 * (used in split/PLC_MODE=remote deployments to point at another host) and
 * otherwise derives the loopback URL from the same port the listener binds.
 * 127.0.0.1 (not `localhost`) matches the monolith listener's loopback bind and
 * avoids any IPv6-resolution mismatch.
 */
export function getBroadcastUrl(): string {
  return process.env.WS_BROADCAST_URL || `http://127.0.0.1:${getBroadcastPort()}/broadcast`
}
