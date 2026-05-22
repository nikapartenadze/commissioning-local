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
- `lib/config/{types,config-service}.ts` — adds one optional config field:
  - `networkPollingDevices: string[]` — fallback-probe device list, used
    only when `@tags` browse fails or returns zero matches. The poller
    itself runs unconditionally on every PLC connection; this field is just
    a safety net for sites with locked-down tag browsing.
- `lib/plc/types.ts` — new `NetworkDeviceSnapshotMessage` in the WS-message
  union for type-safe consumers.
- `components/network-diagnostics-drawer.tsx` — right-anchored slide-in drawer.
  Opens its own WebSocket scoped to drawer lifetime, filters snapshots by
  `deviceName`, computes counter deltas vs. the previous snapshot, renders
  header (product/firmware/link summary) + per-port table with non-zero
  errors/discards highlighted, and a "hide unused ports" toggle.
- `components/network-topology-view.tsx` — adds a small `Activity` icon button
  to every DPM/node card in a ring that opens the drawer for that device.
- `__tests__/network-poller-parser.test.ts` — 6 fixture tests asserting
  header, Ports[0] skip, bit-derivation from `Link_Status_Raw`, per-port
  counter offsets, absolute-offset honoring, and the layout-constants
  invariants.
- `test-network-poll.ts` (+ `npm run test:plc:network`) — hardware smoke test
  that connects, discovers, polls a few cycles, prints what it sees.

### `commissioning-cloud/`

- `app/api/sync/heartbeat/route.ts` — extends the heartbeat Zod schema so
  `systemInfo.networkDevices: NetworkDeviceSnapshot[]` is **validated**, not
  silently accepted. **No Prisma migration:** the data lands in the existing
  `ToolInstance.systemInfo` JSONB column. A separate column can be added later
  when the admin UI needs to filter on it.

## Audit pass (2026-05-22) — what was wrong with the first revision

A subagent audit against `CDW5_MCM01_REV1.L5X` (a more representative L5X
than the original `checkthis.L5X`) and the `IOCT_COMMUNICATION_MONITOR` RLL
routine surfaced several issues that have all been fixed in the follow-up
commit:

- **Layout was off-by-everything.** New L5X structures `UDT_PORT_DATA` as
  composed sub-UDTs. `Link_Status_Raw` (DINT) is at offset 0 inside
  `UDT_LINK_DATA`, NOT the SINT alias byte — the previous code had them
  swapped. The header is 6 bytes + 2 bytes pad, not 4. And the Ports array
  is `Dimension="33"` (1-based, index [0] reserved/unused), not 32. The
  parser now reads `linkStatusRaw` first and decodes flag bits from it
  directly (the CIP-canonical positions 0, 1, 5, 6) rather than from the
  SINT alias byte. The handle is now refused at create time if
  `plc_tag_get_size` disagrees with `TOTAL_SIZE`, so wrong-but-plausible
  data can never silently ship.
- **Flag bits were unreliable anyway.** The PLC `IOCT_COMMUNICATION_MONITOR`
  routine only MSG-writes `Link_Status_Raw` (and the IF + Media counter
  blocks). The hidden SINT alias byte gets populated only if Logix
  bit-aliasing happens to run — which it may not. Deriving the bits from
  the DWORD eliminates that uncertainty.
- **`Speed_Mbps` will be 0 on this PLC.** The routine doesn't MSG-read
  Class 0xF6 Attr 1. Documented; consumers should treat 0 as "not
  populated", not "link down".
- **Log spam fixed.** Per-device errors used to fire every 5 s — same wall
  of noise the original `[TagReader]` produced. The poller now logs an
  error only when the message changes, and re-logs every ~60 s as a
  heartbeat so a stuck device stays visible without spamming. Recovery
  ("device X: recovered") is logged explicitly.
- **Double-start race fixed.** Two `'initialized'` events landing during a
  rapid reconnect could previously run `browseNetworkTags()` twice in
  parallel, each allocating a 256 KB tag-list buffer. Sentinel-assignment
  now happens before any await.
- **Stops on PLC error.** The poller used to keep hammering dead handles
  forever during auto-reconnect. It now tears down on
  `connectionStatusChanged: 'error' | 'disconnected'` and restarts on the
  next `'initialized'`.
- **Stale snapshots expire.** `getLatestSnapshots()` drops entries older
  than 60 s so a dead device doesn't keep haunting the heartbeat.
- **Heartbeat payload downsampled.** Network snapshots ride the heartbeat
  only every 60 s now (was every 10 s). The WS broadcast for the
  diagnostics drawer is unchanged at 5 s.
- **ARIA description added** to the diagnostics drawer; the React
  setState-in-setState pattern in the WS handler is gone (uses a ref).

## What is NOT yet done

1. **Field-validated against a real PLC.** Layout now matches
   `CDW5_MCM01_REV1.L5X` and the size check at handle creation will refuse
   any device whose UDT is a different size, but no real hardware read has
   confirmed the counters land in the right slots yet. The smoke script
   (`npm run test:plc:network`) is the next step.
2. **Discovery via `@tags` browse not exercised on a live controller.**
   Falls back to the explicit `networkPollingDevices` list if browse
   returns empty.
3. **`Speed_Mbps` always 0** on PLCs whose routine doesn't MSG-read
   Class 0xF6 Attr 1. The UI currently shows `"0M"` for linked ports,
   which is misleading. Either the PLC routine needs to add the Speed MSG,
   or the UI should show "—" when speed is 0 but link is up.
4. **No SQLite history.** Counters ship raw, deltas are computed on the
   client.
5. **No status badge on the node card itself.** The Activity-icon button
   opens the drawer, but the card itself still shows only the existing
   ConnectionFaulted-derived green/red/gray dot.
6. **Cloud-side admin surface.** `systemInfo.networkDevices` is stored per
   heartbeat (now max once per minute) but no admin view reads it yet.
7. **WS broadcast fan-out** is still global: every connected tab receives
   every snapshot. Bounded in practice by the small per-cycle payload, but
   a subscribe/unsubscribe protocol would be cleaner long-term.

## Enabling

Nothing to enable. The poller starts automatically on every PLC connect.
A PLC without `*_NetworkNode` tags just logs one "no devices discovered"
line and idles — no impact on IO testing.

The only optional knob is for sites where the PLC blocks `@tags` browse:

```json
{
  "networkPollingDevices": ["SLOT2_EN4TR", "UL17_8_DPM1"]
}
```

When set, the poller falls back to probing each name against the known
suffixes (`_NetworkNode`, `_NN.Data`, `_NN`). When `@tags` browse works,
this field is ignored.

Watch the server log on first PLC connect for:

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
