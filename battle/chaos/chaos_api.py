#!/usr/bin/env python3
"""
Chaos controller. Stdlib only; talks to the Docker Engine API over the
mounted unix socket (no docker CLI in the image).

HTTP endpoints (port 8666, battle network only):
  POST /download            restart plc-sim => connection drop + ALL tags
                            zeroed (exact PLC program-download semantics)
  POST /power?sec=N         plc-sim down N seconds (PLC power cycle)
  POST /delay?ms=N          set CIP-saturation delay (takes effect via restart)
  POST /toolkill            SIGKILL the tool container (laptop power cut;
                            compose restart policy brings it back)
  GET  /events              injected-events journal (JSON lines)

Every injected event is journaled to /runs/<RUN_ID>/injected.jsonl so the
observer can budget expected flaps/restarts and check restore evidence.

Scenario mode (env): DOWNLOAD_STORM="20,40" => background thread injects
/download at random intervals between 20 and 40 minutes.
"""
import http.client
import json
import os
import random
import socket
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

DOCKER_SOCK = "/var/run/docker.sock"
PLC_SIM = os.environ.get("PLC_SIM_CONTAINER", "battle-plc-sim-1")
# Multi-MCM (central scenario): comma-separated sim containers. Downloads and
# power cuts pick a RANDOM one each time, so chaos rotates across MCMs the way
# real per-belt program downloads hit one controller at a time. Empty => the
# single legacy PLC_SIM.
PLC_SIMS = [c.strip() for c in os.environ.get("PLC_SIM_CONTAINERS", "").split(",") if c.strip()] or [PLC_SIM]
TOOL = os.environ.get("TOOL_CONTAINER", "battle-tool-1")
CLOUD = os.environ.get("CLOUD_CONTAINER", "battle-cloud-1")
NETWORK = os.environ.get("NETWORK_NAME", "battle_battle")
RUN_ID = os.environ.get("RUN_ID", "dev")
RUNS_DIR = os.environ.get("RUNS_DIR", "/runs")
DELAY_FILE = os.environ.get("DELAY_FILE", "/gen/delay")

JOURNAL = os.path.join(RUNS_DIR, RUN_ID, "injected.jsonl")
os.makedirs(os.path.dirname(JOURNAL), exist_ok=True)

# When set, all background chaos loops (download storm, cloud flap) stop and no
# new impairment is injected. The observer trips this before its final judgment
# so the system can converge (queue drains, last cloud changes propagate).
CALM = threading.Event()


class UnixHTTPConnection(http.client.HTTPConnection):
    def __init__(self, path: str):
        super().__init__("localhost")
        self.unix_path = path

    def connect(self):
        s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        s.connect(self.unix_path)
        self.sock = s


def docker(method: str, path: str, body: dict | None = None) -> tuple[int, str]:
    conn = UnixHTTPConnection(DOCKER_SOCK)
    try:
        headers = {}
        data = None
        if body is not None:
            data = json.dumps(body).encode()
            headers = {"Content-Type": "application/json"}
        conn.request(method, path, body=data, headers=headers)
        r = conn.getresponse()
        return r.status, r.read().decode(errors="replace")
    finally:
        conn.close()


def journal(event: dict) -> None:
    event = {"ts": time.strftime("%Y-%m-%dT%H:%M:%S"), **event}
    with open(JOURNAL, "a") as f:
        f.write(json.dumps(event) + "\n")
    print(f"chaos: {event}", flush=True)


def do_download(down_seconds: int = 25) -> tuple[int, str]:
    """Simulate a PLC program download: stop, stay DOWN long enough for the
    tool to notice (real downloads take 30s+; a 1s docker restart heals the
    CIP session in place and the tool never fires its reconnect-restore path
    — observed on the very first smoke run), then start with zeroed tags.
    Multi-MCM: targets a random sim each time (one controller per download)."""
    target = random.choice(PLC_SIMS)
    status, _ = docker("POST", f"/containers/{target}/stop?t=1")
    journal({"type": "download", "target": target, "docker_status": status, "down_seconds": down_seconds})

    def up_later():
        time.sleep(down_seconds)
        docker("POST", f"/containers/{target}/start")
        journal({"type": "download-complete", "target": target})

    threading.Thread(target=up_later, daemon=True).start()
    return status, ""


def do_power(sec: int) -> tuple[int, str]:
    target = random.choice(PLC_SIMS)
    docker("POST", f"/containers/{target}/stop?t=1")
    journal({"type": "power", "target": target, "down_seconds": sec})

    def up_later():
        time.sleep(sec)
        docker("POST", f"/containers/{target}/start")
        journal({"type": "power-restored", "target": target})

    threading.Thread(target=up_later, daemon=True).start()
    return 204, ""


def do_delay(ms: int) -> tuple[int, str]:
    with open(DELAY_FILE, "w") as f:
        f.write(str(ms))
    status, body = docker("POST", f"/containers/{PLC_SIM}/restart?t=1")
    journal({"type": "delay", "ms": ms, "docker_status": status})
    return status, body


