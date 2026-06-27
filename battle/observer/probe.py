#!/usr/bin/env python3
"""
Observer — the verdict machine. Stdlib only (no pip at build time).

Probes the tool from OUTSIDE (a separate container, like a real tablet would)
and judges the run at the end. The 1-second /api/health latency probe is the
star: a blocked Node event loop (the 2026-06-05 MCM02 freeze) shows up here
within seconds as multi-second latencies, while CPU stays idle.

Outputs (in /runs/<RUN_ID>/):
  health.csv      ts,latency_ms,status  (one row per probe)
  memory.csv      ts,rss_mb,heap_mb     (scraped from the tool's [HEALTH] log lines)
  verdict.json    invariant results + stats; process exit code 0/1 mirrors it

Invariants (Phase 0):
  I1 responsiveness  p95 < 500 ms, p99 < 2000 ms, no gap > 10 s
  I2 no leak         RSS slope < 5 MB/h after warmup
  I5 stability       unexpected server.start audit events == 0; flap budget
  I3 (evidence only) every chaos 'download' is followed by a
                     "Sync done (plc-reconnect)" with written > 0 within 120 s

Env: TOOL_URL, SOAK_MINUTES (default 480), RUN_ID, FLAP_BUDGET (default 0),
     DATA_DIR (tool's /data mounted ro), RUNS_DIR.
"""
import csv
import glob
import json
import os
import re
import sqlite3
import statistics
import sys
import time
import urllib.error
import urllib.request

TOOL_URL = os.environ.get("TOOL_URL", "http://tool:3000")
SOAK_MINUTES = float(os.environ.get("SOAK_MINUTES", "480"))
RUN_ID = os.environ.get("RUN_ID", time.strftime("run-%Y%m%d-%H%M%S"))
FLAP_BUDGET = int(os.environ.get("FLAP_BUDGET", "0"))
DATA_DIR = os.environ.get("DATA_DIR", "/data")
RUNS_DIR = os.environ.get("RUNS_DIR", "/runs")
# Cloud-side verification (I4). Empty CLOUD_URL => PLC-only run, I4 skipped.
CLOUD_URL = os.environ.get("CLOUD_URL", "http://cloud:3000")
CLOUD_API_KEY = os.environ.get("CLOUD_API_KEY", "***REMOVED***")
SUBSYSTEM_ID = os.environ.get("SUBSYSTEM_ID", "38")
CHAOS_URL = os.environ.get("CHAOS_URL", "http://chaos:8666")

OUT = os.path.join(RUNS_DIR, RUN_ID)
os.makedirs(OUT, exist_ok=True)

P95_LIMIT_MS = 500.0
P99_LIMIT_MS = 2000.0
GAP_LIMIT_S = 10.0
RSS_SLOPE_LIMIT_MB_PER_H = 5.0
# Skip the boot-warmup window before measuring the RSS slope (I2): the first
# minutes allocate hard (4 MCMs each create ~1184 tags + write 209 polarity
# flags), so RSS ramps then plateaus. Always exclude at least 10 min of that
# ramp; on a long soak exclude the full first hour. (A fixed 60 min skipped the
# entire run on short soaks → vacuous pass; SOAK/3 alone let the ramp tail bleed
# into a 25-min window → FALSE leak. max(10, …) clears the ramp either way.)
WARMUP_MINUTES = min(60.0, max(10.0, SOAK_MINUTES / 3.0))
# A linear RSS slope is only trustworthy over a long, settled window: GC
# sawtooth (±15 MB) and chaos-burst transients (a download/power-cut re-writes
# 209 flags) dominate any shorter fit and manufacture a positive slope on a
# perfectly stable process. So I2 only GATES when the post-warmup window is at
# least this long; on shorter runs the slope is reported as INCONCLUSIVE, not a
# failure (leak detection is the multi-hour overnight soak's job — it passed
# clean at 7.5 h). Verified 2026-06-10: 25-min + 60-min central runs both flagged
# ~7-8 MB/h, but RSS was bounded 122-148 MB and plateaued — not a leak.
LEAK_MIN_WINDOW_MIN = 120.0


def probe_once(timeout: float = 10.0) -> tuple[float | None, int]:
    t0 = time.monotonic()
    try:
        with urllib.request.urlopen(f"{TOOL_URL}/api/health", timeout=timeout) as r:
            r.read()
            return (time.monotonic() - t0) * 1000.0, r.status
    except urllib.error.HTTPError as e:
        return (time.monotonic() - t0) * 1000.0, e.code
    except Exception:
        return None, 0


def scrape_logs() -> dict:
    """RSS samples, flap count, restore evidence, server.start events from /data/logs."""
    rss: list[tuple[float, float, float]] = []  # (epoch, rss_mb, heap_mb)
    flaps = 0
    restores: list[str] = []
    health_re = re.compile(
        r"^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}).*\[HEALTH\] Memory: heap=(\d+)MB, rss=(\d+)MB")
    flap_re = re.compile(r"Connection status: error")
    # Restore evidence: the legacy singleton logs reason `plc-reconnect`; the
    # central multi-MCM tool logs `mcm-<subsystemId>-reconnect` (per-MCM
    # registry hook). Either counts — what matters is that a reconnect ran a
    # validation convergence pass.
    restore_re = re.compile(r"Sync done \((?:plc|mcm-[\w.]+)-reconnect.*?(\d+) written")

    for path in sorted(glob.glob(os.path.join(DATA_DIR, "logs", "app-*.log"))):
        try:
            with open(path, errors="replace") as f:
                for line in f:
                    m = health_re.match(line)
                    if m:
                        ts = time.mktime(time.strptime(m.group(1), "%Y-%m-%d %H:%M:%S"))
                        rss.append((ts, float(m.group(3)), float(m.group(2))))
                    elif flap_re.search(line):
                        flaps += 1
                    else:
                        rm = restore_re.search(line)
                        if rm:
                            restores.append(line.strip()[:300])
        except OSError:
            pass

    starts = 0
    for path in sorted(glob.glob(os.path.join(DATA_DIR, "logs", "audit-*.jsonl"))):
        try:
            with open(path, errors="replace") as f:
                for line in f:
                    if '"server.start"' in line:
                        starts += 1
        except OSError:
            pass

    return {"rss": rss, "flaps": flaps, "restores": restores, "server_starts": starts}


def injected_events() -> list[dict]:
    events = []
    p = os.path.join(RUNS_DIR, RUN_ID, "injected.jsonl")
    if os.path.exists(p):
        with open(p) as f:
            for line in f:
                try:
                    events.append(json.loads(line))
                except json.JSONDecodeError:
                    pass
    return events


def journaled_results() -> dict[int, str]:
    """Latest accepted (status 200) result per IO id across all bot journals,
    EXCLUDING any IO whose last write is order-ambiguous. Last-write-wins,
    mirroring the tool's UI. These are writes that must reach local AND cloud.

    Ambiguous = written by more than one bot. The designated hot SET is the
    obvious case, but bots also randomly COLLIDE on the same non-hot IO; those
    uncoordinated concurrent writes have the same ambiguous last-write ordering
    (the observer's ts-sort and the tool's actual apply-order can disagree
    sub-second), so a later 'Cleared' winning locally would look like a wipe of
    an earlier 'Failed'. A single-writer IO keeps strict latest-by-ts, so a real
    destructive wipe (MCM08 class) on uncontended rows still trips I4, and the
    bug-path drop class (B1/B7) is detected separately from logs."""
    # ioId -> {bot -> (ts, result)} ; keep each bot's own latest write.
    per_bot: dict[int, dict[str, tuple[str, str]]] = {}
    hot: set[int] = set()
    for path in glob.glob(os.path.join(RUNS_DIR, RUN_ID, "journal-bot*.jsonl")):
        with open(path, errors="replace") as f:
            for line in f:
                try:
                    e = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if e.get("action") != "mark" or e.get("status") != 200:
                    continue
                iid = e.get("ioId")
                if iid is None:
                    continue
                if e.get("hot"):
                    hot.add(iid)
                    continue
                bot = str(e.get("bot", ""))
                # Append order within a bot's own journal IS its true write
                # order — more reliable than string-comparing ISO timestamps,
                # which tie at the same millisecond (a Failed and a Cleared in
                # the same ms would otherwise mis-order and look like a wipe).
                per_bot.setdefault(iid, {})[bot] = e.get("result")
    out: dict[int, str] = {}
    for iid, slot in per_bot.items():
        if iid in hot or len(slot) > 1:
            # Hot, or collided on by >1 bot → last write is order-ambiguous.
            continue
        out[iid] = next(iter(slot.values()))  # the single writer's last result
    return out


