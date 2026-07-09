/**
 * Singleton PLC Client Manager
 *
 * Manages a single PlcClient instance across API routes.
 * Uses globalThis to persist across hot module reloads in development.
 * Broadcasts PLC events to WebSocket server for real-time updates.
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
import { configService } from './config';
import { getBroadcastUrl } from './broadcast-config';

// WebSocket broadcast HTTP endpoint (PLC_WS_PORT + 100). Single-sourced with the
// server-express listener via lib/broadcast-config (D8) so the port never drifts.
const WS_BROADCAST_URL = getBroadcastUrl();

/**
 * Get the WebSocket broadcast URL. Shared by all API routes.
 */
export function getWsBroadcastUrl(): string {
  return WS_BROADCAST_URL;
}

/**
 * Broadcast a message to all WebSocket clients via HTTP API
 */
async function broadcastToWebSocket(message: object): Promise<void> {
  try {
    const response = await fetch(WS_BROADCAST_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // Carry the broadcast shared secret when configured (opt-in). Harmless
        // on the loopback embedded path; required if this poster ever reaches a
        // non-loopback receiver (WS_BROADCAST_URL pointed at another host).
        ...(process.env.BROADCAST_SECRET ? { 'X-Broadcast-Key': process.env.BROADCAST_SECRET } : {}),
      },
      body: JSON.stringify(message),
    });
    if (!response.ok) {
      console.warn(`[PlcClientManager] WebSocket broadcast failed: ${response.status}`);
    }
  } catch {
    // Silently ignore - WebSocket server might not be running
  }
}

// Use globalThis to persist state across hot module reloads in development
// This is the same pattern used by Prisma and other libraries
interface PlcGlobalState {
  plcClientInstance: PlcClient | null;
  libraryInitialized: boolean;
  currentConnectionConfig: PlcConnectionConfig | null;
  networkPoller: NetworkPoller | null;
}

const globalForPlc = globalThis as unknown as {
  plcState: PlcGlobalState | undefined;
};

// Initialize or retrieve global state
if (!globalForPlc.plcState) {
  globalForPlc.plcState = {
    plcClientInstance: null,
    libraryInitialized: false,
    currentConnectionConfig: null,
    networkPoller: null,
  };
}

// Convenience getters/setters for the global state
function getState(): PlcGlobalState {
  return globalForPlc.plcState!;
}

// Legacy module-level aliases for backward compatibility
let plcClientInstance: PlcClient | null = getState().plcClientInstance;
let libraryInitialized: boolean = getState().libraryInitialized;
let currentConnectionConfig: PlcConnectionConfig | null = getState().currentConnectionConfig;

// Sync local vars with global state after each modification
function syncState() {
  const state = getState();
  plcClientInstance = state.plcClientInstance;
  libraryInitialized = state.libraryInitialized;
  currentConnectionConfig = state.currentConnectionConfig;
}

/**
 * Initialize the libplctag native library
 * Must be called before any PLC operations
 */
function ensureLibraryInitialized(): void {
  syncState();
  const state = getState();

  if (!state.libraryInitialized || !isLibraryLoaded()) {
    console.log('[PlcClientManager] Initializing libplctag native library...');
    try {
      initLibrary();
      state.libraryInitialized = true;
      syncState();
      console.log('[PlcClientManager] libplctag library initialized successfully');
    } catch (error) {
      console.error('[PlcClientManager] Failed to initialize libplctag:', error);
      throw error;
    }
  }
}

/**
 * Get the singleton PLC client instance
 * Creates one if it doesn't exist
 */
export function getPlcClient(): PlcClient {
  // Ensure native library is loaded before creating client
  ensureLibraryInitialized();

  const state = getState();
  if (!state.plcClientInstance) {
    console.log('[PlcClientManager] Creating new PlcClient instance');
    state.plcClientInstance = createPlcClient({
      autoReconnect: true,
      reconnectIntervalMs: 5000, // Retry every 5s on connection loss
    });

    // Set up event listeners to broadcast to WebSocket clients
    setupClientEventListeners(state.plcClientInstance);

    syncState();
  }
  return state.plcClientInstance;
}

/**
 * Set up event listeners on PlcClient to broadcast updates
 */
