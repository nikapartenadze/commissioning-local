# Centralized Server — Validation & Verification Checklist

Everything to verify before trusting the central server in production. Run on a
server that can reach the PLC subnet (and, for the VFD steps, a real drive).

---

## ⛔ FIRST: do not push test data to the production cloud

The running tool, if `apiPassword` + `remoteUrl` are set, **continuously pushes**
to the **production** cloud DB: queued `PendingSyncs` (test results) on the 30s
loop + instant on each test, plus heartbeats and status. To validate safely:

- **NEVER author a test result during validation** — i.e. do **not** call
  `POST /api/ios/:id/test`, `/reset`, `/guided/test`, `/guided/clear`, or press
  Pass/Fail/Clear in a client browser. Those create `PendingSyncs` → pushed to
  prod.
- **Safe operations** (PLC-only, never touch `Ios`/`PendingSyncs`/cloud):
  - `POST /api/safety/fire`, `/api/safety/bypass`
  - `POST /api/vfd-commissioning/write-tag`, `/write-tags-batch`, `/read-tags`
  - Connecting/disconnecting MCMs, reading status/tags.
- **Pulls are read-only** (cloud → local): catch-up/safety pulls never write to
  the cloud. Safe.
- To be extra safe, validate against a **non-production cloud** or temporarily
  blank `apiPassword` in `config.json` (stops all cloud push + pull).
- The concurrency soak test uses a **throwaway temp DB** — never touches prod.

---

## 1. Build & boot

```bash
cd frontend
docker build -t commissioning-central:2.39.16 .          # ~150MB image
# monolith:
docker compose up -d && docker compose logs -f            # expect "Up (healthy)", serves :3000
```
- [ ] Image builds; container `Up (healthy)`; `GET /` → 200.
- [ ] `libplctag.so` loads (trixie base): `docker exec <c> ldd /app/libplctag.so` resolves (no `GLIBC_2.38 not found`).

## 2. Split deployment (gateway + app)

```bash
cp .env.example .env       # set JWT_SECRET_KEY; APP_PORT if 3000 is taken
docker compose -f docker-compose.split.yml up -d
```
- [ ] Both containers healthy. App→gateway: `docker exec <app> node -e "fetch('http://gateway:3200/health').then(r=>r.json()).then(console.log)"`.
- [ ] Gateway→app: `docker exec <gateway> node -e "fetch('http://app:3102/broadcast',{method:'POST',headers:{'Content-Type':'application/json'},body:'{\"type\":\"Ping\"}'}).then(r=>r.json()).then(console.log)"` → `clientsNotified`.
- [ ] **Zero-downtime app hotfix:** connect an MCM, note `gateway /health uptimeSec`, then
      `docker compose -f docker-compose.split.yml up -d --no-deps app`. Gateway uptime keeps
      climbing, `mcmCount` unchanged, the restarted app re-reads the MCM. **PLC connection never dropped.**

## 3. Import + connect (one-touch)

- [ ] `/mcm` page → **Import from cloud** lists all the project's subsystems.
- [ ] Set each MCM's IP (or use the discovered map), then **Connect All** → it auto-pulls IOs and connects; per-MCM reasons shown for any that fail/skip.
- [ ] `GET /api/plc/status` → `connectedMcmCount` / `tagCount` reflect all connected MCMs.

## 4. Sync correctness (no data loss)

- [ ] **Catch-up pull, all MCMs:** restart the app (or drop/restore the network); the log shows
      `SSE reconnect: catch-up pull for N active MCM(s)` → `catch-up done: <id>:ok(<n>) …` for **every** connected MCM (not just one).
- [ ] **Pull can't clobber unsynced work:** with a pending local change, a pull returns
      409 (`Pull skipped — a test was recorded …`) instead of overwriting. *(Authoring a test pushes to cloud — only do this against a non-prod cloud.)*
- [ ] **Push covers all MCMs:** *(non-prod cloud only)* test an IO on each of 2+ MCMs; both reach the cloud.

## 5. Concurrency — no lost updates (automated, safe)

```bash
cd frontend && npx vitest run __tests__/concurrency-soak.test.ts
```
- [ ] 100 concurrent writes to one IO → `Version == 100`, contiguous `1..100`; different IOs land independently; 200 under load, none lost. *(temp DB, no cloud)*

## 6. Recovery & retention

- [ ] `logs/audit-YYYY-MM-DD.jsonl` exists and contains `io.test` / `server.start` lines; a dropped push records `sync.push.drop` with the full payload.
- [ ] `logs/app-YYYY-MM-DD.log` (daily) present; files older than 14d pruned (`LOG_RETENTION_DAYS`).
- [ ] `backups/` gets a `…-startup.db` on boot and `…-periodic.db` every 6h (`BACKUP_INTERVAL_HOURS`); >14d pruned.
- [ ] Restore drill: `sqlite3` open a backup, confirm IOs/TestHistories intact.

## 7. Tag reads at scale

- [ ] Connect all configured MCMs (thousands of tags). `[HEALTH]` RSS stays well under 512MB, no leak trend, `0 failed` tag reads over several minutes.

## 8. Aux PLC flows (MCM-aware)  ⚠ needs the right hardware

**Safety (validated in dev — re-confirm on site):**
- [ ] From a **client browser** (not the server laptop — the server-laptop guard blocks it), open a subsystem's Safety view and **Fire** a real `STD_` tag → bit toggles on the **correct MCM**. Bypass holds while active, releases on stop.
- Smoke (routing only, any tag): `curl -X POST .../api/safety/fire -H 'X-Forwarded-For: <client-ip>' -d '{"tag":"STD_X","action":"start","subsystemId":"<id>"}'` → reaches that MCM (real tag fires; fake → "Not found").

**VFD (needs a real drive — emulators here are Safety controllers, no `CBT_`):**
- [ ] In the VFD wizard for a device on a given MCM, run a step that writes a parameter
      (e.g. Valid_Map, RPM, Override_RVS pairing) → the value lands on **that MCM's drive**;
      read-back (`read-tags`) shows it. Verify **REAL** values (float32) and the
      **Override_RVS + RVS** pair land in the same scan (RVS sticks).
- Routing smoke: `curl -X POST .../api/vfd-commissioning/write-tag -d '{"subsystemId":"<id>","deviceName":"<dev>","field":"Bump","value":1,"dataType":"BOOL"}'`.

---

## Known remaining (Phase 1.1 follow-up — NOT yet split-ready)

These still use the legacy singleton and need the same MCM-aware treatment
before they work on a **split** deployment (they work in **embedded** single-MCM):

- `vfd-commissioning/clear`, `safety/status` — typed reads/writes; fit the
  existing `read/writeTypedTagsForMcm` facade (small).
- `vfd-commissioning/wizard-open` / `wizard-close` — a **stateful ~100ms live
  reader** (`openWizardReader`); in split mode this must run **inside the
  gateway** (like the main tag reader) and broadcast `VfdTagUpdate`. Larger.
- `vfd-commissioning/test-write` — raw-byte write/verify **diagnostic**; niche.

Embedded multi-MCM note: `wizard-open`/`clear`/`safety-status` also need the
per-MCM connection (not the singleton) even embedded — same `subsystemId`
threading as the converted routes.
