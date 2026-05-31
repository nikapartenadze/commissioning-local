/**
 * MCM Registry — multi-MCM PLC connection layer.
 *
 * Holds N concurrent PlcClient instances keyed by subsystemId, each with its
 * own network poller and lifecycle. WebSocket broadcasts from this layer
 * always carry `subsystemId` so consumers (browsers, sync workers) can filter.
 *
 * This is the multi-MCM successor to lib/plc-client-manager.ts, which remains
 * in place for backwards compatibility while the new `/api/mcm/:subsystemId`
 * route namespace is proven out.
 *
 * ── Deployment modes (CENTRAL-SERVER-DEPLOYMENT.md §4, Phase 1) ──────────────
 * PLC_MODE=embedded (default): connections live in THIS process. Used by the
 *   field monolith and by the plc-gateway service itself.
 * PLC_MODE=remote: connections live in a separate plc-gateway process. The
 *   async mutators (connect/disconnect/load-tags/IO writes) forward to the
 *   gateway over HTTP; the synchronous getters read a locally-polled cache
 *   (lib/plc/remote-cache.ts). This lets the app redeploy without dropping the
 *   gateway's live PLC connections.
 *
 * Library init is idempotent at the libplctag level — both this module and
 * the legacy plc-client-manager safely call ensureLibrary().
 */

import {
  PlcClient,
  createPlcClient,
  initLibrary,
  isLibraryLoaded,
  type PlcConnectionConfig,
  type ConnectionStatus,
  type IoTag,
} from './plc';
import { NetworkPoller, type NetworkDeviceSnapshot } from './plc/network';
import { gatewayClient } from './plc/gateway-client';
import {
  getCachedMcm,
  getCachedMcms,
  getCachedTagsForMcm,
  getCachedAllTags,
  getCachedNetworkSnapshots,
  getCachedNetworkForMcm,
  getCachedState,
} from './plc/remote-cache';

/** True when PLC connections live in a separate plc-gateway process. */
const REMOTE = process.env.PLC_MODE === 'remote';

// WebSocket broadcast HTTP endpoint — same as legacy manager, shared port.
const WS_BROADCAST_URL = process.env.WS_BROADCAST_URL || 'http://localhost:3102/broadcast';

async function broadcast(message: object): Promise<void> {
  try {
    await fetch(WS_BROADCAST_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(message),
    });
  } catch {
    // WebSocket server may not be running — silently ignore.
  }
}

function ensureLibrary(): void {
  if (!isLibraryLoaded()) {
    initLibrary();
  }
}

/**
 * Result shape shared by connectMcm and the gateway connect endpoint.
 */
export interface McmConnectResult {
  success: boolean;
  status: ConnectionStatus;
  error?: string;
  plcReachable?: boolean;
  tagsSuccessful?: number;
  tagsFailed?: number;
  failedTags?: Array<{ name: string; error: string }>;
}

/** Single-bit write/read result, decorated with the owning MCM's connectivity. */
export interface IoBitResult {
  connected: boolean;
  success: boolean;
  currentState?: boolean;
  error?: string;
}

/** One live MCM connection — opaque outside this module. */
interface McmEntry {
  subsystemId: string;
  name: string;
  config: PlcConnectionConfig;
  client: PlcClient;
  networkPoller: NetworkPoller | null;
  /** read-cycle counter for throttled TagStatusUpdate broadcasts */
  cycleCount: number;
}

interface McmRegistryState {
  mcms: Map<string, McmEntry>;
}

// HMR-safe global state, same pattern as plc-client-manager.
const globalForRegistry = globalThis as unknown as {
  mcmRegistry: McmRegistryState | undefined;
};

if (!globalForRegistry.mcmRegistry) {
  globalForRegistry.mcmRegistry = { mcms: new Map() };
}

function reg(): McmRegistryState {
  return globalForRegistry.mcmRegistry!;
}

/**
 * Pending tag sets queued by loadMcmTags() in REMOTE mode. The connect route
 * calls loadMcmTags() (sync) then connectMcm() (async); in remote mode we can't
 * fire two ordered HTTP calls from a sync function, so we stash the tags here
 * and fold them into the single gateway connect request. Atomic, no race.
 */
const remotePendingTags = new Map<string, IoTag[]>();

/**
 * Status descriptor for a single MCM, suitable for serializing to clients.
 */