function setupClientEventListeners(client: PlcClient): void {
  // Broadcast IO state changes (deduplicated - only fires on actual state transitions)
  client.on('ioStateChanged', (io, oldState, newState) => {
    if (process.env.NODE_ENV === 'development') {
      console.log(`[PlcClientManager] IO ${io.id} (${io.name}): ${oldState} -> ${newState}`);
    }
    broadcastToWebSocket({
      type: 'UpdateState',
      id: io.id,
      state: newState === 'TRUE',
    });
  });

  // Broadcast ConnectionFaulted tag changes for instant network device status updates
  client.on('tagValueChanged', (event) => {
    broadcastToWebSocket({
      type: 'DeviceFaultChanged',
      tagName: event.name,
      faulted: event.newValue ? true : false,
    });
  });

  // Broadcast connection status changes
  client.on('connectionStatusChanged', (status) => {
    const config = getState().currentConnectionConfig;
    const willReconnect = status === 'error' && config !== null;
    // everConnected lets the UI distinguish a never-succeeded-once retry
    // storm ("Cannot reach PLC — retrying") from a real reconnect after a
    // previously-good session ("Reconnecting"). Previously the toolbar
    // labelled both as "Reconnecting", which confused operators staring
    // at a fresh failed connect attempt and seeing the icon imply a
    // dropped session.
    const everConnected = client.everConnected;
    console.log(`[PlcClientManager] Connection status: ${status}${willReconnect ? ' (will auto-reconnect)' : ''}`);
    broadcastToWebSocket({
      type: 'NetworkStatusChanged',
      moduleName: 'plc',
      status: status,
      reconnecting: willReconnect,
      everConnected,
      errorCount: status === 'error' ? 1 : 0,
    });
    // Tear down the network poller on hard PLC errors. Without this the
    // poller keeps reading dead handles every 5 s and emits a wall of
    // deviceError messages until the next disconnect. The 'initialized'
    // listener restarts the poller automatically when the PLC reconnects.
    if (status === 'error' || status === 'disconnected') {
      void stopNetworkPoller();
    }
  });

  // Broadcast tag status metadata every ~2 seconds (every 30 cycles at 75ms)
  // Only counts IO tags (excludes network status tags with negative IDs)
  let cycleCount = 0;
  client.on('readCycleComplete', (_cycleTimeMs, _successCount, _failCount) => {
    cycleCount++;
    if (cycleCount % 30 === 0) {
      const ioTags = client.getIoTags(); // already filters out negative IDs
      const totalTags = ioTags.length;
      // Count IO-only success/fail from tag states
      let successfulTags = 0;
      let failedTags = 0;
      for (const tag of ioTags) {
        if (tag.state !== undefined && tag.state !== null) {
          successfulTags++;
        } else {
          failedTags++;
        }
      }
      broadcastToWebSocket({
        type: 'TagStatusUpdate',
        totalTags,
        successfulTags,
        failedTags,
        hasErrors: failedTags > 0,
        connected: client.isConnected,
      });
    }
  });

  // On successful PLC connection, start the network device poller.
  // Independent of the IO tag reader — its own handles, its own loop.
  // Failures never affect IO testing. Runs unconditionally; a PLC without
  // *_NetworkNode tags will simply log "no devices discovered" and idle.
  client.on('initialized', () => {
    void startNetworkPoller();
  });

  // On successful PLC connection, sync VFD validation flags (Valid_Map,
  // Valid_HP, Valid_Direction) for all devices whose checks are completed.
  // Runs after a short delay so the tag reader is fully up before we create
  // temporary write handles.
  client.on('initialized', () => {
    setTimeout(async () => {
      try {
        const { syncValidationFlags, clearKnownMissingTags } = await import('@/lib/vfd-validation-writer');
        // A (re)connect often follows a PLC program download. The download may
        // have added CMD tags that previously answered NOT_FOUND — or NOT_FOUND
        // verdicts were collected mid-transfer and are not durable truth. Drop
        // the cache so every validation/polarity flag is re-attempted; genuine
        // misses get re-cached within one cycle. Without this, drives could
        // stay unrestored after a download until a tool restart (CDW5, June 2026).
        clearKnownMissingTags('PLC (re)connected — possible program download, re-discovering CMD tags');
        await syncValidationFlags('plc-reconnect');
      } catch (err) {
        console.warn('[PlcClientManager] VFD validation sync failed:', err);
      }
    }, 3000); // 3 s delay — let tag reader settle first

    // Push a snapshot of every freshly-registered tag to all connected
    // WebSocket clients. Without this, browsers that opened their
    // WebSocket BEFORE the user pressed "Connect to PLC" (i.e. the
    // common case — the page is already up, then they click connect)
    // never learn the value of any tag that doesn't transition. The
    // tag reader only emits on transitions; stable bits stay invisible.
    //
    // 1500ms delay so the first read cycle completes and tag.state is
    // populated before we snapshot. Earlier than the 3s validation-
    // sync above on purpose: state bubbles take precedence over flag
    // reconciliation for UX.
    setTimeout(() => {
      try {
        const ioTags = client.getIoTags();
        const states = ioTags
          .filter((t) => t.id >= 0 && t.state !== undefined && t.state !== null)
          .map((t) => ({ id: t.id, state: t.state === 'TRUE' }));
        if (states.length > 0) {
          broadcastToWebSocket({
            type: 'TagSnapshot',
            states,
            count: states.length,
          });
          console.log(`[PlcClientManager] Broadcast TagSnapshot — ${states.length} tag states to all clients`);
        }
      } catch (err) {
        console.warn('[PlcClientManager] TagSnapshot broadcast failed:', err);
      }
    }, 1500);
  });

  // Broadcast errors. Throttle the server-side console.error so an auto-
  // reconnect storm against an unreachable PLC doesn't pump the same
  // message into the log every 5–60 s. The WebSocket broadcast still
  // fires on every event so the browser console / dialog logs see the
  // real frequency — only the server stdout (and the rolling app.log
  // files it gets captured into in production) gets the dedupe.
  const ERROR_LOG_DEDUPE_MS = 60_000;
  const lastErrorLoggedAt = new Map<string, number>();
  let suppressedSinceLastLog = 0;
  client.on('error', (error) => {
    const now = Date.now();
    const lastAt = lastErrorLoggedAt.get(error.message) ?? 0;
    if (now - lastAt >= ERROR_LOG_DEDUPE_MS) {
      const note = suppressedSinceLastLog > 0
        ? ` (suppressed ${suppressedSinceLastLog} identical messages in the last ${ERROR_LOG_DEDUPE_MS / 1000}s)`
        : '';
      console.error(`[PlcClientManager] Error: ${error.message}${note}`);
      lastErrorLoggedAt.set(error.message, now);
      suppressedSinceLastLog = 0;
    } else {
      suppressedSinceLastLog++;
    }
    broadcastToWebSocket({
      type: 'ErrorEvent',
      source: 'plc',
      message: error.message,
      severity: 'error',
      timestamp: new Date().toISOString(),
    });
  });
}

