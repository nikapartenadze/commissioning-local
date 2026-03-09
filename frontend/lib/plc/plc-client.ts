/**
 * High-Level PLC Client
 *
 * Provides a simple interface for connecting to PLCs, managing tags,
 * and reading/writing values. Based on the C# PlcCommunicationService pattern.
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
  reconnectIntervalMs: 10000,
};

// Connection status
export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

// Type-safe event emitter
export interface PlcClientEvents {
  'connectionStatusChanged': (status: ConnectionStatus) => void;
  'tagValueChanged': (event: TagValueChangeEvent) => void;
  'ioStateChanged': (io: IoTag, oldState: string, newState: string) => void;
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
  private config: PlcClientConfig;
  private connectionConfig: PlcConnectionConfig | null = null;
  private connectionStatus: ConnectionStatus = 'disconnected';
  private ioTags: Map<string, IoTag> = new Map();
  private stateCache: Map<string, string> = new Map();
  private reconnectTimer: NodeJS.Timeout | null = null;
  private isDisposed: boolean = false;

  // Write tag handle (for output operations)
  private writeTagHandle: TagHandle | null = null;
  private writeTagName: string | null = null;

  constructor(config: PlcClientConfig = {}) {
    super();
    this.config = { ...DEFAULT_CLIENT_CONFIG, ...config };
    this.tagReader = createTagReader(this.config);

    // Forward tag reader events
    this.tagReader.on('tagValueChanged', this.handleTagValueChange.bind(this));
    this.tagReader.on('connectionStatusChanged', this.handleConnectionStatusChange.bind(this));
    this.tagReader.on('error', (error) => this.emit('error', error));
  }

  /**
   * Connect to PLC with the specified IP and path
   */
  async connect(config: PlcConnectionConfig): Promise<boolean> {
    if (this.connectionStatus === 'connecting') {
      return false;
    }

    this.connectionConfig = config;
    this.setConnectionStatus('connecting');

    try {
      // Set connection parameters on tag reader
      this.tagReader.setConnection(config.ip, config.path);

      // If we have IO tags loaded, initialize them
      if (this.ioTags.size > 0) {
        const tagNames = Array.from(this.ioTags.keys());
        const result = await this.tagReader.createTags(tagNames);

        if (result.successful.length === 0) {
          this.setConnectionStatus('error');
          this.emit('error', new Error('Failed to initialize any tags'));
          return false;
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
        return true;
      }

      this.setConnectionStatus('connected');
      return true;
    } catch (error) {
      this.setConnectionStatus('error');
      this.emit('error', error instanceof Error ? error : new Error(String(error)));
      this.scheduleReconnect();
      return false;
    }
  }

  /**
   * Disconnect from PLC
   */
  async disconnect(): Promise<void> {
    this.cancelReconnect();
    this.tagReader.stopReading();
    await this.tagReader.resetForReconnection();

    // Clean up write tag if any
    if (this.writeTagHandle !== null) {
      try {
        plc_tag_destroy(this.writeTagHandle);
      } catch {
        // Ignore
      }
      this.writeTagHandle = null;
      this.writeTagName = null;
    }

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

    return this.connect(connectionConfig);
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
   * Read a tag value
   */
  async readTag(name: string): Promise<boolean | null> {
    const value = await this.tagReader.readTagValue(name);
    return value !== null ? Boolean(value) : null;
  }

  /**
   * Write a tag value
   */
  async writeTag(name: string, value: boolean): Promise<boolean> {
    return this.tagReader.writeTagValue(name, value ? 1 : 0);
  }

  /**
   * Initialize an output tag for writing (toggle/fire operations)
   */
  initializeOutputTag(io: IoTag): boolean {
    if (!this.connectionConfig || !io.name) {
      return false;
    }

    // Clean up previous write tag
    if (this.writeTagHandle !== null) {
      try {
        plc_tag_destroy(this.writeTagHandle);
      } catch {
        // Ignore
      }
    }

    try {
      // Create tag synchronously for write operations
      const handle = createTag({
        gateway: this.connectionConfig.ip,
        path: this.connectionConfig.path,
        name: io.name,
        elemSize: 1,
        elemCount: 1,
        timeout: this.config.timeout || 5000,
      });

      if (handle < 0) {
        this.emit('error', new Error(`Failed to create output tag ${io.name}: ${getStatusMessage(handle)}`));
        return false;
      }

      // Do initial read to verify tag exists and populate buffer (critical for writes)
      const readStatus = plc_tag_read(handle, 5000);
      if (readStatus !== PlcTagStatus.PLCTAG_STATUS_OK) {
        console.error(`[initializeOutputTag] Initial read failed for ${io.name}: ${getStatusMessage(readStatus)}`);
        plc_tag_destroy(handle);
        return false;
      }

      this.writeTagHandle = handle;
      this.writeTagName = io.name;
      return true;
    } catch (error) {
      this.emit('error', error instanceof Error ? error : new Error(String(error)));
      return false;
    }
  }

  /**
   * Toggle the current output bit (0 -> 1 or 1 -> 0)
   */
  async toggleBit(): Promise<{ success: boolean; error?: string }> {
    if (this.writeTagHandle === null) {
      return { success: false, error: 'No output tag initialized' };
    }

    try {
      // Read current value
      const readStatus = await readTagAsync(this.writeTagHandle, 1000);
      if (readStatus !== PlcTagStatus.PLCTAG_STATUS_OK) {
        return { success: false, error: `Read failed: ${getStatusMessage(readStatus)}` };
      }

      const currentValue = plc_tag_get_int8(this.writeTagHandle, 0);
      const newValue = currentValue === 0 ? 1 : 0;

      // Set new value
      const setStatus = plc_tag_set_int8(this.writeTagHandle, 0, newValue);
      if (setStatus !== PlcTagStatus.PLCTAG_STATUS_OK) {
        return { success: false, error: `Set value failed: ${getStatusMessage(setStatus)}` };
      }

      // Write to PLC
      const writeStatus = await writeTagAsync(this.writeTagHandle, 1000);
      if (writeStatus !== PlcTagStatus.PLCTAG_STATUS_OK) {
        return { success: false, error: `Write failed: ${getStatusMessage(writeStatus)}` };
      }

      return { success: true };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  }

  /**
   * Set the output bit to a specific value (0 or 1)
   */
  async setBit(value: number): Promise<{ success: boolean; error?: string }> {
    if (this.writeTagHandle === null) {
      return { success: false, error: 'No output tag initialized' };
    }

    try {
      // Read current value first (required to sync tag buffer before writing)
      const readStatus = await readTagAsync(this.writeTagHandle, 1000);
      if (readStatus !== PlcTagStatus.PLCTAG_STATUS_OK) {
        return { success: false, error: `Read failed: ${getStatusMessage(readStatus)}` };
      }

      // Set value
      const setStatus = plc_tag_set_int8(this.writeTagHandle, 0, value === 0 ? 0 : 1);
      if (setStatus !== PlcTagStatus.PLCTAG_STATUS_OK) {
        return { success: false, error: `Set value failed: ${getStatusMessage(setStatus)}` };
      }

      // Write to PLC using blocking mode
      const writeStatus = plc_tag_write(this.writeTagHandle, 5000);
      if (writeStatus !== PlcTagStatus.PLCTAG_STATUS_OK) {
        return { success: false, error: `Write failed: ${getStatusMessage(writeStatus)}` };
      }

      return { success: true };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  }

  /**
   * Get the current state of an IO tag (from cache)
   */
  getIoState(name: string): string | undefined {
    return this.ioTags.get(name)?.state;
  }

  /**
   * Get all IO tags
   */
  getIoTags(): IoTag[] {
    return Array.from(this.ioTags.values());
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
   * Get tag count
   */
  get tagCount(): number {
    return this.ioTags.size;
  }

  /**
   * Get performance statistics
   */
  getPerformanceStats() {
    return this.tagReader.getPerformanceStats();
  }

  /**
   * Dispose the client and clean up resources
   */
  dispose(): void {
    if (this.isDisposed) return;
    this.isDisposed = true;

    this.cancelReconnect();
    this.tagReader.dispose();

    if (this.writeTagHandle !== null) {
      try {
        plc_tag_destroy(this.writeTagHandle);
      } catch {
        // Ignore
      }
    }

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
    this.emit('ioStateChanged', io, oldState, newState);

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