export interface McmDescriptor {
  subsystemId: string;
  name: string;
  ip: string;
  path: string;
  connected: boolean;
  status: ConnectionStatus;
  tagCount: number;
  /** Latest read-cycle stats — undefined if no cycle has completed yet. */
  successfulTags?: number;
  failedTags?: number;
}

/**
 * Connect (or reconnect) the named MCM. Idempotent — re-calling on a live
 * entry updates the stored config and reconnects with the new values.
 */
export async function connectMcm(
  subsystemId: string,
  name: string,
  config: PlcConnectionConfig
): Promise<McmConnectResult> {
  if (REMOTE) {
    const tags = remotePendingTags.get(subsystemId);
    remotePendingTags.delete(subsystemId);
    return gatewayClient.connect(subsystemId, name, { ip: config.ip, path: config.path }, tags);
  }

  try {
    ensureLibrary();
  } catch (err) {
    return {
      success: false,
      status: 'error',
      error: err instanceof Error ? err.message : String(err),
    };
  }

  let entry = reg().mcms.get(subsystemId);
  if (!entry) {
    const client = createPlcClient({
      autoReconnect: true,
      reconnectIntervalMs: 5000,
    });
    entry = {
      subsystemId,
      name,
      config,
      client,
      networkPoller: null,
      cycleCount: 0,
    };
    setupListeners(entry);
    reg().mcms.set(subsystemId, entry);
  } else {
    entry.config = config;
    entry.name = name;
  }

  try {
    const result = await entry.client.connect(config);
    return {
      success: result.success,
      status: entry.client.getConnectionStatus(),
      error: result.error,
      plcReachable: result.plcReachable,
      tagsSuccessful: result.tagsSuccessful,
      tagsFailed: result.tagsFailed,
      failedTags: result.failedTags,
    };
  } catch (error) {
    return {
      success: false,
      status: 'error',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Load the IO tag set for a specific MCM. Must be called before connectMcm()
 * so the client knows which tags to read. Calling again with a new list
 * replaces the previous set.
 */
export function loadMcmTags(subsystemId: string, tags: IoTag[]): boolean {
  if (REMOTE) {
    // Stash for the next connectMcm() to send atomically; also push to the
    // gateway eagerly so a status/tags read before connect still reflects them.
    remotePendingTags.set(subsystemId, tags);
    void gatewayClient.loadTags(subsystemId, tags);
    return true;
  }

  const entry = reg().mcms.get(subsystemId);
  if (!entry) {
    // No live client yet — create a bare client now so callers can load tags
    // before connecting. The connect flow will reuse this same instance.
    try {
      ensureLibrary();
    } catch {
      return false;
    }
    const client = createPlcClient({ autoReconnect: true, reconnectIntervalMs: 5000 });
    const placeholder: McmEntry = {
      subsystemId,
      name: subsystemId,
      // Bare config — overwritten by connectMcm() before any actual connect.
      config: { ip: '', path: '' },
      client,
      networkPoller: null,
      cycleCount: 0,
    };
    setupListeners(placeholder);
    reg().mcms.set(subsystemId, placeholder);
    placeholder.client.loadIoTags(tags);
    return true;
  }
  entry.client.loadIoTags(tags);
  return true;
}

/**
 * Disconnect an MCM and tear down its network poller. Safe on unknown ids.
 */
export async function disconnectMcm(subsystemId: string): Promise<{ success: boolean }> {
  if (REMOTE) return gatewayClient.disconnect(subsystemId);

  const entry = reg().mcms.get(subsystemId);
  if (!entry) return { success: true };

  if (entry.networkPoller) {
    await entry.networkPoller.stop();
    entry.networkPoller = null;
  }
  await entry.client.disconnect();
  return { success: true };
}

/**
 * Snapshot of one MCM's current state. Returns null when the id is unknown.
 */
export function getMcmStatus(subsystemId: string): McmDescriptor | null {
  if (REMOTE) return getCachedMcm(subsystemId);

  const entry = reg().mcms.get(subsystemId);
  if (!entry) return null;
  return toDescriptor(entry);
}

/**
 * Cached tags + their current values for one MCM. Returns an empty list when
 * the id is unknown.
 */
export function getMcmTags(subsystemId: string): { tags: IoTag[]; count: number } {
  if (REMOTE) {
    const tags = getCachedTagsForMcm(subsystemId);
    return { tags, count: tags.length };
  }

  const entry = reg().mcms.get(subsystemId);
  if (!entry) return { tags: [], count: 0 };
  const tags = entry.client.getIoTags();
  return { tags, count: tags.length };
}

/**
 * Every MCM the registry knows about, regardless of connection state. Useful
 * for the landing page status grid.
 */
export function listMcms(): McmDescriptor[] {
  if (REMOTE) return getCachedMcms();
  return Array.from(reg().mcms.values()).map(toDescriptor);
}

export function hasMcm(subsystemId: string): boolean {
  if (REMOTE) return getCachedMcm(subsystemId) !== null;
  return reg().mcms.has(subsystemId);
}

/**
 * Whether any MCM is currently connected. Used by legacy routes to decide
 * if they should route through the registry vs the old singleton.
 */
export function hasAnyConnectedMcm(): boolean {
  if (REMOTE) return getCachedState().aggregate.anyConnected;
  for (const entry of reg().mcms.values()) {
    if (entry.client.isConnected) return true;
  }
  return false;
}

/**
 * Whether the registry has any MCM entries at all (connected or not).
 */
export function hasAnyMcm(): boolean {
  if (REMOTE) return getCachedMcms().length > 0;
  return reg().mcms.size > 0;
}

/**
 * Latest per-device network snapshots from one MCM. Empty array if the
 * poller is off or hasn't completed a cycle yet.
 */
export function getMcmNetworkSnapshots(subsystemId: string): NetworkDeviceSnapshot[] {
  if (REMOTE) return getCachedNetworkForMcm(subsystemId);
  const entry = reg().mcms.get(subsystemId);
  return entry?.networkPoller?.getLatestSnapshots() ?? [];
}

/**
 * Latest network snapshots across every MCM. Each snapshot is decorated
 * with `subsystemId` so the cloud receiver can attribute the diagnostic
 * data correctly.
 */
export function getAllNetworkSnapshots(): Array<NetworkDeviceSnapshot & { subsystemId: string }> {
  if (REMOTE) return getCachedNetworkSnapshots();
  const out: Array<NetworkDeviceSnapshot & { subsystemId: string }> = [];
  for (const entry of reg().mcms.values()) {
    const snaps = entry.networkPoller?.getLatestSnapshots() ?? [];
    for (const s of snaps) {
      out.push({ ...s, subsystemId: entry.subsystemId });
    }
  }
  return out;
}

// ── IO-aware resolution (per-IO routing) ──────────────────────────────────

/**
 * Cache for Ios.id → SubsystemId lookup. Populated lazily on first lookup
 * for an ioId and invalidated on disconnect/dispose. SQLite is fast enough
 * for ad-hoc lookups, but the test path can fire hundreds of reads per
 * second so we keep it in-memory.
 *
 * This stays DB-backed in BOTH modes — the app always owns SQLite, even when
 * PLC connections are remote. The gateway never resolves ioId→subsystem.
 */
const ioToSubsystemCache = new Map<number, string>();

/**
 * Invalidate the IO→subsystem cache. Call after pulling fresh IOs from the
 * cloud or otherwise mutating the Ios table's SubsystemId column.
 */
export function invalidateIoSubsystemCache(): void {
  ioToSubsystemCache.clear();
}

/**
 * Look up which subsystem (and therefore which MCM) owns a given IO. Cached.
 * Returns null when the IO is unknown.
 *
 * Lazy-imported `db` to avoid a module-init cycle — mcm-registry is imported
 * early by the PLC layer, and `db-sqlite` initializes pragmas on first load.
 */
export function getMcmIdForIo(ioId: number): string | null {
  const cached = ioToSubsystemCache.get(ioId);
  if (cached !== undefined) return cached;

  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { db } = require('@/lib/db-sqlite') as typeof import('@/lib/db-sqlite');
    const row = db
      .prepare('SELECT SubsystemId FROM Ios WHERE id = ?')
      .get(ioId) as { SubsystemId: number } | undefined;
    if (!row) return null;
    const id = String(row.SubsystemId);
    ioToSubsystemCache.set(ioId, id);
    return id;
  } catch (err) {
    console.warn(`[McmRegistry] getMcmIdForIo(${ioId}) failed:`, err);
    return null;
  }
}

/**
 * Resolve the PlcClient that owns a given IO. Returns null when:
 *   - the IO is unknown
 *   - the IO's subsystem has no registry entry (registry empty / not configured)
 * Callers should fall back to their legacy path when this returns null.
 *
 * In REMOTE mode there is no in-process PlcClient. We return a read-only shim
 * backed by the cache so callers that only inspect connectivity / tag state
 * (e.g. the test route's `ownerClient.isConnected` guard) keep working. Write
 * paths must use writeOutputBitForIo()/readOutputBitForIo(), which RPC the
 * gateway — the shim's write methods throw to make a mistake loud.
 */
export function getClientForIo(ioId: number): PlcClient | null {
  if (REMOTE) {
    const subsystemId = getMcmIdForIo(ioId);
    if (!subsystemId) return null;
    const mcm = getCachedMcm(subsystemId);
    if (!mcm) return null;
    return buildRemoteClientShim(subsystemId) as unknown as PlcClient;
  }
  const subsystemId = getMcmIdForIo(ioId);
  if (!subsystemId) return null;
  const entry = reg().mcms.get(subsystemId);
  return entry?.client ?? null;
}

/**
 * Find the current tag value/state for an IO across every loaded MCM.
 * Returns null if the IO isn't found in any registry client. The IO does
 * not need to be currently connected — the tag reader caches the last
 * read state on the client even after the connection drops.
 */
export function getTagForIo(ioId: number): IoTag | null {
  if (REMOTE) {
    const subsystemId = getMcmIdForIo(ioId);
    if (subsystemId) {
      const tag = getCachedTagsForMcm(subsystemId).find((t) => t.id === ioId);
      if (tag) return tag;
    }
    return getCachedAllTags().find((t) => t.id === ioId) ?? null;
  }

  const subsystemId = getMcmIdForIo(ioId);
  if (subsystemId) {
    const entry = reg().mcms.get(subsystemId);
    if (entry) {
      // Prefer the IO's owning MCM. Use getIoTag-by-id if available, else scan.
      const tags = entry.client.getIoTags();
      const tag = tags.find((t) => t.id === ioId);
      if (tag) return tag;
    }
  }
  // Fallback scan across every MCM in case the IO's SubsystemId was rewritten
  // or the cache is stale.
  for (const entry of reg().mcms.values()) {
    const tags = entry.client.getIoTags();
    const tag = tags.find((t) => t.id === ioId);
    if (tag) return tag;
  }
  return null;
}

/**
 * Union of every MCM's tag list, decorated with `subsystemId` so callers can
 * tell which MCM each tag belongs to. Used by the legacy /api/plc/tags route
 * when no subsystemId filter is supplied.
 */
export function getAllTags(): {
  tags: Array<IoTag & { subsystemId: string }>;
  count: number;
} {
  if (REMOTE) {
    const tags = getCachedAllTags();
    return { tags, count: tags.length };
  }
  const tags: Array<IoTag & { subsystemId: string }> = [];
  for (const entry of reg().mcms.values()) {
    for (const t of entry.client.getIoTags()) {
      tags.push({ ...t, subsystemId: entry.subsystemId });
    }
  }
  return { tags, count: tags.length };
}

/**
 * Aggregate connection status across every MCM. Used by /api/plc/status
 * and the heartbeat when the legacy callers want one summary number.
 */
export function getAggregateStatus(): {
  anyConnected: boolean;
  connectedCount: number;
  totalCount: number;
  totalTagCount: number;
  mcms: McmDescriptor[];
} {
  const mcms = listMcms();
  const connectedCount = mcms.filter((m) => m.connected).length;
  const totalTagCount = mcms.reduce((sum, m) => sum + m.tagCount, 0);
  return {
    anyConnected: connectedCount > 0,
    connectedCount,
    totalCount: mcms.length,
    totalTagCount,
    mcms,
  };
}

/**
 * Tear down an MCM entirely — disconnect, drop its client. Used when the
 * operator removes the MCM from the configured list.
 */
export async function disposeMcm(subsystemId: string): Promise<void> {
  if (REMOTE) {
    await gatewayClient.dispose(subsystemId);
    return;
  }
  const entry = reg().mcms.get(subsystemId);
  if (!entry) return;
  if (entry.networkPoller) {
    await entry.networkPoller.stop();
    entry.networkPoller = null;
  }
  entry.client.dispose();
  reg().mcms.delete(subsystemId);
}

// ── IO write/read facades ──────────────────────────────────────────────────
//
// These unify the "resolve the owning controller, check it's connected, then
// write/read a single output bit" flow used by /api/ios/:id/fire-output and
// /api/ios/:id/state. Mode-aware: embedded drives the in-process client;
// remote RPCs the gateway. Both return the same IoBitResult shape.

type IoRef = Pick<IoTag, 'id' | 'name' | 'tagType'>;

/** Lazy legacy singleton accessor — avoids a static import cycle. */
function legacyPlcClient(): PlcClient | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mgr = require('@/lib/plc-client-manager') as typeof import('@/lib/plc-client-manager');
    return mgr.getPlcClient();
  } catch {
    return null;
  }
}

