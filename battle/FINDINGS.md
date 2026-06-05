# Battle-test findings

Living log of what the battle environment has found. The environment's job is
to **reproduce, in an automated soak, the bug classes that have hit the field**
— and then catch their regressions forever.

## Target bug catalog (from the MCM11 sync incident, 2026-06-05)

`2026-06-05-mcm11-sync-incident.md` §5 lists 8 bugs (B1–B8) that make silent
sync-data-loss recur even on v2.40.2. The battle env targets the connectivity/
load-triggered ones because those are reproducible without a human:

| Bug | What | How the env reproduces it | Which invariant catches it |
|---|---|---|---|
| **B1** | HTTP **429** (cloud rate-limit) classified as permanent → result **dropped, not retried**. `cloud-sync-service.ts`: `permanent = status>=400 && status<500`. Cloud rate-limits push at **300/min/key**. | High write volume + `CLOUD_FLAP` (queue builds during cut, floods retries on restore → 429). | **I4** `suspect_silent_drops` with reason `HTTP 429` |
| **B7** | Version-conflict retry-cap: 200 + updatedCount=0 burns a strike; after 10 the row is **deleted** assuming "cloud already has it". | **Hot set** — all bots hammer a shared slice of IOs → version races. | **I4** `suspect_silent_drops` (version reason) |
| **B6** | Pre-pull backup failure does **not** abort the destructive pull. | (planned) make the backup dir unwritable, trigger a pull. | (planned I-backup) |
| **B2** | Pull at-risk warning under-reports (ignores comments + L2/FV). | (planned) unsynced L2 + comment, trigger pull, inspect 409 payload. | (planned) |
| **B3/B4/B5/B8** | Unsynced indicator = queue count only; heartbeat carries no queue depth; ephemeral drop toast; status-error resets count. | Mostly UI/observability — the **observer itself is the local-vs-cloud reconciliation the tool lacks (B3)**. Heartbeat depth (B4) is a cloud-side check. | I4 is the external reconciliation |

The MCM08 pull-wipe class (a destructive pull erasing unsynced local results)
is covered directly: **I4 anti-wipe** compares the bot journal (what the field
typed) to local SQLite, so a wipe that nulls both local and cloud is still caught.

## Confirmed findings

### F1 — B1 reproduced and FIXED (HTTP 429 silent drop) — 2026-06-06

**Reproduced.** A high-load + cloud-flap soak (12 bots @ 150–700ms, `CLOUD_FLAP=2,6`)
against the real MCM02 dataset drove cloud push past the 300/min rate limit. The
tool logged, repeatedly:

```
[IO Update] DROPPED-PERMANENT pendingId=1346 ioId=61516 reason="HTTP 429" result="Failed" version=3
```

9 real test results silently discarded in ~5 minutes — the exact MCM11 incident
mechanism, in an automated test. I4's `suspect_silent_drops` (reason `HTTP 429`)
flags it; the env did NOT mask it as a business rejection.

**Fixed** (`lib/cloud/sync-failure-classification.ts` + `cloud-sync-service.ts`):
429 is now classified network-level (transient) — it does NOT burn the retry
cap and is NOT deleted; it defers and retries after the window. `permanent` was
recomputed to exclude any network-level status (the caller checks `permanent`
before `network`). Unit test added (`__tests__/sync-retry-cap.test.ts`).
Verified in the env: same flap load, `suspect_silent_drops`(HTTP 429) → 0,
queue drains, I4 passes.

This single fix is incident recommendation #1 ("Fix B1 immediately").

### Still open (documented, not yet fixed)

- **B7** version-conflict retry-cap can drop genuinely-unsynced results. The
  hot-set load produces version races; if a soak shows `suspect_silent_drops`
  with a version reason, that's B7. Lower frequency than B1.
- **B2/B6** pull-warning completeness + pre-pull-backup-abort — needs a dedicated
  pull-during-dirty-state scenario (planned).
- **B4** heartbeat queue-depth — cloud-side/fleet change, out of the tool's soak.

## Run log

(Appended per soak. `verdict.json` per run in the `runs` volume.)
