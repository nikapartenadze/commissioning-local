#!/usr/bin/env node

/**
 * Production Server
 *
 * Starts Next.js standalone server + PLC WebSocket server on a single port.
 * Used by the portable distribution and Docker.
 *
 * Architecture:
 * Tablets/Laptops → http://SERVER_IP:3000  → Next.js (pages + API routes)
 * Browser JS      → ws://SERVER_IP:3000/ws → PLC WebSocket (real-time tag states)
 * Internal only   → http://127.0.0.1:3102  → Broadcast API (API routes push here)
 */

const { createServer } = require('http');
const { parse } = require('url');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const WebSocket = require('ws');

// Back up database on startup (before any writes)
try {
  const { createStartupBackup } = require('./lib/startup-backup');
  createStartupBackup();
} catch (e) {
  console.error('[Backup] Startup backup module failed:', e.message);
}

// Load .env file manually (standalone mode doesn't have Next.js env loader)
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  fs.readFileSync(envPath, 'utf8').split('\n').forEach(line => {
    line = line.trim();
    if (!line || line.startsWith('#')) return;
    const idx = line.indexOf('=');
    if (idx === -1) return;
    const key = line.substring(0, idx).trim();
    const value = line.substring(idx + 1).trim();
    if (!process.env[key]) process.env[key] = value;
  });
}

const PORT = parseInt(process.env.PORT || '3000', 10);
const WS_PORT = parseInt(process.env.PLC_WS_PORT || '3002', 10);
const HOSTNAME = process.env.HOSTNAME || '0.0.0.0';

// ============================================================================
// Production Logging — clean console + detailed file logs
// ============================================================================

// Use ProgramData logs dir if database is there (service install), otherwise app dir (portable)
const dbUrl = process.env.DATABASE_URL || '';
const programDataMatch = dbUrl.match(/file:([A-Z]:\\ProgramData\\[^\\]+)\\/i);
const LOG_DIR = programDataMatch ? path.join(programDataMatch[1], 'logs') : path.join(__dirname, 'logs');
const LOG_FILE = path.join(LOG_DIR, 'app.log');
const ERROR_FILE = path.join(LOG_DIR, 'errors.log');
const MAX_LOG_SIZE = 10 * 1024 * 1024; // 10MB

try { if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true }); } catch {}

const MAX_LOG_FILES = 3; // Keep at most 3 rotated files per type (30MB total max)

function logTimestamp() { return new Date().toISOString().replace('T', ' ').substring(0, 19); }
function cleanupOldLogs(baseName) { try {
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
} catch {} }
function appendLog(file, line) { try {
  if (fs.existsSync(file) && fs.statSync(file).size > MAX_LOG_SIZE) {
    fs.renameSync(file, file.replace('.log', `.${Date.now()}.log`));
    cleanupOldLogs(file);
  }
  fs.appendFileSync(file, line + '\n');
} catch {} }

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

  console.log = (...args) => {
    const msg = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
    const ts = logTimestamp();
    appendLog(LOG_FILE, `${ts} [INFO]  ${msg}`);
    if (SUPPRESS_PATTERNS.some(p => p.test(msg))) return; // file only
    if (CONSOLE_PATTERNS.some(p => p.test(msg))) { origLog(msg); return; }
    // Default: suppress in production (file only)
  };

  console.warn = (...args) => {
    const msg = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
    const ts = logTimestamp();
    appendLog(LOG_FILE, `${ts} [WARN]  ${msg}`);
    appendLog(ERROR_FILE, `${ts} [WARN]  ${msg}`);
    if (SUPPRESS_PATTERNS.some(p => p.test(msg))) return;
    origWarn(`⚠ ${msg}`);
  };

  console.error = (...args) => {
    const msg = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
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

const plcWss = new WebSocket.Server({ noServer: true });
const plcClients = new Set();

// HTTP server for broadcast API (internal, port WS_PORT + 100)
const HTTP_PORT = WS_PORT + 100;
const broadcastHttpServer = createServer((req, res) => {
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
    req.on('data', chunk => {
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
        plcClients.forEach(ws => {
          if (ws.readyState === WebSocket.OPEN) {
            try {
              ws.send(data);
              sent++;
            } catch (err) {
              console.error('[WS] Failed to send to client, removing:', err.message);
              plcClients.delete(ws);
              try { ws.terminate(); } catch { /* ignore */ }
            }
          }
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, clientsNotified: sent }));
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

broadcastHttpServer.listen(HTTP_PORT, '127.0.0.1', () => {
  console.log(`[WS] Broadcast API on http://127.0.0.1:${HTTP_PORT}/broadcast`);
});

plcWss.on('connection', (ws) => {
  plcClients.add(ws);
  ws.isAlive = true;
  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'Heartbeat') {
        ws.send(JSON.stringify({
          type: 'HeartbeatAck',
          serverVersion: process.env.NEXT_PUBLIC_BUILD_HASH || 'unknown',
          timestamp: Date.now()
        }));
      }
    } catch {}
  });
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('close', () => { plcClients.delete(ws); });
  ws.on('error', () => { plcClients.delete(ws); });
});