/**
 * Write a single output bit for the controller that owns `ioId`.
 * value: 1 (on) | 0 (off) | 'toggle'.
 */
export async function writeOutputBitForIo(
  ioId: number,
  io: IoRef,
  value: number | 'toggle'
): Promise<IoBitResult> {
  if (REMOTE) {
    const subsystemId = getMcmIdForIo(ioId);
    if (!subsystemId) return { connected: false, success: false, error: 'IO has no subsystem mapping' };
    return gatewayClient.writeIo(subsystemId, io, value);
  }

  // Embedded: route the write to the owning controller, falling back to the
  // legacy singleton when no MCM is registered (field single-PLC laptops).
  const client = hasAnyMcm() ? getClientForIo(ioId) ?? legacyPlcClient() : legacyPlcClient();
  if (!client) return { connected: false, success: false, error: 'No PLC client' };
  if (!client.isConnected) return { connected: false, success: false, error: 'PLC not connected' };
  const r = client.writeOutputBit(io as IoTag, value);
  return { connected: true, success: r.success, currentState: r.currentState, error: r.error };
}

/** Read a single output bit for the controller that owns `ioId`. */
export async function readOutputBitForIo(ioId: number, io: IoRef): Promise<IoBitResult> {
  if (REMOTE) {
    const subsystemId = getMcmIdForIo(ioId);
    if (!subsystemId) return { connected: false, success: false, error: 'IO has no subsystem mapping' };
    return gatewayClient.readIo(subsystemId, io);
  }

  const client = hasAnyMcm() ? getClientForIo(ioId) ?? legacyPlcClient() : legacyPlcClient();
  if (!client) return { connected: false, success: false, error: 'No PLC client' };
  if (!client.isConnected) return { connected: false, success: false, error: 'PLC not connected' };
  const r = client.readOutputBit(io as IoTag);
  return { connected: true, success: r.success, currentState: r.currentState, error: r.error };
}