/**
 * Start the network device poller on PLC connect. Idempotent — calling it
 * twice while one is already running is a no-op. Race-safe against two
 * concurrent 'initialized' events firing during a rapid reconnect: the
 * sentinel below is set BEFORE any await so the second caller exits early.
 *
 * Runs unconditionally for every PLC connection. The `networkPollingDevices`
 * config field is an OPTIONAL fallback — used only when the PLC's @tags
 * browse is locked down and returns zero matches.
 */
async function startNetworkPoller(): Promise<void> {
  const state = getState();
  if (state.networkPoller) return;

  // Reserve the slot BEFORE awaiting config — a second concurrent
  // 'initialized' must not get past the guard above and re-enter this
  // function while we're still loading config / wiring listeners.
  const placeholder = new NetworkPoller();
  state.networkPoller = placeholder;
  syncState();

  const connConfig = state.currentConnectionConfig;
  if (!connConfig) {
    state.networkPoller = null;
    syncState();
    return;
  }

  // Best-effort config read for the optional fallback device list and the
  // poll-cadence override. A missing/unreadable config is fine — the poller
  // will still try @tags browse (primary discovery path) and fall back to
  // its built-in 60 s default cadence.
  let fallbackDevices: string[] = [];
  let pollIntervalMs: number | undefined;
  let dlrPath: string | undefined;
  try {
    const cfg = await configService.getConfig();
    fallbackDevices = cfg.networkPollingDevices ?? [];
    pollIntervalMs = cfg.networkPollingIntervalMs;
    dlrPath = cfg.dlrSupervisorPath;
  } catch (err) {
    console.warn('[PlcClientManager] Could not load network poller config:', err);
  }

  const poller = new NetworkPoller({ fallbackDevices, pollIntervalMs, dlrPath });
  poller.setConnection(connConfig.ip, connConfig.path);

  poller.on('snapshot', (snapshot) => {
    broadcastToWebSocket({
      type: 'NetworkDeviceSnapshot',
      snapshot,
    });
  });
  poller.on('ringStatus', (ring) => {
    broadcastToWebSocket({
      type: 'RingStatusUpdate',
      ring,
    });
  });
  // 'discovered' and per-device errors are already logged inside the poller
  // (with de-spam). Manager-level listeners would duplicate the lines.

  state.networkPoller = poller;
  syncState();
  await poller.start();
}

