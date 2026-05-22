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
 *
 * Error / log policy (deliberate, see audit findings):
 *   - Per-device errors only log when the error CHANGES (or every N cycles as
 *     a heartbeat). The original [TagReader] logged every failure every cycle;
 *     that was unreadable spam for a 5 s × N device loop and obscured real
 *     issues. The deviceError event still fires every cycle for consumers
 *     (e.g. WS broadcast) that want fine-grained data.
 *   - A device with a hard size mismatch is refused at create-time, not
 *     dropped silently later. Silent garbage data was the worst failure
 *     mode from the previous revision.
 *   - getLatestSnapshots() drops entries older than the stale threshold so a
 *     dead device doesn't keep haunting the heartbeat after the PLC restarts.
 */

import { EventEmitter } from 'events';
import {
  createTag,
  plc_tag_destroy,
  plc_tag_get_size,
  plc_tag_get_int8,
  plc_tag_get_int16,
  plc_tag_get_int32,
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
/** Force-re-log a per-device error every N cycles even if the message didn't change. Keeps a stuck device visible without spamming. */
const ERROR_HEARTBEAT_CYCLES = 12; // at 5 s/cycle = once every ~60 s
/** Drop cached snapshots older than this from getLatestSnapshots() so heartbeat doesn't ship stale data. */
const STALE_SNAPSHOT_MS = 60_000;

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

/** Last logged error message per device, plus the cycle index when we last logged it. */
interface DeviceErrorState {
  lastMessage: string | null;
  lastLoggedAtCycle: number;
}

export class NetworkPoller extends EventEmitter {
  private readonly pollIntervalMs: number;
  private readonly readTimeoutMs: number;
  private readonly fallbackDevices: string[];

  private gateway = '';
  private path = '';
  private devices: DeviceHandle[] = [];
  private isRunning = false;
  /** Guards against parallel start() invocations (rapid reconnect race). */
  private isStarting = false;
  private abort: AbortController | null = null;
  /** Last successful snapshot per device, keyed by deviceName. */
  private latest: Map<string, NetworkDeviceSnapshot> = new Map();
  /** Per-device error log state — used to de-spam repeated identical errors. */
  private errorState: Map<string, DeviceErrorState> = new Map();
  /** Monotonic cycle counter — drives the per-N-cycles error heartbeat. */
  private cycleIndex = 0;
  /** Whether we've already warned about a slow cycle this streak. Resets on a fast cycle. */
  private warnedSlowThisStreak = false;

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
   * Discover devices, create handles, start the polling loop. Idempotent
   * across both running and in-flight starts.
   */
  async start(): Promise<void> {
    if (this.isRunning || this.isStarting) return;
    if (!this.gateway || !this.path) {
      this.emit('error', new Error('NetworkPoller.setConnection() must be called first'));
      return;
    }
    // Set BEFORE any await so a second concurrent caller exits the guard above.
    this.isStarting = true;

    try {
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
        console.warn(
          `[NetworkPoller] No network device tags discovered (gateway=${this.gateway} path=${this.path}). ` +
            `Set config.networkPollingDevices or check @tags browse permissions.`,
        );
        return;
      }

      this.emit('discovered', discoveredNames);

      let failed = 0;
      for (const tagName of discoveredNames) {
        const device = await this.createDeviceHandle(tagName);
        if (device) {
          this.devices.push(device);
        } else {
          failed++;
        }
      }

      if (this.devices.length === 0) {
        console.warn(
          `[NetworkPoller] All ${discoveredNames.length} discovered device handle(s) failed to initialize — poller idle.`,
        );
        return;
      }

      const total = this.devices.length + failed;
      console.log(
        `[NetworkPoller] Polling ${this.devices.length}/${total} device(s) every ${this.pollIntervalMs / 1000}s: ${this.devices
          .map((d) => d.deviceName)
          .join(', ')}` + (failed > 0 ? ` (${failed} failed to initialize)` : ''),
      );

      this.isRunning = true;
      this.abort = new AbortController();
      this.emit('started');
      void this.loop();
    } finally {
      this.isStarting = false;
    }
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
    this.errorState.clear();
    this.cycleIndex = 0;
    this.warnedSlowThisStreak = false;
    this.emit('stopped');
  }

  /** True while the poll loop is running. */
  get running(): boolean {
    return this.isRunning;
  }

  /**
   * Snapshot of the most recent values per device. Entries older than
   * STALE_SNAPSHOT_MS are filtered out so the heartbeat doesn't ship a
   * snapshot from a device that has gone dark.
   */
  getLatestSnapshots(): NetworkDeviceSnapshot[] {
    const now = Date.now();
    const out: NetworkDeviceSnapshot[] = [];
    for (const snap of Array.from(this.latest.values())) {
      if (now - snap.capturedAt <= STALE_SNAPSHOT_MS) out.push(snap);
    }
    return out;
  }

  // ===== internal =====

  private async loop(): Promise<void> {
    const signal = this.abort?.signal;
    while (this.isRunning && !signal?.aborted) {
      const cycleStart = Date.now();
      this.cycleIndex++;

      // Read devices in parallel — each device is a single CIP request and
      // libplctag pools connections internally. 4-8 devices in parallel is
      // well within its comfort zone.
      await Promise.all(this.devices.map((d) => this.pollDevice(d)));

      const elapsed = Date.now() - cycleStart;
      const delay = Math.max(0, this.pollIntervalMs - elapsed);
      if (elapsed > this.pollIntervalMs * 2) {
        if (!this.warnedSlowThisStreak) {
          console.warn(
            `[NetworkPoller] Cycle ${this.cycleIndex} took ${elapsed}ms (interval ${this.pollIntervalMs}ms) — devices slow or PLC busy.`,
          );
          this.warnedSlowThisStreak = true;
        }
      } else {
        this.warnedSlowThisStreak = false;
      }
      if (delay > 0) await this.sleep(delay);
    }
  }

  private async pollDevice(device: DeviceHandle): Promise<void> {
    try {
      const status = await readTagAsync(device.handle, this.readTimeoutMs);
      if (status !== PlcTagStatus.PLCTAG_STATUS_OK) {
        this.reportDeviceError(device.deviceName, `Read failed: ${getStatusMessage(status)}`);
        return;
      }

      const reader: ByteReader = {
        int8: (off) => plc_tag_get_int8(device.handle, off),
        int16: (off) => plc_tag_get_int16(device.handle, off),
        int32: (off) => plc_tag_get_int32(device.handle, off),
      };

      const snapshot = parseNetworkDevice(reader, {
        tagName: device.tagName,
        deviceName: device.deviceName,
        capturedAt: Date.now(),
      });

      this.latest.set(device.deviceName, snapshot);
      // First successful read after an error streak — explicitly log recovery.
      const prev = this.errorState.get(device.deviceName);
      if (prev?.lastMessage) {
        console.log(`[NetworkPoller] ${device.deviceName}: recovered`);
        this.errorState.delete(device.deviceName);
      }
      this.emit('snapshot', snapshot);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.reportDeviceError(device.deviceName, msg);
    }
  }

  /**
   * Emit deviceError + console.warn with de-spam policy:
   *   - On message change: log once.
   *   - On unchanged message: log every ERROR_HEARTBEAT_CYCLES cycles.
   *   - The 'deviceError' event always fires (consumers may want every tick).
   */
  private reportDeviceError(deviceName: string, message: string): void {
    this.emit('deviceError', deviceName, message);
    const prev = this.errorState.get(deviceName);
    const isNew = !prev || prev.lastMessage !== message;
    const isHeartbeat =
      prev && prev.lastMessage === message && this.cycleIndex - prev.lastLoggedAtCycle >= ERROR_HEARTBEAT_CYCLES;
    if (isNew || isHeartbeat) {
      console.warn(`[NetworkPoller] ${deviceName}: ${message}`);
      this.errorState.set(deviceName, { lastMessage: message, lastLoggedAtCycle: this.cycleIndex });
    }
  }

  /**
   * Create a libplctag handle for one device's UDT. REFUSES the handle if
   * `plc_tag_get_size` disagrees with NETWORK_NODE_LAYOUT.TOTAL_SIZE — a
   * size mismatch means our parser would misalign every counter, and
   * publishing wrong-but-plausible data is worse than no data.
   */
  private async createDeviceHandle(tagName: string): Promise<DeviceHandle | null> {
    const deviceName = stripNetworkTagSuffix(tagName) ?? tagName;

    const handle = createTag({
      gateway: this.gateway,
      path: this.path,
      name: tagName,
      // libplctag uses elem_size * elem_count to size the buffer. We pass the
      // full expected UDT byte count as a single element; the byte-level
      // accessors operate by raw offset.
      elemSize: NETWORK_NODE_LAYOUT.TOTAL_SIZE,
      elemCount: 1,
      timeout: 0,
    });

    if (handle < 0) {
      this.reportDeviceError(deviceName, `Create failed: ${getStatusMessage(handle)}`);
      return null;
    }

    const status = await readTagAsync(handle, this.readTimeoutMs);
    if (status !== PlcTagStatus.PLCTAG_STATUS_OK) {
      this.reportDeviceError(deviceName, `Initial read failed: ${getStatusMessage(status)}`);
      try {
        plc_tag_destroy(handle);
      } catch {
        /* best-effort */
      }
      return null;
    }

    const sizeBytes = plc_tag_get_size(handle);
    if (sizeBytes !== NETWORK_NODE_LAYOUT.TOTAL_SIZE) {
      console.error(
        `[NetworkPoller] ${deviceName}: refusing to poll — tag size ${sizeBytes}B != expected ${NETWORK_NODE_LAYOUT.TOTAL_SIZE}B. ` +
          `UDT layout mismatch likely (firmware variant or controller has a different UDT definition). ` +
          `Update NETWORK_NODE_LAYOUT in lib/plc/network/types.ts or skip this device.`,
      );
      try {
        plc_tag_destroy(handle);
      } catch {
        /* best-effort */
      }
      return null;
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
   * Entry length = 22 + string_len.
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
        `[NetworkPoller] @tags browse found ${names.length} candidate network device tag(s) in ${size} bytes.`,
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
   * that opens and reads successfully wins per device. All probe handles are
   * destroyed before this method returns; createDeviceHandle re-opens the
   * winning name fresh.
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