def do_toolkill() -> tuple[int, str]:
    status, body = docker("POST", f"/containers/{TOOL}/kill?signal=SIGKILL")
    journal({"type": "toolkill", "docker_status": status})
    return status, body


def do_cloudcut(sec: int) -> tuple[int, str]:
    """Sever the tool↔cloud link by detaching cloud from the battle network for
    `sec` seconds, then reattaching. The tool keeps testing the PLC and queues
    results (PendingSyncs); on restore the offline queue must drain with NO
    lost writes. This is the MCM08 'lost connectivity while pushing' class and
    the VPN-down case. DNS-name based (tool reaches `cloud` by name), so the
    reattached container's new IP is transparent."""
    status, _ = docker("POST", f"/networks/{NETWORK}/disconnect",
                        {"Container": CLOUD, "Force": True})
    journal({"type": "cloudcut", "down_seconds": sec, "disconnect_status": status})

    def restore():
        time.sleep(sec)
        # CRITICAL: re-add the compose SERVICE alias ("cloud") and container
        # name on reconnect. A bare `network connect` does NOT restore the
        # service-name DNS alias compose set at creation, so the tool would
        # forever fail to resolve `cloud` even though the container is up —
        # a harness bug that falsely looked like "tool never recovers SSE".
        s, _ = docker("POST", f"/networks/{NETWORK}/connect", {
            "Container": CLOUD,
            "EndpointConfig": {"Aliases": ["cloud", CLOUD]},
        })
        journal({"type": "cloudcut-restored", "connect_status": s})

    threading.Thread(target=restore, daemon=True).start()
    return status, ""


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):  # quiet
        pass

    def _reply(self, code: int, payload: dict):
        body = json.dumps(payload).encode()
        self.send_response(code)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if urlparse(self.path).path == "/events":
            try:
                with open(JOURNAL) as f:
                    lines = [json.loads(line) for line in f]
            except FileNotFoundError:
                lines = []
            return self._reply(200, {"events": lines})
        return self._reply(404, {"error": "unknown"})

    def do_POST(self):
        url = urlparse(self.path)
        q = parse_qs(url.query)
        if url.path == "/download":
            s, _ = do_download()
            return self._reply(200, {"ok": s < 400})
        if url.path == "/power":
            sec = int(q.get("sec", ["60"])[0])
            do_power(sec)
            return self._reply(200, {"ok": True, "down_seconds": sec})
        if url.path == "/delay":
            ms = int(q.get("ms", ["0"])[0])
            s, _ = do_delay(ms)
            return self._reply(200, {"ok": s < 400, "ms": ms})
        if url.path == "/toolkill":
            s, _ = do_toolkill()
            return self._reply(200, {"ok": s < 400})
        if url.path == "/cloudcut":
            sec = int(q.get("sec", ["120"])[0])
            do_cloudcut(sec)
            return self._reply(200, {"ok": True, "down_seconds": sec})
        if url.path == "/calm":
            # Stop all background chaos and make sure the cloud is attached, so
            # the system can converge for the observer's final judgment.
            CALM.set()
            s, _ = docker("POST", f"/networks/{NETWORK}/connect", {
                "Container": CLOUD, "EndpointConfig": {"Aliases": ["cloud", CLOUD]},
            })
            journal({"type": "calm", "reconnect_status": s})
            return self._reply(200, {"ok": True})
        return self._reply(404, {"error": "unknown"})


def download_storm(spec: str) -> None:
    lo, hi = (float(x) for x in spec.split(","))
    print(f"chaos: download storm armed — every {lo}-{hi} min", flush=True)
    while not CALM.is_set():
        time.sleep(random.uniform(lo * 60, hi * 60))
        if CALM.is_set():
            break
        do_download()
    print("chaos: download storm stopped (calm)", flush=True)


def cloud_flap(spec: str) -> None:
    """VPN-flap profile: cut the cloud link for `down` min every `period` min.
    spec = "down_min,period_min" e.g. "10,60" = down 10 of every 60 min."""
    down_min, period_min = (float(x) for x in spec.split(","))
    print(f"chaos: cloud-flap armed — down {down_min}min every {period_min}min", flush=True)
    while not CALM.is_set():
        time.sleep(max(0.0, (period_min - down_min)) * 60)
        if CALM.is_set():
            break
        do_cloudcut(int(down_min * 60))
        time.sleep(down_min * 60)
    print("chaos: cloud-flap stopped (calm)", flush=True)


if __name__ == "__main__":
    storm = os.environ.get("DOWNLOAD_STORM")
    if storm:
        threading.Thread(target=download_storm, args=(storm,), daemon=True).start()
    flap = os.environ.get("CLOUD_FLAP")
    if flap:
        threading.Thread(target=cloud_flap, args=(flap,), daemon=True).start()
    print(f"chaos: listening :8666 (plc-sims={PLC_SIMS}, tool={TOOL}, cloud={CLOUD})", flush=True)
    ThreadingHTTPServer(("0.0.0.0", 8666), Handler).serve_forever()
