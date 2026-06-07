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

  for (;;) {
    if (existsSync(STOP_FILE)) {
      console.log(`[crew] ${name} stopping (soak ended)`);
      return;
    }
    try {
      const { status, body } = await api('/api/ios');
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
      let io, result, hot = false;
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
        const mine = ios.filter((io) => (io.id % BOTS) === (n - 1));
        if (mine.length === 0) { await sleep(2000); continue; }
        io = pick(mine);
        const roll = Math.random();
        result = roll < 0.75 ? 'Passed' : roll < 0.95 ? 'Failed' : 'Cleared';
      }
      const comments =
        result === 'Failed' ? `battle-bot${n}: simulated failure ${Date.now()}` : undefined;

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
