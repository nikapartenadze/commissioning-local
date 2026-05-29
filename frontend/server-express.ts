#!/usr/bin/env node

/**
 * Production Server (Express + Vite static)
 *
 * Replaces server.js for the Vite-based build. No Next.js dependency.
 *
 * Architecture:
 * Tablets/Laptops → http://SERVER_IP:3000     → Express (API routes + static files)
 * Browser JS      → ws://SERVER_IP:3000/ws    → PLC WebSocket (real-time tag states)
 * Internal only   → http://127.0.0.1:3102     → Broadcast API (API routes push here)
 */

// MUST BE FIRST. Loads .env into process.env before any other module
// (especially db-sqlite via routes) reads DATABASE_URL etc.
import '@/lib/load-env';

import { createServer, IncomingMessage, ServerResponse } from 'http';
import { parse } from 'url';
import path from 'path';
import fs from 'fs';
import express from 'express';
import WebSocket, { WebSocketServer } from 'ws';
import { createApiRouter } from './routes';
import { resolveLogsDirPath } from '@/lib/storage-paths';
import { getPlcTags, connectPlc, loadPlcTags } from '@/lib/plc-client-manager';
import { configService } from '@/lib/config';
import { db } from '@/lib/db-sqlite';
import { reconcileUpdateStateOnBoot } from '@/lib/update/update-utils';
import { getAppVersion } from '@/lib/app-version';

// Resolved once at startup. Rides every HeartbeatAck so the browser can detect
// a server upgrade (version differs across a reconnect) and full-reload to pick
// up new client assets. NEXT_PUBLIC_BUILD_HASH is honoured if set (it never is
// in current builds), otherwise this falls back to package.json version.
const SERVER_VERSION = process.env.NEXT_PUBLIC_BUILD_HASH || getAppVersion();

// Startup backup is deferred to after server starts listening (see httpServer.listen callback)

const PORT = parseInt(process.env.PORT || '3000', 10);
const WS_PORT = parseInt(process.env.PLC_WS_PORT || '3002', 10);
const HOSTNAME = process.env.HOSTNAME || '0.0.0.0';

// ============================================================================
// Production Logging — clean console + detailed file logs
// ============================================================================

// Keep logs beside the active database/config storage root.
const LOG_DIR = resolveLogsDirPath();
const LOG_FILE = path.join(LOG_DIR, 'app.log');
const ERROR_FILE = path.join(LOG_DIR, 'errors.log');
const MAX_LOG_SIZE = 10 * 1024 * 1024; // 10MB

try { if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true }); } catch {}

const MAX_LOG_FILES = 3; // Keep at most 3 rotated files per type (30MB total max)

function logTimestamp(): string { return new Date().toISOString().replace('T', ' ').substring(0, 19); }

function cleanupOldLogs(baseName: string): void {
  try {
    const dir = path.dirname(baseName);
    const ext = path.extname(baseName);
    const name = path.basename(baseName, ext);
    const rotated = fs.readdirSync(dir)
      .filter(f => f.startsWith(name + '.') && f.endsWith(ext) && f !== path.basename(baseName))
      .sort()
      .reverse();
    for (let i = MAX_LOG_FILES; i < rotated.length; i++) {
      try { fs.unlinkSync(path.join(dir, rotated[i])); } catch {}
    }
  } catch {}
}

function appendLog(file: string, line: string): void {
  try {
    if (fs.existsSync(file) && fs.statSync(file).size > MAX_LOG_SIZE) {
      fs.renameSync(file, file.replace('.log', `.${Date.now()}.log`));
      cleanupOldLogs(file);
    }
    fs.appendFileSync(file, line + '\n');
  } catch {}
}

