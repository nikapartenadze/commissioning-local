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
TOOL = os.environ.get("TOOL_CONTAINER", "battle-tool-1")
RUN_ID = os.environ.get("RUN_ID", "dev")
RUNS_DIR = os.environ.get("RUNS_DIR", "/runs")
DELAY_FILE = os.environ.get("DELAY_FILE", "/gen/delay")

JOURNAL = os.path.join(RUNS_DIR, RUN_ID, "injected.jsonl")
os.makedirs(os.path.dirname(JOURNAL), exist_ok=True)


class UnixHTTPConnection(http.client.HTTPConnection):
    def __init__(self, path: str):
        super().__init__("localhost")
        self.unix_path = path

    def connect(self):
        s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        s.connect(self.unix_path)
        self.sock = s


def docker(method: str, path: str) -> tuple[int, str]:
    conn = UnixHTTPConnection(DOCKER_SOCK)
    try:
        conn.request(method, path)
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
    — observed on the very first smoke run), then start with zeroed tags."""
    status, _ = docker("POST", f"/containers/{PLC_SIM}/stop?t=1")
    journal({"type": "download", "docker_status": status, "down_seconds": down_seconds})

    def up_later():
        time.sleep(down_seconds)
        docker("POST", f"/containers/{PLC_SIM}/start")
        journal({"type": "download-complete"})

    threading.Thread(target=up_later, daemon=True).start()
    return status, ""


def do_power(sec: int) -> tuple[int, str]:
    docker("POST", f"/containers/{PLC_SIM}/stop?t=1")
    journal({"type": "power", "down_seconds": sec})

    def up_later():
        time.sleep(sec)
        docker("POST", f"/containers/{PLC_SIM}/start")
        journal({"type": "power-restored"})

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
        return self._reply(404, {"error": "unknown"})


def download_storm(spec: str) -> None:
    lo, hi = (float(x) for x in spec.split(","))
    print(f"chaos: download storm armed — every {lo}-{hi} min", flush=True)
    while True:
        time.sleep(random.uniform(lo * 60, hi * 60))
        do_download()


if __name__ == "__main__":
    storm = os.environ.get("DOWNLOAD_STORM")
    if storm:
        threading.Thread(target=download_storm, args=(storm,), daemon=True).start()
    print(f"chaos: listening :8666 (plc-sim={PLC_SIM}, tool={TOOL})", flush=True)
    ThreadingHTTPServer(("0.0.0.0", 8666), Handler).serve_forever()
