/**
 * Network device poller.
 *
 * Runs independently of the IO tag reader (lib/plc/tag-reader.ts) — its own
 * libplctag handles, its own loop, its own error path. Polls every 60 s by
 * default; if a cycle overruns it starts the next one immediately rather than
 * queueing, so the cadence is "at most every N s" not "exactly every N s".
 *
 * Cadence note: this poller used to run every 5 s, which caused noticeable
 * lag in the IO testing grid on busy controllers — every cycle queued N
 * parallel CIP requests against the same PLC the IO tag reader hammers at
 * ~75 ms × 600+ tags. The cloud-side consumer (heartbeat in system-info.ts)
 * already downsamples to 60 s, so faster polling here was pure overhead.
 * Operators who need fresh data for active network debugging can override
 * via `networkPollingIntervalMs` in config.json.
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
 *     that was unreadable spam for a fast loop and obscured real issues. The
 *     deviceError event still fires every cycle for consumers (e.g. WS
 *     broadcast) that want fine-grained data.
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
  plc_tag_get_raw_bytes,
  readTagAsync,
} from '../libplctag';
import { PlcTagStatus, getStatusMessage, type TagHandle } from '../types';
import {
  EXCLUDED_RACK_SLOTS,
  isExcludedRackSlot,
  NETWORK_NODE_LAYOUT,
  NETWORK_TAG_SUFFIXES,
  stripNetworkTagSuffix,
  type NetworkDeviceSnapshot,
} from './types';
import { bufferReader, parseNetworkDevice } from './parser';
import { readDlrStatus, ringVerdict, deriveDlrPath, type RingStatus } from './dlr';

/** Default poll cadence. Operators can override via config.networkPollingIntervalMs. */
const DEFAULT_POLL_INTERVAL_MS = 60_000;
const DEFAULT_READ_TIMEOUT_MS = 4_000;
/** Upper bound on tag-list buffer we'll request. 256 KB easily fits thousands of tag names. */
const TAG_LIST_BUFFER_BYTES = 256 * 1024;
/** Bit 13 of TagInfoEntry.symbol_type — set when the symbol is a structured (UDT) type. */
const SYMBOL_TYPE_STRUCTURE_BIT = 0x2000;
/** Force-re-log a per-device error every N cycles even if the message didn't change. Keeps a stuck device visible without spamming. At 60 s/cycle = once every 5 min. */
const ERROR_HEARTBEAT_CYCLES = 5;
/** Drop cached snapshots older than this so heartbeat doesn't ship stale data. Set to 3× the default poll interval so a single missed cycle doesn't drop a still-recent snapshot; operators tightening pollIntervalMs below 60 s pick up correspondingly fresher staleness anyway. */
const STALE_SNAPSHOT_MS = 180_000;
/** When the DLR ring reads UNKNOWN (no supervisor reply — absent module times
 * out, which is costly), only re-probe every N cycles instead of every cycle.
 * While the ring IS readable we probe every cycle so a break is caught fast. */
const DLR_REPROBE_CYCLES = 5;

export interface NetworkPollerConfig {
  pollIntervalMs?: number;
  readTimeoutMs?: number;
  /**
   * Optional explicit device-name list, used when @tags browse fails. Empty
   * by default — without this, sites with locked-down browse access will see
   * "no network devices" in logs and need to populate it.
   */
  fallbackDevices?: string[];
  /**
   * Backplane path to the DLR ring supervisor (the EN2TR/EN4TR), e.g. "1,2".
   * When omitted, derived from a discovered SLOTn_EN4TR device name; when
   * neither is available, the DLR ring read is skipped (ring → unknown).
   */
  dlrPath?: string;
}

export interface NetworkPollerEvents {
  /** Fired once per device per successful read. */
  snapshot: (snapshot: NetworkDeviceSnapshot) => void;
  /** Fired after each DLR ring probe with the current ring verdict. */
  ringStatus: (status: RingStatus) => void;
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
  /**
   * Set once we've already printed the "no candidate tags discovered" / "no
   * network device tags discovered" warnings for the current `start()`. The
   * field log showed these printing on every restart of the poller (and the
   * NetworkPoller restarts on every PLC connect/reconnect cycle), which
   * filled the service-error log with 5+ identical multi-line blocks per
   * minute during a connection storm. Cleared in `stop()` so a subsequent
   * start() can re-warn if the situation hasn't been fixed.
   */
  private warnedNoDevicesThisStart = false;
  private warnedNoCandidatesThisStart = false;
  /** Backplane path to the DLR supervisor (configured or derived); '' = none. */
  private dlrPath: string | undefined;
  /** Latest DLR ring verdict. Unknown until the first successful probe. */
  private latestRing: RingStatus = { state: 'unknown', reason: 'Not yet probed' };
  /** Cycle index of the last DLR probe — drives the unknown-state backoff. */
  private lastDlrProbeCycle = -DLR_REPROBE_CYCLES;

