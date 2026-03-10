#!/usr/bin/env node

/**
 * Development Server with WebSocket Integration
 *
 * Starts both Next.js dev server and the PLC WebSocket server.
 * - Next.js runs on port 3020 (development)
 * - WebSocket server runs on port 3002
 *
 * This is the entry point for development mode.
 */

const { spawn } = require('child_process');
const path = require('path');

// Configuration
const NEXTJS_PORT = parseInt(process.env.PORT || '3020', 10);
const WS_PORT = parseInt(process.env.PLC_WS_PORT || '3002', 10);

console.log('='.repeat(60));
console.log('Development Server with WebSocket Integration');
console.log('='.repeat(60));
console.log(`Next.js port: ${NEXTJS_PORT}`);
console.log(`WebSocket port: ${WS_PORT}`);
console.log('='.repeat(60));

// Track child processes for cleanup
const childProcesses = [];

/**
 * Start the WebSocket server
 */
function startWebSocketServer() {
  return new Promise((resolve, reject) => {
    console.log('[WebSocket] Starting PLC WebSocket server...');

    const wsServer = spawn('node', [
      path.join(__dirname, 'scripts', 'plc-websocket-server.js')
    ], {
      env: {
        ...process.env,
        PLC_WS_PORT: WS_PORT.toString(),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    childProcesses.push(wsServer);

    wsServer.stdout.on('data', (data) => {
      const output = data.toString().trim();
      console.log(`[WebSocket] ${output}`);
      if (output.includes('listening')) {
        resolve(wsServer);
      }
    });

    wsServer.stderr.on('data', (data) => {
      console.error(`[WebSocket Error] ${data.toString().trim()}`);
    });

    wsServer.on('error', (error) => {
      console.error('[WebSocket] Failed to start:', error);
      reject(error);
    });

    wsServer.on('close', (code) => {
      if (code !== 0 && code !== null) {
        console.error(`[WebSocket] Process exited with code ${code}`);
      }
    });

    // Resolve after a short delay if no listening message is received
    setTimeout(() => resolve(wsServer), 2000);
  });
}

/**
 * Start Next.js development server
 */
function startNextJs() {
  return new Promise((resolve, reject) => {
    console.log('[Next.js] Starting development server...');

    const nextServer = spawn('npx', ['next', 'dev', '-H', '0.0.0.0', '-p', NEXTJS_PORT.toString()], {
      env: {
        ...process.env,
        PORT: NEXTJS_PORT.toString(),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: true,
    });

    childProcesses.push(nextServer);

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
      // Next.js outputs some info to stderr
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
        // If Next.js exits, shut down everything
        shutdown();
      }
    });
  });
}

/**
 * Graceful shutdown of all processes
 */
function shutdown() {
  console.log('\nShutting down servers...');

  childProcesses.forEach((proc) => {
    if (proc && !proc.killed) {
      try {
        proc.kill('SIGTERM');
      } catch (e) {
        // Ignore errors during shutdown
      }
    }
  });

  // Force exit after 5 seconds
  setTimeout(() => {
    console.log('Force exiting...');
    process.exit(0);
  }, 5000);
}

// Handle termination signals
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// Start both servers
async function main() {
  try {
    // Start WebSocket server first
    await startWebSocketServer();
    console.log(`[WebSocket] Server ready on ws://localhost:${WS_PORT}`);

    // Start Next.js
    await startNextJs();

    console.log('='.repeat(60));
    console.log('All servers started successfully');
    console.log(`> Next.js:   http://localhost:${NEXTJS_PORT}`);
    console.log(`> WebSocket: ws://localhost:${WS_PORT}`);
    console.log('='.repeat(60));
    console.log('Press Ctrl+C to stop all servers');
  } catch (error) {
    console.error('Failed to start servers:', error);
    shutdown();
    process.exit(1);
  }
}

main();
