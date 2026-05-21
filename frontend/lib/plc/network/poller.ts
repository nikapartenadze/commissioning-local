/**
 * Network device poller.
 *
 * Runs independently of the IO tag reader (lib/plc/tag-reader.ts) — its own
 * libplctag handles, its own loop, its own error path. Polls every 5 s by
 * default; if a cycle overruns it starts the next one immediately rather than
 * queueing, so the cadence is "at most every N s" not "exactly every N s".
 *
 * Discovery is two-stage:
 *   1. @tags browse on the controller. Filter by structure-bit + known tag
 *      suffix (_NetworkNode, _NN.Data, _NN).
 *   2. Fallback name probing against an explicit list (passed in from config)
 *      if the browse fails or returns zero matches.
 */

import { EventEmitter } from 'events';
import {
  createTag,
  plc_tag_destroy,
  plc_tag_get_size,
  plc_tag_get_int8,
  plc_tag_get_int16,
  plc_tag_get_int32,
  plc_tag_get_bit,
  plc_tag_get_uint8,
  readTagAsync,
} from '../libplctag';
import { PlcTagStatus, getStatusMessage, type TagHandle } from '../types';
import {
  NETWORK_NODE_LAYOUT,
  NETWORK_TAG_SUFFIXES,
  stripNetworkTagSuffix,
  type NetworkDeviceSnapshot,
} from './types';
import { parseNetworkDevice, type ByteReader } from './parser';

const DEFAULT_POLL_INTERVAL_MS = 5_000;
const DEFAULT_READ_TIMEOUT_MS = 4_000;
/** Upper bound on tag-list buffer we'll request. 256 KB easily fits thousands of tag names. */
const TAG_LIST_BUFFER_BYTES = 256 * 1024;
/** Bit 13 of TagInfoEntry.symbol_type — set when the symbol is a structured (UDT) type. */
const SYMBOL_TYPE_STRUCTURE_BIT = 0x2000;

export interface NetworkPollerConfig {
  pollIntervalMs?: number;
  readTimeoutMs?: number;
  /**
   * Optional explicit device-name list, used when @tags browse fails. Empty
   * by default — without this, sites with locked-down browse access will see
   * "no network devices" in logs and need to populate it.
   */
  fallbackDevices?: string[];
}

export interface NetworkPollerEvents {
  /** Fired once per device per successful read. */
  snapshot: (snapshot: NetworkDeviceSnapshot) => void;
  /** Fired with the discovered tag names at start time. */
  discovered: (tagNames: string[]) => void;
  /** Fired once when polling actually begins (after discovery + handle setup). */
  started: () => void;
  /** Fired once on dispose / stop. */
  stopped: () => void;
  /** Per-device error during a poll cycle. The poller continues; the device retries next cycle. */
  deviceError: (deviceName: string, error: string) => void;
  /** Global failure (e.g. discovery failed entirely). The poller may still be running. */
  error: (error: Error) => void;
}

export declare interface NetworkPoller {
  on<K extends keyof NetworkPollerEvents>(event: K, listener: NetworkPollerEvents[K]): this;
  off<K extends keyof NetworkPollerEvents>(event: K, listener: NetworkPollerEvents[K]): this;
  emit<K extends keyof NetworkPollerEvents>(
    event: K,
    ...args: Parameters<NetworkPollerEvents[K]>
  ): boolean;
}

interface DeviceHandle {
  tagName: string;
  deviceName: string;
  handle: TagHandle;
  /** Bytes returned by plc_tag_get_size at handle-creation time. Used for sanity check + diagnostics. */
  sizeBytes: number;
}

export class NetworkPoller extends EventEmitter {
  private readonly pollIntervalMs: number;
  private readonly readTimeoutMs: number;
  private readonly fallbackDevices: string[];

  private gateway = '';
  private path = '';
  private devices: DeviceHandle[] = [];
  private isRunning = false;
  private abort: AbortController | null = null;
  /** Last successful snapshot per device, keyed by deviceName. Cached for the heartbeat payload. */
  private latest: Map<string, NetworkDeviceSnapshot> = new Map();

  constructor(config: NetworkPollerConfig = {}) {
    super();
    this.pollIntervalMs = config.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.readTimeoutMs = config.readTimeoutMs ?? DEFAULT_READ_TIMEOUT_MS;
    this.fallbackDevices = config.fallbackDevices ?? [];

    // Defensive guard — node's EventEmitter throws on un-listened 'error' events.
    this.on('error', (err) => {
      console.warn('[NetworkPoller] error:', err instanceof Error ? err.message : err);
    });
  }

  setConnection(gateway: string, path: string): void {
    this.gateway = gateway;
    this.path = path;
  }

