# PLC Tag Reading Architecture — Technical Evaluation

**Date:** March 22, 2026
**System:** IO Checkout Tool (Local Commissioning App)
**PLC Platform:** Allen-Bradley ControlLogix (Ethernet/IP via libplctag)
**Prepared for:** Engineering review — tag read optimization discussion

---

## 1. Current Architecture Overview

The app reads PLC tag states via **libplctag** (C library accessed through ffi-rs). A continuous polling loop runs at a **75ms target interval**, reading all tags and broadcasting state changes to connected browsers via WebSocket.

```
┌─────────────┐     75ms cycle     ┌──────────────┐    WebSocket    ┌──────────┐
│ Allen-Bradley│◄──── reads ───────│  Tag Reader   │───broadcast───►│ Browsers │
│     PLC      │                   │  (Node.js)    │   (port 3002)  │ (tablets)│
└─────────────┘                    └──────────────┘                 └──────────┘
```

### How Tags Are Created

Each IO from the database gets a libplctag handle:

```
plc_tag_create("protocol=ab_eip&gateway=192.168.1.100&path=1,0&cpu=logix
                &elem_size=4&elem_count=1&name=Local:5:I.Data", timeout)
→ returns integer handle (e.g., 42)
```

The handle is stored and reused for all subsequent reads. Creation is a one-time cost during PLC connection.

---

## 2. Two Read Strategies

### Strategy A: Individual Bit Reads (Default)

Each IO tag gets its own handle. Per cycle, each tag requires:
1. `plc_tag_read(handle, 0)` — initiate network read
2. `waitForStatus(handle)` — poll until read completes
3. `plc_tag_get_bit(handle, 0)` — extract boolean value

**Cost per tag per cycle:** 1 network round-trip to PLC

### Strategy B: DINT Grouping (Automatic Optimization)

The system detects bit-notation tags (e.g., `Local:5:I.Data.0`, `Local:5:I.Data.1`, ..., `Local:5:I.Data.15`) that share a common parent word. Instead of 16 individual reads, it:

1. Creates ONE parent tag handle for the word (`Local:5:I.Data`, 4 bytes)
2. Reads the entire word in a single network call
3. Extracts each bit locally via `plc_tag_get_bit(parentHandle, bitIndex)`

**Cost per group per cycle:** 1 network round-trip (regardless of how many bits)

```
WITHOUT GROUPING                     WITH GROUPING
─────────────────                    ──────────────
Local:5:I.Data.0  → PLC read       Local:5:I.Data → PLC read (1 call)
Local:5:I.Data.1  → PLC read         ├─ bit 0 → local extract
Local:5:I.Data.2  → PLC read         ├─ bit 1 → local extract
...                                    ├─ bit 2 → local extract
Local:5:I.Data.15 → PLC read         ...
                                       └─ bit 15 → local extract
= 16 network calls                  = 1 network call
```

**Grouping criteria:**
- Tag name must match pattern `ParentName.BitIndex` (e.g., `Module:I.Data.5`)
- At least 2 bits from the same parent word must exist
- Element size auto-detected: bits 0-7 → 1 byte, bits 0-15 → 2 bytes, bits 0-31 → 4 bytes (DINT)

---

## 3. Polling Loop Mechanics

Each 75ms cycle runs two phases:

### Phase 1: Grouped Word Reads (Sequential)
```
For each GroupedWord:
  1. plc_tag_read(parentHandle)     ← 1 network call
  2. For each bit in group:
     plc_tag_get_bit(parent, idx)   ← local, ~0.001ms each
  3. Emit change events for any flipped bits
```

### Phase 2: Individual Tag Reads (Parallel Batches of 25)
```
For each batch of 25 tags:
  Promise.allSettled([
    readTag(handle1),   ← network call
    readTag(handle2),   ← network call
    ...
    readTag(handle25),  ← network call
  ])
  Wait for batch to complete, then start next batch
```

### Adaptive Timing
```
actualDelay = max(0, 75ms - cycleTime)
```
If reads take 40ms, the system waits 35ms. If reads exceed 75ms, the next cycle starts immediately (no sleep).

