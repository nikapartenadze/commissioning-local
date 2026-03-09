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
  handle: TagHandle;
  value: number;
  previousValue: number;
  hasValue: boolean;
  lastReadStatus: PlcTagStatusCode;
  lastReadTime: number;
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
   */
  async createTag(
    name: string,
    options: { elemSize?: number; elemCount?: number; timeout?: number } = {}
  ): Promise<boolean> {
    const { elemSize = 1, elemCount = 1, timeout = 5000 } = options;

    // Wrap entire operation in a timeout
    const overallTimeout = timeout + 2000; // Add buffer for retries
    const timeoutPromise = new Promise<boolean>((_, reject) => {
      setTimeout(() => reject(new Error(`Tag ${name} creation timed out after ${overallTimeout}ms`)), overallTimeout);
    });

    const createPromise = this.createTagInternal(name, { elemSize, elemCount, timeout });

    try {
      return await Promise.race([createPromise, timeoutPromise]);
    } catch (error) {
      this.emit('error', error instanceof Error ? error : new Error(String(error)), name);
      return false;
    }
  }

  /**
   * Internal tag creation logic
   */
  private async createTagInternal(
    name: string,
    options: { elemSize: number; elemCount: number; timeout: number }
  ): Promise<boolean> {
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
        return false;
      }

      // Wait for tag creation to complete
      const status = await this.waitForStatus(handle, timeout);
      if (status !== PlcTagStatus.PLCTAG_STATUS_OK) {
        console.log(`[TagReader] Tag ${name} status check failed: ${getStatusMessage(status)}`);
        plc_tag_destroy(handle);
        return false;
      }

      // Perform initial read to validate tag exists
      const readStatus = await readTagAsync(handle, this.config.readTimeoutMs);
      if (readStatus !== PlcTagStatus.PLCTAG_STATUS_OK) {
        console.log(`[TagReader] Tag ${name} validation read failed: ${getStatusMessage(readStatus)}`);
        plc_tag_destroy(handle);
        return false;
      }

      // Get initial value
      const initialValue = plc_tag_get_int8(handle, 0);

      // For digital I/O, accept any value (not just 0/1) - PLC might have fault states
      // Just log a warning instead of failing
      if (elemSize === 1 && initialValue !== 0 && initialValue !== 1) {
        console.log(`[TagReader] Tag ${name} has non-boolean value: ${initialValue} (continuing anyway)`);
      }

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
      return true;
    } catch (error) {
      // Clean up handle if we created one
      if (handle >= 0) {
        try { plc_tag_destroy(handle); } catch { /* ignore */ }
      }
      throw error;
    }
  }

  /**
   * Create multiple tags in parallel batches
   * Includes early exit if PLC appears unreachable
   */
  async createTags(tagNames: string[]): Promise<{ successful: string[]; failed: string[] }> {
    const successful: string[] = [];
    const failed: string[] = [];

    if (tagNames.length === 0) {
      return { successful, failed };
    }

    console.log(`[TagReader] Creating ${tagNames.length} tags in batches of ${this.config.batchSize}`);

    // Process in batches
    const batches: string[][] = [];
    for (let i = 0; i < tagNames.length; i += this.config.batchSize) {
      batches.push(tagNames.slice(i, i + this.config.batchSize));
    }

    let batchIndex = 0;
    for (const batch of batches) {
      batchIndex++;
      const batchStartTime = Date.now();

      const results = await Promise.allSettled(
        batch.map(async (name) => {
          const success = await this.createTag(name);
          return { name, success };
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
            failed.push(result.value.name);
            batchFailed++;
          }
        } else {
          // Promise rejected
          failed.push(batch[results.indexOf(result)]);
          batchFailed++;
        }
      }

      const batchTime = Date.now() - batchStartTime;
      console.log(`[TagReader] Batch ${batchIndex}/${batches.length}: ${batchSuccess} success, ${batchFailed} failed (${batchTime}ms)`);

      // Early exit: if first batch completely fails, PLC is likely unreachable
      if (batchIndex === 1 && batchSuccess === 0 && batchFailed > 0) {
        console.log('[TagReader] First batch failed completely - PLC may be unreachable, aborting');
        // Mark remaining tags as failed
        for (let i = 1; i < batches.length; i++) {
          failed.push(...batches[i]);
        }
        break;
      }
    }

    console.log(`[TagReader] Tag creation complete: ${successful.length} success, ${failed.length} failed`);
    return { successful, failed };
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

    const value = plc_tag_get_int8(tagState.handle, 0);
    tagState.value = value;
    tagState.lastReadTime = Date.now();
    tagState.lastReadStatus = status;

    return value;
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

    const tagValues = Array.from(this.tags.values());
    for (const tagState of tagValues) {
      try {
        plc_tag_destroy(tagState.handle);
      } catch {
        // Ignore disposal errors
      }
    }

    this.tags.clear();
    this.removeAllListeners();
  }

  /**
   * Reset for reconnection - disposes all tags but keeps the service alive
   */
  async resetForReconnection(): Promise<void> {
    this.stopReading();

    // Wait for reading to fully stop
    await this.delay(300);

    // Dispose all existing tags
    const tagValues = Array.from(this.tags.values());
    for (const tagState of tagValues) {
      try {
        plc_tag_destroy(tagState.handle);
      } catch {
        // Ignore disposal errors
      }
    }

    this.tags.clear();
    this.consecutiveErrorCycles = 0;
    this.totalReadCycles = 0;
    this.totalReadTimeMs = 0;
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
        // Read all tags in parallel batches
        const tagArray = Array.from(this.tags.values());
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

      const newValue = plc_tag_get_int8(tagState.handle, 0);
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