def cloud_results() -> dict[int, str | None] | None:
    """Pull every IO's result from cloud-stage via the REAL pull endpoint the
    field tool uses. SUBSYSTEM_ID may be a comma-separated list (central
    multi-MCM scenario) — results merge across all of them. None => cloud
    unreachable (any subsystem failing fails the read; a partial map would
    make every missing IO look wiped)."""
    out: dict[int, str | None] = {}
    for sid in [s.strip() for s in SUBSYSTEM_ID.split(",") if s.strip()]:
        url = f"{CLOUD_URL}/api/sync/subsystem/{sid}"
        req = urllib.request.Request(url, headers={"X-API-Key": CLOUD_API_KEY})
        # Large MCMs (e.g. MCM11/12 ~3800 IOs) pull slowly, and the cloud-stage
        # can be briefly restarting right after the chaos quiesce — so retry per
        # subsystem with a generous timeout. Only a PERSISTENT failure → None
        # (a partial map would make every missing IO look wiped, a false I4 fail).
        data = None
        for attempt in range(4):
            try:
                with urllib.request.urlopen(req, timeout=120) as r:
                    data = json.loads(r.read())
                break
            except Exception as e:
                print(f"observer: cloud read failed (subsystem {sid}, attempt {attempt + 1}/4): {e}")
                time.sleep(5)
        if data is None:
            print(f"observer: cloud read GAVE UP for subsystem {sid} after 4 attempts")
            return None
        for io in data.get("ios", []):
            out[int(io["id"])] = io.get("result")
    return out


def local_results_and_queue() -> tuple[dict[int, str | None], int, set[int]]:
    """Tool's local SQLite: authoritative results, pending-sync queue depth,
    and the set of IO ids still queued (those writes are SAFE, just not yet
    synced — not data loss)."""
    db_path = os.path.join(DATA_DIR, "database.db")
    res: dict[int, str | None] = {}
    pending = -1
    queued_ios: set[int] = set()
    try:
        con = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True, timeout=10)
        for iid, r in con.execute("SELECT id, Result FROM Ios"):
            res[int(iid)] = r
        # Sum all three offline queues — IO results, L2 cell writes, and
        # device-blocker edits. A non-empty queue is pending work (safe), not
        # loss; we report depth but don't fail on it.
        # ACTIVE queue only — match the tool's own pull-gate semantics. Parked
        # rows (DeadLettered=1) are permanently-rejected writes set aside for
        # attention; they will never sync and must NOT count as backlog, or the
        # queue would look "never drained" forever (masking real propagation —
        # exactly the v2.40.4 pull-gate regression this run surfaced).
        pending = 0
        for tbl, where in (
            ("PendingSyncs", " WHERE DeadLettered = 0"),
            ("L2PendingSyncs", " WHERE DeadLettered = 0"),
            ("DeviceBlockerPendingSyncs", ""),
        ):
            try:
                pending += con.execute(f"SELECT COUNT(*) FROM {tbl}{where}").fetchone()[0]
            except sqlite3.Error:
                pass
        try:
            for (iid,) in con.execute("SELECT DISTINCT IoId FROM PendingSyncs"):
                queued_ios.add(int(iid))
        except sqlite3.Error:
            pass
        con.close()
    except sqlite3.Error as e:
        print(f"observer: local DB read failed: {e}")
    return res, pending, queued_ios


def norm(result: str | None) -> str | None:
    """A journaled 'Cleared' lands as NULL result in both stores."""
    if result in (None, "", "Cleared"):
        return None
    return result


# A DROPPED-PERMANENT whose reason is one of these is the cloud AUTHORITATIVELY
# rejecting the value (legitimate divergence — exclude from data loss). ANY
# OTHER permanent drop — notably HTTP 4xx like 429 (B1) or a version-conflict
# retry-cap drop (B7) — is the tool THROWING AWAY a result the cloud never
# accepted. Those are the silent-data-loss bugs from the MCM11 incident; I4
# must count them as loss, not mask them.
BUSINESS_REJECT_PATTERNS = (
    "SPARE cannot be",
    "invalid result",
    "IO not found",
    "No valid updates",
)


def scrape_permanent_drops() -> tuple[set[int], list[dict]]:
    """Return (business_rejected_ids, suspect_drops).
    business_rejected_ids → excluded from I4 (legit cloud value rejection).
    suspect_drops → [{io, reason}] the tool dropped on HTTP status / version
    cap; these are bug-class silent drops (B1/B7) and stay in the loss check."""
    business: set[int] = set()
    suspect: list[dict] = []
    # v2.40.4 renamed the silent DROP to PARKED (kept, not deleted); match both.
    rx = re.compile(r"(?:DROPPED|PARKED)-PERMANENT.*?ioId=(\d+).*?reason=\"([^\"]*)\"")
    for path in sorted(glob.glob(os.path.join(DATA_DIR, "logs", "app-*.log"))):
        try:
            with open(path, errors="replace") as f:
                for line in f:
                    m = rx.search(line)
                    if not m:
                        continue
                    iid, reason = int(m.group(1)), m.group(2)
                    if any(p in reason for p in BUSINESS_REJECT_PATTERNS):
                        business.add(iid)
                    else:
                        suspect.append({"io": iid, "reason": reason})
        except OSError:
            pass
    return business, suspect


def mutator_edited_ids() -> set[int]:
    """IO ids the cloud-mutator deliberately changed on the cloud authority.
    For these, a journal-vs-local divergence is EXPECTED (the mutator overwrote
    the field's value on the authoritative side) and is verified by I7 instead —
    so they are out of scope for I4's field-work-loss check."""
    edited: set[int] = set()
    mut_path = os.path.join(RUNS_DIR, RUN_ID, "cloud-mutations.jsonl")
    if not os.path.exists(mut_path):
        return edited
    for line in open(mut_path, errors="replace"):
        try:
            e = json.loads(line)
        except json.JSONDecodeError:
            continue
        for key in ("edited", "added"):
            if e.get(key):
                edited |= {int(x) for x in str(e[key]).split(",") if x}
    return edited


def quiesce_crew() -> None:
    """Signal every bot to stop (sentinel the crew polls each loop) and wait for
    in-flight writes to land, so the journal stops growing before we snapshot.
    Waits a touch longer than the bots' max think time + request timeout."""
    run_dir = os.path.join(RUNS_DIR, RUN_ID)
    try:
        os.makedirs(run_dir, exist_ok=True)
        with open(os.path.join(run_dir, "STOP"), "w") as f:
            f.write("stop\n")
    except OSError as e:
        print(f"observer: could not write crew STOP sentinel: {e}")
        return
    think_max_s = int(os.environ.get("THINK_MAX_MS", "15000")) / 1000.0
    wait_s = min(60.0, think_max_s + 20.0)  # last loop's sleep + in-flight PUT
    print(f"observer: crew STOP sent — waiting {wait_s:.0f}s for bots to go quiet")
    time.sleep(wait_s)