// Messages matching these patterns go to CONSOLE + file (user-facing)
const CONSOLE_PATTERNS = [
  /Commissioning Tool/,
  /Ready in \d+ms/,
  /Starting Next\.js/,
  /Background auto-sync started/,
  /Shutting down/,
  /Connection status: (connected|error)/,
  /PLC connected|PLC connection lost|PLC connection failed/,
  /PLC native library/,
  /libplctag.*initialized/,
  /libplctag.*failed/,
  /Pushed \d+ results/,
  /Pushing \d+ pending/,
  /Updated \d+ IOs/,
  /Pulling \d+ IO/,
  /Merged \d+ test results/,
  /Pulled \d+ change request/,
  /Pushed \d+ change request/,
  /CloudSSE.*Connected|CloudSSE.*Disconnected|CloudSSE.*Reconnecting/,
  /Successfully pulled/,
  /Successfully upserted/,
  /Auto-assigned tagType/,
  /Cloud config saved/,
  /CloudPull.*Network/,
  /CloudPull.*EStop/,
  /CloudPull.*Broadcast/,
  /CloudPull.*Starting network/,
  /CloudPull.*Fetching network/,
  /CloudPull.*Pulled \d+ punchlist/,
  /Pull.*Safety/,
  /Configuration saved/,
  /Configuration loaded/,
  /Config file not found/,
  /Tag creation complete/,
  /PLC unreachable/,
  /Testing mode for/,
  /Test recorded for/,
  /User logged in/,
  /Auto-seeded \d+ diagnostic/,
  /ERROR|EADDRINUSE/,
  /\[SHUTDOWN\]/,
  /\[FATAL\]/,
  /\[HEALTH\].*WARNING/,
];

// Messages matching these patterns are FILE-ONLY (noise)
const SUPPRESS_PATTERNS = [
  /\[TagReader\] Tag .* creation returned/,
  /\[TagReader\] Batch \d+/,
  /\[TagReader\] Grouped/,
  /\[TagReader\] Creating \d+ individual/,
  /\[TagReader\] First batch failed/,
  /\[TagReader\] PLC reachable but grouped/,
  /\[TagReader\] waitForStatus/,
  /\[WS\] Broadcast API/,
  /\[WS\] PLC WebSocket server/,
  /\[PlcClientManager\] Creating new/,
  /\[PlcClientManager\] IO \d+/,
  /\[AutoSync\] Push interval/,
  /\[AutoSync\] Stopped/,
  /\[AutoSync\] Push error/,
  /\[AutoSync\] Pull error/,
  /\[AutoSync\] Cleaned up/,
  /no changes detected/,
  /nothing to push/,
  /no IOs from cloud/,
  /no remote URL/,
  /no subsystem/,
  /CloudSync.*updateConfig/,
  /CloudSync.*Configuration after/,
  /CloudPull.*Cloud response/,
  /CloudPull.*IOs extracted/,
  /CloudPull.*Retrieved/,
  /CloudPull.*Ensured subsystem/,
  /CloudPull.*Cleared/,
  /CloudPull.*Failed to update/,
  /Connect API.*Sample tag/,
  /Connect API.*Loaded \d+ tags/,
  /Connect API.*libplctag library status/,
  /IOs API.*Got \d+ tags/,
  /ConfigService.*Watching/,
  /ConfigService.*Stopped watching/,
  /ConfigService.*changed externally/,
  /ConfigService.*Error in change/,
  /ConfigService.*Error starting/,
  /Request error/,
  /prisma:error/,
  /\[DB\] WAL mode/,
  /\[DB\] busy_timeout/,
  /Failed to send to client/,
];

