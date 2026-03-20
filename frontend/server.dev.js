#!/usr/bin/env node

/**
 * Development Server with WebSocket Integration
 *
 * Starts both Next.js dev server and the PLC WebSocket server in-process.
 * - Next.js runs on port 3000 (same as production)
 * - WebSocket server runs on port 3002
 * - Broadcast HTTP API runs on port 3102 (localhost only)
 *
 * This is the entry point for development mode.
 */

const { spawn } = require('child_process');
const http = require('http');
const WebSocket = require('ws');

// Configuration
const NEXTJS_PORT = parseInt(process.env.PORT || '3000', 10);
const WS_PORT = parseInt(process.env.PLC_WS_PORT || '3002', 10);
const HTTP_PORT = WS_PORT + 100; // 3102

console.log('='.repeat(60));
console.log('Development Server with WebSocket Integration');
console.log('='.repeat(60));
console.log(`Next.js port: ${NEXTJS_PORT}`);
console.log(`WebSocket port: ${WS_PORT}`);
console.log(`Broadcast API port: ${HTTP_PORT}`);
console.log('='.repeat(60));

// ============================================================================
// PLC WebSocket Server (in-process)
// ============================================================================

const plcWss = new WebSocket.Server({ port: WS_PORT, host: '0.0.0.0' });
const plcClients = new Set();

plcWss.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[WS] ERROR: Port ${WS_PORT} is already in use.`);
    process.exit(1);
  }
  console.error('[WS] WebSocket server error:', err);
});

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

console.log(`[WS] PLC WebSocket server on ws://0.0.0.0:${WS_PORT}`);

// HTTP broadcast API (localhost only)
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
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const message = JSON.parse(body);
        const data = JSON.stringify(message);
        let sent = 0;
        plcClients.forEach(ws => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(data);
            sent++;
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
    res.end(JSON.stringify({ clients: plcClients.size, wsPort: WS_PORT }));
    return;
  }

  res.writeHead(404);
  res.end();
});

broadcastHttpServer.listen(HTTP_PORT, '127.0.0.1', () => {
  console.log(`[WS] Broadcast API on http://127.0.0.1:${HTTP_PORT}/broadcast`);
});

// ============================================================================
// Next.js Development Server (child process)
// ============================================================================

let nextServer = null;

function startNextJs() {
  return new Promise((resolve, reject) => {
    console.log('[Next.js] Starting development server...');

    nextServer = spawn('npx', ['next', 'dev', '-H', '0.0.0.0', '-p', NEXTJS_PORT.toString()], {
      env: {
        ...process.env,
        PORT: NEXTJS_PORT.toString(),
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

  clearInterval(heartbeatInterval);

  if (nextServer && !nextServer.killed) {
    try { nextServer.kill('SIGTERM'); } catch (e) { /* ignore */ }
  }

  plcWss.close();
  broadcastHttpServer.close();

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
    console.log(`> Next.js:   http://localhost:${NEXTJS_PORT}`);
    console.log(`> WebSocket: ws://localhost:${WS_PORT}`);
    console.log(`> Broadcast: http://127.0.0.1:${HTTP_PORT}/broadcast`);
    console.log('='.repeat(60));
    console.log('Press Ctrl+C to stop all servers');
  } catch (error) {
    console.error('Failed to start servers:', error);
    shutdown();
    process.exit(1);
  }
}

main();
