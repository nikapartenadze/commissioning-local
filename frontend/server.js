/**
 * Custom server that wraps Next.js standalone output.
 * Provides WebSocket proxy for SignalR so only port 3000 needs to be exposed.
 *
 * Architecture:
 * Phone/Browser → :3000 (this server) → Next.js (internal) for pages/API
 *                                     → Backend :5000 for SignalR /hub
 */

const { createServer } = require('http');
const { parse } = require('url');
const httpProxy = require('http-proxy');
const path = require('path');

// Start the Next.js standalone server on internal port
const NEXT_PORT = 3001;
const EXTERNAL_PORT = parseInt(process.env.PORT || '3000', 10);
const HOSTNAME = process.env.HOSTNAME || '0.0.0.0';
const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:5000';

console.log('='.repeat(60));
console.log('Custom Server with SignalR Proxy');
console.log('='.repeat(60));
console.log(`External port: ${EXTERNAL_PORT}`);
console.log(`Next.js internal port: ${NEXT_PORT}`);
console.log(`Backend URL (SignalR): ${BACKEND_URL}`);
console.log('='.repeat(60));

// Create proxy for WebSocket connections to backend
const wsProxy = httpProxy.createProxyServer({
  target: BACKEND_URL,
  ws: true,
  changeOrigin: true,
});

// Create proxy for Next.js requests
const nextProxy = httpProxy.createProxyServer({
  target: `http://127.0.0.1:${NEXT_PORT}`,
  ws: false,
});

wsProxy.on('error', (err, req, res) => {
  console.error('[SignalR Proxy] Error:', err.message);
  if (res && res.writeHead) {
    res.writeHead(502, { 'Content-Type': 'text/plain' });
    res.end('SignalR proxy error: ' + err.message);
  }
});

nextProxy.on('error', (err, req, res) => {
  console.error('[Next.js Proxy] Error:', err.message);
  if (res && res.writeHead) {
    res.writeHead(502, { 'Content-Type': 'text/plain' });
    res.end('Next.js proxy error: ' + err.message);
  }
});

// Start Next.js standalone server in background
const { spawn } = require('child_process');
// In Docker, we're inside the standalone directory, so server.js is at root
const nextServerPath = path.join(__dirname, 'server.js');
const nextServer = spawn('node', [nextServerPath], {
  env: {
    ...process.env,
    PORT: NEXT_PORT.toString(),
    HOSTNAME: '127.0.0.1',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

nextServer.stdout.on('data', (data) => {
  console.log(`[Next.js] ${data.toString().trim()}`);
});

nextServer.stderr.on('data', (data) => {
  console.error(`[Next.js Error] ${data.toString().trim()}`);
});

nextServer.on('close', (code) => {
  console.error(`[Next.js] Process exited with code ${code}`);
  process.exit(code);
});

// Wait for Next.js to start
const waitForNextJs = () => {
  return new Promise((resolve) => {
    const check = () => {
      const http = require('http');
      const req = http.request({
        host: '127.0.0.1',
        port: NEXT_PORT,
        path: '/',
        method: 'HEAD',
        timeout: 1000,
      }, (res) => {
        resolve();
      });
      req.on('error', () => {
        setTimeout(check, 500);
      });
      req.end();
    };
    check();
  });
};

// Create main server
const server = createServer((req, res) => {
  const parsedUrl = parse(req.url, true);
  const { pathname } = parsedUrl;

  // Proxy SignalR hub requests to backend
  if (pathname.startsWith('/hub')) {
    console.log(`[SignalR HTTP] ${req.method} ${pathname}`);
    wsProxy.web(req, res);
    return;
  }

  // All other requests go to Next.js
  nextProxy.web(req, res);
});

// Handle WebSocket upgrades
server.on('upgrade', (req, socket, head) => {
  const parsedUrl = parse(req.url, true);
  const { pathname } = parsedUrl;

  if (pathname.startsWith('/hub')) {
    console.log(`[SignalR WS] Upgrading WebSocket: ${pathname}`);
    wsProxy.ws(req, socket, head);
  } else {
    // Unknown WebSocket - could be HMR in dev, just destroy
    console.log(`[Unknown WS] Destroying: ${pathname}`);
    socket.destroy();
  }
});

// Start server after Next.js is ready
waitForNextJs().then(() => {
  server.listen(EXTERNAL_PORT, HOSTNAME, () => {
    console.log('='.repeat(60));
    console.log(`> Server ready on http://${HOSTNAME}:${EXTERNAL_PORT}`);
    console.log(`> SignalR proxy: /hub -> ${BACKEND_URL}/hub`);
    console.log(`> All other requests -> Next.js on :${NEXT_PORT}`);
    console.log('='.repeat(60));
  });
});

// Handle process termination
process.on('SIGTERM', () => {
  console.log('Received SIGTERM, shutting down...');
  nextServer.kill();
  server.close();
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('Received SIGINT, shutting down...');
  nextServer.kill();
  server.close();
  process.exit(0);
});