---

## 4. Call Count Analysis

### Example: 664 IO Tags (Typical MCM09 Subsystem)

Assume tag breakdown:
- 400 bit-notation tags groupable into 25 DINT words (16 bits each)
- 264 individual tags (VFDs, standalone IOs, etc.)

| Phase | Tags | PLC Network Calls | Method |
|-------|------|-------------------|--------|
| Grouped reads | 400 bits | **25 calls** | 1 per parent word |
| Individual reads | 264 tags | **264 calls** | 1 per tag |
| **Total** | **664 tags** | **289 calls/cycle** | |

**Without grouping:** 664 calls/cycle
**With grouping:** 289 calls/cycle
**Reduction:** 56% fewer network calls

### Timing Impact

On local network (1-5ms per PLC read):
- 289 calls × ~3ms avg = **~867ms per cycle** (sequential)
- With parallel batching (25 concurrent): ~867ms / 25 ≈ **~35ms per cycle**
- Well within 75ms target

On slower network (5-10ms per read):
- 289 calls × 7ms / 25 batch = **~81ms per cycle**
- Slightly exceeds 75ms — cycles would run back-to-back

---

## 5. How Different IO Structures Are Handled

### IB16 / OB16 (16-point Digital IO Blocks)
- Tags: `Module:I.Data.0` through `Module:I.Data.15`
- **Current handling:** Automatically grouped into 1 DINT read (2 bytes, INT)
- **Calls:** 1 per module instead of 16
- **Status:** Optimally handled

### IB32 / DINT-width Blocks
- Tags: `Module:I.Data.0` through `Module:I.Data.31`
- **Current handling:** Grouped into 1 DINT read (4 bytes)
- **Calls:** 1 per module instead of 32
- **Status:** Optimally handled

### APF (Analog Point-to-Field) Modules
- Tags often use structured paths: `Module:I.Ch0Data`, `Module:I.Ch1Data`
- These are NOT bit-notation — each channel is a separate tag
- **Current handling:** Individual reads (1 call per channel)
- **Potential optimization:** Could read entire module I/O buffer as a single block and extract channels locally

### VFD (Variable Frequency Drives)
- Tags: `VFD_Name:I.ConnectionFaulted`, `VFD_Name:I.In_0`, `VFD_Name:O.Out_0`
- Mix of status bits and control words
- **Current handling:** Individual reads per tag
- **Potential optimization:** Group by VFD if multiple tags share same device gateway

### FIOM (Field IO Modules)
- Similar to IB16 — typically `FIOM:I.Data.0` through `FIOM:I.Data.N`
- **Current handling:** Automatically grouped via DINT optimization
- **Status:** Optimally handled for bit-notation tags

### Network Status Tags (ConnectionFaulted)
- Tags like `DPM1:I.ConnectionFaulted` — one per network device
- **Current handling:** Individual reads (boolean per device)
- Use negative IDs, excluded from IO testing UI
- **Potential optimization:** Could group if PLC has a summary word, but typically these are scattered across different modules

---

## 6. Known Inefficiencies

### 6.1 Single-Bit Parents Not Grouped
Tags where only 1 bit exists for a parent word are excluded from grouping (threshold: ≥ 2 bits). These fall back to individual reads even though reading the parent word would be just as fast.

**Impact:** Minor — adds 1 extra call per orphan bit.

### 6.2 No Multi-Word Block Reads
If a module has `I.Data[0]` through `I.Data[3]` (4 DINTs = 128 bits), the system creates 4 grouped reads. A single block read (`elem_count=4`) could fetch all 128 bits in 1 call.

**Impact:** Moderate — reduces calls by ~4x for large modules.
**Implementation complexity:** Low — libplctag supports `elem_count > 1`.

### 6.3 Sequential Grouped Reads
Grouped word reads run sequentially (one after another). They could run in parallel like individual tags.

**Impact:** Minor — grouped reads are few (10-30 typically) and fast.

### 6.4 No Read-Ahead Pipelining
While processing batch N results, batch N+1 could already be reading. Currently each batch waits for the previous to complete.

