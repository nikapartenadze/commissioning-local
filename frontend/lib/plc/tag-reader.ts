/**
 * Tag Reader Service for PLC Communication
 *
 * This service manages multiple PLC tags, polls them at configurable intervals,
 * and emits events when tag values change. Based on the C# NativeTagReaderService pattern.
 */

import { EventEmitter } from 'events';
import type { TagHandle, PlcTagStatusCode } from './types';
import {
  PlcTagStatus,
  getStatusMessage,
  isStatusOk,
  isStatusPending,
} from './types';
import {
  createTag,
  plc_tag_create,
  plc_tag_destroy,
  plc_tag_read,
  plc_tag_status,
  plc_tag_get_int8,
  plc_tag_set_int8,
  plc_tag_get_int32,
  plc_tag_get_bit,
  readTagAsync,
} from './libplctag';

// Tag state interface
export interface TagState {
  name: string;
  handle: TagHandle;  // -1 if read via a grouped parent word
  value: number;
  previousValue: number;
  hasValue: boolean;
  lastReadStatus: PlcTagStatusCode;
  lastReadTime: number;
}

// Grouped word: one PLC read returns all bits for several IO tags
interface GroupedWord {
  parentName: string;    // e.g. "Local:5:I.Data"
  handle: TagHandle;
  elemSize: number;      // bytes: 2=INT(16-bit), 4=DINT(32-bit)
  bits: Map<number, string>; // bitIndex → individual tag name
}

// Tag value change event payload
export interface TagValueChangeEvent {
  name: string;
  oldValue: boolean;
  newValue: boolean;
  timestamp: number;
}

// Tag reader configuration
export interface TagReaderConfig {
  pollIntervalMs: number;
  readTimeoutMs: number;
  batchSize: number;
  maxConcurrentReaders: number;
}

// Default configuration (mirrors C# PlcConstants)
const DEFAULT_CONFIG: TagReaderConfig = {
  pollIntervalMs: 75,      // 75ms polling interval (from C# code)
  readTimeoutMs: 2000,     // 2 second timeout per read
  batchSize: 25,           // Tags per batch (from C# OptimizedBatchSize concept)
  maxConcurrentReaders: 6, // Concurrent reader tasks
};

// Type-safe event emitter
export interface TagReaderEvents {
  'tagValueChanged': (event: TagValueChangeEvent) => void;
  'stateChanged': () => void;
  'connectionStatusChanged': (isConnected: boolean) => void;
  'error': (error: Error, tagName?: string) => void;
  'readCycleComplete': (cycleTimeMs: number, successCount: number, failCount: number) => void;
}

export declare interface TagReaderService {
  on<K extends keyof TagReaderEvents>(event: K, listener: TagReaderEvents[K]): this;
  off<K extends keyof TagReaderEvents>(event: K, listener: TagReaderEvents[K]): this;
  emit<K extends keyof TagReaderEvents>(event: K, ...args: Parameters<TagReaderEvents[K]>): boolean;
}

/**
 * Tag Reader Service
 *
 * Manages continuous reading of PLC tags and emits events on value changes.
 * Uses parallel batch reading for optimal performance with large tag counts.
 */
export class TagReaderService extends EventEmitter {
  private tags: Map<string, TagState> = new Map();
  private groupedWords: Map<string, GroupedWord> = new Map(); // parentName → GroupedWord
  private isReading: boolean = false;
  private abortController: AbortController | null = null;
  private config: TagReaderConfig;
  private gateway: string = '';
  private path: string = '';
  private isConnected: boolean = true;
  private consecutiveErrorCycles: number = 0;
  private lastConnectionStatus: boolean = true;

  // Performance tracking
  private totalReadCycles: number = 0;
  private totalReadTimeMs: number = 0;

  constructor(config: Partial<TagReaderConfig> = {}) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Initialize the tag reader with PLC connection parameters
   */
  setConnection(gateway: string, path: string): void {
    this.gateway = gateway;
    this.path = path;
  }

