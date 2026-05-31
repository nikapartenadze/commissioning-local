#!/usr/bin/env node

/**
 * plc-gateway — standalone PLC connection service.
 *
 * Phase 1 of the centralized-server modularity plan (CENTRAL-SERVER-DEPLOYMENT.md
 * §4). This process OWNS the live libplctag connections, the per-MCM tag cache
 * and the network pollers via the in-process mcm-registry. It is DB-free: the
 * app resolves anything that needs SQLite and passes it in the request body, so
 * the app remains the single SQLite writer.
 *
 * Two channels:
 *   1. Control (app -> gateway): this HTTP API (default :3200). The app's
 *      mode-aware registry calls it when PLC_MODE=remote.
 *   2. Events (gateway -> app): the registry POSTs tag/connection broadcasts to
 *      WS_BROADCAST_URL (the app's :3102 receiver), which fans them out to
 *      browsers. Same seam the monolith already used internally.
 *
 * Why this enables zero-downtime app hotfixes: the app can restart freely; the
 * gateway keeps every PLC connection and poller alive. When the app returns it
 * re-reads gateway state over GET /state and browsers reconnect to the app's WS.
 *
 * MUST run with PLC_MODE unset/embedded — it is the owner, not a client.
 */

import '@/lib/load-env';

import express, { type Request, type Response } from 'express';
import {
  connectMcm,
  loadMcmTags,
  disconnectMcm,
  disposeMcm,
  getMcmStatus,
  getMcmTags,
  listMcms,
  getAggregateStatus,
  getAllTags,
  getAllNetworkSnapshots,
  writeOutputBitForMcm,
  readOutputBitForMcm,
} from '@/lib/mcm-registry';
import { getAppVersion } from '@/lib/app-version';
import { DEFAULT_GATEWAY_PORT, type GatewayState } from '@/lib/plc/gateway-protocol';

if (process.env.PLC_MODE === 'remote') {
  // A remote gateway would forward to itself — fatal misconfiguration.
  console.error('[plc-gateway] FATAL: PLC_MODE=remote is invalid for the gateway process. Unset it.');
  process.exit(1);
}

const PORT = parseInt(process.env.GATEWAY_PORT || String(DEFAULT_GATEWAY_PORT), 10);
const HOST = process.env.GATEWAY_HOST || '0.0.0.0';
const VERSION = getAppVersion();
const STARTED_AT = Date.now();

const app = express();
app.use(express.json({ limit: '10mb' }));

// ── Request logging (errors + slow only) ────────────────────────────────────
app.use((req, res, next) => {
  const start = Date.now();
  const end = res.end;
  res.end = function (...args: any[]) {
    const ms = Date.now() - start;
    if (res.statusCode >= 500) {
      console.error(`[plc-gateway] ${req.method} ${req.path} -> ${res.statusCode} (${ms}ms)`);
    } else if (ms > 5000) {
      console.warn(`[plc-gateway] SLOW ${req.method} ${req.path} -> ${res.statusCode} (${ms}ms)`);
    }
    return end.apply(res, args as any);
  } as any;
  next();
});

// ── Health ──────────────────────────────────────────────────────────────────
app.get('/health', (_req: Request, res: Response) => {
  const agg = getAggregateStatus();
  res.json({
    ok: true,
    service: 'plc-gateway',
    version: VERSION,
    uptimeSec: Math.floor((Date.now() - STARTED_AT) / 1000),
    mcmCount: agg.totalCount,
    connectedCount: agg.connectedCount,
  });
});

// ── Full state snapshot (drives the app's read cache) ────────────────────────
app.get('/state', (_req: Request, res: Response) => {
  const agg = getAggregateStatus();
  const state: GatewayState = {
    mcms: listMcms(),
    aggregate: {
      anyConnected: agg.anyConnected,
      connectedCount: agg.connectedCount,
      totalCount: agg.totalCount,
      totalTagCount: agg.totalTagCount,
    },
    tags: getAllTags().tags,
    network: getAllNetworkSnapshots(),
  };
  res.json(state);
});