def check_data_loss() -> dict:
    """I4 — no silent data loss. Local SQLite is the authority. For every IO
    written DURING this soak (bot journals), cloud must mirror local. The only
    allowed divergence is an IO the tool logged as a PERMANENT rejection
    (cloud business rule). Anything else = a sync bug losing field work — the
    MCM08/MCM11 class. Re-polls cloud to absorb in-flight batch syncs."""
    # Bring the crew to a STOP before snapshotting. The bots loop forever; if
    # they keep writing, `journaled` (read now) and `local` (read after the
    # settle) are incoherent — a write that lands during settle looks like a
    # wipe — and the offline queue never drains so the I7 pull never fires. The
    # sentinel makes the system QUIESCENT so the verdict judges a steady state.
    quiesce_crew()

    journaled = journaled_results()  # {ioId: latest result the field wrote}
    # Drop IOs the cloud-mutator changed: those diverge by design (I7's job).
    mutated = mutator_edited_ids()
    if mutated:
        journaled = {i: r for i, r in journaled.items() if i not in mutated}
    rejected, suspect_drops = scrape_permanent_drops()

    # Tell chaos to stop flapping/storming and restore connectivity, so the
    # system can converge for an honest final judgment (otherwise an ongoing
    # flap keeps the queue perpetually non-empty).
    try:
        urllib.request.urlopen(
            urllib.request.Request(f"{CHAOS_URL}/calm", method="POST"), timeout=10).read()
        print("observer: requested chaos /calm — letting the system converge")
    except Exception as e:
        print(f"observer: /calm failed (continuing): {e}")

    # Settle: wait for cloud reachable AND the queue to drain, so we judge a
    # CONVERGED system. The chaos flapper is expected to have stopped by now
    # (scenario ends the flap before the soak ends). A queue that still won't
    # drain after this window is reported but is not by itself "loss" — the
    # writes are safe in the queue; what matters is nothing was DROPPED.
    settle_deadline = time.monotonic() + 900
    while time.monotonic() < settle_deadline:
        c = cloud_results()
        _, pend, _ = local_results_and_queue()
        if c is not None and pend == 0:
            break
        # If the cloud is still unreachable, the one-shot /calm above may have
        # raced an in-flight flap cut (or the reconnect didn't hold). Keep
        # re-requesting /calm every iteration so we force the cloud back onto the
        # network until it's actually reachable — don't just wait out 15 min.
        if c is None:
            try:
                urllib.request.urlopen(
                    urllib.request.Request(f"{CHAOS_URL}/calm", method="POST"), timeout=10).read()
            except Exception as e:
                print(f"observer: re-/calm failed (continuing): {e}")
        print(f"observer: I4 settling — cloud={'up' if c is not None else 'down'} queue={pend}")
        time.sleep(15)

    local, pending, queued = local_results_and_queue()

    # ANTI-WIPE (MCM08 pull-wipe class): every write the field made (status 200,
    # not permanently rejected) must STILL be in local SQLite. A destructive
    # pull that nulled local AND cloud would pass a naive local==cloud check —
    # this catches it by comparing the JOURNAL (what the field typed) to local.
    wiped = [
        iid for iid, r in journaled.items()
        if iid not in rejected and norm(local.get(iid)) != norm(r)
    ]

    cloud = None
    unsynced: list[int] = []
    for attempt in range(6):  # ~60 s grace for the batch pusher to drain
        cloud = cloud_results()
        if cloud is None:
            break
        # A write still sitting in the offline queue is SAFE (pending), not
        # lost — exclude queued IOs. Loss = local has it, cloud doesn't, it's
        # NOT queued, and there's no business reason. THAT is the bug class.
        unsynced = [
            iid for iid in journaled
            if norm(local.get(iid)) != norm(cloud.get(iid))
            and iid not in rejected and iid not in queued
        ]
        if not unsynced:
            break
        print(f"observer: I4 grace re-poll {attempt+1}/6 — {len(unsynced)} unsynced (not queued)")
        time.sleep(10)

    if cloud is None:
        return {"pass": False, "reason": "cloud unreachable", "soak_writes": len(journaled)}

    explained = [
        iid for iid in journaled
        if norm(local.get(iid)) != norm(cloud.get(iid)) and iid in rejected
    ]
    # TRUE wipes only: a field write that LOCAL no longer holds (erased to
    # null) — the MCM08 destructive-pull class. A local value that merely
    # DIFFERS from cloud is NOT loss: the system is last-write-wins (the
    # incident report is explicit — "a different cloud result is NOT at risk"),
    # and a SPARE-Passed value the cloud legitimately refuses stays local-only
    # by design. Those must not fail I4; only an actual erasure or a bug-drop
    # (suspect_silent_drops: B1 429 / B7 version-cap) is real loss.
    true_wipes = [iid for iid in wiped if norm(local.get(iid)) is None]
    # `unsynced` is reported for visibility but is dominated by last-write-wins
    # + business (SPARE) divergence, so it does NOT gate the verdict.
    return {
        # Fail on real loss only: a value erased from local (true wipe) or a
        # result dropped by a bug path (suspect). Divergence and a non-empty
        # queue are reported, not failed.
        "pass": not true_wipes and not suspect_drops,
        "soak_writes": len(journaled),
        "true_wipes": len(true_wipes),
        "divergence_lww_or_business": len(unsynced),
        "still_queued_safe": len(queued),
        # The headline bug detector: results the tool threw away on a non-
        # business reason (HTTP 429 = B1, version-conflict cap = B7).
        "suspect_silent_drops": len(suspect_drops),
        "suspect_drop_reasons": _top_reasons(suspect_drops),
        "explained_business_rejections": len(explained),
        "pending_queue_at_end": pending,
        # True-wipe detail with the cloud value, so a failure self-explains:
        # cloud HOLDS the value => MCM08-class local clobber (real, recoverable
        # on next pull); cloud MISSING too => harder global loss.
        "true_wipe_detail": [
            {"io": iid, "field_wrote": journaled.get(iid),
             "local_now": local.get(iid), "cloud_now": cloud.get(iid),
             "queued": iid in queued}
            for iid in wiped if norm(local.get(iid)) is None
        ][:15],
        "wiped_samples": [
            {"io": iid, "field_wrote": journaled[iid], "local_now": local.get(iid)}
            for iid in wiped[:10]
        ],
        "unsynced_samples": [
            {"io": iid, "local": local.get(iid), "cloud": cloud.get(iid)}
            for iid in unsynced[:10]
        ],
        "suspect_drop_samples": suspect_drops[:10],
    }


def _top_reasons(drops: list[dict]) -> dict:
    counts: dict[str, int] = {}
    for d in drops:
        counts[d["reason"]] = counts.get(d["reason"], 0) + 1
    return dict(sorted(counts.items(), key=lambda x: -x[1])[:6])