// ── In-process IO write/read by subsystem (gateway-side helpers) ────────────
//
// Used by the plc-gateway server to service /mcm/:id/io/write|read. These are
// EMBEDDED-only (the gateway always runs embedded). They resolve the client by
// subsystemId — the app passes the id, the gateway never touches SQLite.

export function writeOutputBitForMcm(
  subsystemId: string,
  io: IoRef,
  value: number | 'toggle'
): IoBitResult {
  const entry = reg().mcms.get(subsystemId);
  if (!entry) return { connected: false, success: false, error: `MCM ${subsystemId} not registered` };
  if (!entry.client.isConnected) return { connected: false, success: false, error: `MCM ${subsystemId} not connected` };
  const r = entry.client.writeOutputBit(io as IoTag, value);
  return { connected: true, success: r.success, currentState: r.currentState, error: r.error };
}

export function readOutputBitForMcm(subsystemId: string, io: IoRef): IoBitResult {
  const entry = reg().mcms.get(subsystemId);
  if (!entry) return { connected: false, success: false, error: `MCM ${subsystemId} not registered` };
  if (!entry.client.isConnected) return { connected: false, success: false, error: `MCM ${subsystemId} not connected` };
  const r = entry.client.readOutputBit(io as IoTag);
  return { connected: true, success: r.success, currentState: r.currentState, error: r.error };
}

