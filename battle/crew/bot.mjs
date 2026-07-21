#!/usr/bin/env node
/**
 * Crew — N simulated technicians hammering the tool's API the way the real
 * UI does. Node 20 built-ins only (fetch), no npm install.
 *
 * Each bot loops: fetch the IO list -> pick a random untested-or-any IO ->
 * mark Passed/Failed (occasionally Cleared) with a comment -> journal the
 * action to /runs/<RUN_ID>/journal-<bot>.jsonl (ground truth for the I4
 * data-loss invariant in Phase 1).
 *
 * Env: TOOL_URL, BOTS (default 6), RUN_ID, RUNS_DIR,
 *      THINK_MIN_MS/THINK_MAX_MS (default 2000/15000)
 */
import { appendFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const TOOL_URL = process.env.TOOL_URL ?? 'http://tool:3000';
const BOTS = parseInt(process.env.BOTS ?? '6', 10);
const RUN_ID = process.env.RUN_ID ?? 'dev';
const RUNS_DIR = process.env.RUNS_DIR ?? '/runs';
const THINK_MIN = parseInt(process.env.THINK_MIN_MS ?? '2000', 10);
const THINK_MAX = parseInt(process.env.THINK_MAX_MS ?? '15000', 10);
// HOT_SET: how many IOs ALL bots converge on, forcing concurrent writes to the
// same rows → version races (reproduces B7, the version-conflict retry-cap
// drop). HOT_FRACTION: chance a write targets the hot set vs a random IO.
const HOT_SET = parseInt(process.env.HOT_SET ?? '12', 10);
const HOT_FRACTION = parseFloat(process.env.HOT_FRACTION ?? '0.35');
// FV_FRACTION: chance an iteration does a FUNCTIONAL-VALIDATION (L2 cell) write
// instead of an IO result — simulates electricians filling FV checks per MCM.
// These flow through the same offline queue (L2PendingSyncs) so a cloud outage
// must hold them and drain on reconnect (the "internet gone for days then back"
// case).
// FV_WRITE_CHANCE (2026-07-08, I8_FV build-out): the scenario-independent knob
// run_scenario.sh exports for EVERY scenario (default 0.2) so no soak is blind
// to the FV wipe class. Precedence: an explicit FV_FRACTION > 0 (scenario
// tuning) wins; else FV_WRITE_CHANCE (0 is a valid off-switch); neither → 0.2.
const _fvFraction = parseFloat(process.env.FV_FRACTION ?? '');
const _fvChance = parseFloat(process.env.FV_WRITE_CHANCE ?? '');
const FV_FRACTION = _fvFraction > 0 ? _fvFraction
  : (Number.isFinite(_fvChance) ? _fvChance : 0.2);
// Per-FEATURE write fractions (2026-07-06 coverage build-out). Each iteration
// rolls these in order; the first hit runs that feature action (partitioned +
// journaled), else it falls through to the FV/IO path. IO stays dominant. All
// drive the REAL production endpoints → their durable offline queues, so a
// cloud outage must hold every feature's work and drain it on reconnect, and
// the observer's per-type survival gates (I22-I25) judge each one.
//   estop  → EStopCheckPendingSyncs   (SAFETY data)
//   guided → GuidedTaskStatePendingSyncs
//   punch  → PendingSyncs (Punchlist Updated op)
//   deps   → PendingSyncs (Dependencies Updated op)
//   blocker→ DeviceBlockerPendingSyncs (VFD bump-test blocker)
const ESTOP_FRACTION = parseFloat(process.env.ESTOP_FRACTION ?? '0');
const GUIDED_FRACTION = parseFloat(process.env.GUIDED_FRACTION ?? '0');
// Guided IO WALK (pool → steps → /api/guided/test). Distinct from
// GUIDED_FRACTION, which only writes synthetic GuidedTaskState rows.
const GUIDED_IO_FRACTION = parseFloat(process.env.GUIDED_IO_FRACTION ?? '0');
const PUNCH_FRACTION = parseFloat(process.env.PUNCH_FRACTION ?? '0');
const DEPS_FRACTION = parseFloat(process.env.DEPS_FRACTION ?? '0');
const BLOCKER_FRACTION = parseFloat(process.env.BLOCKER_FRACTION ?? '0');
// VFD wizard cell writes via the REAL wizard endpoint (write-l2-cells), which
// resolves columnName→columnId, writes L2CellValues, AND triggers the PLC
// validation-flag writeback — the identity/direction/polarity path a tech runs
// in the VFD wizard. Distinct from the generic FV single-cell edit.
const VFDWIZARD_FRACTION = parseFloat(process.env.VFDWIZARD_FRACTION ?? '0');

const OUT = join(RUNS_DIR, RUN_ID);
mkdirSync(OUT, { recursive: true });

// The observer drops this sentinel when the soak ends so the crew goes QUIET
// before the data-loss verdict. Without it bots write forever — the journal
// keeps growing during the observer's settle window, so `journaled` (snapshot
// at judgment start) and `local` (read ~minutes later) are incoherent and a
// later write looks like a wipe; and the offline queue never drains, so the
// cloud-pull (I7) never fires. A quiescent system is required to judge.
const STOP_FILE = join(OUT, 'STOP');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (lo, hi) => lo + Math.random() * (hi - lo);
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
// Stable non-negative hash of a string → used to partition e-stop checks (keyed
// by checkTag, not a numeric id) so each check is single-writer across bots.
const hashStr = (s) => {
  let h = 0;
  for (let i = 0; i < String(s).length; i++) h = (h * 31 + String(s).charCodeAt(i)) | 0;
  return Math.abs(h);
};

async function api(path, opts = {}, timeoutMs = 30_000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(`${TOOL_URL}${path}`, {
      ...opts,
      signal: ctl.signal,
      headers: { 'content-type': 'application/json', ...(opts.headers ?? {}) },
    });
    const body = await res.json().catch(() => null);
    return { status: res.status, body };
  } finally {
    clearTimeout(t);
  }
}