  constructor(config: NetworkPollerConfig = {}) {
    super();
    this.pollIntervalMs = config.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.readTimeoutMs = config.readTimeoutMs ?? DEFAULT_READ_TIMEOUT_MS;
    this.fallbackDevices = config.fallbackDevices ?? [];
    this.dlrPath = config.dlrPath;

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
      // Let the IO tag reader's startup burst finish before we add CIP load.
      // Without this delay the PLC's request queue is saturated and every
      // initial read comes back PLCTAG_ERR_BUSY.
      await this.sleep(2_000);

      let discoveredNames: string[] = [];
      try {
        discoveredNames = await this.browseNetworkTags();
      } catch (err) {
        this.emit('error', err instanceof Error ? err : new Error(String(err)));
      }

      if (discoveredNames.length === 0 && this.fallbackDevices.length > 0) {
        discoveredNames = await this.probeFallbackDevices();
      }

      // Drop excluded controller-chassis rack slots (field request) — these
      // carry no real network node and were just noise in the readings.
      const beforeExclude = discoveredNames.length;
      discoveredNames = discoveredNames.filter((tagName) => !isExcludedRackSlot(tagName));
      const excludedCount = beforeExclude - discoveredNames.length;
      if (excludedCount > 0) {
        console.log(
          `[NetworkPoller] Excluded ${excludedCount} rack-slot device(s) (SLOT${EXCLUDED_RACK_SLOTS.join('/')}) from polling.`,
        );
      }

      // Resolve the DLR ring-supervisor path: explicit config wins, else derive
      // from a SLOTn_EN4TR device name. No path → ring status stays Unknown.
      if (!this.dlrPath) this.dlrPath = deriveDlrPath(discoveredNames);
      console.log(
        this.dlrPath
          ? `[NetworkPoller] DLR ring supervisor path: ${this.dlrPath}`
          : '[NetworkPoller] No DLR supervisor path (no SLOTn_EN4TR found / none configured) — ring status = Unknown.',
      );

      if (discoveredNames.length === 0) {
        if (!this.warnedNoDevicesThisStart) {
          console.warn(
            `[NetworkPoller] No network device tags discovered (gateway=${this.gateway} path=${this.path}). ` +
              `Set config.networkPollingDevices or check @tags browse permissions.`,
          );
          this.warnedNoDevicesThisStart = true;
        }
        return;
      }

      this.emit('discovered', discoveredNames);

      // Throttle handle creation so we don't burst-flood the PLC's CIP queue.
      // createDeviceHandle has its own retry-on-BUSY, but spacing requests
      // here keeps the initial read on each handle from competing with the
      // previous one's tail.
      let failed = 0;
      for (const tagName of discoveredNames) {
        const device = await this.createDeviceHandle(tagName);
        if (device) {
          this.devices.push(device);
        } else {
          failed++;
        }
        await this.sleep(120);
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
    this.warnedNoDevicesThisStart = false;
    this.warnedNoCandidatesThisStart = false;
    this.latestRing = { state: 'unknown', reason: 'Not yet probed' };
    this.lastDlrProbeCycle = -DLR_REPROBE_CYCLES;
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

  /** Latest DLR ring verdict (Unknown until the first probe / when no path). */
  getLatestRingStatus(): RingStatus {
    return this.latestRing;
  }

  // ===== internal =====

  /**
   * Probe the DLR ring supervisor once per cycle while the ring is readable;
   * back off to once per DLR_REPROBE_CYCLES while Unknown (an absent module
   * times out, which is costly). No path → leave ring Unknown, never probe.
   * Never throws — a DLR read failure must not break the device poll loop.
   */
  private async maybeProbeDlr(): Promise<void> {
    if (!this.dlrPath) return;
    const due = this.cycleIndex - this.lastDlrProbeCycle >= DLR_REPROBE_CYCLES;
    if (this.latestRing.state === 'unknown' && !due) return;
    this.lastDlrProbeCycle = this.cycleIndex;

    let verdict: RingStatus;
    try {
      verdict = ringVerdict(await readDlrStatus(this.gateway, this.dlrPath));
    } catch {
      verdict = { state: 'unknown', reason: 'DLR read error' };
    }
    const changed =
      verdict.state !== this.latestRing.state || verdict.reason !== this.latestRing.reason;
    this.latestRing = verdict;
    if (changed) {
      console.log(`[NetworkPoller] DLR ring: ${verdict.state}${verdict.reason ? ` — ${verdict.reason}` : ''}`);
    }
    this.emit('ringStatus', verdict);
  }

  private async loop(): Promise<void> {
    const signal = this.abort?.signal;
    while (this.isRunning && !signal?.aborted) {
      const cycleStart = Date.now();
      this.cycleIndex++;

      // Read devices in parallel — each device is a single CIP request and
      // libplctag pools connections internally. 4-8 devices in parallel is
      // well within its comfort zone.
      await Promise.all(this.devices.map((d) => this.pollDevice(d)));
      await this.maybeProbeDlr();

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

      // Bulk-copy the UDT into a Node Buffer in a single FFI call, then parse
      // from JS memory. Previous code did ~830 plc_tag_get_int32/int8 calls
      // per device per cycle — each call a sync FFI round-trip that blocks
      // the Node event loop for ~100–500 µs. With 20 devices the cycle would
      // pin the loop for seconds. One copy + JS parse is microseconds.
      const buf = Buffer.alloc(device.sizeBytes);
      const copyStatus = plc_tag_get_raw_bytes(device.handle, 0, buf);
      if (copyStatus !== PlcTagStatus.PLCTAG_STATUS_OK) {
        this.reportDeviceError(device.deviceName, `Bulk copy failed: ${getStatusMessage(copyStatus)}`);
        return;
      }

      const snapshot = parseNetworkDevice(bufferReader(buf), {
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
   *
   * Retries on PLCTAG_ERR_BUSY with exponential backoff because the IO tag
   * reader is hammering the PLC at ~75ms cadence with 600+ tags during
   * startup; the PLC's CIP queue often replies BUSY for the first second
   * or two on a fresh handle. Without retry every device would fail to
   * initialize on a busy controller.
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

    // Retry initial read on BUSY (and a couple of related transient codes)
    // with exponential backoff. ~3.6 s total budget.
    const TRANSIENT_CODES = new Set<number>([
      PlcTagStatus.PLCTAG_ERR_BUSY,
      PlcTagStatus.PLCTAG_ERR_TIMEOUT,
      PlcTagStatus.PLCTAG_ERR_NO_RESOURCES,
    ]);
    let status: number = PlcTagStatus.PLCTAG_ERR_BUSY;
    let delay = 200;
    for (let attempt = 0; attempt < 6; attempt++) {
      status = await readTagAsync(handle, this.readTimeoutMs);
      if (status === PlcTagStatus.PLCTAG_STATUS_OK) break;
      if (!TRANSIENT_CODES.has(status)) break; // hard error — don't retry
      await this.sleep(delay);
      delay = Math.min(delay * 1.8, 1500);
    }
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

      // Bulk-copy the whole @tags response into a Node Buffer with ONE FFI
      // call, then parse the layout from JS memory. Previous code did one
      // plc_tag_get_uint8() per byte of the response — for a typical Logix
      // PLC with ~2000 tags × 34-byte avg entry that's ~68,000 sync FFI
      // calls, each blocking the event loop for 100–500 µs = up to half a
      // minute of frozen HTTP/WS handling on every PLC connect. A single
      // bulk copy is one FFI call regardless of payload size.
      const buf = Buffer.alloc(size);
      const copyStatus = plc_tag_get_raw_bytes(handle, 0, buf);
      if (copyStatus !== PlcTagStatus.PLCTAG_STATUS_OK) {
        console.warn(`[NetworkPoller] @tags bulk copy failed: ${getStatusMessage(copyStatus)}`);
        return [];
      }

      const names: string[] = [];
      /** Sample of the first ~10 names seen (regardless of suffix filter) — surfaces in the log so misconfigured naming on a new site is obvious. */
      const sampleAllNames: string[] = [];
      let entriesParsed = 0;
      let off = 0;
      while (off + 22 <= size) {
        const symbolType = buf.readUInt16LE(off + 4);
        const stringLen = buf.readUInt16LE(off + 20);

        if (stringLen === 0 || off + 22 + stringLen > size) break;

        const name = buf.toString('ascii', off + 22, off + 22 + stringLen);
        off += 22 + stringLen;
        entriesParsed++;

        if (sampleAllNames.length < 10) sampleAllNames.push(name);

        // Don't gate on the structure-bit: bit positions vary by libplctag
        // version and by firmware. The suffix filter is specific enough that
        // a non-UDT tag accidentally ending with _NN is harmless — it'll be
        // rejected at handle creation by the TOTAL_SIZE check. (`symbolType`
        // kept in the loop in case we want to log/inspect it later.)
        void symbolType;
        if (!NETWORK_TAG_SUFFIXES.some((s) => name.endsWith(s))) continue;

        names.push(name);
      }

      if (names.length > 0) {
        console.log(
          `[NetworkPoller] @tags browse: ${names.length} candidate(s) of ${entriesParsed} tag(s) in ${size}B — ${names.slice(0, 8).join(', ')}${names.length > 8 ? ', …' : ''}`,
        );
      } else if (!this.warnedNoCandidatesThisStart) {
        console.warn(
          `[NetworkPoller] @tags browse parsed ${entriesParsed} entries in ${size}B but matched 0 candidate(s). ` +
          `Suffix filter: ${NETWORK_TAG_SUFFIXES.join(' | ')}. ` +
          `Sample of first names seen: ${sampleAllNames.length === 0 ? '(none — parser broke early)' : sampleAllNames.join(', ')}. ` +
          `If the device tags use a different suffix on this controller, update NETWORK_TAG_SUFFIXES in lib/plc/network/types.ts.`,
        );
        this.warnedNoCandidatesThisStart = true;
      }
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

export function createNetworkPoller(config?: NetworkPollerConfig): NetworkPoller {
  return new NetworkPoller(config);
}