// ── internals ─────────────────────────────────────────────────────────────

/**
 * A read-only PlcClient stand-in for REMOTE mode, backed by the polled cache.
 * Only connectivity/tag-state inspection is supported; write/read throw because
 * those must go through the gateway RPC facades.
 */
function buildRemoteClientShim(subsystemId: string) {
  const mcm = () => getCachedMcm(subsystemId);
  const tags = () => getCachedTagsForMcm(subsystemId);
  const blocked = () => {
    throw new Error('PLC writes are not available on the remote client shim — use writeOutputBitForIo()');
  };
  return {
    get isConnected() {
      return mcm()?.connected ?? false;
    },
    getConnectionStatus(): ConnectionStatus {
      return mcm()?.status ?? 'disconnected';
    },
    get tagCount() {
      return mcm()?.tagCount ?? 0;
    },
    getIoTags(): IoTag[] {
      return tags();
    },
    getIoTag(name: string): IoTag | undefined {
      return tags().find((t) => t.name === name);
    },
    writeOutputBit: blocked,
    readOutputBit: blocked,
  };
}

function toDescriptor(entry: McmEntry): McmDescriptor {
  return {
    subsystemId: entry.subsystemId,
    name: entry.name,
    ip: entry.config.ip,
    path: entry.config.path,
    connected: entry.client.isConnected,
    status: entry.client.getConnectionStatus(),
    tagCount: entry.client.tagCount,
  };
}