if (process.env.NODE_ENV === 'production') {
  const origLog = console.log.bind(console);
  const origWarn = console.warn.bind(console);
  const origError = console.error.bind(console);

  console.log = (...args: any[]) => {
    const msg = args.map((a: any) => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
    const ts = logTimestamp();
    appendLog(LOG_FILE, `${ts} [INFO]  ${msg}`);
    if (SUPPRESS_PATTERNS.some(p => p.test(msg))) return; // file only
    if (CONSOLE_PATTERNS.some(p => p.test(msg))) { origLog(msg); return; }
    // Default: suppress in production (file only)
  };

  console.warn = (...args: any[]) => {
    const msg = args.map((a: any) => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
    const ts = logTimestamp();
    appendLog(LOG_FILE, `${ts} [WARN]  ${msg}`);
    appendLog(ERROR_FILE, `${ts} [WARN]  ${msg}`);
    if (SUPPRESS_PATTERNS.some(p => p.test(msg))) return;
    origWarn(`⚠ ${msg}`);
  };

  console.error = (...args: any[]) => {
    const msg = args.map((a: any) => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
    const ts = logTimestamp();
    appendLog(LOG_FILE, `${ts} [ERROR] ${msg}`);
    appendLog(ERROR_FILE, `${ts} [ERROR] ${msg}`);
    if (SUPPRESS_PATTERNS.some(p => p.test(msg))) return;
    origError(`✗ ${msg}`);
  };
}

// ============================================================================
// Startup Banner
// ============================================================================

console.log('');
console.log('Commissioning Tool - Production Server');
console.log('');
console.log(`  App + WebSocket: http://${HOSTNAME}:${PORT} (ws upgrades on /ws)`);
console.log('');

// Log startup diagnostics to file for crash investigation
const startupInfo = [
  `[STARTUP] Server starting at ${new Date().toISOString()}`,
  `[STARTUP] Node.js ${process.version}, pid: ${process.pid}, platform: ${process.platform} ${process.arch}`,
  `[STARTUP] PORT=${PORT}, HOSTNAME=${HOSTNAME}, NODE_ENV=${process.env.NODE_ENV || 'undefined'}`,
  `[STARTUP] Memory: ${Math.round(process.memoryUsage().rss / 1024 / 1024)}MB RSS`,
  `[STARTUP] Log dir: ${LOG_DIR}`,
];
startupInfo.forEach(line => appendLog(LOG_FILE, `${logTimestamp()} ${line}`));

// ============================================================================
// PLC WebSocket Server (noServer mode — attached to main HTTP server)
// ============================================================================

const plcWss = new WebSocketServer({ noServer: true });
const plcClients = new Set<AliveWebSocket>();

// Extend WebSocket type for isAlive tracking and per-MCM subscription state.
interface AliveWebSocket extends WebSocket {
  isAlive: boolean;
  /**
   * Set of subsystemIds this client is interested in. `undefined` means
   * "subscribed to everything" (legacy/default behavior — required for the
   * existing commissioning UI which never sends a Subscribe frame).
   *
   * Central-tool clients SEND `{ type: 'Subscribe', subsystemIds: [...] }`
   * after connect to opt into filtered delivery.
   */
  subscribedSubsystemIds?: Set<string>;
}

/**
 * Should a broadcast message reach this client? Honors per-client subscription.
 * Messages without a `subsystemId` field are global (config reload, library
 * errors, etc.) and always pass.
 */
function shouldDeliver(message: any, ws: AliveWebSocket): boolean {
  // No subscription set → legacy client, receive everything.
  if (!ws.subscribedSubsystemIds) return true;
  // Global event (no subsystemId on the payload) → always pass.
  if (message == null || typeof message !== 'object') return true;
  const sid = message.subsystemId;
  if (sid === undefined || sid === null || sid === '') return true;
  return ws.subscribedSubsystemIds.has(String(sid));
}

// ============================================================================
// Broadcast HTTP API (internal, port WS_PORT + 100)
// ============================================================================

const HTTP_PORT = WS_PORT + 100;
const broadcastHttpServer = createServer((req: IncomingMessage, res: ServerResponse) => {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method === 'POST' && req.url === '/broadcast') {
    let body = '';
    req.on('data', (chunk: Buffer) => {
      body += chunk;
      if (body.length > 1048576) {
        res.writeHead(413);
        res.end('Payload too large');
        req.destroy();
        return;
      }
    });
    req.on('end', () => {
      try {
        const message = JSON.parse(body);
        const data = JSON.stringify(message);
        let sent = 0;
        let filtered = 0;
        plcClients.forEach((ws) => {
          if (ws.readyState !== WebSocket.OPEN) return;
          if (!shouldDeliver(message, ws)) {
            filtered++;
            return;
          }
          try {
            ws.send(data);
            sent++;
          } catch (err: any) {
            console.error('[WS] Failed to send to client, removing:', err.message);
            plcClients.delete(ws);
            try { ws.terminate(); } catch { /* ignore */ }
          }
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, clientsNotified: sent, filtered }));
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON' }));
      }
    });
    return;
  }

  if (req.method === 'GET' && req.url === '/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ clients: plcClients.size, wsPort: PORT }));
    return;
  }

  res.writeHead(404);
  res.end();
});

broadcastHttpServer.on('error', (err: any) => {
  if (err.code === 'EADDRINUSE') {
    console.warn(`[WS] Broadcast port ${HTTP_PORT} in use, retrying in 2s...`);
    setTimeout(() => broadcastHttpServer.listen(HTTP_PORT, '127.0.0.1'), 2000);
  } else {
    console.error('[WS] Broadcast server error:', err);
  }
});
broadcastHttpServer.listen(HTTP_PORT, '127.0.0.1', () => {
  console.log(`[WS] Broadcast API on http://127.0.0.1:${HTTP_PORT}/broadcast`);
});

// ============================================================================
// WebSocket connection handling
// ============================================================================

plcWss.on('connection', (ws: AliveWebSocket) => {
  plcClients.add(ws);
  ws.isAlive = true;

  // ─────────────────────────────────────────────────────────────────────────
  // Send a snapshot of every currently-known tag state immediately on
  // connect. Without this, a browser that opens its WebSocket *after*
  // the PLC's bits stabilized never sees those bits' values — the tag
  // reader only emits on TRANSITIONS, so a tag that is stably TRUE
  // since before the page loaded never broadcasts. The race is most
  // visible right after a "Connect to PLC" + page reload sequence
  // (tags register over a few seconds; the page's GET /api/ios fires
  // before they're all populated and gets back state=null), and any
  // subsequent /api/ios re-fetch alone doesn't help because tags that
  // are stable continue to be stable — they never get re-broadcast.
  //
  // The snapshot fires as a one-shot "TagSnapshot" message that the
  // browser-side websocket-client.ts fans out to its existing
  // per-IO state callbacks (no page-level changes needed).
  // ─────────────────────────────────────────────────────────────────────────
  try {
    const { tags } = getPlcTags();
    const states = tags
      .filter((t) => t.id >= 0 && t.state !== undefined && t.state !== null)
      .map((t) => ({ id: t.id, state: t.state === 'TRUE' }));
    if (states.length > 0) {
      ws.send(JSON.stringify({
        type: 'TagSnapshot',
        states,
        count: states.length,
      }));
    }
  } catch (err) {
    // Don't fail the connection if snapshot fails; the client will
    // still receive subsequent change events.
    console.warn('[WS] Failed to send tag snapshot on connect:', err);
  }

  ws.on('message', (data: WebSocket.Data) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'Heartbeat') {
        ws.send(JSON.stringify({
          type: 'HeartbeatAck',
          serverVersion: SERVER_VERSION,
          timestamp: Date.now()
        }));
        return;
      }
      // central-tool: client subscribes to a specific set of MCMs.
      // { type: 'Subscribe', subsystemIds: ['37','41'] } → filter
      // { type: 'Subscribe', subsystemIds: ['*'] }       → receive everything
      // { type: 'Unsubscribe' }                          → revert to legacy "everything"
      if (msg.type === 'Subscribe' && Array.isArray(msg.subsystemIds)) {
        const ids = msg.subsystemIds.map((x: unknown) => String(x)).filter(Boolean);
        if (ids.includes('*')) {
          ws.subscribedSubsystemIds = undefined; // receive everything
        } else {
          ws.subscribedSubsystemIds = new Set(ids);
        }
        ws.send(JSON.stringify({
          type: 'SubscribeAck',
          subsystemIds: Array.from(ws.subscribedSubsystemIds ?? ['*']),
        }));
        return;
      }
      if (msg.type === 'Unsubscribe') {
        ws.subscribedSubsystemIds = undefined;
        ws.send(JSON.stringify({ type: 'SubscribeAck', subsystemIds: ['*'] }));
        return;
      }
    } catch {}
  });
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('close', () => { plcClients.delete(ws); });
  ws.on('error', () => { plcClients.delete(ws); });
});