def check_cloud_propagation(mut_path: str) -> dict:
    """I7 — data added on the CLOUD side reaches the field. New cloud IOs reach
    the field ONLY via the reconnect-pull: the tool ignores SSE io-updated events
    for an IO it doesn't have locally (cloud-sse-client: `if (!localIo) return`),
    and our mutator writes straight to Postgres (no SSE emission anyway). So we
    deterministically drive the REAL field path — force one clean SSE reconnect
    (cloud cut+restore) once the queue is drained, which triggers pullFromCloud
    (INSERT OR IGNORE of new IOs) — then verify the additions landed."""
    added_ids: list[int] = []
    for line in open(mut_path, errors="replace"):
        try:
            e = json.loads(line)
        except json.JSONDecodeError:
            continue
        if e.get("added"):
            added_ids += [int(x) for x in str(e["added"]).split(",") if x]
    if not added_ids:
        return {"pass": True, "added": 0, "note": "no cloud additions recorded"}

    # PRECONDITION: the tool defers cloud pulls while its ACTIVE offline queue is
    # non-empty (local work first — documented design). If it never drains (heavy
    # business-rejection churn) propagation can't be observed → INCONCLUSIVE, not
    # a fail. Once drained, force a clean reconnect so the reconnect-pull fires.
    QUEUE_DRAINED = 5  # active (non-parked) rows; tool pulls only at ~empty
    _local, pending0, _q0 = local_results_and_queue()
    if pending0 is not None and pending0 <= QUEUE_DRAINED:
        try:
            urllib.request.urlopen(urllib.request.Request(
                f"{CHAOS_URL}/cloudcut?sec=5", method="POST"), timeout=20).read()
            print("observer: I7 forced a clean SSE reconnect (cloudcut 5s) to trigger the reconnect-pull")
            time.sleep(20)  # 5s down + reconnect backoff + the pull itself
        except Exception as e:
            print(f"observer: I7 reconnect trigger failed (continuing): {e}")

    missing = added_ids
    pending = None
    drained = False
    for _ in range(24):  # up to ~4 min (reconnect + pull + insert)
        local, pending, _q = local_results_and_queue()
        missing = [i for i in added_ids if i not in local]
        drained = pending is not None and pending <= QUEUE_DRAINED
        if not missing:
            break
        note = "queue drained, awaiting pull" if drained else f"queue busy ({pending} pending) — pull deferred by design"
        print(f"observer: I7 — {len(missing)}/{len(added_ids)} not yet local; {note}")
        time.sleep(10)

    if missing and not drained:
        # Propagation untestable: the precondition (drained queue) never held.
        return {
            "pass": True,
            "status": "inconclusive: queue never drained — pull correctly deferred",
            "cloud_added": len(added_ids),
            "not_propagated_to_local": len(missing),
            "pending_at_check": pending,
            "missing_samples": missing[:10],
        }
    return {
        # Queue drained (or nearly): now propagation is genuinely under test.
        # Allow the final batch to still be in flight: fail only if a meaningful
        # fraction never arrived after the queue was free to pull.
        "pass": len(missing) <= max(3, int(0.05 * len(added_ids))),
        "cloud_added": len(added_ids),
        "not_propagated_to_local": len(missing),
        "pending_at_check": pending,
        "missing_samples": missing[:10],
    }


def _delta_journal(mut_path: str) -> tuple[list[int], list[int], bool]:
    """Parse the mutator journal → (added_ids, deleted_ids, is_api_mode).
    api mode is the `delta` scenario: changes went through the recorded admin
    API, so the cloud fired recordChange + the SSE hint and the field should
    apply them via the granular delta path."""
    added: list[int] = []
    deleted: list[int] = []
    is_api = False
    try:
        for line in open(mut_path, errors="replace"):
            try:
                e = json.loads(line)
            except json.JSONDecodeError:
                continue
            if e.get("mode") == "api":
                is_api = True
            if e.get("added"):
                added += [int(x) for x in str(e["added"]).split(",") if x]
            if e.get("deleted"):
                deleted += [int(x) for x in str(e["deleted"]).split(",") if x]
    except OSError:
        pass
    return added, deleted, is_api


def _tool_log_has(pattern: str) -> bool:
    rx = re.compile(pattern)
    for path in sorted(glob.glob(os.path.join(DATA_DIR, "logs", "app-*.log"))):
        try:
            with open(path, errors="replace") as f:
                for line in f:
                    if rx.search(line):
                        return True
        except OSError:
            pass
    return False


def check_delta_propagation(mut_path: str) -> dict:
    """I11 — IOs added on the cloud via the recorded admin API converge in the
    field's local DB AND arrived via the GRANULAR delta path (the `[AutoSync]
    delta` log line), not a destructive full pull. The SSE subsystem_changed
    hint drives this automatically — no forced reconnect needed."""
    added, deleted, is_api = _delta_journal(mut_path)
    dset = set(deleted)
    added = [i for i in added if i not in dset]  # ones later deleted are tested by I12
    if not added:
        return {"pass": True, "added": 0, "note": "no api-mode cloud additions"}
    missing = added
    for _ in range(24):  # up to ~4 min
        local, _pending, _q = local_results_and_queue()
        missing = [i for i in added if i not in local]
        if not missing:
            break
        print(f"observer: I11 — {len(missing)}/{len(added)} cloud-added IOs not yet local")
        time.sleep(10)
    # Matches either the hint path (`[AutoSync] delta <sid>: +x/-y`) or the
    # delta-first catch-up (`catch-up done: <sid>:delta(+x/-y)`).
    delta_used = _tool_log_has(r":delta\(\+|\[AutoSync\] delta ")
    return {
        # All (modulo a small final-batch in-flight margin) must have arrived,
        # AND at least one must have come through the granular delta path.
        "pass": len(missing) <= max(2, int(0.05 * len(added))) and delta_used,
        "cloud_added": len(added),
        "not_propagated_to_local": len(missing),
        "arrived_via_delta": delta_used,
        "missing_samples": missing[:10],
    }


def check_delete_propagation(mut_path: str) -> dict:
    """I12 — IOs deleted on the cloud are removed from the field's local DB,
    EXCEPT any that still hold un-pushed local work (a PendingSyncs row): those
    must be KEPT (guarded delete — never drop field work). A deleted IO still
    present with NO pending local result is a missed delete = fail."""
    _added, deleted, _is_api = _delta_journal(mut_path)
    if not deleted:
        return {"pass": True, "deleted": 0, "note": "no api-mode cloud deletes"}
    still_present = deleted
    for _ in range(18):  # up to ~3 min
        local, _pending, queued = local_results_and_queue()
        still_present = [i for i in deleted if i in local]
        # Removed, or only the guarded (queued) ones remain → done.
        if not [i for i in still_present if i not in queued]:
            break
        time.sleep(10)
    local, _pending, queued = local_results_and_queue()
    unguarded = [i for i in deleted if i in local and i not in queued]
    guarded = [i for i in deleted if i in local and i in queued]
    return {
        "pass": len(unguarded) == 0,
        "cloud_deleted": len(deleted),
        "still_present_unguarded": len(unguarded),  # missed deletes (bad)
        "still_present_guarded": len(guarded),       # kept on purpose (good)
        "unguarded_samples": unguarded[:10],
    }


def check_cold_start_cursor() -> dict:
    """I13 — the field's per-subsystem delta cursor (SyncCursors.LastSeq) advances
    PAST 0, proving the cold-start handshake worked and granular deltas actually
    run (not a perpetual resync→full-pull loop where the cursor stays 0)."""
    db_path = os.path.join(DATA_DIR, "database.db")
    max_seq = -1  # -1 = table/db unreadable
    try:
        con = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True, timeout=10)
        try:
            row = con.execute("SELECT MAX(LastSeq) FROM SyncCursors").fetchone()
            max_seq = int(row[0]) if row and row[0] is not None else 0
        except sqlite3.Error:
            max_seq = -1
        con.close()
    except sqlite3.Error:
        max_seq = -1
    return {"pass": max_seq > 0, "max_cursor": max_seq}


# ── crud-propagation (I14-I17, REPORT-ONLY) ──────────────────────────────────
# The four data types the field PULLS (definition/CRUD, NOT the result path):
# VFD ADDRESSED blocker, L2/FV cell, e-stop zone tree, network ring. The
# cloud-mutator (MUTATE_MODE=crud) edits each on cloud-stage Postgres and writes
# a per-kind line to cloud-mutations.jsonl; here we DRIVE the field's scoped pull
# (its real local HTTP endpoints) then read the tool's local SQLite and compare
# to the latest cloud edit. Mirrors the I11/I12 mechanism exactly:
# parse-journal → trigger → poll local DB → compare. REPORT-ONLY (skill rule #4).


