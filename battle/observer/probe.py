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
CLOUD_API_KEY = os.environ.get("CLOUD_API_KEY", "battle-key-mcm02")
SUBSYSTEM_ID = os.environ.get("SUBSYSTEM_ID", "38")

OUT = os.path.join(RUNS_DIR, RUN_ID)
os.makedirs(OUT, exist_ok=True)

P95_LIMIT_MS = 500.0
P99_LIMIT_MS = 2000.0
GAP_LIMIT_S = 10.0
RSS_SLOPE_LIMIT_MB_PER_H = 5.0
WARMUP_MINUTES = 60.0


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
    restore_re = re.compile(r"Sync done \(plc-reconnect\).*?(\d+) written")

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
    EXCLUDING hot-set writes (concurrent races on shared rows have ambiguous
    last-write ordering — B7 is detected from logs instead). Last-write-wins,
    mirroring the tool's UI. These are writes that must reach local AND cloud."""
    latest: dict[int, tuple[str, str]] = {}  # ioId -> (ts, result)
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
                ts = e.get("ts", "")
                if iid not in latest or ts > latest[iid][0]:
                    latest[iid] = (ts, e.get("result"))
    # A row that was ever a hot target is excluded entirely (a bot may hit it
    # both ways across the soak).
    return {iid: r for iid, (ts, r) in latest.items() if iid not in hot}


def cloud_results() -> dict[int, str | None] | None:
    """Pull every IO's result from cloud-stage via the REAL pull endpoint the
    field tool uses. None => cloud unreachable."""
    url = f"{CLOUD_URL}/api/sync/subsystem/{SUBSYSTEM_ID}"
    req = urllib.request.Request(url, headers={"X-API-Key": CLOUD_API_KEY})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            data = json.loads(r.read())
    except Exception as e:
        print(f"observer: cloud read failed: {e}")
        return None
    out: dict[int, str | None] = {}
    for io in data.get("ios", []):
        out[int(io["id"])] = io.get("result")
    return out


def local_results_and_queue() -> tuple[dict[int, str | None], int]:
    """Tool's local SQLite: authoritative results + pending-sync queue depth."""
    db_path = os.path.join(DATA_DIR, "database.db")
    res: dict[int, str | None] = {}
    pending = -1
    try:
        con = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True, timeout=10)
        for iid, r in con.execute("SELECT id, Result FROM Ios"):
            res[int(iid)] = r
        # Sum all three offline queues — IO results, L2 cell writes, and
        # device-blocker edits. ALL must drain; a stuck L2 queue is the same
        # class of lost field work as a stuck result.
        pending = 0
        for tbl in ("PendingSyncs", "L2PendingSyncs", "DeviceBlockerPendingSyncs"):
            try:
                pending += con.execute(f"SELECT COUNT(*) FROM {tbl}").fetchone()[0]
            except sqlite3.Error:
                pass
        con.close()
    except sqlite3.Error as e:
        print(f"observer: local DB read failed: {e}")
    return res, pending


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
    rx = re.compile(r"DROPPED-PERMANENT.*?ioId=(\d+).*?reason=\"([^\"]*)\"")
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