/**
 * Stop and dispose the network poller. Safe to call when no poller exists.
 */
async function stopNetworkPoller(): Promise<void> {
  const state = getState();
  const poller = state.networkPoller;
  if (!poller) return;
  state.networkPoller = null;
  syncState();
  await poller.stop();
}

/**
 * Get the most recent network device snapshots, one per device. Empty array
 * when the poller is off or hasn't completed a cycle yet. Used by the
 * heartbeat service to ship the data to the cloud.
 */
export function getLatestNetworkDeviceSnapshots(): NetworkDeviceSnapshot[] {
  const state = getState();
  return state.networkPoller?.getLatestSnapshots() ?? [];
}

/**
 * Get the most recent DLR ring verdict from the network poller, or null when
 * the poller is off / hasn't probed yet. Used by Guided Mode (committee D5:
 * guided mode cannot function when the DPM ring is not nominal).
 */
export function getLatestRingStatus(): RingStatus | null {
  const state = getState();
  return state.networkPoller?.getLatestRingStatus() ?? null;
}

/**
 * Get IO ID by tag name (from loaded tags)
 */
function getIoIdByName(name: string): number {
  const state = getState();
  if (!state.plcClientInstance) return 0;

  const io = state.plcClientInstance.getIoTag(name);
  return io?.id ?? 0;
}

/**
 * Check if a PLC client instance exists.
 *
 * Multi-MCM aware: returns true when the registry has at least one MCM
 * even if the legacy singleton was never instantiated. Routes that gate
 * on "is there a PLC at all?" (heartbeat, status endpoints) need this
 * to see the central-tool state.
 */
export function hasPlcClient(): boolean {
  syncState();
  if (getState().plcClientInstance !== null) return true;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const reg = require('./mcm-registry') as typeof import('./mcm-registry');
    return reg.hasAnyMcm();
  } catch {
    return false;
  }
}

/**
 * Connect to PLC with the specified configuration
 */