// Heartbeat — terminate dead connections every 30s
setInterval(() => {
  plcWss.clients.forEach((ws: WebSocket) => {
    const aws = ws as AliveWebSocket;
    if (aws.isAlive === false) { plcClients.delete(aws); return ws.terminate(); }
    aws.isAlive = false;
    ws.ping();
  });
}, 30000);

// ============================================================================
// Express App — API routes + static file serving
// ============================================================================

const app = express();

// Trust X-Forwarded-For from loopback proxies only. Lets noTestingOnServerLaptop
// see the real client IP when the request arrives through Vite dev proxy or a
// future local reverse proxy (IIS, etc). Direct LAN connections to :3000 are
// unaffected — Express still uses the socket remote address there.
app.set('trust proxy', 'loopback');

// JSON body parsing with 10mb limit
app.use(express.json({ limit: '10mb' }));

// Request logging — log slow/failed API requests for crash investigation
app.use((req, res, next) => {
  if (!req.path.startsWith('/api/')) return next();
  const start = Date.now();
  const originalEnd = res.end;
  res.end = function (...args: any[]) {
    const duration = Date.now() - start;
    const status = res.statusCode;
    // Log errors and slow requests (>5s) to file for crash investigation
    if (status >= 500) {
      console.error(`[API] ${req.method} ${req.path} → ${status} (${duration}ms)`);
    } else if (duration > 5000) {
      console.warn(`[API] SLOW ${req.method} ${req.path} → ${status} (${duration}ms)`);
    }
    return originalEnd.apply(res, args);
  } as any;
  next();
});