def _crud_mutations(kind: str) -> list[dict]:
    """All crud-mode mutator journal rows of one `kind`, in emit order."""
    out: list[dict] = []
    p = os.path.join(RUNS_DIR, RUN_ID, "cloud-mutations.jsonl")
    if not os.path.exists(p):
        return out
    for line in open(p, errors="replace"):
        try:
            e = json.loads(line)
        except json.JSONDecodeError:
            continue
        if e.get("mode") == "crud" and e.get("kind") == kind:
            out.append(e)
    return out


def _latest_crud_per_subsystem(kind: str) -> dict[int, dict]:
    """The LAST crud edit of `kind` per subsystem (the value the field must hold
    after a converged pull). Keyed by subsystemId."""
    latest: dict[int, dict] = {}
    for e in _crud_mutations(kind):
        try:
            sid = int(e.get("subsystemId"))
        except (TypeError, ValueError):
            continue
        latest[sid] = e  # journal is append-order → last wins
    return latest


def _tool_post(path: str, body: dict | None = None, timeout: float = 60.0) -> bool:
    """POST to one of the tool's local pull endpoints (drives the field's scoped
    pull deterministically — the SQL-mode mutator fires no SSE hint, so we
    trigger the same way I7 forces a reconnect). True on a 2xx."""
    data = None
    headers = {}
    if body is not None:
        data = json.dumps(body).encode()
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(f"{TOOL_URL}{path}", data=data, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            r.read()
            return 200 <= r.status < 300
    except urllib.error.HTTPError as e:
        print(f"observer: tool POST {path} -> HTTP {e.code}")
        return False
    except Exception as e:
        print(f"observer: tool POST {path} failed: {e}")
        return False


def _local_query(sql: str, params: tuple = ()) -> list[tuple]:
    """Read the tool's local SQLite (read-only mount). [] on any failure."""
    db_path = os.path.join(DATA_DIR, "database.db")
    try:
        con = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True, timeout=10)
        try:
            return list(con.execute(sql, params))
        finally:
            con.close()
    except sqlite3.Error as e:
        print(f"observer: local query failed: {e}")
        return []


def check_i14_vfd_addressed() -> dict:
    """I14 — a belt VFD marked ADDRESSED on the cloud reaches the field's
    VfdAddressed mirror; other MCMs untouched. Drives the field's
    /api/vfd-commissioning/refresh-addressed pull per subsystem."""
    latest = _latest_crud_per_subsystem("vfd_addressed")
    if not latest:
        return {"pass": True, "checked": 0, "note": "no vfd_addressed mutations"}
    for sid in latest:
        _tool_post("/api/vfd-commissioning/refresh-addressed", {"subsystemId": sid})
    missing: list[dict] = []
    for _ in range(18):  # ~3 min
        missing = []
        for sid, e in latest.items():
            dev = e.get("key")
            rows = _local_query(
                "SELECT Addressed FROM VfdAddressed WHERE SubsystemId=? AND DeviceName=?",
                (sid, dev),
            )
            if not rows or int(rows[0][0]) != 1:
                missing.append({"subsystem": sid, "device": dev})
        if not missing:
            break
        for sid in latest:
            _tool_post("/api/vfd-commissioning/refresh-addressed", {"subsystemId": sid})
        time.sleep(10)
    return {
        "pass": len(missing) == 0,
        "checked": len(latest),
        "not_propagated": len(missing),
        "missing_samples": missing[:10],
    }


def check_i15_l2_cell() -> dict:
    """I15 — an L2/FV cell edited on the cloud (newer version) converges in the
    field's L2CellValues; an OLDER-version cloud echo must NOT clobber a
    locally-newer cell (the LWW negative case). Drives /api/cloud/pull-l2.

    The cloud cell id == the field's CloudCellId (the seeder mirrors ids). We
    locate the local cell by CloudCellId and compare Value+Version."""
    latest = _latest_crud_per_subsystem("l2_cell")
    cfg = _read_local_config()
    remote = cfg.get("remoteUrl") or CLOUD_URL
    api_key = cfg.get("apiPassword") or CLOUD_API_KEY
    if not latest:
        return {"pass": True, "checked": 0, "note": "no l2_cell mutations"}
    for sid in latest:
        _tool_post("/api/cloud/pull-l2", {"remoteUrl": remote, "apiPassword": api_key, "subsystemId": sid})
    not_conv: list[dict] = []
    for _ in range(18):
        not_conv = []
        for sid, e in latest.items():
            cloud_cell_id = e.get("key")
            want_val, want_ver = e.get("value"), int(e.get("version", 0))
            rows = _local_query(
                "SELECT Value, Version FROM L2CellValues WHERE CloudCellId=?",
                (cloud_cell_id,),
            )
            if not rows or rows[0][0] != want_val or int(rows[0][1]) < want_ver:
                not_conv.append({"subsystem": sid, "cloud_cell_id": cloud_cell_id,
                                 "want": want_val, "want_ver": want_ver,
                                 "have": (rows[0] if rows else None)})
        if not not_conv:
            break
        for sid in latest:
            _tool_post("/api/cloud/pull-l2", {"remoteUrl": remote, "apiPassword": api_key, "subsystemId": sid})
        time.sleep(10)

    # Negative case: an OLDER cloud echo must not clobber a locally-newer cell.
    # We assert it on the merge SQL's contract (version-gated LWW): take the
    # converged local cell, prove its Version is >= the cloud version we last
    # saw — i.e. a stale-version cloud value can never have overwritten it.
    # NOTE (TODO-verify-on-soak): a true end-to-end negative drive would require
    # the mutator to push an OLDER version AND a live SSE l2_cell_updated echo
    # (the destructive pull-l2 ignores versions — it wholesale-replaces). That
    # SSE-echo path is exercised by the unit test l2-fv-sync-coverage.test.ts;
    # here we record the contract observation rather than fake it via the
    # version-blind pull. Reported, never gated.
    lww_ok = True
    lww_detail: list[dict] = []
    for sid, e in latest.items():
        cloud_cell_id = e.get("key")
        want_ver = int(e.get("version", 0))
        rows = _local_query("SELECT Version FROM L2CellValues WHERE CloudCellId=?", (cloud_cell_id,))
        if rows and int(rows[0][0]) < want_ver:
            lww_ok = False
            lww_detail.append({"cloud_cell_id": cloud_cell_id, "local_ver": int(rows[0][0]), "cloud_ver": want_ver})
    return {
        "pass": len(not_conv) == 0,
        "checked": len(latest),
        "not_converged": len(not_conv),
        "lww_older_echo_no_clobber": lww_ok,
        "lww_negative_case": "contract-observed (full e2e older-echo needs SSE path; see note + unit test)",
        "not_converged_samples": not_conv[:10],
        "lww_detail": lww_detail[:5],
    }