/**
 * Wire WebSocket-broadcast listeners onto a fresh client. Every broadcast
 * carries `subsystemId` so consumers can route to the right MCM panel.
 */
function setupListeners(entry: McmEntry): void {
  const { client, subsystemId } = entry;

  client.on('ioStateChanged', (io, _oldState, newState) => {
    broadcast({
      type: 'UpdateState',
      subsystemId,
      id: io.id,
      state: newState === 'TRUE',
    });
  });

  client.on('tagValueChanged', (event) => {
    broadcast({
      type: 'DeviceFaultChanged',
      subsystemId,
      tagName: event.name,
      faulted: event.newValue ? true : false,
    });
  });

  client.on('connectionStatusChanged', (status) => {
    const willReconnect = status === 'error';
    broadcast({
      type: 'NetworkStatusChanged',
      subsystemId,
      moduleName: 'plc',
      status,
      reconnecting: willReconnect,
      errorCount: status === 'error' ? 1 : 0,
    });
    // Tear down the per-MCM network poller on hard PLC errors — same reason
    // as the legacy manager: dead handles otherwise spam deviceError every
    // 5 s until the next disconnect.
    if ((status === 'error' || status === 'disconnected') && entry.networkPoller) {
      const poller = entry.networkPoller;
      entry.networkPoller = null;
      void poller.stop();
    }
  });

  client.on('readCycleComplete', () => {
    entry.cycleCount += 1;
    if (entry.cycleCount % 30 !== 0) return;
    const ioTags = client.getIoTags();
    let successfulTags = 0;
    let failedTags = 0;
    for (const tag of ioTags) {
      if (tag.state !== undefined && tag.state !== null) {
        successfulTags += 1;
      } else {
        failedTags += 1;
      }
    }
    broadcast({
      type: 'TagStatusUpdate',
      subsystemId,
      totalTags: ioTags.length,
      successfulTags,
      failedTags,
      hasErrors: failedTags > 0,
      connected: client.isConnected,
    });
  });

  client.on('initialized', () => {
    void startPoller(entry);

    // Broadcast a one-shot snapshot of every tag's current state once the
    // first read cycle has completed. Matches the legacy manager's behaviour
    // so browsers that opened before the operator pressed Connect still
    // populate stable bits — the tag reader only emits on transitions.
    setTimeout(() => {
      try {
        const ioTags = client.getIoTags();
        const states = ioTags
          .filter((t) => t.id >= 0 && t.state !== undefined && t.state !== null)
          .map((t) => ({ id: t.id, state: t.state === 'TRUE' }));
        if (states.length > 0) {
          broadcast({
            type: 'TagSnapshot',
            subsystemId,
            states,
            count: states.length,
          });
        }
      } catch {
        // Snapshot best-effort.
      }
    }, 1500);
  });

  client.on('error', (error) => {
    broadcast({
      type: 'ErrorEvent',
      subsystemId,
      source: 'plc',
      message: error.message,
      severity: 'error',
      timestamp: new Date().toISOString(),
    });
  });
}

async function startPoller(entry: McmEntry): Promise<void> {
  if (entry.networkPoller) return;

  // Reserve the slot before awaiting so a second concurrent 'initialized'
  // event can't sneak past the guard and start a second poller.
  const placeholder = new NetworkPoller();
  entry.networkPoller = placeholder;

  if (!entry.config.ip) {
    entry.networkPoller = null;
    return;
  }

  const poller = new NetworkPoller();
  poller.setConnection(entry.config.ip, entry.config.path);
  poller.on('snapshot', (snapshot) => {
    broadcast({
      type: 'NetworkDeviceSnapshot',
      subsystemId: entry.subsystemId,
      snapshot,
    });
  });

  entry.networkPoller = poller;
  await poller.start();
}