  /**
   * Create and initialize a tag for reading
   * Has overall timeout protection to prevent hanging
   * Returns { success, error? } so callers get the specific failure reason
   */
  async createTag(
    name: string,
    options: { elemSize?: number; elemCount?: number; timeout?: number } = {}
  ): Promise<{ success: boolean; error?: string }> {
    const { elemSize = 1, elemCount = 1, timeout = 5000 } = options;

    // Wrap entire operation in a timeout
    const overallTimeout = timeout + 2000; // Add buffer for retries
    const timeoutPromise = new Promise<{ success: boolean; error?: string }>((_, reject) => {
      setTimeout(() => reject(new Error(`Tag ${name} creation timed out after ${overallTimeout}ms`)), overallTimeout);
    });

    const createPromise = this.createTagInternal(name, { elemSize, elemCount, timeout });

    try {
      return await Promise.race([createPromise, timeoutPromise]);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.emit('error', error instanceof Error ? error : new Error(errorMsg), name);
      return { success: false, error: errorMsg };
    }
  }

  /**
   * Internal tag creation logic
   */
  private async createTagInternal(
    name: string,
    options: { elemSize: number; elemCount: number; timeout: number }
  ): Promise<{ success: boolean; error?: string }> {
    const { elemSize, elemCount, timeout } = options;
    let handle: number = -1;

    try {
      // Create the tag handle using PlcTagConfig
      handle = createTag({
        gateway: this.gateway,
        path: this.path,
        name: name,
        elemSize: elemSize,
        elemCount: elemCount,
        timeout: timeout,
      });

      if (handle < 0) {
        const errorMsg = getStatusMessage(handle);
        console.log(`[TagReader] Tag ${name} creation returned error: ${errorMsg}`);
        return { success: false, error: `Create failed: ${errorMsg}` };
      }

      // Wait for tag creation to complete
      const status = await this.waitForStatus(handle, timeout);
      if (status !== PlcTagStatus.PLCTAG_STATUS_OK) {
        const errorMsg = getStatusMessage(status);
        console.log(`[TagReader] Tag ${name} status check failed: ${errorMsg}`);
        plc_tag_destroy(handle);
        return { success: false, error: `Status check failed: ${errorMsg}` };
      }

      // Perform initial read to validate tag exists
      const readStatus = await readTagAsync(handle, this.config.readTimeoutMs);
      if (readStatus !== PlcTagStatus.PLCTAG_STATUS_OK) {
        const errorMsg = getStatusMessage(readStatus);
        console.log(`[TagReader] Tag ${name} validation read failed: ${errorMsg}`);
        plc_tag_destroy(handle);
        return { success: false, error: `Read failed: ${errorMsg}` };
      }

      // Get initial value using bit-level read (works correctly for all tag types)
      const initialValue = plc_tag_get_bit(handle, 0);

      // Store tag state
      const tagState: TagState = {
        name,
        handle,
        value: initialValue,
        previousValue: initialValue,
        hasValue: true,
        lastReadStatus: PlcTagStatus.PLCTAG_STATUS_OK,
        lastReadTime: Date.now(),
      };

      this.tags.set(name, tagState);
      return { success: true };
    } catch (error) {
      // Clean up handle if we created one
      if (handle >= 0) {
        try { plc_tag_destroy(handle); } catch { /* ignore */ }
      }
      throw error;
    }
  }