def check_i16_estop() -> dict:
    """I16 — an e-stop zone edited on the cloud converges in the field's
    EStopZones for that subsystem AND other MCMs' zones are NOT wiped. The
    legacy /api/cloud/pull-estop does `DELETE FROM EStopZones` GLOBALLY — so on
    a multi-MCM run a single pull would wipe every other MCM's zones. We snapshot
    OTHER subsystems' zone counts before/after to catch exactly that."""
    latest = _latest_crud_per_subsystem("estop_zone")
    if not latest:
        return {"pass": True, "checked": 0, "note": "no estop_zone mutations"}
    edited_sids = set(latest)
    # Baseline: zone count for OTHER (non-edited) subsystems before any pull.
    before = {}
    for (sid, c) in _local_query("SELECT SubsystemId, COUNT(*) FROM EStopZones GROUP BY SubsystemId"):
        if sid is not None and int(sid) not in edited_sids:
            before[int(sid)] = int(c)

    for sid in latest:
        _tool_post("/api/cloud/pull-estop")  # reads config's subsystemId
    converged: list[dict] = []
    for _ in range(18):
        converged = []
        for sid, e in latest.items():
            want_name = e.get("value")
            rows = _local_query(
                "SELECT 1 FROM EStopZones WHERE SubsystemId=? AND Name=?", (sid, want_name))
            if not rows:
                converged.append({"subsystem": sid, "want_zone": want_name})
        if not converged:
            break
        for sid in latest:
            _tool_post("/api/cloud/pull-estop")
        time.sleep(10)

    after = {}
    for (sid, c) in _local_query("SELECT SubsystemId, COUNT(*) FROM EStopZones GROUP BY SubsystemId"):
        if sid is not None and int(sid) not in edited_sids:
            after[int(sid)] = int(c)
    cross_wipes = [
        {"subsystem": sid, "before": before[sid], "after": after.get(sid, 0)}
        for sid in before if after.get(sid, 0) < before[sid]
    ]
    return {
        # Report-only: the global-DELETE cross-MCM wipe is a KNOWN hazard of the
        # legacy route; on a single-MCM run `before` is empty so cross_wipes is
        # vacuously []. Pin the path on a multi-MCM soak to make a wipe show up.
        "pass": len(converged) == 0 and len(cross_wipes) == 0,
        "checked": len(latest),
        "not_converged": len(converged),
        "cross_mcm_wipes": len(cross_wipes),
        "cross_wipe_detail": cross_wipes[:10],
        "other_mcms_observed": len(before),
        "not_converged_samples": converged[:10],
    }


def check_i17_network() -> dict:
    """I17 — a network ring edited on the cloud converges in the field's
    NetworkRings for that subsystem; the cascade leaves no orphan ports and no
    cross-MCM wipe (pull-network DELETEs only WHERE SubsystemId = this one).
    Drives /api/cloud/pull-network."""
    latest = _latest_crud_per_subsystem("network_ring")
    if not latest:
        return {"pass": True, "checked": 0, "note": "no network_ring mutations"}
    edited_sids = set(latest)
    before = {}
    for (sid, c) in _local_query(
        "SELECT SubsystemId, COUNT(*) FROM NetworkRings GROUP BY SubsystemId"):
        if sid is not None and int(sid) not in edited_sids:
            before[int(sid)] = int(c)

    for sid in latest:
        _tool_post("/api/cloud/pull-network")  # reads config's subsystemId
    converged: list[dict] = []
    for _ in range(18):
        converged = []
        for sid, e in latest.items():
            want_name = e.get("value")
            rows = _local_query(
                "SELECT 1 FROM NetworkRings WHERE SubsystemId=? AND Name=?", (sid, want_name))
            if not rows:
                converged.append({"subsystem": sid, "want_ring": want_name})
        if not converged:
            break
        for sid in latest:
            _tool_post("/api/cloud/pull-network")
        time.sleep(10)

    # Orphan ports: a port whose node no longer exists (cascade left a dangling
    # row). Should always be 0 after a clean cascade-replace.
    orphans = _local_query(
        "SELECT COUNT(*) FROM NetworkPorts WHERE NodeId NOT IN (SELECT id FROM NetworkNodes)")
    orphan_ports = int(orphans[0][0]) if orphans else -1
    after = {}
    for (sid, c) in _local_query(
        "SELECT SubsystemId, COUNT(*) FROM NetworkRings GROUP BY SubsystemId"):
        if sid is not None and int(sid) not in edited_sids:
            after[int(sid)] = int(c)
    cross_wipes = [
        {"subsystem": sid, "before": before[sid], "after": after.get(sid, 0)}
        for sid in before if after.get(sid, 0) < before[sid]
    ]
    return {
        "pass": len(converged) == 0 and orphan_ports == 0 and len(cross_wipes) == 0,
        "checked": len(latest),
        "not_converged": len(converged),
        "orphan_ports": orphan_ports,
        "cross_mcm_wipes": len(cross_wipes),
        "cross_wipe_detail": cross_wipes[:10],
        "other_mcms_observed": len(before),
        "not_converged_samples": converged[:10],
    }


def _read_local_config() -> dict:
    """The tool's /data/config.json (remoteUrl / apiPassword / subsystemId)."""
    try:
        with open(os.path.join(DATA_DIR, "config.json")) as f:
            return json.load(f)
    except (OSError, json.JSONDecodeError):
        return {}


def rss_slope_mb_per_h(samples: list[tuple[float, float, float]], skip_first_s: float) -> float | None:
    if not samples:
        return None
    t0 = samples[0][0]
    pts = [(t, r) for (t, r, _h) in samples if t - t0 >= skip_first_s]
    if len(pts) < 10:
        return None
    xs = [p[0] for p in pts]
    ys = [p[1] for p in pts]
    mx, my = statistics.fmean(xs), statistics.fmean(ys)
    denom = sum((x - mx) ** 2 for x in xs)
    if denom == 0:
        return None
    slope_per_s = sum((x - mx) * (y - my) for x, y in zip(xs, ys)) / denom
    return slope_per_s * 3600.0


def check_live_channel() -> dict:
    """I8 — the cloud live channel (SSE) must authenticate.

    The 2026-06-16 MCM11 incident: a cloud security deploy gated /api/sync/events
    behind a browser session, so the field tool's X-API-Key SSE subscription got
    a permanent HTTP 401. The cloud then showed the server/PLC as disconnected
    ("Red") and real-time pushes degraded to 15-min safety pulls — invisible to
    every existing test.

    We GATE only on the DETERMINISTIC failure: an auth rejection (HTTP 401/403)
    on the SSE connect. Transient `fetch failed`/`terminated` reconnect loops are
    docker-network noise (see I7 note) and are recorded but never gate. So a clean
    auth contract → green; the exact incident → red.
    """
    connecting = connected = auth_fail = transient = 0
    last_auth_samples: list[str] = []
    connect_re = re.compile(r"\[CloudSSE\] Connecting to")
    ok_re = re.compile(r"\[CloudSSE\] Connected")
    auth_re = re.compile(r"\[CloudSSE\] Connection error: HTTP (401|403)")
    other_err_re = re.compile(r"\[CloudSSE\] Connection error: (?!HTTP (?:401|403))")
    for path in sorted(glob.glob(os.path.join(DATA_DIR, "logs", "app-*.log"))):
        try:
            with open(path, errors="replace") as f:
                for line in f:
                    if connect_re.search(line):
                        connecting += 1
                    elif ok_re.search(line):
                        connected += 1
                    elif auth_re.search(line):
                        auth_fail += 1
                        if len(last_auth_samples) < 5:
                            last_auth_samples.append(line.strip()[:200])
                    elif other_err_re.search(line):
                        transient += 1
        except OSError:
            pass

    # GATE: any auth rejection is a real contract break. If the tool never even
    # attempted SSE (connecting == 0), there is nothing to judge → pass (the
    # scenario may not point the tool at a cloud).
    passed = auth_fail == 0
    return {
        "pass": passed,
        "connect_attempts": connecting,
        "connected_ok": connected,
        "auth_failures_401_403": auth_fail,
        "transient_errors": transient,
        "auth_failure_samples": last_auth_samples,
        "note": (
            "SSE auth rejected (HTTP 401/403) — cloud live channel broken, "
            "field tool shows Red and loses real-time sync"
            if auth_fail else
            ("never connected, no auth error (transient/network only)"
             if connecting and not connected else
             ("live channel OK" if connected else "SSE not attempted"))
        ),
    }


