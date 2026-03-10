#!/usr/bin/env node

/**
 * PLC WebSocket Server
 * Runs alongside the Next.js app to provide real-time PLC communication.
 *
 * Features:
 * - WebSocket server on port 3002 for browser connections
 * - HTTP API on port 3102 to receive broadcasts from PLC client
 * - Real-time IO state updates
 */

const WebSocket = require('ws');
const http = require('http');

const WS_PORT = parseInt(process.env.PLC_WS_PORT || '3002', 10);
const HTTP_PORT = WS_PORT + 100; // 3102 for HTTP API

// Create WebSocket server
const wss = new WebSocket.Server({ port: WS_PORT });

console.log(`🔌 PLC WebSocket server listening on ws://localhost:${WS_PORT}`);

// Store connected clients
const clients = new Set();
let heartbeatInterval = null;

// Handle new WebSocket connections
wss.on('connection', (ws) => {
  console.log('🔌 New WebSocket client connected');
  clients.add(ws);

  // Mark connection as alive for heartbeat
  ws.isAlive = true;

  ws.on('pong', () => {
    ws.isAlive = true;
  });

  ws.on('message', (data) => {
    try {
      const message = JSON.parse(data.toString());
      console.log(`📨 Received: ${message.type}`);
    } catch (error) {
      console.error('Error parsing WebSocket message:', error);
    }
  });

  ws.on('close', () => {
    console.log('🔌 WebSocket client disconnected');
    clients.delete(ws);
  });

  ws.on('error', (error) => {
    console.error('WebSocket error:', error.message);
    clients.delete(ws);
  });
});

// Start heartbeat to detect dead connections
heartbeatInterval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) {
      console.log('🔌 Terminating dead connection');
      clients.delete(ws);
      return ws.terminate();
    }
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

/**
 * Broadcast message to all connected clients
 */
function broadcast(message) {
  const data = JSON.stringify(message);
  let sentCount = 0;

  clients.forEach((ws) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(data);
      sentCount++;
    }
  });

  if (sentCount > 0) {
    console.log(`📡 Broadcast ${message.type} to ${sentCount} clients`);
  }
}

// ============================================================================
// HTTP API for receiving broadcasts from PLC client
// ============================================================================

const httpServer = http.createServer((req, res) => {
  // CORS headers for local development
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method === 'POST' && req.url === '/broadcast') {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk.toString();
    });
    req.on('end', () => {
      try {
        const message = JSON.parse(body);
        broadcast(message);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, clientCount: clients.size }));
      } catch (error) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: error.message }));
      }
    });
  } else if (req.method === 'GET' && req.url === '/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      running: true,
      clientCount: clients.size,
      wsPort: WS_PORT,
      httpPort: HTTP_PORT,
    }));
  } else {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not Found' }));
  }
});

httpServer.listen(HTTP_PORT, () => {
  console.log(`📡 HTTP broadcast API listening on http://localhost:${HTTP_PORT}`);
  console.log(`   POST /broadcast - Send a message to all WebSocket clients`);
  console.log(`   GET /status - Get server status`);
});

// Graceful shutdown
function shutdown() {
  console.log('\n🛑 Shutting down PLC WebSocket server...');

  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
    heartbeatInterval = null;
  }

  // Close all client connections
  clients.forEach((ws) => {
    try { ws.close(); } catch (e) { /* ignore */ }
  });
  clients.clear();

  // Close servers
  wss.close(() => {
    console.log('✅ WebSocket server stopped');
    httpServer.close(() => {
      console.log('✅ HTTP server stopped');
      process.exit(0);
    });
  });

  // Force exit after 5 seconds
  setTimeout(() => {
    console.log('⚠️ Force exiting...');
    process.exit(0);
  }, 5000);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
