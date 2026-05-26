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
import { NetworkPoller, type NetworkDeviceSnapshot } from './plc/network';
import { configService } from './config';

// WebSocket broadcast HTTP endpoint (WS port + 100 = HTTP broadcast port)
const WS_BROADCAST_URL = process.env.WS_BROADCAST_URL || 'http://localhost:3102/broadcast';

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
      headers: { 'Content-Type': 'application/json' },
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
    console.log(`[PlcClientManager] Connection status: ${status}${willReconnect ? ' (will auto-reconnect)' : ''}`);
    broadcastToWebSocket({
      type: 'NetworkStatusChanged',
      moduleName: 'plc',
      status: status,
      reconnecting: willReconnect,
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
        const { syncValidationFlags } = await import('@/lib/vfd-validation-writer');
        await syncValidationFlags();
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

  // Broadcast errors
  client.on('error', (error) => {
    console.error(`[PlcClientManager] Error: ${error.message}`);
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
  try {
    const cfg = await configService.getConfig();
    fallbackDevices = cfg.networkPollingDevices ?? [];
    pollIntervalMs = cfg.networkPollingIntervalMs;
  } catch (err) {
    console.warn('[PlcClientManager] Could not load network poller config:', err);
  }

  const poller = new NetworkPoller({ fallbackDevices, pollIntervalMs });
  poller.setConnection(connConfig.ip, connConfig.path);

  poller.on('snapshot', (snapshot) => {
    broadcastToWebSocket({
      type: 'NetworkDeviceSnapshot',
      snapshot,
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
 * Get IO ID by tag name (from loaded tags)
 */
function getIoIdByName(name: string): number {
  const state = getState();
  if (!state.plcClientInstance) return 0;

  const io = state.plcClientInstance.getIoTag(name);
  return io?.id ?? 0;
}

/**
 * Check if a PLC client instance exists
 */
export function hasPlcClient(): boolean {
  syncState();
  return getState().plcClientInstance !== null;
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
 * Get current PLC connection status
 */
export function getPlcStatus(): {
  connected: boolean;
  status: ConnectionStatus;
  tagCount: number;
  connectionConfig: PlcConnectionConfig | null;
} {
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
 * Get all loaded tags with their current values
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