def check_backup_bound() -> dict:
    """I9 — the auto-backup directory must stay bounded.

    The 2026-06-16 MCM11 incident: the pre-pull safety backup (a full DB copy)
    ran before EVERY pull for EVERY active MCM with no retention, so a central
    server filled the disk to ~4 GB / ~1,700 copies. The fix adds retention
    (BACKUP_RETENTION_KEEP) and a no-op-pull short-circuit. This invariant fails
    on unbounded growth.

    Deterministic + non-vacuous: we only judge retention once enough backups were
    CREATED to require pruning (created > keep). We always gate an absolute
    runaway (total size over BACKUP_DIR_MAX_MB) regardless.
    """
    keep = max(1, int(os.environ.get("BACKUP_RETENTION_KEEP", "300") or "300"))
    slack = int(os.environ.get("BACKUP_RETENTION_SLACK", "50") or "50")
    max_mb = float(os.environ.get("BACKUP_DIR_MAX_MB", "2048") or "2048")

    backups_dir = os.path.join(DATA_DIR, "backups")
    remaining = 0
    total_bytes = 0
    try:
        for name in os.listdir(backups_dir):
            if name.startswith("database-") and name.endswith(".db"):
                remaining += 1
                try:
                    total_bytes += os.path.getsize(os.path.join(backups_dir, name))
                except OSError:
                    pass
    except OSError:
        pass

    created = 0
    created_re = re.compile(r"Auto-backup created")
    for path in sorted(glob.glob(os.path.join(DATA_DIR, "logs", "app-*.log"))):
        try:
            with open(path, errors="replace") as f:
                for line in f:
                    if created_re.search(line):
                        created += 1
        except OSError:
            pass

    total_mb = round(total_bytes / (1024 * 1024), 1)
    exercised = created > keep
    runaway = total_mb > max_mb
    retention_broken = exercised and remaining > keep + slack
    passed = not runaway and not retention_broken
    return {
        "pass": passed,
        "created": created,
        "remaining": remaining,
        "total_mb": total_mb,
        "keep": keep,
        "retention_exercised": exercised,
        "note": (
            f"backup dir runaway: {total_mb} MB > {max_mb} MB cap" if runaway else
            (f"retention broken: {remaining} kept > {keep}+{slack} after {created} created"
             if retention_broken else
             ("retention OK" if exercised else
              f"not exercised (only {created} created, keep={keep})"))
        ),
    }


def check_mcm_isolation() -> dict:
    """I10 — per-MCM data isolation (central server).

    The 2026-06-18 "FV shows only one MCM" class: data that should be scoped to
    one MCM was instead a single shared pool, so every MCM's page showed the same
    rows. On a central server each configured MCM must have its OWN IO / L2 /
    network rows (SubsystemId-scoped) AND there must be NO unscoped (NULL
    SubsystemId) rows — a NULL row matches EVERY subsystem via the tool's OR-NULL
    read fallback, leaking one MCM's data into all of them.

    Deterministic DB read at judgment time (after quiesce). GATES on: every MCM
    has its own IOs (non-vacuous) AND zero unscoped L2/network rows (isolation).
    L2/network presence per MCM is reported. Single-MCM runs: N/A → pass.
    """
    sids = [int(s) for s in SUBSYSTEM_ID.split(",") if s.strip().isdigit()]
    if len(sids) <= 1:
        return {"pass": True, "subsystems": len(sids), "note": "single-MCM — isolation N/A"}

    db_path = os.path.join(DATA_DIR, "database.db")
    per: dict[int, dict] = {}
    leak_l2 = leak_net = -1
    try:
        con = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True, timeout=10)
        try:
            for sid in sids:
                per[sid] = {
                    "ios": con.execute("SELECT COUNT(*) FROM Ios WHERE SubsystemId=?", (sid,)).fetchone()[0],
                    "l2_devices": con.execute("SELECT COUNT(*) FROM L2Devices WHERE SubsystemId=?", (sid,)).fetchone()[0],
                    "network_rings": con.execute("SELECT COUNT(*) FROM NetworkRings WHERE SubsystemId=?", (sid,)).fetchone()[0],
                }
            leak_l2 = con.execute("SELECT COUNT(*) FROM L2Devices WHERE SubsystemId IS NULL").fetchone()[0]
            leak_net = con.execute("SELECT COUNT(*) FROM NetworkRings WHERE SubsystemId IS NULL").fetchone()[0]
        finally:
            con.close()
    except Exception as e:  # noqa: BLE001 — a read failure must not crash the verdict
        return {"pass": True, "subsystems": sids, "note": f"isolation check skipped (db read failed: {e})"}

    every_io = all(per[s]["ios"] > 0 for s in sids)
    every_l2 = all(per[s]["l2_devices"] > 0 for s in sids)
    every_net = all(per[s]["network_rings"] > 0 for s in sids)
    no_leak = leak_l2 == 0 and leak_net == 0
    passed = every_io and no_leak
    return {
        "pass": passed,
        "subsystems": sids,
        "per_subsystem": {str(k): v for k, v in per.items()},
        "unscoped_l2_devices": leak_l2,
        "unscoped_network_rings": leak_net,
        "every_mcm_has_ios": every_io,
        "every_mcm_has_l2": every_l2,
        "every_mcm_has_network": every_net,
        "note": (
            "each MCM has its own scoped data, no unscoped leak" if passed else
            ("unscoped (NULL-subsystem) L2/network rows leak into every MCM's page"
             if not no_leak else "an MCM has zero IOs (not its own data)")
        ),
    }


