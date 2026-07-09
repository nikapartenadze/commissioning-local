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
import { NetworkPoller, type NetworkDeviceSnapshot, type RingStatus } from './plc/network';
import { gatewayClient } from './plc/gateway-client';
import {
  getCachedMcm,
  getCachedMcms,
  getCachedTagsForMcm,
  getCachedAllTags,
  getCachedNetworkSnapshots,
  getCachedNetworkForMcm,
  getCachedState,
  isCacheFresh,
} from './plc/remote-cache';

/** True when PLC connections live in a separate plc-gateway process. */
const REMOTE = process.env.PLC_MODE === 'remote';

// WebSocket broadcast HTTP endpoint — same as legacy manager, shared port.
const WS_BROADCAST_URL = process.env.WS_BROADCAST_URL || 'http://localhost:3102/broadcast';

async function broadcast(message: object): Promise<void> {
  try {
    await fetch(WS_BROADCAST_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // In the split deployment this poster runs in the plc-gateway process
        // and reaches the app's broadcast receiver across the container network
        // (non-loopback), so it must carry the shared secret when one is set.
        ...(process.env.BROADCAST_SECRET ? { 'X-Broadcast-Key': process.env.BROADCAST_SECRET } : {}),
      },
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

  // No-IP guard. An MCM with a blank/whitespace IP can never connect; without
  // this it would fall through to client.connect(''), which fails and (in the
  // legacy path) schedules a reconnect that hammers the empty host every few
  // seconds, spamming disconnect broadcasts. Surface a clear, terminal "no IP
  // configured" state instead and never create/dial a client for it. Field
  // central deployments leave most mcms[].ip blank until the operator fills
  // each station in, so this is the common case, not an edge.
  if (!config.ip || config.ip.trim().length === 0) {
    return {
      success: false,
      status: 'disconnected',
      plcReachable: false,
      error: `No PLC IP configured for ${name || subsystemId}`,
    };
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
  if (REMOTE) {
    const mcm = getCachedMcm(subsystemId);
    if (!mcm) return null;
    // STALE gateway link: never report the frozen `connected: true`. Force
    // disconnected so callers (test gating, status endpoints) don't act on a
    // dead reading. The distinct "gateway link stale" signal is surfaced by the
    // heartbeat (see lib/heartbeat/system-info.ts) via getGatewayLinkState().
    if (!isCacheFresh()) return { ...mcm, connected: false, status: 'disconnected' };
    return mcm;
  }

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
    // Stale gateway link → the cached tag values are frozen, not live. Return
    // empty rather than serve stale bits as current (R1).
    if (!isCacheFresh()) return { tags: [], count: 0 };
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
  // Stale gateway link → we don't actually know anything is connected; the
  // aggregate is frozen. Report false rather than a stale true (R1).
  if (REMOTE) return isCacheFresh() && getCachedState().aggregate.anyConnected;
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
 * Latest DLR ring verdict for one MCM, read from that MCM's own network
 * poller. Returns null when the id is unknown, the poller is off / hasn't
 * probed yet, or we're in REMOTE mode (the polled cache carries per-device
 * network snapshots but no ring verdict — see remote-cache.ts; guided mode's
 * D5 gate then degrades to "unknown" rather than fabricating a verdict).
 *
 * Mirror of getLatestRingStatus() in the legacy singleton manager, but scoped
 * to a registry MCM so the central/multi-MCM server gets a per-MCM ring gate
 * instead of the never-running singleton poller's null.
 */
export function getRingStatusForMcm(subsystemId: string): RingStatus | null {
  if (REMOTE) return null;
  const entry = reg().mcms.get(subsystemId);
  return entry?.networkPoller?.getLatestRingStatus() ?? null;
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
 * One embedded-mode MCM connection, exposed for direct-FFI consumers (the VFD
 * validation writer / wizard reader) that need the controller's ip/path plus
 * a live client for connectivity + cached-tag checks.
 */
export interface EmbeddedMcmConnection {
  subsystemId: string;
  name: string;
  ip: string;
  path: string;
  client: PlcClient;
}

/**
 * Every currently-CONNECTED MCM in embedded mode. Returns [] in REMOTE mode —
 * libplctag lives in the gateway process there, so direct-FFI flows (VFD
 * validation writer, wizard reader) cannot run in-process (Phase 1.1 routes
 * them through the gateway protocol instead).
 */
export function getConnectedEmbeddedMcms(): EmbeddedMcmConnection[] {
  if (REMOTE) return [];
  const out: EmbeddedMcmConnection[] = [];
  for (const entry of reg().mcms.values()) {
    if (entry.client.isConnected) {
      out.push({
        subsystemId: entry.subsystemId,
        name: entry.name,
        ip: entry.config.ip,
        path: entry.config.path,
        client: entry.client,
      });
    }
  }
  return out;
}

/**
 * The named MCM's embedded connection, or null when unknown, disconnected, or
 * running in REMOTE mode (see getConnectedEmbeddedMcms).
 */
export function getEmbeddedMcmConnection(subsystemId: string): EmbeddedMcmConnection | null {
  if (REMOTE) return null;
  const entry = reg().mcms.get(subsystemId);
  if (!entry || !entry.client.isConnected) return null;
  return {
    subsystemId: entry.subsystemId,
    name: entry.name,
    ip: entry.config.ip,
    path: entry.config.path,
    client: entry.client,
  };
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
  const rawMcms = listMcms();
  // Stale gateway link (REMOTE) → the polled snapshot is frozen. Present every
  // MCM as disconnected so the rollup can't report a stale "connected" count.
  // totalCount is preserved (we still know how many MCMs exist). (R1)
  const stale = REMOTE && !isCacheFresh();
  const mcms = stale
    ? rawMcms.map((m) => ({ ...m, connected: false, status: 'disconnected' as ConnectionStatus }))
    : rawMcms;
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

  // Embedded. Multi-MCM: route ONLY to the IO's owning controller — never fall
  // back to the legacy singleton, which may be connected to a DIFFERENT PLC
  // (cross-MCM misroute; safety-relevant for output writes). Single-PLC field
  // laptop (no MCMs registered): legacy singleton.
  let client: PlcClient | null;
  if (hasAnyMcm()) {
    client = getClientForIo(ioId);
    if (!client) {
      const sid = getMcmIdForIo(ioId);
      return { connected: false, success: false, error: sid ? `MCM ${sid} not connected` : 'IO has no MCM mapping' };
    }
  } else {
    client = legacyPlcClient();
  }
  if (!client || !client.isConnected) return { connected: false, success: false, error: 'PLC not connected' };
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

  // Embedded. Multi-MCM: read ONLY from the IO's owning controller; never fall
  // back to the legacy singleton (could be a different PLC). Single-PLC: legacy.
  let client: PlcClient | null;
  if (hasAnyMcm()) {
    client = getClientForIo(ioId);
    if (!client) {
      const sid = getMcmIdForIo(ioId);
      return { connected: false, success: false, error: sid ? `MCM ${sid} not connected` : 'IO has no MCM mapping' };
    }
  } else {
    client = legacyPlcClient();
  }
  if (!client || !client.isConnected) return { connected: false, success: false, error: 'PLC not connected' };
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

// ── Mode-aware bit write/read by subsystemId (for aux flows: safety, guided) ──
//
// Phase 1.1: the safety/guided routes write output bits BY TAG NAME against a
// specific MCM (not resolved from an ioId via SQLite). Embedded drives the
// in-process client; remote RPCs the gateway (reusing the /mcm/:id/io/write
// endpoint from Phase 1). Same IoBitResult shape as writeOutputBitForIo.

export async function writeOutputBitBySubsystem(
  subsystemId: string,
  io: IoRef,
  value: number | 'toggle'
): Promise<IoBitResult> {
  if (REMOTE) return gatewayClient.writeIo(subsystemId, io, value);
  return writeOutputBitForMcm(subsystemId, io, value);
}

export async function readOutputBitBySubsystem(subsystemId: string, io: IoRef): Promise<IoBitResult> {
  if (REMOTE) return gatewayClient.readIo(subsystemId, io);
  return readOutputBitForMcm(subsystemId, io);
}

// ── Generic typed tag write/read by name (VFD commissioning, etc.) ────────────

// DINT = true 32-bit integer (numeric int32), distinct from REAL's float32
// bit-pattern. Speed setpoints (HMI.Speed_At_30rev) are DINT on the controller;
// writing them as REAL overflowed to ~1.1e9. See PlcScalarType in plc-client.
export type TagDataType = 'BOOL' | 'REAL' | 'INT' | 'DINT';
export interface TypedTagWrite { name: string; value: number; dataType: TagDataType; }
export interface TypedTagRead { name: string; dataType: TagDataType; }
export interface TypedWriteResult { name: string; success: boolean; error?: string; }
export interface TypedReadResult { name: string; success: boolean; value?: number | boolean; error?: string; }
export interface TypedBatchResult<T> { connected: boolean; results: T[]; }

/**
 * Gateway-side (embedded) batch typed write against an MCM's client.
 *
 * ASYNC (Phase 1.1): the previous implementation looped the SYNCHRONOUS
 * writeTypedTag — each tag parks the event loop for up to 5 s on a slow
 * controller, and in the plc-gateway that loop serves EVERY MCM. Now the
 * whole batch goes through PlcClient.writeTypedTags (non-blocking initiate +
 * shared status sweeps); semantics per tag are unchanged.
 */
export async function writeTypedTagsForMcmLocal(
  subsystemId: string,
  writes: TypedTagWrite[]
): Promise<TypedBatchResult<TypedWriteResult>> {
  const entry = reg().mcms.get(subsystemId);
  if (!entry || !entry.client.isConnected) {
    return {
      connected: false,
      results: writes.map((w) => ({ name: w.name, success: false, error: `MCM ${subsystemId} not connected` })),
    };
  }
  const results = await entry.client.writeTypedTags(writes);
  return {
    connected: true,
    results: results.map((r) => ({ name: r.name, success: r.success, error: r.error })),
  };
}

/** Gateway-side (embedded) batch typed read against an MCM's client. ASYNC — see writeTypedTagsForMcmLocal. */
export async function readTypedTagsForMcmLocal(
  subsystemId: string,
  reads: TypedTagRead[]
): Promise<TypedBatchResult<TypedReadResult>> {
  const entry = reg().mcms.get(subsystemId);
  if (!entry || !entry.client.isConnected) {
    return {
      connected: false,
      results: reads.map((rd) => ({ name: rd.name, success: false, error: `MCM ${subsystemId} not connected` })),
    };
  }
  const results = await entry.client.readTypedTags(reads);
  return {
    connected: true,
    results: results.map((r) => ({ name: r.name, success: r.success, value: r.value, error: r.error })),
  };
}

/** Mode-aware: embedded in-process, remote → plc-gateway batch RPC. */
export async function writeTypedTagsForMcm(
  subsystemId: string,
  writes: TypedTagWrite[]
): Promise<TypedBatchResult<TypedWriteResult>> {
  if (REMOTE) return gatewayClient.writeTags(subsystemId, writes);
  return writeTypedTagsForMcmLocal(subsystemId, writes);
}

export async function readTypedTagsForMcm(
  subsystemId: string,
  reads: TypedTagRead[]
): Promise<TypedBatchResult<TypedReadResult>> {
  if (REMOTE) return gatewayClient.readTags(subsystemId, reads);
  return readTypedTagsForMcmLocal(subsystemId, reads);
}

// ── Timing-critical hammer-write (VFD Override_RVS pairing) ───────────────────

export interface HammerWrite { field: string; value: number; dataType: TagDataType; }
export interface HammerResult {
  connected: boolean;
  success: boolean;
  iterations: number;
  writes: Array<{ tagPath: string; ok: boolean }>;
  error?: string;
}

export function hammerWriteTagsForMcmLocal(
  subsystemId: string,
  deviceName: string,
  writes: HammerWrite[],
  durationMs?: number
): HammerResult {
  const entry = reg().mcms.get(subsystemId);
  if (!entry || !entry.client.isConnected) {
    return { connected: false, success: false, iterations: 0, writes: [], error: `MCM ${subsystemId} not connected` };
  }
  const r = entry.client.hammerWriteTags(deviceName, writes, durationMs);
  return { connected: true, ...r };
}

export async function hammerWriteTagsForMcm(
  subsystemId: string,
  deviceName: string,
  writes: HammerWrite[]
): Promise<HammerResult> {
  if (REMOTE) return gatewayClient.hammerWrite(subsystemId, deviceName, writes);
  return hammerWriteTagsForMcmLocal(subsystemId, deviceName, writes);
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

    // On (re)connect, restore VFD validation/polarity flags for THIS MCM's
    // drives — mirrors the legacy manager's singleton hook. A reconnect often
    // follows a PLC program download that zeroes the Valid_* / polarity bits
    // (CDW5, June 2026); without this, registry-connected MCMs would only be
    // restored by the writer's 5-minute safety net instead of seconds after
    // reconnect. clearKnownMissingTags first: NOT_FOUND verdicts collected
    // mid-download are not durable truth.
    //
    // SPLIT DEPLOYMENT (Phase 1.1): inside the plc-gateway process the writer
    // CANNOT run — it needs SQLite (L2 truth) and the gateway is DB-free, so
    // the dynamic import below would fail trying to open a database that
    // doesn't exist there and the restore would silently never happen (the
    // exact CDW5 polarity-loss class this hook exists to prevent). Instead
    // the gateway broadcasts an McmReconnected event over the :3102 seam;
    // the APP intercepts it in its /broadcast handler and runs the writer
    // there, writing back through the gateway's typed-batch endpoints.
    setTimeout(async () => {
      if (process.env.PLC_GATEWAY_PROCESS === '1') {
        void broadcast({ type: 'McmReconnected', subsystemId });
        return;
      }
      try {
        const { syncValidationFlags, clearKnownMissingTags } = await import('@/lib/vfd-validation-writer');
        clearKnownMissingTags(`MCM ${subsystemId} (re)connected — possible program download, re-discovering CMD tags`);
        await syncValidationFlags(`mcm-${subsystemId}-reconnect`);
      } catch (err) {
        console.warn(`[McmRegistry ${subsystemId}] VFD validation sync failed:`, err);
      }
    }, 3000); // 3 s delay — let the tag reader settle first (same as legacy manager)

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