// ── Per-MCM control ──────────────────────────────────────────────────────────
app.post('/mcm/:subsystemId/load-tags', (req: Request, res: Response) => {
  const subsystemId = String(req.params.subsystemId);
  const tags = Array.isArray(req.body?.tags) ? req.body.tags : [];
  const ok = loadMcmTags(subsystemId, tags);
  res.json({ success: ok });
});

app.post('/mcm/:subsystemId/connect', async (req: Request, res: Response) => {
  const subsystemId = String(req.params.subsystemId);
  const { name, ip, path, tags } = req.body ?? {};
  if (!ip) {
    return res.status(400).json({ success: false, status: 'error', error: 'ip is required' });
  }
  try {
    if (Array.isArray(tags) && tags.length > 0) {
      loadMcmTags(subsystemId, tags);
    }
    const result = await connectMcm(subsystemId, String(name ?? subsystemId), {
      ip: String(ip),
      path: String(path ?? '1,0'),
    });
    res.json(result);
  } catch (err) {
    console.error(`[plc-gateway] connect ${subsystemId} failed:`, err);
    res.status(500).json({
      success: false,
      status: 'error',
      error: err instanceof Error ? err.message : String(err),
    });
  }
});

app.post('/mcm/:subsystemId/disconnect', async (req: Request, res: Response) => {
  const subsystemId = String(req.params.subsystemId);
  try {
    const r = await disconnectMcm(subsystemId);
    res.json(r);
  } catch (err) {
    res.status(500).json({ success: false, error: err instanceof Error ? err.message : String(err) });
  }
});

app.post('/mcm/:subsystemId/dispose', async (req: Request, res: Response) => {
  const subsystemId = String(req.params.subsystemId);
  try {
    await disposeMcm(subsystemId);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err instanceof Error ? err.message : String(err) });
  }
});

app.get('/mcm/:subsystemId/status', (req: Request, res: Response) => {
  res.json(getMcmStatus(String(req.params.subsystemId)));
});

app.get('/mcm/:subsystemId/tags', (req: Request, res: Response) => {
  res.json(getMcmTags(String(req.params.subsystemId)));
});

// ── Per-IO single-bit write/read ──────────────────────────────────────────────
app.post('/mcm/:subsystemId/io/write', (req: Request, res: Response) => {
  const subsystemId = String(req.params.subsystemId);
  const { io, value } = req.body ?? {};
  if (!io || typeof io.name !== 'string') {
    return res.status(400).json({ connected: false, success: false, error: 'io.name is required' });
  }
  res.json(writeOutputBitForMcm(subsystemId, io, value));
});

app.post('/mcm/:subsystemId/io/read', (req: Request, res: Response) => {
  const subsystemId = String(req.params.subsystemId);
  const { io } = req.body ?? {};
  if (!io || typeof io.name !== 'string') {
    return res.status(400).json({ connected: false, success: false, error: 'io.name is required' });
  }
  res.json(readOutputBitForMcm(subsystemId, io));
});

// ── Startup ───────────────────────────────────────────────────────────────────
const server = app.listen(PORT, HOST, () => {
  console.log('');
  console.log('plc-gateway - Centralized PLC connection service');
  console.log(`  Control API: http://${HOST}:${PORT}`);
  console.log(`  Broadcasts to: ${process.env.WS_BROADCAST_URL || 'http://localhost:3102/broadcast'}`);
  console.log(`  Version: ${VERSION}`);
  console.log('');
});

server.on('error', (err: any) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[plc-gateway] FATAL: port ${PORT} already in use`);
    process.exit(1);
  }
  console.error('[plc-gateway] server error:', err);
});

// ── Graceful shutdown ──────────────────────────────────────────────────────────
// We intentionally do NOT disconnect MCMs here — the gateway only stops when its
// own image is being replaced (rare), and libplctag handles handle cleanup on
// process exit. Closing the HTTP server is enough to stop accepting control RPCs.
let shuttingDown = false;
function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[plc-gateway] ${signal} — shutting down control API`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

process.on('uncaughtException', (err) => {
  console.error('[plc-gateway] FATAL uncaughtException:', err);
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  console.error('[plc-gateway] FATAL unhandledRejection:', reason);
  process.exit(1);
});
