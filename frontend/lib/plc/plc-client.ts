/**
 * High-Level PLC Client
 *
 * Provides a simple interface for connecting to PLCs, managing tags,
 * and reading/writing values.
 */

import { EventEmitter } from 'events';
import {
  TagReaderService,
  createTagReader,
  type TagReaderConfig,
  type TagValueChangeEvent,
} from './tag-reader';
import type { TagHandle } from './types';
import {
  PlcTagStatus,
  getStatusMessage,
  isStatusOk,
} from './types';
import {
  createTag,
  plc_tag_create,
  plc_tag_destroy,
  plc_tag_read,
  plc_tag_write,
  plc_tag_status,
  plc_tag_get_int8,
  plc_tag_set_int8,
  plc_tag_get_bit,
  plc_tag_set_bit,
  readTagAsync,
  writeTagAsync,
  buildAttributeString,
} from './libplctag';

// IO tag definition (matches backend Io model)
export interface IoTag {
  id: number;
  name: string;
  description?: string;
  type?: 'input' | 'output';
  state?: string;
  result?: string;
  tagType?: string;
}

// PLC connection configuration
export interface PlcConnectionConfig {
  ip: string;
  path: string;
  timeout?: number;
}

// PLC client configuration
export interface PlcClientConfig extends Partial<TagReaderConfig> {
  autoReconnect?: boolean;
  reconnectIntervalMs?: number;
  timeout?: number;
}

// Default client configuration
const DEFAULT_CLIENT_CONFIG: PlcClientConfig = {
  pollIntervalMs: 75,
  readTimeoutMs: 2000,
  autoReconnect: true,
  reconnectIntervalMs: 5000,
};

// Connection status
export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

// Type-safe event emitter
export interface PlcClientEvents {
  'connectionStatusChanged': (status: ConnectionStatus) => void;
  'tagValueChanged': (event: TagValueChangeEvent) => void;
  'ioStateChanged': (io: IoTag, oldState: string, newState: string) => void;
  'readCycleComplete': (cycleTimeMs: number, successCount: number, failCount: number) => void;
  'error': (error: Error) => void;
  'initialized': () => void;
}

export declare interface PlcClient {
  on<K extends keyof PlcClientEvents>(event: K, listener: PlcClientEvents[K]): this;
  off<K extends keyof PlcClientEvents>(event: K, listener: PlcClientEvents[K]): this;
  emit<K extends keyof PlcClientEvents>(event: K, ...args: Parameters<PlcClientEvents[K]>): boolean;
}

/**
 * High-Level PLC Client
 *
 * Manages PLC connection, tag list, and provides methods for reading/writing values.
 * Emits events for state changes that can trigger test prompts in the UI.
 */
export class PlcClient extends EventEmitter {
  private tagReader: TagReaderService;
  private tagReader2: TagReaderService | null = null; // Second reader for dual-connection mode
  private config: PlcClientConfig;
  private connectionConfig: PlcConnectionConfig | null = null;
  private connectionStatus: ConnectionStatus = 'disconnected';
  private ioTags: Map<string, IoTag> = new Map();
  private stateCache: Map<string, string> = new Map();
  private reconnectTimer: NodeJS.Timeout | null = null;
  private isDisposed: boolean = false;

  // Active write handles keyed by tag name (for concurrent multi-user output operations)
  private writeHandles: Map<string, TagHandle> = new Map();

  // Bound listener references for cleanup
  private boundTagValueChange: (event: TagValueChangeEvent) => void;
  private boundConnectionStatusChange: (isConnected: boolean) => void;
  private boundError: (error: Error) => void;
  private boundReadCycleComplete: (cycleTimeMs: number, successCount: number, failCount: number) => void;

  // Dual reader threshold — use 2 readers when tag count exceeds this
  private static DUAL_READER_THRESHOLD = 500;

  constructor(config: PlcClientConfig = {}) {
    super();
    this.config = { ...DEFAULT_CLIENT_CONFIG, ...config };
    this.tagReader = createTagReader(this.config);

    // Store bound listeners for later removal
    this.boundTagValueChange = this.handleTagValueChange.bind(this);
    this.boundConnectionStatusChange = this.handleConnectionStatusChange.bind(this);
    this.boundError = (error) => this.emit('error', error);
    this.boundReadCycleComplete = (cycleTimeMs, successCount, failCount) =>
      this.emit('readCycleComplete', cycleTimeMs, successCount, failCount);

    // Forward tag reader events
    this.tagReader.on('tagValueChanged', this.boundTagValueChange);
    this.tagReader.on('connectionStatusChanged', this.boundConnectionStatusChange);
    this.tagReader.on('error', this.boundError);
    this.tagReader.on('readCycleComplete', this.boundReadCycleComplete);
  }