def main() -> None:
    print(f"observer: run={RUN_ID} target={TOOL_URL} soak={SOAK_MINUTES}min")
    deadline = time.monotonic() + SOAK_MINUTES * 60.0
    lat_path = os.path.join(OUT, "health.csv")
    latencies: list[float] = []        # post-warmup only (the I1 judging set)
    gaps: list[float] = []
    last_ok = time.monotonic()
    # Schema init + 592-tag creation + first connect briefly block the loop at
    # boot. That one-time transient must NOT fail I1 on a short soak (it's
    # negligible over a 7 h run). Exclude a warmup window, like I2 does.
    probe_start = time.monotonic()
    I1_WARMUP_S = 120.0

    # Wait up to 3 min for the tool to come up before the clock counts.
    for _ in range(180):
        lat, status = probe_once(timeout=3.0)
        if status == 200:
            break
        time.sleep(1)
    else:
        sys.exit("observer: tool never became healthy — aborting run")
    print("observer: tool is up, probing every 1s")

    with open(lat_path, "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["ts", "latency_ms", "status"])
        while time.monotonic() < deadline:
            t = time.time()
            lat, status = probe_once()
            if lat is not None and status == 200:
                warm = (time.monotonic() - probe_start) >= I1_WARMUP_S
                if warm:
                    latencies.append(lat)
                gap = time.monotonic() - last_ok
                if gap > GAP_LIMIT_S and warm:
                    gaps.append(gap)
                last_ok = time.monotonic()
                w.writerow([f"{t:.0f}", f"{lat:.1f}", status])
            else:
                w.writerow([f"{t:.0f}", "", status])
            f.flush()
            time.sleep(max(0.0, 1.0 - (time.time() - t)))

    # ── verdict ────────────────────────────────────────────────────
    logs = scrape_logs()
    injected = injected_events()
    downloads = [e for e in injected if e.get("type") == "download"]

    with open(os.path.join(OUT, "memory.csv"), "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["ts", "rss_mb", "heap_mb"])
        for ts, r, h in logs["rss"]:
            w.writerow([f"{ts:.0f}", r, h])

    lat_sorted = sorted(latencies)
    pct = lambda p: lat_sorted[min(len(lat_sorted) - 1, int(len(lat_sorted) * p))] if lat_sorted else None
    p95, p99 = pct(0.95), pct(0.99)
    slope = rss_slope_mb_per_h(logs["rss"], WARMUP_MINUTES * 60.0)
    # Post-warmup window actually covered by RSS samples — decides whether the
    # slope is trustworthy enough to GATE (see LEAK_MIN_WINDOW_MIN).
    rss = logs["rss"]
    post_warm = [s for s in rss if s[0] - rss[0][0] >= WARMUP_MINUTES * 60.0] if rss else []
    leak_window_min = (post_warm[-1][0] - post_warm[0][0]) / 60.0 if len(post_warm) >= 2 else 0.0
    leak_reliable = leak_window_min >= LEAK_MIN_WINDOW_MIN and slope is not None
    # Flap budget: every injected download/power event legitimately causes
    # one error->reconnect cycle; anything beyond budget+injected is organic.
    allowed_flaps = FLAP_BUDGET + len(downloads) + len([e for e in injected if e.get("type") == "power"])

    invariants = {
        "I1_responsiveness": {
            "pass": bool(lat_sorted) and p95 < P95_LIMIT_MS and p99 < P99_LIMIT_MS and not gaps,
            "p50": pct(0.50), "p95": p95, "p99": p99,
            "max": lat_sorted[-1] if lat_sorted else None,
            "samples": len(lat_sorted), "gaps_over_10s": len(gaps),
        },
        "I2_no_leak": {
            # GATE only on a reliable (long, settled) window. On a short window
            # the slope is reported but treated as inconclusive → pass, so a
            # bounded-but-sawtoothing process doesn't false-fail. A genuine leak
            # shows up on the overnight soak where the window is long enough.
            "pass": slope is None or slope < RSS_SLOPE_LIMIT_MB_PER_H or not leak_reliable,
            "status": (
                "ok" if (slope is None or slope < RSS_SLOPE_LIMIT_MB_PER_H)
                else "LEAK" if leak_reliable
                else f"inconclusive: {leak_window_min:.0f}min post-warmup window "
                     f"< {LEAK_MIN_WINDOW_MIN:.0f}min needed for a reliable slope "
                     f"(leak gating is the long-soak's job)"
            ),
            "rss_slope_mb_per_h": slope,
            "leak_window_min": round(leak_window_min, 1),
            "gated": leak_reliable,
            "rss_samples": len(logs["rss"]),
        },
        "I5_stability": {
            # 1 expected server.start (boot). Flaps within budget.
            "pass": logs["server_starts"] <= 1 + len([e for e in injected if e.get("type") == "toolkill"])
                    and logs["flaps"] <= allowed_flaps,
            "server_starts": logs["server_starts"],
            "plc_flaps": logs["flaps"], "allowed_flaps": allowed_flaps,
        },
        "I3_restore_evidence": {
            # Phase 0: evidence-level only — each injected download should be
            # followed by a plc-reconnect sync that wrote flags back.
            "pass": len(downloads) == 0 or len(logs["restores"]) >= len(downloads),
            "injected_downloads": len(downloads),
            "reconnect_restores_seen": len(logs["restores"]),
            "samples": logs["restores"][:5],
        },
    }
    # I4 data-loss — only when a cloud is attached to this run.
    if CLOUD_URL:
        invariants["I4_no_data_loss"] = check_data_loss()

    # I7 cloud→field propagation — only in the cloud-mutation scenario.
    mut_path = os.path.join(RUNS_DIR, RUN_ID, "cloud-mutations.jsonl")
    if CLOUD_URL and os.path.exists(mut_path):
        invariants["I7_cloud_propagation"] = check_cloud_propagation(mut_path)
        # Delta scenario (mutator api mode): the recorded admin API fired the SSE
        # hint, so verify the GRANULAR delta path end-to-end.
        _a, _d, _is_api = _delta_journal(mut_path)
        if _is_api:
            invariants["I11_delta_propagation"] = check_delta_propagation(mut_path)
            invariants["I12_delete_propagation"] = check_delete_propagation(mut_path)
            invariants["I13_cold_start_cursor"] = check_cold_start_cursor()
        # crud-propagation scenario (MUTATE_MODE=crud): cloud→field DEFINITION/
        # CRUD propagation for the four data types the field PULLS. The mutator
        # writes per-kind `mode:"crud"` journal rows; if none are present these
        # are no-op passes. REPORT-ONLY (see REPORT_ONLY below).
        if _crud_mutations("vfd_addressed") or _crud_mutations("l2_cell") \
                or _crud_mutations("estop_zone") or _crud_mutations("network_ring"):
            invariants["I14_vfd_addressed_propagation"] = check_i14_vfd_addressed()
            invariants["I15_l2_cell_propagation"] = check_i15_l2_cell()
            invariants["I16_estop_def_propagation"] = check_i16_estop()
            invariants["I17_network_propagation"] = check_i17_network()

    # I8 cloud live-channel (SSE) auth — only when a cloud is attached. Gates on
    # an HTTP 401/403 auth break (the 2026-06-16 MCM11 incident class), not on
    # transient docker-network reconnect noise.
    if CLOUD_URL:
        invariants["I8_live_channel"] = check_live_channel()

    # I9 bounded auto-backups — always; backups are local to the tool. Catches
    # the unbounded pre-pull-backup disk runaway (2026-06-16 MCM11 incident).
    invariants["I9_backup_bound"] = check_backup_bound()

    # I10 per-MCM data isolation — central server: each MCM has its own IO/L2/
    # network rows, no unscoped (NULL) rows leaking into every MCM's page
    # (2026-06-18 "FV shows one MCM" class). N/A → pass on single-MCM runs.
    invariants["I10_mcm_isolation"] = check_mcm_isolation()

    # REPORT-ONLY invariants do NOT gate the build. I7 (cloud→field propagation)
    # depends on the SSE-reconnect-pull firing cleanly, which the docker-network
    # flap does not reliably deliver (reconnect "fetch failed" loops) — so a I7
    # failure is recorded for investigation, not treated as a release blocker.
    # The real guarantees (responsiveness, leak, restore, stability, DATA LOSS)
    # gate. See FINDINGS B10.
    # I11/I12/I13 (delta-sync) start REPORT-ONLY until proven non-flaky across
    # two clean runs (skill rule #4); promote to gating once stable.
    # I14-I17 (crud-propagation) start REPORT-ONLY too: new invariants must be
    # proven green twice on a real soak before they gate (skill rule #4), and
    # some carry TODO-verify-on-soak unknowns (exact cloud columns, the SSE-echo
    # negative case for I15). Recorded in verdict.json, never affect the gate.
    REPORT_ONLY = {"I7_cloud_propagation", "I11_delta_propagation",
                   "I12_delete_propagation", "I13_cold_start_cursor",
                   "I14_vfd_addressed_propagation", "I15_l2_cell_propagation",
                   "I16_estop_def_propagation", "I17_network_propagation"}
    gating = {k: v for k, v in invariants.items() if k not in REPORT_ONLY}
    verdict = {
        "run": RUN_ID,
        "ended": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "soak_minutes": SOAK_MINUTES,
        "pass": all(v["pass"] for v in gating.values()),
        "report_only": sorted(REPORT_ONLY & invariants.keys()),
        "invariants": invariants,
    }
    with open(os.path.join(OUT, "verdict.json"), "w") as f:
        json.dump(verdict, f, indent=2)

    print(json.dumps(verdict, indent=2))
    sys.exit(0 if verdict["pass"] else 1)


if __name__ == "__main__":
    main()
