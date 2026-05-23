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
): Promise<{
  success: boolean;
  status: ConnectionStatus;
  error?: string;
  plcReachable?: boolean;
  tagsSuccessful?: number;
  tagsFailed?: number;
  failedTags?: Array<{ name: string; error: string }>;
}> {
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
  const entry = reg().mcms.get(subsystemId);
  if (!entry) return null;
  return toDescriptor(entry);
}

/**
 * Cached tags + their current values for one MCM. Returns an empty list when
 * the id is unknown.
 */
export function getMcmTags(subsystemId: string): { tags: IoTag[]; count: number } {
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
  return Array.from(reg().mcms.values()).map(toDescriptor);
}

export function hasMcm(subsystemId: string): boolean {
  return reg().mcms.has(subsystemId);
}

/**
 * Whether any MCM is currently connected. Used by legacy routes to decide
 * if they should route through the registry vs the old singleton.
 */
export function hasAnyConnectedMcm(): boolean {
  for (const entry of reg().mcms.values()) {
    if (entry.client.isConnected) return true;
  }
  return false;
}

/**
 * Whether the registry has any MCM entries at all (connected or not).
 */
export function hasAnyMcm(): boolean {
  return reg().mcms.size > 0;
}

/**
 * Latest per-device network snapshots from one MCM. Empty array if the
 * poller is off or hasn't completed a cycle yet.
 */
export function getMcmNetworkSnapshots(subsystemId: string): NetworkDeviceSnapshot[] {
  const entry = reg().mcms.get(subsystemId);
  return entry?.networkPoller?.getLatestSnapshots() ?? [];
}

/**
 * Latest network snapshots across every MCM. Each snapshot is decorated
 * with `subsystemId` so the cloud receiver can attribute the diagnostic
 * data correctly.
 */
export function getAllNetworkSnapshots(): Array<NetworkDeviceSnapshot & { subsystemId: string }> {
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
 */
export function getClientForIo(ioId: number): PlcClient | null {
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
  const entry = reg().mcms.get(subsystemId);
  if (!entry) return;
  if (entry.networkPoller) {
    await entry.networkPoller.stop();
    entry.networkPoller = null;
  }
  entry.client.dispose();
  reg().mcms.delete(subsystemId);
}

// ── internals ─────────────────────────────────────────────────────────────

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
