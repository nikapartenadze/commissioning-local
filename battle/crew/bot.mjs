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
// case). 0 disables (single-MCM IO-only runs).
const FV_FRACTION = parseFloat(process.env.FV_FRACTION ?? '0');

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
        const devices = (lb?.devices ?? []).filter((d) => (d.id % BOTS) === (n - 1));
        const columns = (lb?.columns ?? []).filter((c) => c.IsEditable !== 0 && c.IsSystem !== 1);
        if (devices.length > 0 && columns.length > 0) {
          const dev = pick(devices);
          const col = pick(columns);
          const value = Math.random() < 0.85 ? 'Pass' : 'Fail';
          const t0 = Date.now();
          const r = await api('/api/l2/cell', {
            method: 'POST',
            body: JSON.stringify({ deviceId: dev.id, columnId: col.id, value, updatedBy: name }),
          });
          log({
            action: 'fv', subsystemId: scoped, deviceId: dev.id, columnId: col.id,
            value, status: r.status, latencyMs: Date.now() - t0,
          });
          if (r.status !== 200) console.log(`[crew] ${name}: POST /api/l2/cell -> ${r.status}`);
          await sleep(rand(THINK_MIN, THINK_MAX));
          continue;
        }
        // no owned FV work for this MCM → fall through to the IO path
      }

      const { status, body } = await api(scoped ? `/api/ios?subsystemId=${scoped}` : '/api/ios');
      const ios = Array.isArray(body) ? body : (body?.ios ?? []);
      if (status !== 200 || ios.length === 0) {
        log({ action: 'list', status, count: ios.length ?? 0, error: status !== 200 });
        await sleep(5000);
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