def check_data_loss() -> dict:
    """I4 — no silent data loss. Local SQLite is the authority. For every IO
    written DURING this soak (bot journals), cloud must mirror local. The only
    allowed divergence is an IO the tool logged as a PERMANENT rejection
    (cloud business rule). Anything else = a sync bug losing field work — the
    MCM08/MCM11 class. Re-polls cloud to absorb in-flight batch syncs."""
    journaled = journaled_results()  # {ioId: latest result the field wrote}
    rejected, suspect_drops = scrape_permanent_drops()

    # Settle: if the soak ended mid-flap (cloud cut) the queue can't have
    # drained yet. Wait up to 15 min for cloud reachable AND queue at 0 so we
    # judge a converged system, not a transient mid-outage state.
    settle_deadline = time.monotonic() + 900
    while time.monotonic() < settle_deadline:
        c = cloud_results()
        _, pend = local_results_and_queue()
        if c is not None and pend == 0:
            break
        print(f"observer: I4 settling — cloud={'up' if c is not None else 'down'} queue={pend}")
        time.sleep(15)

    local, pending = local_results_and_queue()

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
        unsynced = [
            iid for iid in journaled
            if norm(local.get(iid)) != norm(cloud.get(iid)) and iid not in rejected
        ]
        if not unsynced:
            break
        print(f"observer: I4 grace re-poll {attempt+1}/6 — {len(unsynced)} not yet converged")
        time.sleep(10)

    if cloud is None:
        return {"pass": False, "reason": "cloud unreachable", "soak_writes": len(journaled)}

    explained = [
        iid for iid in journaled
        if norm(local.get(iid)) != norm(cloud.get(iid)) and iid in rejected
    ]
    return {
        # Fail on: a wiped local write (data destroyed), an unsynced write the
        # cloud never got (lost in transit / dropped on 429/version-cap), a
        # suspect permanent-drop (B1 429 / B7 version-cap — silent loss), or a
        # queue that never drained (MCM08 retry-cap class).
        "pass": (not wiped and not unsynced and not suspect_drops
                 and (pending == 0 or pending < 0)),
        "soak_writes": len(journaled),
        "local_wiped": len(wiped),
        "unsynced_to_cloud": len(unsynced),
        # The headline bug detector: results the tool threw away on a non-
        # business reason (HTTP 429 = B1, version-conflict cap = B7).
        "suspect_silent_drops": len(suspect_drops),
        "suspect_drop_reasons": _top_reasons(suspect_drops),
        "explained_business_rejections": len(explained),
        "pending_queue_at_end": pending,
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
    """I7 — data added on the CLOUD side reaches the field WITHOUT a re-pull of
    everything and WITHOUT wiping local. We verify the additions propagated:
    every IO the cloud-mutator added must be present in local SQLite by the end
    (the field pulled it on an SSE-reconnect). The no-wipe half is already
    enforced by I4's anti-wipe. Excludes the most-recent additions (no pull may
    have happened yet) by giving a settle window."""
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

    # Give the field time to pull the last batch (SSE reconnect cadence).
    missing = added_ids
    for _ in range(12):  # up to ~2 min
        local, _pending = local_results_and_queue()
        missing = [i for i in added_ids if i not in local]
        if not missing:
            break
        print(f"observer: I7 waiting — {len(missing)}/{len(added_ids)} cloud-added IOs not yet local")
        time.sleep(10)

    return {
        # Allow the final batch to still be in flight: fail only if a
        # meaningful fraction never arrived (a real propagation break).
        "pass": len(missing) <= max(3, int(0.05 * len(added_ids))),
        "cloud_added": len(added_ids),
        "not_propagated_to_local": len(missing),
        "missing_samples": missing[:10],
    }


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


def main() -> None:
    print(f"observer: run={RUN_ID} target={TOOL_URL} soak={SOAK_MINUTES}min")
    deadline = time.monotonic() + SOAK_MINUTES * 60.0
    lat_path = os.path.join(OUT, "health.csv")
    latencies: list[float] = []
    gaps: list[float] = []
    last_ok = time.monotonic()

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
                latencies.append(lat)
                gap = time.monotonic() - last_ok
                if gap > GAP_LIMIT_S:
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
            "pass": slope is None or slope < RSS_SLOPE_LIMIT_MB_PER_H,
            "rss_slope_mb_per_h": slope,
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
    verdict = {
        "run": RUN_ID,
        "ended": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "soak_minutes": SOAK_MINUTES,
        "pass": all(v["pass"] for v in invariants.values()),
        "invariants": invariants,
    }
    with open(os.path.join(OUT, "verdict.json"), "w") as f:
        json.dump(verdict, f, indent=2)

    print(json.dumps(verdict, indent=2))
    sys.exit(0 if verdict["pass"] else 1)


if __name__ == "__main__":
    main()
