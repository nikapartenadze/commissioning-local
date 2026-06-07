# battle/ — overnight battle-test environment

Field-realistic abuse for the commissioning tool **before** it reaches a site.
Design + rationale: `../docs/BATTLE-TEST-PLAN.md`. Born from the 2026-06-05
MCM02 freeze (v2.40.0 VFD writer blocking the event loop at 72-VFD scale —
a class of bug only visible at scale + duration).

## Quick start

```powershell
# 1. one-time: produce the seed from a field DB copy (real MCM02 data)
python battle/tools/prepare_seed.py mcm02/database.db

# 2. run a soak (from battle/)
$env:RUN_ID = "s1-$(Get-Date -Format yyyyMMdd-HHmm)"; $env:SOAK_MINUTES = "480"
docker compose -f docker-compose.battle.yml -p battle up --build -d

# 3. verdict (blocks until the soak ends; exit code 0 = PASS)
docker wait battle-observer-1
docker cp battle-observer-1:/runs/$env:RUN_ID ./runs/   # artifacts from the named volume
Get-Content runs/$env:RUN_ID/verdict.json
```

Peek at the live UI during a soak: http://localhost:13000

## Scenarios

| Scenario | How |
|---|---|
| **S1 scale soak** | defaults — MCM02 dataset, 6 bots, clean network |
| **S2 download storm** | `$env:DOWNLOAD_STORM = "20,40"` (program download every 20–40 min; set `FLAP_BUDGET` stays 0 — injected events are auto-budgeted) |
| **PLC power cycle** | `curl -X POST http://<chaos>:8666/power?sec=300` |
| **CIP saturation** | `curl -X POST http://<chaos>:8666/delay?ms=300` |
| **Laptop power cut** | `curl -X POST http://<chaos>:8666/toolkill` (compose `restart: always` = NSSM recovery) |
| **Real Emulate 5580** | `$env:GATEWAY_IP = "192.168.5.107"` (or wherever the box lives today) — plc-sim idles, the tool talks to the real emulator |

The chaos API listens on the battle network (`battle-chaos-1:8666`); from the
host use `docker exec battle-chaos-1 python -c ...` or publish the port ad hoc.

## What the observer judges (verdict.json, exit code)

- **I1 responsiveness** — `/api/health` probed every 1 s from outside; p95 < 500 ms,
  p99 < 2 s, no gap > 10 s. *This catches the MCM02 event-loop-freeze class within seconds.*
- **I2 no leak** — RSS slope < 5 MB/h after 1 h warm-up (from `[HEALTH]` log lines).
- **I5 stability** — no unexpected `server.start` audit events; PLC connection flaps
  ≤ injected chaos events.
- **I3 restore evidence** — every injected download is followed by a
  `Sync done (plc-reconnect)` that wrote flags back. (Phase 1 upgrades this to
  reading actual tag values back through a CIP client.)

Artifacts per run live in the named `runs` volume (`/runs/<RUN_ID>/`):
`health.csv`, `memory.csv`, `verdict.json`, `injected.jsonl`,
`journal-bot*.jsonl`. Retrieve with `docker cp battle-observer-1:/runs/<RUN_ID> .`
(no host bind mounts — required for the GitLab DinD runner).

## CI (GitLab — gitlab.lci.ge/commissioning/commissioning-local, project 24)

- **Nightly schedule 00:30** on the `tracker-ci-dind` runner: 6 h soak, scenario
  rotated by weekday (`battle/ci/run_scenario.sh`: Mon/Wed/Fri/Sun = S2 storm,
  Tue/Thu = S1 clean, Sat = S6 CIP saturation). Verdict gates the pipeline;
  artifacts (verdict, CSVs, tool logs) retained 30 days.
- **battle-smoke** (15 min storm): run manually from the GitLab UI on the
  release commit before cutting a GitHub release.
- Seed DB comes from the project's **generic package registry**
  (`battle-seed/1/database.db`) — refresh after `prepare_seed.py` with the
  curl in `.gitlab-ci.yml`'s header comment.
- **Push to BOTH remotes** (GitHub = primary/releases, GitLab = CI):
  `git push origin main && git push gitlab main`.

## Components

| Dir | What |
|---|---|
| `plc-sim/` | libplctag `ab_server` v2.6.16, patched (see `patch_ab_server.py`) to accept module/UDT-style flat tag names (`UL21_3_VFD:I.In_0`, `CBT_X.CTRL.CMD.Valid_Map`). Restart = program download (tags zeroed). |
| `seeder/` | one-shot: seed DB + `config.json` + generates the ab_server tag list from the DB |
| `crew/` | N API bots marking pass/fail like technicians, with action journals |
| `chaos/` | REST chaos controller (docker-socket): download / power / delay / toolkill + download-storm mode |
| `observer/` | 1 s health probe + log scraping + invariant verdict |
| `tools/prepare_seed.py` | field-DB copy → checkpointed single-file seed |

## Safety

- Touches **no production system**: no prod DB, no prod cloud, no dockerhost.
  `remoteUrl` is empty (Phase 0) or points at a local throwaway cloud-stage (Phase 1).
- `seed/` and `runs/` are git-ignored — field data and artifacts never land in git.

## Roadmap

- **Phase 1:** cloud-stage (commissioning-cloud + throwaway Postgres) → I4
  data-loss invariant (journals vs SQLite vs cloud), real tag read-back for I3,
  pumba network profiles (wifi / vpn-flap).
- **Phase 2:** GitLab nightly schedule on `tracker-ci-dind` + release gate,
  Playwright crew (real UI), Grafana on dh3.
- **Phase 3:** update-channel scenario, 72 h endurance, Windows install
  checklist stays manual.