  /**
   * Discover devices, create handles, start the polling loop. Safe to call
   * twice — the second call is a no-op while running.
   */
  async start(): Promise<void> {
    if (this.isRunning) return;
    if (!this.gateway || !this.path) {
      this.emit('error', new Error('NetworkPoller.setConnection() must be called first'));
      return;
    }

    let discoveredNames: string[] = [];
    try {
      discoveredNames = await this.browseNetworkTags();
    } catch (err) {
      this.emit('error', err instanceof Error ? err : new Error(String(err)));
    }

    if (discoveredNames.length === 0 && this.fallbackDevices.length > 0) {
      discoveredNames = await this.probeFallbackDevices();
    }

    if (discoveredNames.length === 0) {
      console.log('[NetworkPoller] No network device tags discovered — poller idle');
      return;
    }

    this.emit('discovered', discoveredNames);

    for (const tagName of discoveredNames) {
      const device = await this.createDeviceHandle(tagName);
      if (device) this.devices.push(device);
    }

    if (this.devices.length === 0) {
      console.log('[NetworkPoller] All device handles failed to initialize — poller idle');
      return;
    }

    console.log(
      `[NetworkPoller] Polling ${this.devices.length} device(s) every ${this.pollIntervalMs / 1000}s: ${this.devices.map((d) => d.deviceName).join(', ')}`,
    );

    this.isRunning = true;
    this.abort = new AbortController();
    this.emit('started');
    void this.loop();
  }

  /** Stop the loop and destroy all handles. */
  async stop(): Promise<void> {
    if (!this.isRunning && this.devices.length === 0) return;
    this.isRunning = false;
    this.abort?.abort();
    this.abort = null;
    for (const d of this.devices) {
      try {
        plc_tag_destroy(d.handle);
      } catch {
        /* ignore — destroying handles during shutdown is best-effort */
      }
    }
    this.devices = [];
    this.latest.clear();
    this.emit('stopped');
  }

  /** True while the poll loop is running. */
  get running(): boolean {
    return this.isRunning;
  }

  /** Snapshot of the most recent values per device. Safe to call any time; returns a shallow copy. */
  getLatestSnapshots(): NetworkDeviceSnapshot[] {
    return Array.from(this.latest.values());
  }

  // ===== internal =====

  private async loop(): Promise<void> {
    const signal = this.abort?.signal;
    while (this.isRunning && !signal?.aborted) {
      const cycleStart = Date.now();

      // Read devices in parallel — each device is a single CIP request, and
      // libplctag handles its own connection pooling/concurrency under the
      // hood. 4-8 devices in parallel is well within its comfort zone.
      await Promise.all(this.devices.map((d) => this.pollDevice(d)));

      const elapsed = Date.now() - cycleStart;
      const delay = Math.max(0, this.pollIntervalMs - elapsed);
      if (delay === 0 && elapsed > this.pollIntervalMs * 2) {
        console.warn(
          `[NetworkPoller] Cycle took ${elapsed}ms (interval ${this.pollIntervalMs}ms) — devices may be slow`,
        );
      }
      if (delay > 0) await this.sleep(delay);
    }
  }

  private async pollDevice(device: DeviceHandle): Promise<void> {
    try {
      const status = await readTagAsync(device.handle, this.readTimeoutMs);
      if (status !== PlcTagStatus.PLCTAG_STATUS_OK) {
        this.emit('deviceError', device.deviceName, `Read failed: ${getStatusMessage(status)}`);
        return;
      }

      const reader: ByteReader = {
        int8: (off) => plc_tag_get_int8(device.handle, off),
        int16: (off) => plc_tag_get_int16(device.handle, off),
        int32: (off) => plc_tag_get_int32(device.handle, off),
        bit: (bitOff) => plc_tag_get_bit(device.handle, bitOff) === 1,
      };

      const snapshot = parseNetworkDevice(reader, {
        tagName: device.tagName,
        deviceName: device.deviceName,
        capturedAt: Date.now(),
      });

      this.latest.set(device.deviceName, snapshot);
      this.emit('snapshot', snapshot);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.emit('deviceError', device.deviceName, msg);
    }
  }

  /**
   * Create a libplctag handle for one device's UDT. Validates the resulting
   * byte size against NETWORK_NODE_LAYOUT.TOTAL_SIZE; if it disagrees, we still
   * accept it (firmware padding can vary) but log a warning so a parse glitch
   * shows up as a clue rather than a mystery.
   */
  private async createDeviceHandle(tagName: string): Promise<DeviceHandle | null> {
    const deviceName = stripNetworkTagSuffix(tagName) ?? tagName;

    const handle = createTag({
      gateway: this.gateway,
      path: this.path,
      name: tagName,
      // libplctag uses elem_size * elem_count to size the buffer. We don't
      // know the exact size for sure (firmware padding varies), so we pass
      // the expected total bytes as a single element. libplctag accepts this
      // for UDT reads — the byte-level accessors operate by raw offset.
      elemSize: NETWORK_NODE_LAYOUT.TOTAL_SIZE,
      elemCount: 1,
      timeout: 0,
    });

    if (handle < 0) {
      this.emit('deviceError', deviceName, `Create failed: ${getStatusMessage(handle)}`);
      return null;
    }

    const status = await readTagAsync(handle, this.readTimeoutMs);
    if (status !== PlcTagStatus.PLCTAG_STATUS_OK) {
      this.emit('deviceError', deviceName, `Initial read failed: ${getStatusMessage(status)}`);
      try {
        plc_tag_destroy(handle);
      } catch {
        /* best-effort */
      }
      return null;
    }

    const sizeBytes = plc_tag_get_size(handle);
    if (sizeBytes !== NETWORK_NODE_LAYOUT.TOTAL_SIZE) {
      console.warn(
        `[NetworkPoller] ${deviceName}: tag size ${sizeBytes} != expected ${NETWORK_NODE_LAYOUT.TOTAL_SIZE} — parsing anyway, watch for misaligned counters`,
      );
    }

    return { tagName, deviceName, handle, sizeBytes };
  }