  /**
   * Create a grouped parent word handle and register child TagState entries.
   * Each child tag gets a TagState with handle=-1 (reads via parent).
   */
  private async createGroupedWord(
    parentName: string,
    elemSize: number,
    children: { bitIndex: number; tagName: string }[]
  ): Promise<{ success: boolean; error?: string }> {
    const timeout = 5000;
    let handle: number = -1;

    try {
      handle = createTag({
        gateway: this.gateway,
        path: this.path,
        name: parentName,
        elemSize,
        elemCount: 1,
        timeout,
      });

      if (handle < 0) {
        const errorMsg = getStatusMessage(handle);
        return { success: false, error: `Parent word create failed: ${errorMsg}` };
      }

      const status = await this.waitForStatus(handle, timeout);
      if (status !== PlcTagStatus.PLCTAG_STATUS_OK) {
        plc_tag_destroy(handle);
        return { success: false, error: `Parent word status failed: ${getStatusMessage(status)}` };
      }

      const readStatus = await readTagAsync(handle, this.config.readTimeoutMs);
      if (readStatus !== PlcTagStatus.PLCTAG_STATUS_OK) {
        plc_tag_destroy(handle);
        return { success: false, error: `Parent word read failed: ${getStatusMessage(readStatus)}` };
      }

      // Register the grouped word
      const bits = new Map<number, string>();
      for (const child of children) {
        bits.set(child.bitIndex, child.tagName);
      }
      this.groupedWords.set(parentName, { parentName, handle, elemSize, bits });

      // Create a TagState entry for each child (handle=-1 means "read via parent")
      for (const child of children) {
        const initialValue = plc_tag_get_bit(handle, child.bitIndex);
        this.tags.set(child.tagName, {
          name: child.tagName,
          handle: -1,
          value: initialValue,
          previousValue: initialValue,
          hasValue: true,
          lastReadStatus: PlcTagStatus.PLCTAG_STATUS_OK,
          lastReadTime: Date.now(),
        });
      }

      console.log(`[TagReader] Grouped word "${parentName}" (${elemSize}B): ${children.length} bits`);
      return { success: true };
    } catch (error) {
      if (handle >= 0) {
        try { plc_tag_destroy(handle); } catch { /* ignore */ }
      }
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /**
   * Parse a tag name into { parentName, bitIndex } if it follows the "Parent.N" bit-notation.
   * Returns null if it's not a bit-notation tag.
   * Examples:
   *   "Local:5:I.Data.0"   → { parentName: "Local:5:I.Data", bitIndex: 0 }
   *   "NCP1_VFD:I.In_0"    → null  (doesn't end in bare integer after dot)
   */
  private parseBitNotation(tagName: string): { parentName: string; bitIndex: number } | null {
    const match = tagName.match(/^(.+)\.(\d+)$/);
    if (!match) return null;
    const bitIndex = parseInt(match[2], 10);
    // Sanity check: bit index must be 0-31
    if (bitIndex < 0 || bitIndex > 31) return null;
    return { parentName: match[1], bitIndex };
  }

  /**
   * Create multiple tags in parallel batches.
   * Bit-notation tags (e.g. "Local:5:I.Data.0") sharing the same parent word are
   * grouped — one tag handle is created per parent word and all bits are extracted
   * from a single PLC read, reducing network requests.
   * Includes early exit if PLC appears unreachable.
   */
  async createTags(tagNames: string[]): Promise<{
    successful: string[];
    failed: Array<{ name: string; error: string }>;
    plcReachable: boolean;
  }> {
    const successful: string[] = [];
    const failed: Array<{ name: string; error: string }> = [];

    if (tagNames.length === 0) {
      return { successful, failed, plcReachable: true };
    }

    // Connection-level errors indicate PLC is unreachable
    const isConnectionError = (error: string) =>
      /Bad connection|Bad gateway|Timeout|timed out|ECONNREFUSED|EHOSTUNREACH/i.test(error);

    // --- Step 1: Separate bit-notation tags from individual tags ---
    const individualTags: string[] = [];
    const bitGroups = new Map<string, { bitIndex: number; tagName: string }[]>();

    for (const name of tagNames) {
      const parsed = this.parseBitNotation(name);
      if (parsed) {
        const group = bitGroups.get(parsed.parentName) ?? [];
        group.push({ bitIndex: parsed.bitIndex, tagName: name });
        bitGroups.set(parsed.parentName, group);
      } else {
        individualTags.push(name);
      }
    }

    // Groups with only one child are not worth grouping — treat them as individual
    for (const [parentName, children] of Array.from(bitGroups.entries())) {
      if (children.length < 2) {
        bitGroups.delete(parentName);
        individualTags.push(children[0].tagName);
      }
    }

    if (bitGroups.size > 0) {
      const totalGrouped = Array.from(bitGroups.values()).reduce((s, g) => s + g.length, 0);
      console.log(`[TagReader] Grouped ${totalGrouped} bit-notation tags into ${bitGroups.size} parent word reads`);
    }

    // --- Step 2: Create grouped parent handles ---
    for (const [parentName, children] of Array.from(bitGroups.entries())) {
      const maxBit = Math.max(...children.map((c: { bitIndex: number; tagName: string }) => c.bitIndex));
      // Determine smallest element size that fits all bits
      const elemSize = maxBit <= 7 ? 1 : maxBit <= 15 ? 2 : 4;

      const result = await this.createGroupedWord(parentName, elemSize, children);
      if (result.success) {
        for (const child of children) successful.push(child.tagName);
      } else {
        for (const child of children) {
          failed.push({ name: child.tagName, error: result.error || 'Parent word creation failed' });
        }
      }
    }

    // Early-exit check: if grouped reads all failed, check WHY
    if (successful.length === 0 && failed.length > 0 && individualTags.length > 0) {
      const hasConnectionErrors = failed.some(f => isConnectionError(f.error));
      if (hasConnectionErrors) {
        // PLC is genuinely unreachable — skip individual tags
        console.log('[TagReader] PLC unreachable (connection error) — skipping individual tags');
        for (const name of individualTags) {
          failed.push({ name, error: 'Skipped (PLC unreachable)' });
        }
        return { successful, failed, plcReachable: false };
      }
      // PLC is reachable but grouped tags don't exist — continue with individual tags
      console.log('[TagReader] PLC reachable but grouped tags not found — continuing with individual tags');
    }

    console.log(`[TagReader] Creating ${individualTags.length} individual tags in batches of ${this.config.batchSize}`);

    // Process in batches
    const batches: string[][] = [];
    for (let i = 0; i < individualTags.length; i += this.config.batchSize) {
      batches.push(individualTags.slice(i, i + this.config.batchSize));
    }

    let batchIndex = 0;
    for (const batch of batches) {
      batchIndex++;
      const batchStartTime = Date.now();

      const results = await Promise.allSettled(
        batch.map(async (name) => {
          const result = await this.createTag(name);
          return { name, ...result };
        })
      );

      let batchSuccess = 0;
      let batchFailed = 0;

      for (const result of results) {
        if (result.status === 'fulfilled') {
          if (result.value.success) {
            successful.push(result.value.name);
            batchSuccess++;
          } else {
            failed.push({ name: result.value.name, error: result.value.error || 'Unknown error' });
            batchFailed++;
          }
        } else {
          // Promise rejected
          const name = batch[results.indexOf(result)];
          failed.push({ name, error: result.reason?.message || 'Exception' });
          batchFailed++;
        }
      }

      const batchTime = Date.now() - batchStartTime;
      console.log(`[TagReader] Batch ${batchIndex}/${batches.length}: ${batchSuccess} success, ${batchFailed} failed (${batchTime}ms)`);

      // Early exit: if first batch completely fails with connection errors, PLC is unreachable
      if (batchIndex === 1 && batchSuccess === 0 && batchFailed > 0) {
        const batchErrors = failed.slice(-batchFailed);
        const allConnectionErrors = batchErrors.every(f => isConnectionError(f.error));
        if (allConnectionErrors) {
          console.log('[TagReader] PLC unreachable — aborting remaining batches');
          for (let i = 1; i < batches.length; i++) {
            for (const name of batches[i]) {
              failed.push({ name, error: 'Skipped (PLC unreachable)' });
            }
          }
          break;
        }
        // Tags just don't exist — keep trying remaining batches
        console.log('[TagReader] First batch failed (tags not found) — continuing remaining batches');
      }
    }

    // Determine reachability: if ANY tag succeeded, PLC is definitely reachable.
    // If all failed, check error types.
    const plcReachable = successful.length > 0 || failed.every(f => !isConnectionError(f.error));
    console.log(`[TagReader] Tag creation complete: ${successful.length} success, ${failed.length} failed, PLC reachable: ${plcReachable}`);
    return { successful, failed, plcReachable };
  }

  /**
   * Start continuous reading loop
   */
  async startReading(): Promise<void> {
    if (this.isReading) {
      return;
    }

    if (this.tags.size === 0) {
      this.emit('error', new Error('No tags available for reading'));
      return;
    }

    this.isReading = true;
    this.abortController = new AbortController();
    this.consecutiveErrorCycles = 0;

    // Start the continuous reading loop
    this.continuousReadLoop();
  }

  /**
   * Stop continuous reading
   */
  stopReading(): void {
    this.isReading = false;
    this.abortController?.abort();
    this.abortController = null;
  }

  /**
   * Read a single tag synchronously
   */
  async readTagValue(name: string): Promise<number | null> {
    const tagState = this.tags.get(name);
    if (!tagState) {
      return null;
    }

    const status = await readTagAsync(tagState.handle, this.config.readTimeoutMs);
    if (status !== PlcTagStatus.PLCTAG_STATUS_OK) {
      return null;
    }

    const value = plc_tag_get_bit(tagState.handle, 0);
    tagState.value = value;
    tagState.lastReadTime = Date.now();
    tagState.lastReadStatus = status;

    return value;
  }

  /**
   * Get the last cached value for a tag (from the polling loop, no fresh PLC read)
   */
  getCachedValue(name: string): number | null {
    const tagState = this.tags.get(name);
    if (!tagState) return null;
    return tagState.value;
  }

  /**
   * Check if a tag handle exists
   */
  hasTag(name: string): boolean {
    return this.tags.has(name);
  }

  /**
   * Write a value to a tag
   */
  async writeTagValue(name: string, value: number): Promise<boolean> {
    const tagState = this.tags.get(name);
    if (!tagState) {
      return false;
    }

    const status = plc_tag_set_int8(tagState.handle, 0, value);
    return status === PlcTagStatus.PLCTAG_STATUS_OK;
  }

  /**
   * Get the current value of a tag (from cache)
   */
  getTagValue(name: string): number | undefined {
    return this.tags.get(name)?.value;
  }

  /**
   * Get the boolean state of a tag
   */
  getTagState(name: string): boolean | undefined {
    const value = this.tags.get(name)?.value;
    return value !== undefined ? Boolean(value) : undefined;
  }

  /**
   * Get all tag names
   */
  getTagNames(): string[] {
    return Array.from(this.tags.keys());
  }

  /**
   * Get tag count
   */
  get tagCount(): number {
    return this.tags.size;
  }

  /**
   * Check if currently reading
   */
  get reading(): boolean {
    return this.isReading;
  }

  /**
   * Get connection status
   */
  get connected(): boolean {
    return this.isConnected;
  }

  /**
   * Get performance statistics
   */
  getPerformanceStats(): { totalCycles: number; avgCycleTimeMs: number } {
    return {
      totalCycles: this.totalReadCycles,
      avgCycleTimeMs: this.totalReadCycles > 0 ? this.totalReadTimeMs / this.totalReadCycles : 0,
    };
  }

  /**
   * Dispose all tags and clean up
   */
  dispose(): void {
    this.stopReading();
    this.destroyAllHandles();
    this.removeAllListeners();
  }

  /**
   * Reset for reconnection - disposes all tags but keeps the service alive
   */
  async resetForReconnection(): Promise<void> {
    this.stopReading();
    await this.delay(300);
    this.destroyAllHandles();
    this.consecutiveErrorCycles = 0;
    this.totalReadCycles = 0;
    this.totalReadTimeMs = 0;
  }

  /**
   * Destroy all tag handles (individual + grouped) and clear state maps.
   */
  private destroyAllHandles(): void {
    // Destroy individual tag handles (skip handle=-1 which are grouped children)
    for (const tagState of Array.from(this.tags.values())) {
      if (tagState.handle >= 0) {
        try { plc_tag_destroy(tagState.handle); } catch { /* ignore */ }
      }
    }
    this.tags.clear();

    // Destroy grouped parent word handles
    for (const word of Array.from(this.groupedWords.values())) {
      try { plc_tag_destroy(word.handle); } catch { /* ignore */ }
    }
    this.groupedWords.clear();
  }

  // === Private Methods ===

  /**
   * Main continuous reading loop
   */
  private async continuousReadLoop(): Promise<void> {
    const signal = this.abortController?.signal;

    while (this.isReading && !signal?.aborted) {
      const cycleStart = Date.now();
      let successCount = 0;
      let failCount = 0;

      try {
        // --- Read grouped parent words first (one read → many bits) ---
        for (const word of Array.from(this.groupedWords.values())) {
          if (signal?.aborted) break;
          const ok = await this.readAndProcessGroupedWord(word);
          if (ok) {
            successCount += word.bits.size;
          } else {
            failCount += word.bits.size;
          }
        }

        // --- Read individual tags (those without a grouped parent) ---
        const tagArray = Array.from(this.tags.values()).filter(t => t.handle !== -1);
        const batches: TagState[][] = [];

        for (let i = 0; i < tagArray.length; i += this.config.batchSize) {
          batches.push(tagArray.slice(i, i + this.config.batchSize));
        }

        // Process batches with limited concurrency
        for (const batch of batches) {
          if (signal?.aborted) break;

          const results = await Promise.allSettled(
            batch.map((tagState) => this.readAndProcessTag(tagState))
          );

          for (const result of results) {
            if (result.status === 'fulfilled' && result.value) {
              successCount++;
            } else {
              failCount++;
            }
          }
        }

        // Update connection status based on results
        const cycleSuccessful = failCount === 0 || successCount > failCount;
        this.updateConnectionStatus(cycleSuccessful);

        // Track performance
        const cycleTimeMs = Date.now() - cycleStart;
        this.totalReadCycles++;
        this.totalReadTimeMs += cycleTimeMs;

        this.emit('readCycleComplete', cycleTimeMs, successCount, failCount);
        this.emit('stateChanged');

        // Adaptive delay - maintain target poll interval
        const delay = Math.max(0, this.config.pollIntervalMs - cycleTimeMs);
        if (delay > 0) {
          await this.delay(delay);
        }
      } catch (error) {
        if ((error as Error).name !== 'AbortError') {
          this.emit('error', error instanceof Error ? error : new Error(String(error)));
        }
      }
    }
  }

  /**
   * Read a single tag and process value changes
   */
  private async readAndProcessTag(tagState: TagState): Promise<boolean> {
    try {
      const status = await readTagAsync(tagState.handle, this.config.readTimeoutMs);

      if (status !== PlcTagStatus.PLCTAG_STATUS_OK) {
        tagState.lastReadStatus = status as PlcTagStatusCode;
        return false;
      }

      // Use plc_tag_get_bit for boolean reads - int8 returns garbage for DINT/structured tags
      const newValue = plc_tag_get_bit(tagState.handle, 0);
      const oldValue = tagState.value;

      tagState.previousValue = oldValue;
      tagState.value = newValue;
      tagState.lastReadTime = Date.now();
      tagState.lastReadStatus = status as PlcTagStatusCode;

      // Emit value change event if value changed
      if (oldValue !== newValue) {
        const event: TagValueChangeEvent = {
          name: tagState.name,
          oldValue: Boolean(oldValue),
          newValue: Boolean(newValue),
          timestamp: Date.now(),
        };
        this.emit('tagValueChanged', event);
      }

      return true;
    } catch {
      return false;
    }
  }

  /**
   * Read a grouped parent word and update all child TagState entries.
   * One PLC read → extract N bits locally, no extra network requests.
   */
  private async readAndProcessGroupedWord(word: GroupedWord): Promise<boolean> {
    try {
      const status = await readTagAsync(word.handle, this.config.readTimeoutMs);
      if (status !== PlcTagStatus.PLCTAG_STATUS_OK) return false;

      const now = Date.now();
      for (const [bitIndex, tagName] of Array.from(word.bits.entries())) {
        const tagState = this.tags.get(tagName);
        if (!tagState) continue;

        const newValue = plc_tag_get_bit(word.handle, bitIndex);
        const oldValue = tagState.value;

        tagState.previousValue = oldValue;
        tagState.value = newValue;
        tagState.lastReadTime = now;
        tagState.lastReadStatus = PlcTagStatus.PLCTAG_STATUS_OK;

        if (oldValue !== newValue) {
          this.emit('tagValueChanged', {
            name: tagName,
            oldValue: Boolean(oldValue),
            newValue: Boolean(newValue),
            timestamp: now,
          });
        }
      }
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Update connection status based on read results
   */
  private updateConnectionStatus(cycleSuccessful: boolean): void {
    if (cycleSuccessful) {
      this.consecutiveErrorCycles = 0;
      if (!this.isConnected) {
        this.isConnected = true;
        this.emit('connectionStatusChanged', true);
      }
    } else {
      this.consecutiveErrorCycles++;
      // Mark as disconnected after 3 consecutive error cycles
      if (this.consecutiveErrorCycles >= 3 && this.isConnected) {
        this.isConnected = false;
        this.emit('connectionStatusChanged', false);
      }
    }
  }

  /**
   * Wait for a tag to reach non-pending status
   * Uses exponential backoff to avoid CPU thrashing
   */
  private async waitForStatus(handle: TagHandle, timeoutMs: number): Promise<PlcTagStatusCode> {
    const startTime = Date.now();
    let pollDelay = 5; // Start with 5ms
    const maxPollDelay = 100; // Max 100ms between polls
    const maxIterations = 1000; // Safety limit
    let iterations = 0;

    while (iterations < maxIterations) {
      iterations++;

      // Check timeout FIRST to avoid unnecessary status checks
      const elapsed = Date.now() - startTime;
      if (elapsed > timeoutMs) {
        console.log(`[TagReader] waitForStatus timeout after ${elapsed}ms, ${iterations} iterations`);
        return PlcTagStatus.PLCTAG_ERR_TIMEOUT;
      }

      try {
        const status = plc_tag_status(handle);

        if (status !== PlcTagStatus.PLCTAG_STATUS_PENDING) {
          return status as PlcTagStatusCode;
        }
      } catch (error) {
        console.error('[TagReader] Error getting tag status:', error);
        return PlcTagStatus.PLCTAG_ERR_BAD_STATUS;
      }

      // Exponential backoff with cap
      await this.delay(pollDelay);
      pollDelay = Math.min(pollDelay * 1.5, maxPollDelay);
    }

    console.log(`[TagReader] waitForStatus exceeded max iterations (${maxIterations})`);
    return PlcTagStatus.PLCTAG_ERR_TIMEOUT;
  }

  /**
   * Promise-based delay
   */
  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

// Export a factory function for creating tag reader instances
export function createTagReader(config?: Partial<TagReaderConfig>): TagReaderService {
  return new TagReaderService(config);
}