  /**
   * Attach event listeners to a secondary tag reader
   */
  private attachReader2Events(reader: TagReaderService): void {
    reader.on('tagValueChanged', this.boundTagValueChange);
    reader.on('error', this.boundError);
    // Don't forward connectionStatusChanged from reader2 — reader1 is authoritative
  }

  /**
   * Connect to PLC with the specified IP and path
   */
  async connect(config: PlcConnectionConfig): Promise<{
    success: boolean;
    plcReachable: boolean;
    tagsSuccessful: number;
    tagsFailed: number;
    failedTags: Array<{ name: string; error: string }>;
    error?: string;
  }> {
    if (this.connectionStatus === 'connecting') {
      return { success: false, plcReachable: false, tagsSuccessful: 0, tagsFailed: 0, failedTags: [], error: 'Already connecting' };
    }

    this.connectionConfig = config;
    this.setConnectionStatus('connecting');

    try {
      // Set connection parameters on tag reader
      this.tagReader.setConnection(config.ip, config.path);

      // If we have IO tags loaded, initialize them
      if (this.ioTags.size > 0) {
        const tagNames = Array.from(this.ioTags.keys());

        // Decide whether to use dual readers based on tag count
        const useDualReaders = tagNames.length > PlcClient.DUAL_READER_THRESHOLD;

        if (useDualReaders) {
          // Split tags into two halves for parallel reading
          const midpoint = Math.ceil(tagNames.length / 2);
          const tags1 = tagNames.slice(0, midpoint);
          const tags2 = tagNames.slice(midpoint);

          console.log(`[PlcClient] Dual-reader mode: ${tags1.length} + ${tags2.length} tags across 2 CIP sessions`);

          // Create second reader if needed
          if (!this.tagReader2) {
            this.tagReader2 = createTagReader(this.config);
            this.attachReader2Events(this.tagReader2);
          }
          this.tagReader2.setConnection(config.ip, config.path);

          // Create tags on both readers in parallel
          const [result1, result2] = await Promise.all([
            this.tagReader.createTags(tags1),
            this.tagReader2.createTags(tags2),
          ]);

          const totalSuccessful = result1.successful.length + result2.successful.length;
          const totalFailed = [...result1.failed, ...result2.failed];
          const plcReachable = result1.plcReachable || result2.plcReachable;

          if (totalSuccessful === 0) {
            this.setConnectionStatus('error');
            const errorMsg = plcReachable
              ? `PLC connected but none of the ${totalFailed.length} tags exist on the PLC. Tag names may not match the PLC program.`
              : `Cannot reach PLC at ${config.ip}. Check IP address, network connection, and PLC status.`;
            this.emit('error', new Error(errorMsg));
            this.scheduleReconnect();
            return {
              success: false,
              plcReachable,
              tagsSuccessful: 0,
              tagsFailed: totalFailed.length,
              failedTags: totalFailed,
              error: errorMsg,
            };
          }

          // Start both readers concurrently
          await Promise.all([
            this.tagReader.startReading(),
            this.tagReader2.startReading(),
          ]);

          // Update initial states from both readers
          for (const name of [...result1.successful, ...result2.successful]) {
            const reader = result1.successful.includes(name) ? this.tagReader : this.tagReader2!;
            const value = reader.getTagState(name);
            if (value !== undefined) {
              const state = value ? 'TRUE' : 'FALSE';
              this.stateCache.set(name, state);
              const io = this.ioTags.get(name);
              if (io) io.state = state;
            }
          }

          this.setConnectionStatus('connected');
          this.emit('initialized');

          if (totalFailed.length > 0) {
            console.warn(`[PlcClient] Connected with ${totalFailed.length} failed tags:`, totalFailed.slice(0, 10).map(f => f.name));
          }

          return {
            success: true,
            plcReachable: true,
            tagsSuccessful: totalSuccessful,
            tagsFailed: totalFailed.length,
            failedTags: totalFailed,
          };
        }

        // Single reader mode (tag count <= threshold)
        const result = await this.tagReader.createTags(tagNames);

        if (result.successful.length === 0) {
          this.setConnectionStatus('error');
          const errorMsg = result.plcReachable
            ? `PLC connected but none of the ${result.failed.length} tags exist on the PLC. Tag names may not match the PLC program.`
            : `Cannot reach PLC at ${config.ip}. Check IP address, network connection, and PLC status.`;
          this.emit('error', new Error(errorMsg));
          this.scheduleReconnect();
          return {
            success: false,
            plcReachable: result.plcReachable,
            tagsSuccessful: 0,
            tagsFailed: result.failed.length,
            failedTags: result.failed,
            error: errorMsg,
          };
        }

        // Start continuous reading
        await this.tagReader.startReading();

        // Update initial states from cache
        for (const name of result.successful) {
          const value = this.tagReader.getTagState(name);
          if (value !== undefined) {
            const state = value ? 'TRUE' : 'FALSE';
            this.stateCache.set(name, state);
            const io = this.ioTags.get(name);
            if (io) {
              io.state = state;
            }
          }
        }

        this.setConnectionStatus('connected');
        this.emit('initialized');

        if (result.failed.length > 0) {
          console.warn(`[PlcClient] Connected with ${result.failed.length} failed tags:`, result.failed.slice(0, 10).map(f => f.name));
        }

        return {
          success: true,
          plcReachable: true,
          tagsSuccessful: result.successful.length,
          tagsFailed: result.failed.length,
          failedTags: result.failed,
        };
      }

      this.setConnectionStatus('connected');
      return { success: true, plcReachable: true, tagsSuccessful: 0, tagsFailed: 0, failedTags: [] };
    } catch (error) {
      this.setConnectionStatus('error');
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.emit('error', error instanceof Error ? error : new Error(errorMsg));
      this.scheduleReconnect();
      return { success: false, plcReachable: false, tagsSuccessful: 0, tagsFailed: 0, failedTags: [], error: errorMsg };
    }
  }