async function bot(n) {
  const name = `Bot ${n}`;
  const journal = join(OUT, `journal-bot${n}.jsonl`);
  const log = (entry) =>
    appendFileSync(journal, JSON.stringify({ ts: new Date().toISOString(), bot: n, ...entry }) + '\n');

  // jitter start so bots don't move in lockstep
  await sleep(rand(0, 5000));
  console.log(`[crew] ${name} starting`);

  // Realistic client behavior: a real tablet / browser grid fetches ONE
  // MCM's IO list (?subsystemId=), never the whole site. On the 19-MCM
  // central seed an unscoped /api/ios serializes 25k rows — 12 bots doing
  // that every think-cycle was ~8 site-wide JSON builds/sec, which saturated
  // the tool's event loop ALL BY ITSELF and drowned the real signal
  // (2026-06-07 central-cdw5 round 3). Discover the subsystem list once,
  // then work one randomly-chosen subsystem per iteration.
  let subsystems = [];
  while (subsystems.length === 0) {
    if (existsSync(STOP_FILE)) return;
    try {
      const { status, body } = await api('/api/mcm');
      const mcms = Array.isArray(body) ? body : (body?.mcms ?? []);
      subsystems = mcms.map((m) => String(m.subsystemId)).filter(Boolean);
      if (subsystems.length === 0) {
        // single-MCM / legacy stack: fall back to the unscoped list below
        break;
      }
    } catch { /* tool still booting */ }
    if (subsystems.length === 0) await sleep(3000);
  }

  // I8_FV precondition visibility (rig rule 5): count LOUDLY how many FV cells
  // this bot OWNS and can write at startup. A seed without L2 devices/columns
  // → 0 → the bot writes no FV and the observer reports I8_FV inconclusive
  // (never a vacuous pass/fail). One-time scoped fetches only.
  try {
    let fvOwned = 0, fvDevs = 0;
    for (const s of (subsystems.length > 0 ? subsystems : [null])) {
      const { body: lb } = await api(s ? `/api/l2?subsystemId=${s}` : '/api/l2');
      const devs = (lb?.devices ?? []).filter(
        (d) => (d.id % BOTS) === (n - 1) && !/vfd/i.test(`${d.DeviceName ?? ''}`));
      fvDevs += devs.length;
      for (const d of devs) {
        fvOwned += (lb?.columns ?? []).filter(
          (c) => c.SheetId === d.SheetId && c.IsEditable !== 0 && c.IsSystem !== 1).length;
      }
    }
    console.log(`[crew] ${name}: FV writable cells owned at startup = ${fvOwned} `
      + `(${fvDevs} owned non-VFD devices, fvChance=${FV_FRACTION})`);
  } catch (e) {
    console.log(`[crew] ${name}: FV startup probe failed (${e?.message ?? e}) — FV path re-discovers per tick`);
  }

  // Monotonic per-bot counter → every FV write carries a unique, traceable
  // value (BOT<n>-<counter>): a lost/clobbered cell is unambiguous in the
  // I8_FV/I18 verdicts (no accidental value collision between writes).
  let fvCounter = 0;

  for (;;) {
    if (existsSync(STOP_FILE)) {
      console.log(`[crew] ${name} stopping (soak ended)`);
      return;
    }
    try {
      const scoped = subsystems.length > 0 ? pick(subsystems) : null;

      // Functional-validation (L2) path — simulate an electrician filling FV
      // cells for THIS MCM. Scoped per subsystem (the per-MCM fix) and
      // partitioned by device.id % BOTS so each device is single-writer (the
      // observer can then judge L2 cell survival unambiguously). The write goes
      // through /api/l2/cell → L2PendingSyncs, so an offline window holds it and
      // it must drain when the cloud returns.
      if (scoped && FV_FRACTION > 0 && Math.random() < FV_FRACTION) {
        const { body: lb } = await api(`/api/l2?subsystemId=${scoped}`);
        // Exclude VFD-named devices: those belong to the VFD-wizard action, so
        // fv and vfdwizard write DISJOINT cells and never race the same L2 cell
        // (the cross-action contention that false-tripped I18/I26 on the first
        // slowlink run — local kept the last write, no data was lost).
        const devices = (lb?.devices ?? []).filter(
          (d) => (d.id % BOTS) === (n - 1) && !/vfd/i.test(`${d.DeviceName ?? ''}`));
        if (devices.length > 0) {
          const dev = pick(devices);
          // Only columns on THIS device's sheet are valid cells to write.
          const columns = (lb?.columns ?? []).filter(
            (c) => c.SheetId === dev.SheetId && c.IsEditable !== 0 && c.IsSystem !== 1);
          if (columns.length === 0) { await sleep(rand(THINK_MIN, THINK_MAX)); continue; }
          const col = pick(columns);
          // Unique traceable value (I8_FV): BOT<n>-<counter>, never reused.
          const value = `BOT${n}-${++fvCounter}`;
          const t0 = Date.now();
          const r = await api('/api/l2/cell', {
            method: 'POST',
            body: JSON.stringify({ deviceId: dev.id, columnId: col.id, value, updatedBy: name }),
          });
          // kind:'l2' is the distinct record type the observer's I8_FV check
          // keys on (IO logic untouched); action:'fv' kept for I18. Journal in
          // APPEND order — the observer never ts-sorts (same-ms ties mis-order).
          log({
            action: 'fv', kind: 'l2', subsystemId: scoped, deviceId: dev.id, columnId: col.id,
            value, status: r.status, latencyMs: Date.now() - t0,
          });
          if (r.status !== 200) console.log(`[crew] ${name}: POST /api/l2/cell -> ${r.status}`);
          await sleep(rand(THINK_MIN, THINK_MAX));
          continue;
        }
        // no owned FV work for this MCM → fall through to the IO path
      }

      // ── E-STOP CHECK (safety data) — discover real zones/EPCs for this MCM,
      // partition by checkTag so each check is single-writer, POST a pass/fail
      // through the real /api/estop/check → EStopCheckPendingSyncs queue. ──
      if (scoped && ESTOP_FRACTION > 0 && Math.random() < ESTOP_FRACTION) {
        const { body: eb } = await api(`/api/estop/status?subsystemId=${scoped}`);
        const checks = [];
        for (const z of (eb?.zones ?? [])) {
          for (const epc of (z.epcs ?? [])) {
            if (epc.checkTag) checks.push({ zoneName: z.name, checkTag: epc.checkTag });
          }
        }
        const mine = checks.filter((c) => (hashStr(c.checkTag) % BOTS) === (n - 1));
        if (mine.length > 0) {
          const c = pick(mine);
          const result = Math.random() < 0.85 ? 'pass' : 'fail';
          const t0 = Date.now();
          const r = await api('/api/estop/check', {
            method: 'POST',
            body: JSON.stringify({
              subsystemId: Number(scoped), zoneName: c.zoneName, checkTag: c.checkTag,
              result, checkType: 'preliminary', testedBy: name,
              comments: result === 'fail' ? `battle-bot${n}: EPC fail ${Date.now()}` : undefined,
            }),
          });
          log({ action: 'estop', subsystemId: Number(scoped), zoneName: c.zoneName,
                checkTag: c.checkTag, result, status: r.status, latencyMs: Date.now() - t0 });
          if (r.status !== 200) console.log(`[crew] ${name}: POST /api/estop/check -> ${r.status}`);
          await sleep(rand(THINK_MIN, THINK_MAX));
          continue;
        }
      }

      // ── GUIDED IO WALK — the REAL guided loop, end to end. ────────────────
      // Everything else labelled "guided" in this rig writes synthetic task ids
      // to GuidedTaskState, which only proves the override table syncs. This
      // walks what a technician actually does: build the pool, open a task,
      // fetch its server-built steps, and record a verdict through
      // POST /api/guided/test — the path that carries the MCM-ownership guard,
      // the SPARE rejection, the install gate, Trade/blocker columns on the
      // PendingSync, and the recovery journal.
      //
      // Single-writer discipline (rig rule): a bot only records IOs where
      // io.id % BOTS === n-1, so I4's last-write is never ambiguous.
      if (scoped && GUIDED_IO_FRACTION > 0 && Math.random() < GUIDED_IO_FRACTION) {
        const { body: pool } = await api(`/api/guided/tasks?subsystemId=${scoped}`);
        const workable = (pool?.tasks ?? []).filter(
          (t) => String(t.type ?? '').startsWith('io_check') &&
                 (t.state === 'available' || t.state === 'in_progress') && !t.claimedBy);
        if (workable.length) {
          const task = workable[Math.floor(Math.random() * workable.length)];
          const { body: sb } = await api(
            `/api/guided/tasks/steps?subsystemId=${scoped}&taskId=${encodeURIComponent(task.id)}`);
          // Only io_check steps carry an ioId; navigate/info steps record nothing.
          const mine = (sb?.steps ?? []).filter(
            (s) => s.kind === 'io_check' && Number.isInteger(s.ioId) && (s.ioId % BOTS) === (n - 1));
          if (mine.length) {
            const step = mine[Math.floor(Math.random() * mine.length)];
            const result = Math.random() < 0.85 ? 'Pass' : 'Fail';
            const t0 = Date.now();
            const r = await api('/api/guided/test', {
              method: 'POST',
              body: JSON.stringify({
                ioId: step.ioId,
                subsystemId: Number(scoped),   // exercises the ownership guard
                result,
                currentUser: name,
                failureMode: result === 'Fail' ? 'No Response' : undefined,
                trade: result === 'Fail' ? 'Controls' : undefined,
                comments: result === 'Fail' ? `battle-bot${n}: guided fail ${Date.now()}` : undefined,
              }),
            });
            // Journal in the SAME shape as a grid 'mark' so I4 counts these as
            // real field writes and a silent drop here fails the data-loss gate.
            log({ action: 'mark', subsystemId: Number(scoped), ioId: step.ioId,
                  result: result === 'Pass' ? 'Passed' : 'Failed',
                  via: 'guided', taskId: task.id, status: r.status,
                  latencyMs: Date.now() - t0 });
            if (r.status !== 200) console.log(`[crew] ${name}: guided io -> ${r.status}`);
            await sleep(rand(THINK_MIN, THINK_MAX));
            continue;
          }
        }
      }

      // ── GUIDED TASK STATE — synthetic per-bot task ids (the endpoint keys by
      // (subsystem, taskId) with no pool FK, so partitioned synthetic ids
      // exercise the real GuidedTaskStatePendingSyncs queue + sync path). ──
      if (scoped && GUIDED_FRACTION > 0 && Math.random() < GUIDED_FRACTION) {
        const taskId = `battle-guided-${scoped}-bot${n}-${Math.floor(Math.random() * 8)}`;
        const complete = Math.random() < 0.7;
        const t0 = Date.now();
        const r = complete
          ? await api('/api/guided/tasks/complete', {
              method: 'POST',
              body: JSON.stringify({ subsystemId: Number(scoped), taskId, currentUser: name }),
            })
          : await api('/api/guided/tasks/skip', {
              method: 'POST',
              body: JSON.stringify({ subsystemId: Number(scoped), taskId, reason: `battle skip ${Date.now()}`, currentUser: name }),
            });
        log({ action: 'guided', subsystemId: Number(scoped), taskId,
              statusVal: complete ? 'completed' : 'skipped', status: r.status, latencyMs: Date.now() - t0 });
        if (r.status !== 200) console.log(`[crew] ${name}: guided task -> ${r.status}`);
        await sleep(rand(THINK_MIN, THINK_MAX));
        continue;
      }

      // ── VFD WIZARD — drive the REAL wizard write path (write-l2-cells) on a
      // partitioned VFD device: resolve columnName→columnId, write L2CellValues,
      // trigger PLC flag writeback. This is the identity/direction/polarity flow
      // a tech runs in the wizard (distinct from the generic FV single-cell). ──
      if (scoped && VFDWIZARD_FRACTION > 0 && Math.random() < VFDWIZARD_FRACTION) {
        const { body: lb } = await api(`/api/l2?subsystemId=${scoped}&vfd=1`);
        const vfds = (lb?.devices ?? []).filter((d) => (d.id % BOTS) === (n - 1) && d.DeviceName);
        if (vfds.length > 0) {
          const dev = pick(vfds);
          // Only columns on THIS device's sheet resolve in write-l2-cells; a
          // column from another sheet is silently skipped (200 + ok:false),
          // which would false-trip I26. Scope to the device's sheet.
          const cols = (lb?.columns ?? []).filter(
            (c) => c.SheetId === dev.SheetId && c.IsEditable !== 0 && c.IsSystem !== 1 && c.Name);
          if (cols.length === 0) { await sleep(rand(THINK_MIN, THINK_MAX)); continue; }
          const col = pick(cols);
          const value = `bot${n} ${Date.now() % 100000}`;
          const t0 = Date.now();
          const r = await api('/api/vfd-commissioning/write-l2-cells', {
            method: 'POST',
            body: JSON.stringify({
              deviceName: dev.DeviceName, subsystemId: Number(scoped), updatedBy: name,
              cells: [{ columnName: col.Name, value }],
            }),
          });
          log({ action: 'vfdwizard', subsystemId: Number(scoped), deviceName: dev.DeviceName,
                columnName: col.Name, value, status: r.status, latencyMs: Date.now() - t0 });
          if (r.status !== 200) console.log(`[crew] ${name}: write-l2-cells -> ${r.status}`);
          await sleep(rand(THINK_MIN, THINK_MAX));
          continue;
        }
      }

      // ── VFD DEVICE BLOCKER — set on a partitioned VFD device (cloud resolves
      // deviceName→Devices, returns ok even if unknown, so this is safe). ──
      if (scoped && BLOCKER_FRACTION > 0 && Math.random() < BLOCKER_FRACTION) {
        const { body: lb } = await api(`/api/l2?subsystemId=${scoped}`);
        const owned = (lb?.devices ?? []).filter((d) => (d.id % BOTS) === (n - 1) && d.DeviceName);
        // Prefer VFD-named devices (the semantic case), but fall back to any
        // owned device — the cloud resolves deviceName→Devices and returns ok
        // even when unresolved, so any name exercises the blocker queue+sync.
        const vfds = owned.filter((d) => /vfd/i.test(`${d.DeviceName}`));
        const cands = vfds.length > 0 ? vfds : owned;
        if (cands.length > 0) {
          const dev = pick(cands);
          const party = pick(['Controls', 'Electrical', 'Mechanical']);
          const description = `battle-bot${n}: bump blocker ${Date.now()}`;
          const t0 = Date.now();
          const r = await api('/api/vfd-commissioning/bump-blocker', {
            method: 'POST',
            body: JSON.stringify({
              subsystemId: Number(scoped), deviceName: dev.DeviceName, op: 'set',
              blockerResponsibleParty: party, blockerDescription: description, updatedBy: name,
            }),
          });
          log({ action: 'blocker', subsystemId: Number(scoped), deviceName: dev.DeviceName,
                op: 'set', party, description, status: r.status, latencyMs: Date.now() - t0 });
          if (r.status !== 200) console.log(`[crew] ${name}: bump-blocker -> ${r.status}`);
          await sleep(rand(THINK_MIN, THINK_MAX));
          continue;
        }
      }

      const { status, body } = await api(scoped ? `/api/ios?subsystemId=${scoped}` : '/api/ios');
      const ios = Array.isArray(body) ? body : (body?.ios ?? []);
      if (status !== 200 || ios.length === 0) {
        log({ action: 'list', status, count: ios.length ?? 0, error: status !== 200 });
        await sleep(5000);
        continue;
      }

      // ── PUNCHLIST / DEPENDENCIES — metadata edits on an OWNED IO (reuse the
      // list fetch above). Both ride PendingSyncs as their own ops (F4 punchlist
      // + Dependencies Updated); the observer's I25 verifies they survive. ──
      const ownedIos = ios.filter((x) => (x.id % BOTS) === (n - 1));
      if (ownedIos.length > 0 && PUNCH_FRACTION > 0 && Math.random() < PUNCH_FRACTION) {
        const io2 = pick(ownedIos);
        const punchlistStatus = Math.random() < 0.6 ? 'ADDRESSED' : 'CLARIFICATION';
        const trade = pick(['electrical', 'controls', 'mechanical']);
        const clarificationNote = `battle-bot${n}: ${punchlistStatus} ${Date.now()}`;
        const t0 = Date.now();
        const r = await api(`/api/ios/${io2.id}/punchlist`, {
          method: 'PATCH',
          body: JSON.stringify({ punchlistStatus, trade, clarificationNote, updatedBy: name }),
        });
        log({ action: 'punch', ioId: io2.id, punchlistStatus, trade,
              status: r.status, latencyMs: Date.now() - t0 });
        if (r.status !== 200) console.log(`[crew] ${name}: punchlist -> ${r.status}`);
        await sleep(rand(THINK_MIN, THINK_MAX));
        continue;
      }
      if (ownedIos.length > 0 && DEPS_FRACTION > 0 && Math.random() < DEPS_FRACTION) {
        const io2 = pick(ownedIos);
        const hasDependencies = Math.random() < 0.5;
        const t0 = Date.now();
        const r = await api(`/api/ios/${io2.id}/dependencies`, {
          method: 'PATCH',
          body: JSON.stringify({ hasDependencies, currentUser: name }),
        });
        log({ action: 'deps', ioId: io2.id, hasDependencies,
              status: r.status, latencyMs: Date.now() - t0 });
        if (r.status !== 200) console.log(`[crew] ${name}: dependencies -> ${r.status}`);
        await sleep(rand(THINK_MIN, THINK_MAX));
        continue;
      }

      // Hot-set targeting: a shared slice of IOs that every bot hammers, so
      // multiple bots write the same row near-simultaneously (version races).
      // Hot writes use Failed/Cleared (legal on SPARE too) to avoid SPARE
      // noise and keep the race signal clean.
      let io, result, hot = false, wiringFault = false;
      if (ios.length > HOT_SET && Math.random() < HOT_FRACTION) {
        io = ios[Math.floor(Math.random() * HOT_SET)];
        result = Math.random() < 0.5 ? 'Failed' : 'Cleared';
        hot = true;
      } else {
        // PARTITIONED ownership: each bot writes ONLY its disjoint slice of the
        // IO space, keyed on the STABLE io.id (io.id % BOTS === n-1) so the
        // slices never overlap even if /api/ios returns a different order
        // between fetches. Over a long run this keeps every IO single-writer,
        // so its last write is unambiguous and the I4 data-loss check can
        // verify ALL of them — instead of every IO becoming a multi-writer
        // collision (which the observer must exclude, leaving 0 checkable IOs
        // over an 8 h soak). Real techs don't both test the same point either;
        // concurrent-write stress stays in the (separate) hot-set branch.
        // SPARE semantics (field reality): a SPARE point is left ALONE — it
        // is never Passed (the cloud refuses it; each refusal parks a row and
        // jams the scoped auto-pull at the result-loss guard, see FINDINGS
        // central rounds 1-2), and it is Failed ONLY when it unexpectedly
        // shows live state — a bit flipping on a spare point means wrong
        // wiring. Anything else a tech wouldn't touch.
        const isSpare = (io) => /spare/i.test(`${io.description ?? ''} ${io.name ?? ''}`);
        const mine = ios.filter((io) => (io.id % BOTS) === (n - 1) && !isSpare(io));
        const miswired = ios.filter(
          (io) => (io.id % BOTS) === (n - 1) && isSpare(io) && io.state === true,
        );
        if (mine.length === 0 && miswired.length === 0) { await sleep(2000); continue; }
        if (miswired.length > 0) {
          // Unexpected state on a SPARE → fail it (wrong-wiring catch).
          io = pick(miswired);
          result = 'Failed';
          wiringFault = true;
        } else {
          io = pick(mine);
          const roll = Math.random();
          result = roll < 0.75 ? 'Passed' : roll < 0.95 ? 'Failed' : 'Cleared';
        }
      }
      const comments =
        result === 'Failed'
          ? (wiringFault
              ? `battle-bot${n}: SPARE showed state — check wiring ${Date.now()}`
              : `battle-bot${n}: simulated failure ${Date.now()}`)
          : undefined;

      const t0 = Date.now();
      const r = await api(`/api/ios/${io.id}`, {
        method: 'PUT',
        body: JSON.stringify({ result, comments, currentUser: name }),
      });
      // `hot` writes race on shared rows — their last-write-wins ordering is
      // ambiguous, so the observer excludes them from journal-vs-store checks
      // and relies on the log-based suspect-drop detector for B7.
      log({
        action: 'mark', ioId: io.id, ioName: io.name, result, hot,
        status: r.status, latencyMs: Date.now() - t0,
      });
      if (r.status !== 200) {
        console.log(`[crew] ${name}: PUT /api/ios/${io.id} -> ${r.status}`);
      }
    } catch (err) {
      log({ action: 'error', message: String(err?.message ?? err) });
    }
    await sleep(rand(THINK_MIN, THINK_MAX));
  }
}

console.log(`[crew] ${BOTS} bots -> ${TOOL_URL}`);
for (let i = 1; i <= BOTS; i++) void bot(i);
