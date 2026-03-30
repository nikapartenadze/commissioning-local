#!/usr/bin/env node

/**
 * Development Server with WebSocket Integration
 *
 * Runs a single HTTP server on port 3000 that:
 * - Proxies HTTP requests to Next.js dev server (running internally on port 3001)
 * - Handles WebSocket upgrades on /ws for PLC real-time updates
 * - Proxies all other WebSocket upgrades to Next.js (HMR hot reload)
 * - Broadcast HTTP API runs on port 3102 (localhost only)
 *
 * This is the entry point for development mode.
 */

const { spawn } = require('child_process');
const http = require('http');
const WebSocket = require('ws');
const httpProxy = require('http-proxy');
const { createStartupBackup } = require('./lib/startup-backup');

// Back up database before anything else
createStartupBackup();

// Configuration
const NEXTJS_PORT = parseInt(process.env.PORT || '3000', 10);
const NEXTJS_INTERNAL_PORT = NEXTJS_PORT + 1; // 3001 — internal, not exposed
const WS_PORT = parseInt(process.env.PLC_WS_PORT || '3002', 10);
const HTTP_PORT = WS_PORT + 100; // 3102

console.log('='.repeat(60));
console.log('Development Server with WebSocket Integration');
console.log('='.repeat(60));
console.log(`Main server:     http://0.0.0.0:${NEXTJS_PORT} (app + /ws)`);
console.log(`Next.js internal: http://localhost:${NEXTJS_INTERNAL_PORT}`);
console.log(`Broadcast API:   http://127.0.0.1:${HTTP_PORT}`);
console.log('='.repeat(60));

// ============================================================================
// Proxy to Next.js internal server
// ============================================================================

const proxy = httpProxy.createProxyServer({
  target: `http://127.0.0.1:${NEXTJS_INTERNAL_PORT}`,
  ws: true,
});

proxy.on('error', (err, req, res) => {
  // Next.js not ready yet — return 502
  if (res && res.writeHead) {
    res.writeHead(502, { 'Content-Type': 'text/plain' });
    res.end('Next.js dev server not ready yet');
  }
});

// ============================================================================
// PLC WebSocket Server (noServer mode — attached to main HTTP server)
// ============================================================================

const plcWss = new WebSocket.Server({ noServer: true });
const plcClients = new Set();

plcWss.on('connection', (ws) => {
  plcClients.add(ws);
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('close', () => { plcClients.delete(ws); });
  ws.on('error', () => { plcClients.delete(ws); });
});

// Heartbeat
const heartbeatInterval = setInterval(() => {
  plcWss.clients.forEach(ws => {
    if (ws.isAlive === false) { plcClients.delete(ws); return ws.terminate(); }
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

// ============================================================================
// Main HTTP server on port 3000 (proxy to Next.js + WebSocket upgrades)
// ============================================================================

const mainServer = http.createServer((req, res) => {
  proxy.web(req, res);
});

// WebSocket upgrade handling
mainServer.on('upgrade', (req, socket, head) => {
  const url = require('url').parse(req.url);
  if (url.pathname === '/ws') {
    // PLC WebSocket — handle locally
    plcWss.handleUpgrade(req, socket, head, (ws) => {
      plcWss.emit('connection', ws, req);
    });
  } else {
    // Everything else (Next.js HMR /_next/webpack-hmr) — proxy to Next.js
    proxy.ws(req, socket, head);
  }
});

mainServer.listen(NEXTJS_PORT, '0.0.0.0', () => {
  console.log(`[Server] Main server listening on http://0.0.0.0:${NEXTJS_PORT}`);
  console.log(`[WS] PLC WebSocket available at ws://0.0.0.0:${NEXTJS_PORT}/ws`);
});

// ============================================================================
// HTTP broadcast API (localhost only, port 3102)
// ============================================================================

const broadcastHttpServer = http.createServer((req, res) => {
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
    res.end(JSON.stringify({ clients: plcClients.size, wsPort: NEXTJS_PORT }));
    return;
  }

  res.writeHead(404);
  res.end();
});

broadcastHttpServer.listen(HTTP_PORT, '127.0.0.1', () => {
  console.log(`[WS] Broadcast API on http://127.0.0.1:${HTTP_PORT}/broadcast`);
});

// ============================================================================
// Next.js Development Server (child process on internal port)
// ============================================================================

let nextServer = null;

function startNextJs() {
  return new Promise((resolve, reject) => {
    console.log(`[Next.js] Starting development server on internal port ${NEXTJS_INTERNAL_PORT}...`);

    nextServer = spawn('npx', ['next', 'dev', '-H', '0.0.0.0', '-p', NEXTJS_INTERNAL_PORT.toString()], {
      env: {
        ...process.env,
        PORT: NEXTJS_INTERNAL_PORT.toString(),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: true,
    });

    nextServer.stdout.on('data', (data) => {
      const output = data.toString().trim();
      if (output) {
        console.log(`[Next.js] ${output}`);
      }
      if (output.includes('Ready') || output.includes('started')) {
        resolve(nextServer);
      }
    });

    nextServer.stderr.on('data', (data) => {
      const output = data.toString().trim();
      if (output && !output.includes('ExperimentalWarning')) {
        console.error(`[Next.js] ${output}`);
      }
    });

    nextServer.on('error', (error) => {
      console.error('[Next.js] Failed to start:', error);
      reject(error);
    });

    nextServer.on('close', (code) => {
      if (code !== 0 && code !== null) {
        console.error(`[Next.js] Process exited with code ${code}`);
        shutdown();
      }
    });
  });
}

// ============================================================================
// Graceful Shutdown
// ============================================================================

function shutdown() {
  console.log('\nShutting down...');

  // Stop auto-sync
  fetch(`http://localhost:${NEXTJS_PORT}/api/cloud/auto-sync`, { method: 'DELETE' }).catch(() => {});

  clearInterval(heartbeatInterval);

  if (nextServer && !nextServer.killed) {
    try { nextServer.kill('SIGTERM'); } catch (e) { /* ignore */ }
  }

  plcWss.close();
  broadcastHttpServer.close();
  mainServer.close();

  setTimeout(() => {
    console.log('Force exiting...');
    process.exit(0);
  }, 5000);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// Start
async function main() {
  try {
    await startNextJs();

    console.log('='.repeat(60));
    console.log('All servers started successfully');
    console.log(`> App + WebSocket: http://localhost:${NEXTJS_PORT} (ws upgrades on /ws)`);
    console.log(`> Broadcast:       http://127.0.0.1:${HTTP_PORT}/broadcast`);
    console.log('='.repeat(60));
    console.log('Press Ctrl+C to stop all servers');

    // Start auto-sync (SSE + background push/pull) after Next.js is ready
    setTimeout(async () => {
      try {
        const resp = await fetch(`http://localhost:${NEXTJS_PORT}/api/cloud/auto-sync`, { method: 'POST' });
        if (resp.ok) {
          console.log('[Server] Background auto-sync started');
        }
      } catch {}
    }, 8000);

  } catch (error) {
    console.error('Failed to start servers:', error);
    shutdown();
    process.exit(1);
  }
}

main();