export async function connectPlc(config: PlcConnectionConfig): Promise<{
  success: boolean;
  plcReachable?: boolean;
  status: ConnectionStatus;
  error?: string;
  tagsSuccessful?: number;
  tagsFailed?: number;
  failedTags?: Array<{ name: string; error: string }>;
}> {
  try {
    const client = getPlcClient();
    const state = getState();
    state.currentConnectionConfig = config;
    syncState();

    // Tear down any existing network poller before (re)connecting. It's bound to
    // the PREVIOUS gateway + device handles; if left in place, the post-connect
    // 'initialized' → startNetworkPoller() no-ops on its `if (state.networkPoller)
    // return` guard, so on a subsystem switch or a reconnect that didn't emit a
    // clean 'error'/'disconnected' first, the poller keeps polling the OLD PLC
    // and the new connection gets no network/diagnostics data (audit 2026-05-26).
    // Clearing it here lets 'initialized' start a fresh poller for this config.
    await stopNetworkPoller();

    const result = await client.connect(config);

    // Persist boot-time auto-connect memory whenever we've genuinely
    // succeeded — PLC reachable AND tags matched. Without the tags-matched
    // guard we'd remember connections to the wrong PLC at the same IP
    // (different site / same VPN address), which is exactly what the boot
    // auto-connect guard is meant to prevent. Best-effort; a config-write
    // failure must never make a successful connect look like it failed.
    if (result.success && (result.tagsSuccessful ?? 0) > 0) {
      try {
        const cfg = await configService.getConfig();
        if (cfg.subsystemId) {
          await configService.saveConfig({
            lastConnectedSubsystemId: cfg.subsystemId,
            lastConnectedAt: new Date().toISOString(),
          });
        }
      } catch (err) {
        console.warn('[PlcClientManager] Failed to persist lastConnectedSubsystemId:', err);
      }
    }

    return {
      success: result.success,
      plcReachable: result.plcReachable,
      status: client.getConnectionStatus(),
      error: result.error,
      tagsSuccessful: result.tagsSuccessful,
      tagsFailed: result.tagsFailed,
      failedTags: result.failedTags,
    };
  } catch (error) {
    return {
      success: false,
      plcReachable: false,
      status: 'error',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Disconnect from PLC
 */
export async function disconnectPlc(): Promise<{
  success: boolean;
  status: ConnectionStatus;
  error?: string;
}> {
  syncState();
  const state = getState();

  try {
    if (!state.plcClientInstance) {
      return {
        success: true,
        status: 'disconnected',
      };
    }

    await stopNetworkPoller();
    await state.plcClientInstance.disconnect();
    state.currentConnectionConfig = null;
    syncState();

    return {
      success: true,
      status: state.plcClientInstance.getConnectionStatus(),
    };
  } catch (error) {
    return {
      success: false,
      status: state.plcClientInstance?.getConnectionStatus() ?? 'error',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Get current PLC connection status.
 *
 * Multi-MCM aware: when the mcm-registry has any MCMs configured, it is the
 * source of truth and the singleton is bypassed. This catches the case where
 * a legacy route (e.g. /api/ios/:id/fire-output) called getPlcClient() and
 * thereby created an unconnected singleton instance — without this ordering,
 * subsequent getPlcStatus() calls would return the singleton's disconnected
 * state even though the registry has 4 MCMs live.
 *
 * Lazy-imports the registry to dodge a module-init cycle.
 */
export function getPlcStatus(): {
  connected: boolean;
  status: ConnectionStatus;
  tagCount: number;
  connectionConfig: PlcConnectionConfig | null;
} {
  // Multi-MCM mode: registry wins.
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const reg = require('./mcm-registry') as typeof import('./mcm-registry');
    if (reg.hasAnyMcm()) {
      const agg = reg.getAggregateStatus();
      const first = agg.mcms.find((m) => m.connected) ?? agg.mcms[0];
      return {
        connected: agg.anyConnected,
        status: (agg.anyConnected ? 'connected' : 'disconnected') as ConnectionStatus,
        tagCount: agg.totalTagCount,
        connectionConfig: first ? { ip: first.ip, path: first.path } : null,
      };
    }
  } catch {
    // registry not available — fall through to legacy singleton path
  }

  // Legacy single-MCM mode.
  syncState();
  const state = getState();
  if (!state.plcClientInstance) {
    return {
      connected: false,
      status: 'disconnected',
      tagCount: 0,
      connectionConfig: null,
    };
  }
  return {
    connected: state.plcClientInstance.isConnected,
    status: state.plcClientInstance.getConnectionStatus(),
    tagCount: state.plcClientInstance.tagCount,
    connectionConfig: state.currentConnectionConfig,
  };
}

/**
 * Get all loaded tags with their current values.
 *
 * Registry-first: if any MCM is configured, returns the union of every
 * MCM's tag list. Otherwise falls back to the legacy singleton. This
 * matches the getPlcStatus() ordering so a stale-singleton can't shadow
 * a live registry.
 */
export function getPlcTags(): {
  tags: Array<{
    id: number;
    name: string;
    description?: string;
    type?: 'input' | 'output';
    state?: string;
    result?: string;
    tagType?: string;
  }>;
  count: number;
} {
  // Multi-MCM mode: registry wins.
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const reg = require('./mcm-registry') as typeof import('./mcm-registry');
    if (reg.hasAnyMcm()) {
      return reg.getAllTags();
    }
  } catch {
    // registry not available
  }

  // Legacy single-MCM mode.
  syncState();
  const state = getState();
  if (!state.plcClientInstance) {
    return {
      tags: [],
      count: 0,
    };
  }
  const tags = state.plcClientInstance.getIoTags();
  return {
    tags,
    count: tags.length,
  };
}

/**
 * Load IO tags into the PLC client
 */
export function loadPlcTags(tags: IoTag[]): void {
  const client = getPlcClient();
  client.loadIoTags(tags);
}

/**
 * Dispose the PLC client and clean up resources
 */
export function disposePlcClient(): void {
  syncState();
  const state = getState();

  // Fire-and-forget — dispose is synchronous from callers' perspective and the
  // poller stop only awaits handle destruction, which is fast and best-effort.
  void stopNetworkPoller();

  if (state.plcClientInstance) {
    state.plcClientInstance.dispose();
    state.plcClientInstance = null;
    state.currentConnectionConfig = null;
    syncState();
  }
}

/**
 * Get performance statistics from the PLC client
 */
export function getPlcPerformanceStats() {
  syncState();
  const state = getState();

  if (!state.plcClientInstance) {
    return null;
  }
  return state.plcClientInstance.getPerformanceStats();
}