// Heartbeat
setInterval(() => {
  plcWss.clients.forEach(ws => {
    if (ws.isAlive === false) { plcClients.delete(ws); return ws.terminate(); }
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

// ============================================================================
// Next.js Server + WebSocket Upgrade Handler
// ============================================================================

process.env.PORT = String(PORT);
process.env.HOSTNAME = HOSTNAME;

const standalonePath = path.join(__dirname, 'next-server.js');

if (fs.existsSync(standalonePath)) {
  // Standalone/portable mode: proxy to standalone server + WebSocket upgrade
  const httpProxy = require('http-proxy');
  const INTERNAL_PORT = PORT + 1;
  process.env.PORT = String(INTERNAL_PORT);
  process.env.HOSTNAME = '127.0.0.1';

  // Start standalone Next.js on internal port
  console.log('[App] Starting Next.js standalone server...');
  require(standalonePath);

  // Proxy server on the real port
  const proxy = httpProxy.createProxyServer({ target: `http://127.0.0.1:${INTERNAL_PORT}`, ws: true });
  proxy.on('error', (err, req, res) => {
    if (res.writeHead) { res.writeHead(502); res.end('Next.js not ready'); }
  });

  const mainServer = createServer((req, res) => {
    proxy.web(req, res);
  });

  mainServer.on('upgrade', (req, socket, head) => {
    const { pathname } = parse(req.url);
    if (pathname === '/ws') {
      plcWss.handleUpgrade(req, socket, head, (ws) => plcWss.emit('connection', ws, req));
    } else {
      socket.destroy();
    }
  });

  mainServer.listen(PORT, HOSTNAME, () => {
    console.log(`[App] Ready on http://${HOSTNAME}:${PORT}`);
    console.log(`[WS] PLC WebSocket available at ws://${HOSTNAME}:${PORT}/ws`);
  });
} else {
  // Full install mode: use next package directly
  try {
    const next = require('next');
    const app = next({ dev: false, hostname: HOSTNAME, port: PORT });
    const handle = app.getRequestHandler();

    app.prepare().then(() => {
      const httpServer = createServer(async (req, res) => {
        try {
          await handle(req, res, parse(req.url, true));
        } catch (err) {
          console.error('Request error:', err);
          res.writeHead(500);
          res.end('Internal Server Error');
        }
      });

      httpServer.on('upgrade', (req, socket, head) => {
        const { pathname } = parse(req.url);
        if (pathname === '/ws') {
          plcWss.handleUpgrade(req, socket, head, (ws) => plcWss.emit('connection', ws, req));
        } else {
          socket.destroy();
        }
      });

      httpServer.listen(PORT, HOSTNAME, () => {
        console.log(`[App] Ready on http://${HOSTNAME}:${PORT}`);
        console.log(`[WS] PLC WebSocket available at ws://${HOSTNAME}:${PORT}/ws`);
      });
    });
  } catch (e) {
    console.error('Failed to start Next.js:', e.message);
    process.exit(1);
  }
}

// ============================================================================
// Automatic Background Sync
// ============================================================================

// Start auto-sync after a delay to let Next.js fully initialize
setTimeout(async () => {
  try {
    const resp = await fetch(`http://localhost:${PORT}/api/cloud/auto-sync`, { method: 'POST' });
    if (resp.ok) {
      console.log('[Server] Background auto-sync started');
    } else {
      console.warn(`[Server] Auto-sync startup returned ${resp.status}`);
    }
  } catch (e) {
    console.warn('[Server] Auto-sync startup failed:', e.message);
  }
}, 8000);

// ============================================================================
// Graceful Shutdown & Crash Protection
// ============================================================================

let isShuttingDown = false;

function shutdown(signal) {
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

  // Force exit after 5 seconds if graceful close hangs
  setTimeout(() => {
    appendLog(LOG_FILE, `${logTimestamp()} [SHUTDOWN] Forced exit after 5s timeout`);
    process.exit(1);
  }, 5000).unref();

  process.exit(0);
}

// Intentional signals (Ctrl+C, kill, Windows service stop)
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// ============================================================================
// Crash Handlers — catch unhandled errors and LOG them before dying
// ============================================================================

process.on('uncaughtException', (err) => {
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

process.on('unhandledRejection', (reason) => {
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