// Mount all API routes
app.use(createApiRouter());

// Serve static files from Vite build output
const distPath = path.join(__dirname, 'dist');
app.use(express.static(distPath));

// SPA fallback — serve index.html for all non-API, non-file routes
app.get('/{*splat}', (req, res) => {
  // Don't serve index.html for API routes that weren't matched
  if (req.path.startsWith('/api/')) {
    res.status(404).json({ error: 'Not found' });
    return;
  }
  const indexPath = path.join(distPath, 'index.html');
  if (fs.existsSync(indexPath)) {
    res.sendFile(indexPath);
  } else {
    res.status(503).send('Application not built yet. Run: npm run build');
  }
});

// ============================================================================
// HTTP Server + WebSocket Upgrade Handler
// ============================================================================

const httpServer = createServer(app);

httpServer.on('error', (err: any) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[Server] FATAL: Port ${PORT} is already in use. Another instance running?`);
    appendLog(ERROR_FILE, `${logTimestamp()} [FATAL] Port ${PORT} EADDRINUSE — server cannot start`);
    process.exit(1);
  }
  console.error('[Server] HTTP server error:', err);
  appendLog(ERROR_FILE, `${logTimestamp()} [ERROR] HTTP server error: ${err.message || err}`);
});

httpServer.on('upgrade', (req, socket, head) => {
  const { pathname } = parse(req.url || '');
  if (pathname === '/ws') {
    plcWss.handleUpgrade(req, socket, head, (ws: WebSocket) => {
      plcWss.emit('connection', ws, req);
    });
  } else {
    socket.destroy();
  }
});

httpServer.listen(PORT, HOSTNAME, () => {
  console.log(`[App] Ready on http://${HOSTNAME}:${PORT}`);
  console.log(`[WS] PLC WebSocket available at ws://${HOSTNAME}:${PORT}/ws`);

  // Heal a poisoned update-status.json left behind by an interrupted update.
  // A successful self-update restarts us into the new build with a non-terminal
  // status still on disk; reconciliation stamps it success (running ≥ target)
  // or error (still on the old build) so the fleet UI reflects reality and the
  // channel isn't stuck on "Updating…". Cheap sync file op — safe inline.
  reconcileUpdateStateOnBoot();

  // Deferred startup backup — runs after server is listening so it doesn't block startup
  setTimeout(() => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { createStartupBackup } = require('./lib/startup-backup');
      createStartupBackup();
    } catch (e: any) {
      console.error('[Backup] Startup backup module failed:', e.message);
    }
  }, 0);
});

// ============================================================================
// Automatic Background Sync
// ============================================================================

