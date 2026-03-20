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
    console.log(`[PlcClientManager] IO ${io.id} (${io.name}): ${oldState} -> ${newState}`);
    broadcastToWebSocket({
      type: 'UpdateState',
      id: io.id,
      state: newState === 'TRUE',
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
  });

  // Broadcast tag status metadata every ~2 seconds (every 30 cycles at 75ms)
  let cycleCount = 0;
  client.on('readCycleComplete', (_cycleTimeMs, successCount, failCount) => {
    cycleCount++;
    if (cycleCount % 30 === 0) {
      const tags = client.getIoTags();
      const totalTags = tags.length;
      broadcastToWebSocket({
        type: 'TagStatusUpdate',
        totalTags,
        successfulTags: successCount,
        failedTags: failCount,
        hasErrors: failCount > 0,
        connected: client.isConnected,
      });
    }
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