  /**
   * Disconnect from PLC
   */
  async disconnect(): Promise<void> {
    this.cancelReconnect();
    this.tagReader.stopReading();
    if (this.tagReader2) this.tagReader2.stopReading();
    await this.tagReader.resetForReconnection();
    if (this.tagReader2) await this.tagReader2.resetForReconnection();

    this.destroyAllWriteHandles();
    this.setConnectionStatus('disconnected');
  }

  /**
   * Reconnect to PLC with updated configuration
   */
  async reconnect(config?: PlcConnectionConfig): Promise<boolean> {
    await this.disconnect();

    const connectionConfig = config || this.connectionConfig;
    if (!connectionConfig) {
      return false;
    }

    const result = await this.connect(connectionConfig);
    return result.success;
  }

  /**
   * Load IO tags for the PLC
   */
  loadIoTags(tags: IoTag[]): void {
    this.ioTags.clear();

    for (const tag of tags) {
      if (tag.name) {
        this.ioTags.set(tag.name, { ...tag });

        // Initialize state from cache if available
        const cachedState = this.stateCache.get(tag.name);
        if (cachedState) {
          const io = this.ioTags.get(tag.name);
          if (io) {
            io.state = cachedState;
          }
        }
      }
    }
  }

  /**
   * Read a tag value (fresh PLC read)
   */
  async readTag(name: string): Promise<boolean | null> {
    const value = await this.tagReader.readTagValue(name);
    return value !== null ? Boolean(value) : null;
  }

  /**
   * Get cached tag value from the polling loop (no fresh PLC read)
   */
  readTagCached(name: string): boolean | null {
    const value = this.tagReader.getCachedValue(name);
    if (value !== null) return Boolean(value);
    if (this.tagReader2) {
      const value2 = this.tagReader2.getCachedValue(name);
      if (value2 !== null) return Boolean(value2);
    }
    return null;
  }

  /**
   * Check if a tag handle exists in either reader
   */
  hasTag(name: string): boolean {
    return this.tagReader.hasTag(name) || (this.tagReader2?.hasTag(name) ?? false);
  }

  /**
   * Write a tag value
   */
  async writeTag(name: string, value: boolean): Promise<boolean> {
    return this.tagReader.writeTagValue(name, value ? 1 : 0);
  }