// Start auto-sync after a delay to let server fully initialize
setTimeout(async () => {
  try {
    const resp = await fetch(`http://localhost:${PORT}/api/cloud/auto-sync`, { method: 'POST' });
    if (resp.ok) {
      console.log('[Server] Background auto-sync started');
    } else {
      console.warn(`[Server] Auto-sync startup returned ${resp.status}`);
    }
  } catch (e: any) {
    console.warn('[Server] Auto-sync startup failed:', e.message);
  }
}, 8000);

// ============================================================================
// Boot-time PLC auto-connect
// ============================================================================
// On PC reboot / Windows service restart / crash recovery, the in-memory PLC
// connectionConfig is gone. The PlcClient's scheduleReconnect only fires while
// the process is alive, so without this hook the operator has to click Connect
// again every time the machine starts. Guards:
//
//   1. config.subsystemId must equal config.lastConnectedSubsystemId — the
//      last-known-good was for the currently-loaded IO set. Without this guard
//      a tablet that drove away from Site A could auto-connect to Site B's PLC
//      at the same IP and start broadcasting bits to the wrong controller.
//   2. SQLite must hold IOs. Without them there is nothing to bind to, and the
//      PlcClient would just count failed tags and not reconnect anyway.
//   3. First attempt is fire-and-forget. Subsequent failures route through the
//      same in-process scheduleReconnect that handles live disconnects.

async function tryBootAutoConnect(): Promise<void> {
  try {
    const cfg = await configService.getConfig();
    if (!cfg.ip || !cfg.path || !cfg.subsystemId) {
      console.log('[Boot AutoConnect] Skipped: PLC config incomplete');
      return;
    }
    // ── Upgrade migration ────────────────────────────────────────
    // Tablets that ran a pre-auto-connect build have ip+path+subsystemId
    // already wired up but no lastConnectedSubsystemId (the field didn't
    // exist yet). Without this seed, every tablet upgraded from the old
    // build would skip auto-connect on the very first boot and force the
    // operator to click Connect — defeating the "stays connected through
    // restarts" property the new version promises. Safe because:
    //   - SQLite IOs were pulled for the active subsystemId
    //   - if the PLC at the saved IP/path doesn't match (tablet moved
    //     sites between the old build and now), client.connect() still
    //     bails on 0/N tags exactly the same way as a wrong-PLC case.
    let lastConnectedSubsystemId = cfg.lastConnectedSubsystemId;
    if (!lastConnectedSubsystemId) {
      try {
        await configService.saveConfig({ lastConnectedSubsystemId: cfg.subsystemId });
        lastConnectedSubsystemId = cfg.subsystemId;
        console.log(`[Boot AutoConnect] Migration: seeded lastConnectedSubsystemId=${cfg.subsystemId} from existing config`);
      } catch (err) {
        console.warn('[Boot AutoConnect] Migration seed failed, skipping auto-connect:', err);
        return;
      }
    }
    if (lastConnectedSubsystemId !== cfg.subsystemId) {
      console.log(`[Boot AutoConnect] Skipped: subsystem mismatch (active=${cfg.subsystemId}, last connected=${lastConnectedSubsystemId}) — operator must pick MCM in the UI`);
      return;
    }

    interface IoRow { id: number; Name: string | null; Description: string | null; TagType: string | null; }
    const ios = db.prepare('SELECT id, Name, Description, TagType FROM Ios').all() as IoRow[];
    if (ios.length === 0) {
      console.log('[Boot AutoConnect] Skipped: no IOs in local SQLite — pull from cloud first');
      return;
    }

    const tags = ios.map((io) => ({
      id: io.id,
      name: io.Name || '',
      description: io.Description || undefined,
      tagType: io.TagType || undefined,
    }));
    loadPlcTags(tags);
    console.log(`[Boot AutoConnect] Connecting to PLC at ${cfg.ip} (path ${cfg.path}) with ${tags.length} tags for subsystem ${cfg.subsystemId}…`);

    const result = await connectPlc({ ip: cfg.ip, path: cfg.path });
    if (result.success) {
      console.log(`[Boot AutoConnect] Connected — ${result.tagsSuccessful ?? 0} tags ok, ${result.tagsFailed ?? 0} failed`);
    } else {
      console.warn(`[Boot AutoConnect] First attempt failed: ${result.error || 'unknown'}. PlcClient will retry in the background.`);
    }
  } catch (err) {
    console.warn('[Boot AutoConnect] Unexpected error:', err instanceof Error ? err.message : err);
  }
}