**Impact:** Could reduce cycle time by ~30% for large tag counts.

### 6.5 Uniform Polling Rate
All tags poll at 75ms regardless of importance. Network status tags (ConnectionFaulted) could poll at 500ms. Critical safety-related tags might need 50ms.

**Impact:** Reduces total calls by deprioritizing low-frequency tags.

---

## 7. Optimization Opportunities (Ranked by Impact)

### High Impact

| # | Optimization | Current Calls | Optimized Calls | Reduction |
|---|-------------|---------------|-----------------|-----------|
| 1 | **Multi-word block reads** — read entire module I/O image (elem_count=N) instead of per-DINT | 25 grouped | ~8 block reads | 68% |
| 2 | **APF/analog grouping** — read APF module as single block, extract channels in JS | 1 per channel | 1 per module | 75-90% |
| 3 | **Batch pipelining** — start next batch while processing current | N/A | N/A | ~30% faster cycles |

### Medium Impact

| # | Optimization | Benefit |
|---|-------------|---------|
| 4 | **Priority-based polling** — critical tags at 50ms, status tags at 500ms | 40-60% fewer low-priority reads |
| 5 | **Group single-bit orphans** — remove the ≥2 threshold | Saves 1 call per orphan |
| 6 | **Parallel grouped reads** — run word reads concurrently | Saves ~5-15ms per cycle |

### Low Impact (Diminishing Returns)

| # | Optimization | Benefit |
|---|-------------|---------|
| 7 | Use `plc_tag_get_int32` + JS bitwise instead of `plc_tag_get_bit` per bit | Microseconds saved per extraction |
| 8 | Reduce waitForStatus initial interval from 5ms to 2ms | Faster tag creation, not per-cycle |
| 9 | Connection pooling in libplctag | Depends on library internals |

---

## 8. Recommended Next Steps

### Quick Win (Low Risk, High Value)
**Multi-word block reads.** For modules with consecutive DINT data (like IB32, FIOM I/O blocks), use `elem_count` > 1 in the libplctag attribute string. Read the entire I/O buffer as one block, extract bits in JavaScript.

Example:
```
// Current: 4 separate reads for 4 DINTs
"name=Local:5:I.Data[0]&elem_size=4&elem_count=1"  // read 1
"name=Local:5:I.Data[1]&elem_size=4&elem_count=1"  // read 2
"name=Local:5:I.Data[2]&elem_size=4&elem_count=1"  // read 3
"name=Local:5:I.Data[3]&elem_size=4&elem_count=1"  // read 4

// Optimized: 1 read for all 4 DINTs (128 bits)
"name=Local:5:I.Data[0]&elem_size=4&elem_count=4"  // 1 read, 16 bytes
// Then: plc_tag_get_bit(handle, 0..127) for each bit
```

### Medium Term
**APF analog module block reads.** Investigate APF tag structure — if channels are sequential in the PLC's I/O image, read the entire module buffer as one block.

### Long Term
**Priority-based polling.** Separate tags into tiers (critical/normal/status) with different poll intervals. Requires UI/config changes but scales better with large tag counts.

---

## 9. Summary

| Metric | Current | With Block Reads | Notes |
|--------|---------|-----------------|-------|
| Tags supported | 664 | 664 | No change |
| PLC calls per cycle | ~289 | ~50-80 | 70-80% reduction |
| Cycle time (LAN) | ~35ms | ~10-15ms | Well under 75ms target |
| Grouping coverage | Bit-notation only | All module I/O | Covers APF, IB16, IB32 |
| CPU overhead | Low | Low | Bit extraction is trivial |

**Bottom line:** The current DINT grouping optimization already handles the most common case (IB16/IB32 digital modules). The biggest remaining win is **multi-word block reads** for modules with multiple DINTs, which would reduce PLC calls by another 70-80% on top of existing grouping. This is a libplctag configuration change (`elem_count` > 1), not an architectural rewrite.

---

*Generated from codebase analysis of `lib/plc/tag-reader.ts`, `lib/plc/plc-client.ts`, `lib/plc/libplctag.ts`*