  /**
   * Read the current state of an output tag (per-tag handle, multi-user safe).
   */
  readOutputBit(io: IoTag): { success: boolean; currentState?: boolean; error?: string } {
    if (!this.connectionConfig || !io.name) {
      return { success: false, error: 'No connection config or tag name' };
    }
    // Use writeOutputBit infrastructure to get/reuse a handle, but just read
    const tagName = io.name;
    let handle = this.writeHandles.get(tagName);

    if (handle === undefined) {
      try {
        handle = createTag({
          gateway: this.connectionConfig.ip,
          path: this.connectionConfig.path,
          name: tagName,
          elemSize: 1,
          elemCount: 1,
          timeout: this.config.timeout || 5000,
        });
        if (handle < 0) {
          return { success: false, error: `Failed to create tag ${tagName}: ${getStatusMessage(handle)}` };
        }
        this.writeHandles.set(tagName, handle);
      } catch (error) {
        return { success: false, error: String(error) };
      }
    }

    try {
      const readStatus = plc_tag_read(handle, 5000);
      if (readStatus !== PlcTagStatus.PLCTAG_STATUS_OK) {
        this.destroyWriteHandle(tagName);
        return { success: false, error: `Read failed: ${getStatusMessage(readStatus)}` };
      }
      const currentValue = plc_tag_get_bit(handle, 0);
      return { success: true, currentState: currentValue === 1 };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  }

  /**
   * Write an output bit value atomically.
   * Each call gets/reuses its own per-tag handle, so concurrent requests
   * for different tags are fully isolated (multi-user safe).
   *
   * Returns current state (before write) and success/error.
   */
  writeOutputBit(
    io: IoTag,
    value: number | 'toggle'
  ): { success: boolean; currentState?: boolean; error?: string } {
    if (!this.connectionConfig || !io.name) {
      return { success: false, error: 'No connection config or tag name' };
    }

    const tagName = io.name;

    // Reuse existing handle for this tag, or create a new one
    let handle = this.writeHandles.get(tagName);

    if (handle === undefined) {
      try {
        handle = createTag({
          gateway: this.connectionConfig.ip,
          path: this.connectionConfig.path,
          name: tagName,
          elemSize: 1,
          elemCount: 1,
          timeout: this.config.timeout || 5000,
        });

        if (handle < 0) {
          const msg = `Failed to create output tag ${tagName}: ${getStatusMessage(handle)}`;
          this.emit('error', new Error(msg));
          return { success: false, error: msg };
        }

        this.writeHandles.set(tagName, handle);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        this.emit('error', error instanceof Error ? error : new Error(msg));
        return { success: false, error: msg };
      }
    }

    try {
      // Read current value (syncs tag buffer — required before writing)
      const readStatus = plc_tag_read(handle, 5000);
      if (readStatus !== PlcTagStatus.PLCTAG_STATUS_OK) {
        // Handle may be stale — destroy and remove so next call recreates
        this.destroyWriteHandle(tagName);
        return { success: false, error: `Read failed: ${getStatusMessage(readStatus)}` };
      }

      const currentValue = plc_tag_get_bit(handle, 0);
      const currentState = currentValue === 1;

      // Determine target value
      const targetValue = value === 'toggle' ? (currentState ? 0 : 1) : (value === 0 ? 0 : 1);

      // Set new value
      const setStatus = plc_tag_set_int8(handle, 0, targetValue);
      if (setStatus !== PlcTagStatus.PLCTAG_STATUS_OK) {
        return { success: false, currentState, error: `Set value failed: ${getStatusMessage(setStatus)}` };
      }

      // Write to PLC (blocking)
      const writeStatus = plc_tag_write(handle, 5000);
      if (writeStatus !== PlcTagStatus.PLCTAG_STATUS_OK) {
        return { success: false, currentState, error: `Write failed: ${getStatusMessage(writeStatus)}` };
      }

      return { success: true, currentState };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  }

  /**
   * Destroy a single write handle by tag name
   */
  private destroyWriteHandle(tagName: string): void {
    const handle = this.writeHandles.get(tagName);
    if (handle !== undefined) {
      try { plc_tag_destroy(handle); } catch { /* ignore */ }
      this.writeHandles.delete(tagName);
    }
  }

  /**
   * Destroy all write handles (used during disconnect/dispose)
   */
  private destroyAllWriteHandles(): void {
    for (const [name, handle] of Array.from(this.writeHandles.entries())) {
      try { plc_tag_destroy(handle); } catch { /* ignore */ }
    }
    this.writeHandles.clear();
  }

  /**
   * Get the current state of an IO tag (from cache)
   */
  getIoState(name: string): string | undefined {
    return this.ioTags.get(name)?.state;
  }

  /**
   * Get all IO tags (excludes network status tags which have negative IDs)
   */
  getIoTags(): IoTag[] {
    return Array.from(this.ioTags.values()).filter(t => t.id >= 0);
  }

  /**
   * Get IO tag by name
   */
  getIoTag(name: string): IoTag | undefined {
    return this.ioTags.get(name);
  }

  /**
   * Get current connection status
   */
  getConnectionStatus(): ConnectionStatus {
    return this.connectionStatus;
  }

  /**
   * Check if connected
   */
  get isConnected(): boolean {
    return this.connectionStatus === 'connected';
  }

  /**
   * Get IO tag count (excludes network status tags)
   */
  get tagCount(): number {
    let count = 0;
    this.ioTags.forEach((tag) => {
      if (tag.id >= 0) count++;
    });
    return count;
  }

  /**
   * Get performance statistics
   */
  getPerformanceStats() {
    const stats1 = this.tagReader.getPerformanceStats();
    if (this.tagReader2) {
      const stats2 = this.tagReader2.getPerformanceStats();
      return {
        totalCycles: Math.max(stats1.totalCycles, stats2.totalCycles),
        avgCycleTimeMs: (stats1.avgCycleTimeMs + stats2.avgCycleTimeMs) / 2,
        readers: 2,
      };
    }
    return { ...stats1, readers: 1 };
  }

  /**
   * Dispose the client and clean up resources
   */
  dispose(): void {
    if (this.isDisposed) return;
    this.isDisposed = true;

    this.cancelReconnect();

    // Remove event listeners from tagReader before disposing
    this.tagReader.off('tagValueChanged', this.boundTagValueChange);
    this.tagReader.off('connectionStatusChanged', this.boundConnectionStatusChange);
    this.tagReader.off('error', this.boundError);
    this.tagReader.off('readCycleComplete', this.boundReadCycleComplete);

    this.tagReader.dispose();
    if (this.tagReader2) {
      this.tagReader2.off('tagValueChanged', this.boundTagValueChange);
      this.tagReader2.off('error', this.boundError);
      this.tagReader2.dispose();
      this.tagReader2 = null;
    }

    this.destroyAllWriteHandles();
    this.ioTags.clear();
    this.stateCache.clear();
    this.removeAllListeners();
  }

  // === Private Methods ===

  /**
   * Handle tag value changes from the reader
   */
  private handleTagValueChange(event: TagValueChangeEvent): void {
    const io = this.ioTags.get(event.name);
    if (!io) return;

    const oldState = io.state || 'UNKNOWN';
    const newState = event.newValue ? 'TRUE' : 'FALSE';

    // Only process if state actually changed
    if (oldState === newState) {
      return;
    }

    // Update IO state
    io.state = newState;
    this.stateCache.set(event.name, newState);

    // Emit IO state change event (for triggering test prompts)
    // Skip network status tags (negative IDs) — they don't trigger test prompts
    if (io.id >= 0) {
      this.emit('ioStateChanged', io, oldState, newState);
    }

    // Forward the tag value change event
    this.emit('tagValueChanged', event);
  }

  /**
   * Handle connection status changes from the reader
   */
  private handleConnectionStatusChange(isConnected: boolean): void {
    if (isConnected) {
      this.setConnectionStatus('connected');
      this.cancelReconnect();
    } else {
      this.setConnectionStatus('error');
      if (this.config.autoReconnect) {
        this.scheduleReconnect();
      }
    }
  }

  /**
   * Set and emit connection status
   */
  private setConnectionStatus(status: ConnectionStatus): void {
    if (this.connectionStatus !== status) {
      this.connectionStatus = status;
      this.emit('connectionStatusChanged', status);
    }
  }

  /**
   * Schedule a reconnection attempt
   */
  private scheduleReconnect(): void {
    if (this.reconnectTimer || !this.config.autoReconnect || this.isDisposed) {
      return;
    }

    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      if (this.connectionConfig && !this.isDisposed) {
        await this.connect(this.connectionConfig);
      }
    }, this.config.reconnectIntervalMs || 10000);
  }

  /**
   * Cancel any scheduled reconnection
   */
  private cancelReconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }
}

// Export factory function
export function createPlcClient(config?: PlcClientConfig): PlcClient {
  return new PlcClient(config);
}

