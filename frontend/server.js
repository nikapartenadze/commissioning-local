#!/usr/bin/env node

/**
 * Production Server
 *
 * Starts Next.js standalone server + PLC WebSocket server on a single machine.
 * Used by the portable distribution and Docker.
 *
 * Architecture:
 * Tablets/Laptops → http://SERVER_IP:3000 → Next.js (pages + API routes)
 * Browser JS      → ws://SERVER_IP:3002  → PLC WebSocket (real-time tag states)
 */

const { createServer } = require('http');
const { parse } = require('url');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const WebSocket = require('ws');

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

console.log('='.repeat(60));
console.log('IO Checkout Tool - Production Server');
console.log('='.repeat(60));
console.log(`App:       http://${HOSTNAME}:${PORT}`);
console.log(`WebSocket: ws://${HOSTNAME}:${WS_PORT}`);
console.log('='.repeat(60));

// ============================================================================
// PLC WebSocket Server (real-time tag state broadcasts)
// ============================================================================

const plcWss = new WebSocket.Server({ port: WS_PORT, host: HOSTNAME });
const plcClients = new Set();

plcWss.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[WS] ERROR: Port ${WS_PORT} is already in use.`);
    console.error(`[WS] Another instance may be running. Stop it first (STOP.bat) or check with STATUS.bat.`);
    process.exit(1);
  }
  console.error('[WS] WebSocket server error:', err);
});

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

plcWss.on('connection', (ws) => {
  plcClients.add(ws);
  ws.isAlive = true;
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

console.log(`[WS] PLC WebSocket server on ws://${HOSTNAME}:${WS_PORT}`);

// ============================================================================
// Next.js Standalone Server
// ============================================================================

// Next.js standalone output includes its own minimal server.
// In portable/standalone mode, the .next directory is at ./.next (same level as this server.js).
// We set env vars so the standalone server uses our desired port/hostname.
process.env.PORT = String(PORT);
process.env.HOSTNAME = HOSTNAME;

// In portable builds, the standalone server.js is saved as next-server.js
const standalonePath = path.join(__dirname, 'next-server.js');

if (fs.existsSync(standalonePath)) {
  // Standalone server handles its own HTTP listener
  console.log(`[App] Starting Next.js standalone server...`);
  require(standalonePath);
} else {
  // Dev/full install: use the next package directly
  try {
    const next = require('next');
    const app = next({ dev: false, hostname: HOSTNAME, port: PORT });
    const handle = app.getRequestHandler();
    app.prepare().then(() => {
      const httpServer = createServer(async (req, res) => {
        try {
          const parsedUrl = parse(req.url, true);
          await handle(req, res, parsedUrl);
        } catch (err) {
          console.error('Request error:', err);
          res.writeHead(500);
          res.end('Internal Server Error');
        }
      });
      httpServer.listen(PORT, HOSTNAME, () => {
        console.log(`[App] Ready on http://${HOSTNAME}:${PORT}`);
      });
    });
  } catch (e) {
    console.error('Failed to start Next.js:', e.message);
    console.error('Make sure to run "npm run build" first');
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
// Graceful Shutdown
// ============================================================================

function shutdown() {
  console.log('\nShutting down...');
  // Stop auto-sync
  fetch(`http://localhost:${PORT}/api/cloud/auto-sync`, { method: 'DELETE' }).catch(() => {});
  plcWss.close();
  broadcastHttpServer.close();
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
