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

  // True once any connect in this session has bound at least one tag. The
  // moment we've seen a real working set, "PLC reachable + 0/N tags" can no
  // longer mean "wrong program" — the same names worked, so a momentary
  // 0/N is a CIP transient (controller throttling, brief unreachability
  // during recreate, etc.) and we must keep retrying. See field log
  // logs_MCM08_20260528 for the bug this guards against: a successful 3380/3380
  // connect, a network blip 6 minutes later, then 0/3380 on the immediate
  // recreate, after which the old code refused to reconnect for 53 minutes.
  private hasEverConnectedSuccessfully: boolean = false;

  // Backoff state for scheduleReconnect. Cleared on a successful connect.
  // The 14-attempt-in-2-min storm at 12:51-12:53 on 5/28 spammed the
  // controller's CIP queue with no spacing; exponential backoff with jitter
  // keeps retry pressure low while the controller / network recovers.
  private consecutiveReconnectFailures: number = 0;

  /**
   * Public readonly view of whether this session has ever reached the
   * 'connected' state at least once. The toolbar uses this to label the
   * pending state correctly: a retry storm BEFORE any successful connect
   * should read as "Connecting…" / "Cannot reach PLC — retrying…", not
   * "Reconnecting" (which falsely implies we were once attached and lost
   * it). The internal field is private to preserve the existing transient-
   * zero-tags guard semantics.
   */
  get everConnected(): boolean {
    return this.hasEverConnectedSuccessfully;
  }

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

    // Safety: add a default 'error' listener so unhandled errors don't crash the process.
    // PlcClientManager.setupClientEventListeners() adds its own, but this ensures
    // there is ALWAYS at least one listener even if setup hasn't happened yet.
    this.on('error', (err) => {
      console.error('[PlcClient] Unhandled error event:', err.message || err);
    });

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

    // Destroy any prior native tag handles before creating new ones.
    // Without this, auto-reconnect after a network blip — and operators clicking
    // Connect while still connected — orphan every libplctag handle on the C side,
    // leaving its worker threads polling forever. Over a day that drives CPU up
    // until the service is restarted.
    if (this.tagReader.tagCount > 0 || (this.tagReader2?.tagCount ?? 0) > 0 || this.writeHandles.size > 0) {
      await this.tagReader.resetForReconnection();
      if (this.tagReader2) await this.tagReader2.resetForReconnection();
      this.destroyAllWriteHandles();
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
            // If we've ever successfully bound tags in this session, the
            // program is provably correct; a transient 0/N is a CIP-layer
            // issue (controller throttling during recreate, brief queue
            // saturation) and will heal — keep retrying. Only treat
            // 0/N as permanent on the first-ever connect, where it really
            // could be a wrong-subsystem load.
            const isTransientZero = plcReachable && this.hasEverConnectedSuccessfully;
            const errorMsg = plcReachable
              ? (isTransientZero
                  ? `PLC reachable but 0 of ${totalFailed.length} tags responded (transient — retrying). The program previously matched; this looks like a CIP queue saturation or brief controller unreachability.`
                  : `PLC connected but none of the ${totalFailed.length} tags exist on the PLC. Tag names may not match the PLC program.`)
              : `Cannot reach PLC at ${config.ip}. Check IP address, network connection, and PLC status.`;
            this.emit('error', new Error(errorMsg));
            // Reschedule on genuine unreachability OR on transient 0/N after
            // a previously-successful session (see isTransientZero above).
            if (!plcReachable || isTransientZero) {
              this.scheduleReconnect();
            }
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
          this.hasEverConnectedSuccessfully = true;
          this.consecutiveReconnectFailures = 0;
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
          // See dual-reader branch above for rationale.
          const isTransientZero = result.plcReachable && this.hasEverConnectedSuccessfully;
          const errorMsg = result.plcReachable
            ? (isTransientZero
                ? `PLC reachable but 0 of ${result.failed.length} tags responded (transient — retrying). The program previously matched; this looks like a CIP queue saturation or brief controller unreachability.`
                : `PLC connected but none of the ${result.failed.length} tags exist on the PLC. Tag names may not match the PLC program.`)
            : `Cannot reach PLC at ${config.ip}. Check IP address, network connection, and PLC status.`;
          this.emit('error', new Error(errorMsg));
          if (!result.plcReachable || isTransientZero) {
            this.scheduleReconnect();
          }
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
        this.hasEverConnectedSuccessfully = true;
        this.consecutiveReconnectFailures = 0;
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
    // Operator-initiated disconnect — the next connect should start fresh.
    // hasEverConnectedSuccessfully stays as-is: the program names haven't
    // changed, so the transient-zero-tags guard still applies on the next
    // reconnect cycle in this same session.
    this.consecutiveReconnectFailures = 0;
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
    // Broadcast ConnectionFaulted/Communication_Faulted tag changes as network status
    if (event.name.includes('ConnectionFaulted') || event.name.includes('Communication_Faulted')) {
      this.emit('tagValueChanged', event);
      return;
    }

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
   * Schedule a reconnection attempt with jittered exponential backoff.
   * Spacing schedule (base reconnectIntervalMs = 5000):
   *   attempt 0 → 5 s
   *   attempt 1 → 10 s
   *   attempt 2 → 20 s
   *   attempt 3 → 40 s
   *   attempt 4+ → 60 s (cap)
   * Each delay gets ±20% jitter so multiple tablets reconnecting after a
   * shared site outage don't all pound the controller at the same second.
   * Counter resets to 0 on every confirmed-success connect (see hasEverConnectedSuccessfully
   * setter sites). Without this, a 2-minute network flap produced 14 reconnect
   * attempts in the field log at ~10 s spacing — that's CIP-queue pressure
   * we don't need; the controller heals just as fast on slower retries.
   */
  private scheduleReconnect(): void {
    if (this.reconnectTimer || !this.config.autoReconnect || this.isDisposed) {
      return;
    }

    const baseMs = this.config.reconnectIntervalMs || 5000;
    const exponent = Math.min(this.consecutiveReconnectFailures, 4);
    const uncapped = baseMs * Math.pow(2, exponent);
    const CAP_MS = 60_000;
    const capped = Math.min(uncapped, CAP_MS);
    const jitter = capped * 0.2 * (Math.random() * 2 - 1); // ±20%
    const delayMs = Math.max(1000, Math.round(capped + jitter));
    this.consecutiveReconnectFailures += 1;

    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      if (this.connectionConfig && !this.isDisposed) {
        await this.connect(this.connectionConfig);
      }
    }, delayMs);
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