setTimeout(() => { void tryBootAutoConnect(); }, 5000);

// ============================================================================
// Graceful Shutdown & Crash Protection
// ============================================================================

let isShuttingDown = false;

function shutdown(signal: string): void {
  if (isShuttingDown) return; // prevent double-shutdown
  isShuttingDown = true;

  const ts = logTimestamp();
  const msg = `[SHUTDOWN] Server stopping — signal: ${signal} (pid: ${process.pid}, uptime: ${Math.floor(process.uptime())}s)`;
  console.log(msg);
  // Ensure it's in the log file even if console.log filtering hides it
  appendLog(LOG_FILE, `${ts} ${msg}`);

  // Stop auto-sync (best-effort, don't block shutdown)
  fetch(`http://localhost:${PORT}/api/cloud/auto-sync`, { method: 'DELETE' }).catch(() => {});
  plcWss.close();
  broadcastHttpServer.close();
  httpServer.close(() => {
    appendLog(LOG_FILE, `${logTimestamp()} [SHUTDOWN] HTTP server closed cleanly`);
    process.exit(0);
  });

  // Force exit after 5 seconds if graceful close hangs
  setTimeout(() => {
    appendLog(LOG_FILE, `${logTimestamp()} [SHUTDOWN] Forced exit after 5s timeout`);
    process.exit(1);
  }, 5000).unref();
}

// Intentional signals (Ctrl+C, kill, Windows service stop)
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// ============================================================================
// Crash Handlers — catch unhandled errors and LOG them before dying
// ============================================================================

process.on('uncaughtException', (err: Error) => {
  const ts = logTimestamp();
  const msg = `[FATAL] Uncaught exception: ${err.message}\n${err.stack || '(no stack)'}`;
  // Write directly to error log — console.error might be intercepted/suppressed
  appendLog(ERROR_FILE, `${ts} ${msg}`);
  appendLog(LOG_FILE, `${ts} ${msg}`);
  // Also print to raw stderr so it shows in the terminal
  process.stderr.write(`\n${ts} ${msg}\n`);
  // Exit with error code — the process is in an unknown state
  process.exit(1);
});

process.on('unhandledRejection', (reason: unknown) => {
  const ts = logTimestamp();
  const errMsg = reason instanceof Error
    ? `${reason.message}\n${reason.stack || '(no stack)'}`
    : String(reason);
  const msg = `[FATAL] Unhandled promise rejection: ${errMsg}`;
  appendLog(ERROR_FILE, `${ts} ${msg}`);
  appendLog(LOG_FILE, `${ts} ${msg}`);
  process.stderr.write(`\n${ts} ${msg}\n`);
  // Exit — unhandled rejections are crashes since Node 15+
  process.exit(1);
});

// Log memory usage periodically to detect leaks leading to crashes
setInterval(() => {
  const mem = process.memoryUsage();
  const heapMB = Math.round(mem.heapUsed / 1024 / 1024);
  const rssMB = Math.round(mem.rss / 1024 / 1024);
  const externalMB = Math.round(mem.external / 1024 / 1024);
  appendLog(LOG_FILE, `${logTimestamp()} [HEALTH] Memory: heap=${heapMB}MB, rss=${rssMB}MB, external=${externalMB}MB, clients=${plcClients.size}, uptime=${Math.floor(process.uptime())}s`);
  // Warn if memory is getting high (> 512MB RSS)
  if (rssMB > 512) {
    const warning = `[HEALTH] HIGH MEMORY WARNING: RSS=${rssMB}MB — possible memory leak`;
    appendLog(ERROR_FILE, `${logTimestamp()} ${warning}`);
    console.warn(warning);
  }
}, 60000); // every 60 seconds
