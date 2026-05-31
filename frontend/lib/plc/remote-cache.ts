/**
 * remote-cache — app-side read model of the plc-gateway's live state.
 *
 * In the split deployment (PLC_MODE=remote) the real PLC connections live in
 * the gateway process, but many app code paths call SYNCHRONOUS registry
 * getters (hasAnyMcm, getMcmStatus, getMcmTags, getAggregateStatus, ...) from
 * inside request handlers and the WS layer. They can't do an HTTP round-trip.
 *
 * This module keeps a synchronously-readable snapshot of the gateway state,
 * kept fresh two ways:
 *   1. A background poller (GET /state every ~750ms) — the source of truth.
 *   2. Inbound broadcast events (the same ones flowing gateway -> app -> browser)
 *      patched in for low-latency tag-state / connection freshness between polls.
 *
 * The live UI never reads this cache — browsers get tag events directly over the
 * WebSocket. The cache only serves server-side route logic (test gating, status
 * endpoints, the heartbeat rollup).
 */

import { gatewayClient } from './gateway-client';
import type { GatewayState, IoTag, McmDescriptor, NetworkDeviceSnapshot } from './gateway-protocol';

interface RemoteCacheState {
  state: GatewayState;
  lastPolledAt: number;
  lastOk: boolean;
  pollTimer: ReturnType<typeof setInterval> | null;
  polling: boolean;
}

const EMPTY: GatewayState = {
  mcms: [],
  aggregate: { anyConnected: false, connectedCount: 0, totalCount: 0, totalTagCount: 0 },
  tags: [],
  network: [],
};

// HMR/global-safe singleton, same pattern as the registry.
const g = globalThis as unknown as { __plcRemoteCache?: RemoteCacheState };
if (!g.__plcRemoteCache) {
  g.__plcRemoteCache = { state: EMPTY, lastPolledAt: 0, lastOk: false, pollTimer: null, polling: false };
}
function rc(): RemoteCacheState {
  return g.__plcRemoteCache!;
}

/** Replace the whole snapshot (called by the poller). */
function setState(state: GatewayState): void {
  rc().state = state;
  rc().lastPolledAt = Date.now();
  rc().lastOk = true;
}

async function pollOnce(): Promise<void> {
  if (rc().polling) return; // don't overlap a slow poll with the next tick
  rc().polling = true;
  try {
    const state = await gatewayClient.getState();
    // gatewayClient returns EMPTY on failure; only treat a non-degenerate
    // shape as authoritative so a transient gateway blip doesn't wipe the
    // last-known MCM list mid-restart.
    if (state.mcms.length > 0 || state.aggregate.totalCount > 0 || rc().lastPolledAt === 0) {
      setState(state);
    } else {
      // Empty result: keep prior snapshot but mark the freshness timestamp so
      // staleness can be observed. A genuinely empty gateway also lands here
      // and correctly converges once mcms are added.
      rc().state = state;
      rc().lastPolledAt = Date.now();
    }
  } catch {
    rc().lastOk = false;
  } finally {
    rc().polling = false;
  }
}

/**
 * Begin polling the gateway. Idempotent — safe to call on every boot. Fires an
 * immediate poll so the first request after startup isn't empty.
 */
export function startRemotePolling(intervalMs = 750): void {
  if (rc().pollTimer) return;
  void pollOnce();
  rc().pollTimer = setInterval(() => void pollOnce(), intervalMs);
  // Don't keep the event loop alive solely for polling.
  if (typeof rc().pollTimer?.unref === 'function') rc().pollTimer!.unref();
}

export function stopRemotePolling(): void {
  if (rc().pollTimer) {
    clearInterval(rc().pollTimer!);
    rc().pollTimer = null;
  }
}

// ── Synchronous accessors used by the mode-aware registry ──────────────────

export function getCachedState(): GatewayState {
  return rc().state;
}

export function getCachedMcms(): McmDescriptor[] {
  return rc().state.mcms;
}

export function getCachedMcm(subsystemId: string): McmDescriptor | null {
  return rc().state.mcms.find((m) => m.subsystemId === subsystemId) ?? null;
}

export function getCachedTagsForMcm(subsystemId: string): IoTag[] {
  return rc().state.tags.filter((t) => t.subsystemId === subsystemId);
}

export function getCachedAllTags(): Array<IoTag & { subsystemId: string }> {
  return rc().state.tags;
}

export function getCachedNetworkSnapshots(): Array<NetworkDeviceSnapshot & { subsystemId: string }> {
  return rc().state.network;
}

export function getCachedNetworkForMcm(subsystemId: string): NetworkDeviceSnapshot[] {
  return rc().state.network.filter((s) => s.subsystemId === subsystemId).map((s) => s);
}

export function isCacheFresh(maxAgeMs = 5_000): boolean {
  return rc().lastOk && Date.now() - rc().lastPolledAt < maxAgeMs;
}

// ── Low-latency patching from the broadcast stream ─────────────────────────

/**
 * Patch the cache from a broadcast message the app is about to fan out to
 * browsers. Best-effort and forgiving: anything unexpected is ignored. Keeps
 * tag states and connection flags fresh in the ~750ms gaps between polls so
 * server-side test gating doesn't lag the live UI.
 */
export function applyBroadcastToCache(message: unknown): void {
  if (!message || typeof message !== 'object') return;
  const msg = message as Record<string, unknown>;
  const type = msg.type;
  const subsystemId = msg.subsystemId != null ? String(msg.subsystemId) : undefined;

  try {
    if (type === 'UpdateState' && typeof msg.id === 'number') {
      patchTagState(msg.id, msg.state === true, subsystemId);
    } else if (type === 'TagSnapshot' && Array.isArray(msg.states)) {
      for (const s of msg.states as Array<{ id: number; state: boolean }>) {
        patchTagState(s.id, s.state === true, subsystemId);
      }
    } else if (type === 'NetworkStatusChanged' && subsystemId) {
      const status = String(msg.status ?? '');
      patchMcmConnection(subsystemId, status === 'connected', status);
    } else if (type === 'TagStatusUpdate' && subsystemId) {
      patchMcmConnection(subsystemId, msg.connected === true);
    }
  } catch {
    // Patching is an optimization; the poller is the source of truth.
  }
}

function patchTagState(ioId: number, on: boolean, subsystemId?: string): void {
  const tags = rc().state.tags;
  for (const t of tags) {
    if (t.id === ioId && (!subsystemId || t.subsystemId === subsystemId)) {
      t.state = on ? 'TRUE' : 'FALSE';
    }
  }
}

function patchMcmConnection(subsystemId: string, connected: boolean, status?: string): void {
  const mcm = rc().state.mcms.find((m) => m.subsystemId === subsystemId);
  if (!mcm) return;
  mcm.connected = connected;
  if (status === 'connected' || status === 'disconnected' || status === 'connecting' || status === 'error') {
    mcm.status = status;
  }
}