  /**
   * @tags browse on the controller. Returns the tag names whose symbol_type
   * has the structure bit set AND whose name ends with one of the known
   * NETWORK_TAG_SUFFIXES.
   *
   * TagInfoEntry layout (from libplctag, little-endian):
   *   +0  uint32 instance_id
   *   +4  uint16 symbol_type           (bit13 = structure)
   *   +6  uint16 element_length
   *   +8  uint32 array_dim[0]
   *   +12 uint32 array_dim[1]
   *   +16 uint32 array_dim[2]
   *   +20 uint16 string_len
   *   +22 char   string[string_len]
   * Entry length = 22 + string_len, rounded to next 2 bytes is NOT applied.
   */
  private async browseNetworkTags(): Promise<string[]> {
    let handle: TagHandle = -1;
    try {
      handle = createTag({
        gateway: this.gateway,
        path: this.path,
        name: '@tags',
        elemSize: 1,
        elemCount: TAG_LIST_BUFFER_BYTES,
        timeout: 0,
      });
      if (handle < 0) {
        console.log(`[NetworkPoller] @tags browse unavailable: ${getStatusMessage(handle)}`);
        return [];
      }

      const status = await readTagAsync(handle, this.readTimeoutMs * 2);
      if (status !== PlcTagStatus.PLCTAG_STATUS_OK) {
        console.log(`[NetworkPoller] @tags browse read failed: ${getStatusMessage(status)}`);
        return [];
      }

      const size = plc_tag_get_size(handle);
      if (size <= 0) return [];

      const names: string[] = [];
      let off = 0;
      while (off + 22 <= size) {
        // 22-byte fixed header
        const symbolType = readU16LE(handle, off + 4);
        const stringLen = readU16LE(handle, off + 20);

        if (stringLen === 0 || off + 22 + stringLen > size) break;

        const name = readAscii(handle, off + 22, stringLen);
        off += 22 + stringLen;

        if ((symbolType & SYMBOL_TYPE_STRUCTURE_BIT) === 0) continue; // skip non-UDT
        if (!NETWORK_TAG_SUFFIXES.some((s) => name.endsWith(s))) continue;

        names.push(name);
      }

      console.log(
        `[NetworkPoller] @tags browse found ${names.length} candidate network device tag(s) in ${size} bytes`,
      );
      return names;
    } finally {
      if (handle >= 0) {
        try {
          plc_tag_destroy(handle);
        } catch {
          /* best-effort */
        }
      }
    }
  }

  /**
   * Probe explicit device names against each known suffix. The first suffix
   * that opens and reads successfully wins per device.
   */
  private async probeFallbackDevices(): Promise<string[]> {
    const found: string[] = [];
    for (const device of this.fallbackDevices) {
      for (const suffix of NETWORK_TAG_SUFFIXES) {
        const tagName = `${device}${suffix}`;
        const handle = createTag({
          gateway: this.gateway,
          path: this.path,
          name: tagName,
          elemSize: NETWORK_NODE_LAYOUT.TOTAL_SIZE,
          elemCount: 1,
          timeout: 0,
        });
        if (handle < 0) continue;
        const status = await readTagAsync(handle, this.readTimeoutMs);
        try {
          plc_tag_destroy(handle);
        } catch {
          /* best-effort */
        }
        if (status === PlcTagStatus.PLCTAG_STATUS_OK) {
          found.push(tagName);
          break;
        }
      }
    }
    if (found.length > 0) {
      console.log(`[NetworkPoller] Fallback probe matched ${found.length} device(s): ${found.join(', ')}`);
    }
    return found;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

// ===== local helpers — read multi-byte primitives directly from a tag handle =====

function readU16LE(handle: TagHandle, offset: number): number {
  const lo = plc_tag_get_uint8(handle, offset);
  const hi = plc_tag_get_uint8(handle, offset + 1);
  return (hi << 8) | lo;
}

function readAscii(handle: TagHandle, offset: number, length: number): string {
  const chars = new Array<string>(length);
  for (let i = 0; i < length; i++) {
    chars[i] = String.fromCharCode(plc_tag_get_uint8(handle, offset + i));
  }
  return chars.join('');
}

export function createNetworkPoller(config?: NetworkPollerConfig): NetworkPoller {
  return new NetworkPoller(config);
}
