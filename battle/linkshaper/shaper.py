#!/usr/bin/env python3
"""
Link-shaper — a TCP proxy that models a DEGRADED WAN/VPN link between the field
tool and the cloud (the "terrible internet" case). Stdlib only.

The tool is pointed at this proxy (CLOUD_URL_OVERRIDE=http://linkshaper:3000);
it forwards to the real cloud (UPSTREAM), injecting on the way:
  - SHAPE_DELAY_MS   added one-way latency per data chunk (RTT ≈ 2×)
  - SHAPE_JITTER_MS  random extra latency per chunk (0..jitter)
  - SHAPE_RATE_KBPS  bandwidth cap per direction (0 = unlimited)
  - SHAPE_LOSS_PCT   % of NEW connections dropped at connect (packet-loss /
                     flaky-link → connection failures + client retries/timeouts)
  - SHAPE_CONN_DELAY_MS  extra latency on connection establishment (slow handshake)

This isolates the degradation to the tool↔cloud link only — the observer reads
the real cloud directly (CLOUD_URL=http://cloud:3000), and PLC traffic is
untouched. Handles long-lived SSE streams (bidirectional per-chunk pump, no
buffering). All knobs live-adjustable via a control file (/gen/shape.json) so
chaos can ramp the impairment mid-soak; env sets the initial value.
"""
import json
import os
import random
import socket
import threading
import time

LISTEN_PORT = int(os.environ.get("LISTEN_PORT", "3000"))
UP_HOST, _, UP_PORT = os.environ.get("UPSTREAM", "cloud:3000").partition(":")
UP_PORT = int(UP_PORT or "3000")
CTRL_FILE = os.environ.get("SHAPE_CTRL_FILE", "/gen/shape.json")

# Live-tunable shaping state (env = initial; control file overrides at runtime).
STATE = {
    "delay_ms": float(os.environ.get("SHAPE_DELAY_MS", "0")),
    "jitter_ms": float(os.environ.get("SHAPE_JITTER_MS", "0")),
    "rate_kbps": float(os.environ.get("SHAPE_RATE_KBPS", "0")),
    "loss_pct": float(os.environ.get("SHAPE_LOSS_PCT", "0")),
    "conn_delay_ms": float(os.environ.get("SHAPE_CONN_DELAY_MS", "0")),
}
CHUNK = 32 * 1024


def refresh_state() -> None:
    """Re-read the control file (if present) so impairment can change mid-run."""
    try:
        with open(CTRL_FILE) as f:
            over = json.load(f)
        for k in STATE:
            if k in over:
                STATE[k] = float(over[k])
    except (OSError, ValueError, json.JSONDecodeError):
        pass  # no/invalid control file → keep current STATE


def pump(src: socket.socket, dst: socket.socket, direction: str) -> None:
    """Forward src→dst applying per-chunk latency + bandwidth cap."""
    try:
        while True:
            data = src.recv(CHUNK)
            if not data:
                break
            delay = STATE["delay_ms"] / 1000.0
            if STATE["jitter_ms"] > 0:
                delay += random.uniform(0, STATE["jitter_ms"] / 1000.0)
            if delay > 0:
                time.sleep(delay)
            if STATE["rate_kbps"] > 0:
                # seconds to transmit len(data) bytes at the capped rate
                time.sleep(len(data) / (STATE["rate_kbps"] * 1000.0 / 8.0))
            dst.sendall(data)
    except OSError:
        pass
    finally:
        for s in (src, dst):
            try:
                s.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass


def handle(client: socket.socket) -> None:
    refresh_state()
    # Connection-level loss: drop a fraction of new connections outright, so the
    # tool sees connect failures / timeouts (the flaky-VPN reality).
    if STATE["loss_pct"] > 0 and random.uniform(0, 100) < STATE["loss_pct"]:
        try:
            client.close()
        except OSError:
            pass
        return
    if STATE["conn_delay_ms"] > 0:
        time.sleep(STATE["conn_delay_ms"] / 1000.0)
    try:
        upstream = socket.create_connection((UP_HOST, UP_PORT), timeout=30)
    except OSError:
        try:
            client.close()
        except OSError:
            pass
        return
    threading.Thread(target=pump, args=(client, upstream, "up"), daemon=True).start()
    pump(upstream, client, "down")


def main() -> None:
    srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    srv.bind(("0.0.0.0", LISTEN_PORT))
    srv.listen(128)
    print(f"linkshaper: :{LISTEN_PORT} → {UP_HOST}:{UP_PORT} "
          f"delay={STATE['delay_ms']}ms jitter={STATE['jitter_ms']}ms "
          f"rate={STATE['rate_kbps']}kbps loss={STATE['loss_pct']}%", flush=True)
    while True:
        try:
            client, _ = srv.accept()
        except OSError:
            continue
        threading.Thread(target=handle, args=(client,), daemon=True).start()


if __name__ == "__main__":
    main()
