# Network Device Polling (WIP)

> **Status: in-flight, feature-flagged off by default. Not yet field-validated.**

## Goal

Surface real-time port-level health for every network device on the PLC. Every
network-aware Allen-Bradley module (DPM switch, EN4TR, FIOM, VFD with embedded
Ethernet, …) exposes a `<DeviceName>_NetworkNode` tag of type
`UDT_NETWORK_NODE_DATA`. That UDT carries:

- CIP Identity Object: product code, firmware major/minor
- 32 ports of `UDT_PORT_DATA` — link state, full/half duplex, speed (Mbps),
  hardware fault, raw Interface Flags DWORD, plus 21 cumulative counters per
  port (octets in/out, errors in/out, discards in/out, alignment errors, FCS
  errors, single/multi/late/excessive collisions, MAC TX/RX errors, carrier
  sense, frame too long, etc.).

We poll the whole UDT per device every 5 s, broadcast snapshots over the
existing WebSocket, and pipe a per-cycle cached snapshot into the cloud
heartbeat. A diagnostics drawer on the Network page lets an operator see live
per-port stats and deltas-since-last-cycle without leaving the topology view.

Audience: field technicians troubleshooting "this conveyor keeps faulting" by
asking "is the port flapping, is it dropping packets, is the link half-duplex?"

## What is shipped (this WIP commit)

### `frontend/`

- `lib/plc/network/types.ts` — `NetworkDeviceSnapshot`, `PortStat`,
  `NETWORK_NODE_LAYOUT` (verified UDT byte offsets), tag-suffix helpers.
- `lib/plc/network/parser.ts` — pure `ByteReader → snapshot` decoder. Two
  reader implementations supplied (`bufferReader` for tests, libplctag-handle
  reader inline in the poller). 4/4 unit tests pass.
- `lib/plc/network/poller.ts` — `NetworkPoller` service. Independent of the
  IO tag-reader: own handles, own loop, own error path. Discovery via libplctag
  `@tags` browse (filter by structure-bit + known tag suffix) with name-pattern
  fallback driven by `config.networkPollingDevices`.
- `lib/plc-client-manager.ts` — starts/stops the poller on PLC connect /
  disconnect; broadcasts `NetworkDeviceSnapshot` over the existing
  `:3112/broadcast → /ws` pipe; exposes `getLatestNetworkDeviceSnapshots()` for
  the heartbeat to pull a cached snapshot per device.
- `lib/heartbeat/system-info.ts` — attaches `networkDevices` to the heartbeat
  payload when the poller has produced at least one cycle.
- `lib/config/{types,config-service}.ts` — adds two new config fields:
  - `networkPollingEnabled: boolean` (default **false** — kill-switch per site)
  - `networkPollingDevices: string[]` (fallback-probe device list)
- `lib/plc/types.ts` — new `NetworkDeviceSnapshotMessage` in the WS-message
  union for type-safe consumers.
- `components/network-diagnostics-drawer.tsx` — right-anchored slide-in drawer.
  Opens its own WebSocket scoped to drawer lifetime, filters snapshots by
  `deviceName`, computes counter deltas vs. the previous snapshot, renders
  header (product/firmware/link summary) + per-port table with non-zero
  errors/discards highlighted, and a "hide unused ports" toggle.
- `components/network-topology-view.tsx` — adds a small `Activity` icon button
  to every DPM/node card in a ring that opens the drawer for that device.
- `__tests__/network-poller-parser.test.ts` — 4 fixture tests asserting header,
  flag-byte, counter, and per-port-offset decoding.
- `test-network-poll.ts` (+ `npm run test:plc:network`) — hardware smoke test
  that connects, discovers, polls a few cycles, prints what it sees.

### `commissioning-cloud/`

- `app/api/sync/heartbeat/route.ts` — extends the heartbeat Zod schema so
  `systemInfo.networkDevices: NetworkDeviceSnapshot[]` is **validated**, not
  silently accepted. **No Prisma migration:** the data lands in the existing
  `ToolInstance.systemInfo` JSONB column. A separate column can be added later
  when the admin UI needs to filter on it.

## What is NOT yet done

1. **Field-validated against a real PLC.** Parsing offsets are derived from
   the L5X member order and double-checked via `plc_tag_get_size` at runtime,
   but no real hardware read has confirmed the layout end-to-end. Most likely
   miss: UDT padding/alignment for firmware revisions we haven't seen.
2. **Discovery via `@tags` browse not exercised on a live controller.** The
   code path exists and falls back to the explicit device list if the browse
   read fails or returns zero matches — but neither branch has been verified
   on hardware. The smoke script (`npm run test:plc:network`) is the next step.
3. **No SQLite history.** Counters ship raw, deltas are computed on the
   client. A history table for long-term trend charts is an easy follow-up if
   needed.
4. **No status badge on the node card itself.** The Activity-icon button
   opens the drawer, but the card itself still shows only the existing
   ConnectionFaulted-derived green/red/gray dot. A "↑5/32 ports linked"
   badge or similar could pre-fill from the cached snapshot.
5. **Cloud-side admin surface.** `systemInfo.networkDevices` is now stored
   per heartbeat but no admin view reads it yet. Easiest first step: a
   per-instance details modal section that renders the latest cached
   snapshot list.
6. **Drawer keyboard accessibility / mobile breakpoint** untested. Drawer
   uses the existing Radix Dialog primitive so escape-to-close works, but
   width / scroll behavior on a small viewport hasn't been checked.

## Enabling

In `config.json` next to `database.db`:

```json
{
  "networkPollingEnabled": true,
  "networkPollingDevices": ["SLOT2_EN4TR", "UL17_8_DPM1"]
}
```

`networkPollingDevices` is **only used if `@tags` browse returns zero
candidates** — it's a safety net for sites where the PLC blocks tag browsing.

Restart the field tool. Watch the server log for:

```
[PlcClientManager] Network poller discovered N device(s)
[NetworkPoller] Polling N device(s) every 5s: <names>
```

Click the Activity icon on any DPM card in the Network page; first snapshot
appears within ~5 s, deltas appear on the second cycle.

## Wire shapes

WebSocket broadcast:

```jsonc
{
  "type": "NetworkDeviceSnapshot",
  "snapshot": {
    "tagName": "SLOT2_EN4TR_NetworkNode",
    "deviceName": "SLOT2_EN4TR",
    "productCode": 258,
    "firmwareMajor": 7,
    "firmwareMinor": 1,
    "ports": [ /* PortStat × 32 */ ],
    "capturedAt": 1747832200000
  }
}
```

Cloud heartbeat payload (delta only — rest unchanged):

```jsonc
{
  // … existing heartbeat fields …
  "systemInfo": {
    // … existing systemInfo fields …
    "networkDevices": [ /* NetworkDeviceSnapshot[] */ ]
  }
}
```

Type definitions in `frontend/lib/plc/network/types.ts` and the
mirrored Zod validator in
`commissioning-cloud/app/api/sync/heartbeat/route.ts`.

## Safety / kill-switch

- The poller is **off by default**. A site running the latest build with no
  config change behaves identically to the previous build.
- The poller is independent of the IO tag-reader. A failing handle in the
  poller never affects IO testing.
- Disposing the PLC client (`disconnectPlc` / `disposePlcClient`) tears down
  the poller's handles as well.
