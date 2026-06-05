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
