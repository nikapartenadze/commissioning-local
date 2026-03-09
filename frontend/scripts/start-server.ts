#!/usr/bin/env tsx

/**
 * TypeScript Development Server Startup
 *
 * Initializes the PLC client, starts the WebSocket server, and launches Next.js.
 * This script provides a more integrated development experience with full
 * TypeScript support and proper PLC client initialization.
 *
 * Usage: npx tsx scripts/start-server.ts
 */

import { spawn, ChildProcess } from 'child_process';
import path from 'path';
import {
  startPlcWebSocketServer,
  stopPlcWebSocketServer,
  getPlcWebSocketServer,
} from '../lib/plc/websocket-server';
import { createPlcClient, type PlcClient } from '../lib/plc/plc-client';

// Configuration
const NEXTJS_PORT = parseInt(process.env.PORT || '3020', 10);
const WS_PORT = parseInt(process.env.PLC_WS_PORT || '3001', 10);
const PLC_IP = process.env.PLC_IP || '';
const PLC_PATH = process.env.PLC_PATH || '1,0';

console.log('='.repeat(60));
console.log('TypeScript Development Server');
console.log('='.repeat(60));
console.log(`Next.js port: ${NEXTJS_PORT}`);
console.log(`WebSocket port: ${WS_PORT}`);
if (PLC_IP) {
  console.log(`PLC IP: ${PLC_IP}`);
  console.log(`PLC Path: ${PLC_PATH}`);
}
console.log('='.repeat(60));

// Track resources for cleanup
let plcClient: PlcClient | null = null;
let nextProcess: ChildProcess | null = null;
let isShuttingDown = false;

/**
 * Initialize the PLC client (optional, only if PLC_IP is provided)
 */
async function initializePlcClient(): Promise<PlcClient | null> {
  if (!PLC_IP) {
    console.log('[PLC] No PLC_IP provided, skipping PLC initialization');
    console.log('[PLC] Set PLC_IP environment variable to enable PLC communication');
    return null;
  }

  console.log('[PLC] Initializing PLC client...');

  const client = createPlcClient({
    pollIntervalMs: 75,
    autoReconnect: true,
    reconnectIntervalMs: 10000,
  });

  // Set up event handlers
  client.on('connectionStatusChanged', (status) => {
    console.log(`[PLC] Connection status: ${status}`);
  });

  client.on('tagValueChanged', (event) => {
    // Log tag value changes for debugging
    console.log(`[PLC] Tag ${event.name}: ${event.oldValue} -> ${event.newValue}`);
  });

  client.on('ioStateChanged', (io, oldState, newState) => {
    console.log(`[PLC] IO ${io.name} (id=${io.id}): ${oldState} -> ${newState}`);
    // Broadcast state changes to all WebSocket clients
    const wsServer = getPlcWebSocketServer();
    if (wsServer) {
      wsServer.broadcastStateUpdate(io.id, newState === 'TRUE');
    }
  });

  client.on('error', (error) => {
    console.error('[PLC] Error:', error.message);
    // Broadcast error to WebSocket clients
    const wsServer = getPlcWebSocketServer();
    if (wsServer) {
      wsServer.broadcastErrorEvent('plc', error.message, 'error');
    }
  });

  // Attempt to connect
  try {
    const connected = await client.connect({
      ip: PLC_IP,
      path: PLC_PATH,
      timeout: 5000,
    });

    if (connected) {
      console.log('[PLC] Successfully connected');
    } else {
      console.log('[PLC] Connection pending (will auto-reconnect)');
    }
  } catch (error) {
    console.error('[PLC] Initial connection failed:', error);
    console.log('[PLC] Will attempt to reconnect automatically');
  }

  return client;
}

/**
 * Start the WebSocket server using the TypeScript implementation
 */
function startWebSocketServer(): void {
  console.log('[WebSocket] Starting PLC WebSocket server...');

  const server = startPlcWebSocketServer(WS_PORT);

  console.log(`[WebSocket] Server ready on ws://localhost:${WS_PORT}`);
  console.log(`[WebSocket] Clients connected: ${server.getClientCount()}`);
}

/**
 * Start Next.js development server
 */
function startNextJs(): Promise<void> {
  return new Promise((resolve, reject) => {
    console.log('[Next.js] Starting development server...');

    const args = ['next', 'dev', '-p', NEXTJS_PORT.toString()];

    nextProcess = spawn('npx', args, {
      env: {
        ...process.env,
        PORT: NEXTJS_PORT.toString(),
        PLC_WS_PORT: WS_PORT.toString(),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: true,
      cwd: path.join(__dirname, '..'),
    });

    let resolved = false;

    nextProcess.stdout?.on('data', (data: Buffer) => {
      const output = data.toString().trim();
      if (output) {
        // Filter out noisy logs
        const lines = output.split('\n').filter(line =>
          !line.includes('ExperimentalWarning') && line.trim()
        );
        lines.forEach(line => console.log(`[Next.js] ${line}`));
      }
      if (!resolved && (output.includes('Ready') || output.includes('started'))) {
        resolved = true;
        resolve();
      }
    });

    nextProcess.stderr?.on('data', (data: Buffer) => {
      const output = data.toString().trim();
      if (output && !output.includes('ExperimentalWarning')) {
        console.error(`[Next.js] ${output}`);
      }
    });

    nextProcess.on('error', (error) => {
      console.error('[Next.js] Failed to start:', error);
      reject(error);
    });

    nextProcess.on('close', (code) => {
      if (code !== 0 && code !== null && !isShuttingDown) {
        console.error(`[Next.js] Process exited with code ${code}`);
        shutdown();
      }
    });

    // Resolve after timeout if no ready message
    setTimeout(() => {
      if (!resolved) {
        resolved = true;
        resolve();
      }
    }, 15000);
  });
}

/**
 * Graceful shutdown of all resources
 */
async function shutdown(): Promise<void> {
  if (isShuttingDown) return;
  isShuttingDown = true;

  console.log('\nShutting down servers...');

  // Stop PLC client
  if (plcClient) {
    console.log('[PLC] Disconnecting...');
    try {
      await plcClient.disconnect();
      plcClient.dispose();
    } catch (e) {
      // Ignore cleanup errors
    }
    plcClient = null;
  }

  // Stop WebSocket server
  console.log('[WebSocket] Stopping server...');
  stopPlcWebSocketServer();

  // Stop Next.js
  if (nextProcess && !nextProcess.killed) {
    console.log('[Next.js] Stopping server...');
    try {
      nextProcess.kill('SIGTERM');
    } catch (e) {
      // Ignore
    }
  }

  console.log('Shutdown complete');

  // Force exit after delay
  setTimeout(() => {
    process.exit(0);
  }, 2000);
}

// Handle termination signals
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
process.on('uncaughtException', (error) => {
  console.error('Uncaught exception:', error);
  shutdown();
});
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection:', reason);
  shutdown();
});

/**
 * Main entry point
 */
async function main(): Promise<void> {
  try {
    // Start WebSocket server first
    startWebSocketServer();

    // Initialize PLC client (if PLC_IP is provided)
    plcClient = await initializePlcClient();

    // Start Next.js
    await startNextJs();

    console.log('='.repeat(60));
    console.log('All servers started successfully');
    console.log(`> Next.js:   http://localhost:${NEXTJS_PORT}`);
    console.log(`> WebSocket: ws://localhost:${WS_PORT}`);
    if (plcClient) {
      console.log(`> PLC:       ${PLC_IP} (${plcClient.getConnectionStatus()})`);
    }
    console.log('='.repeat(60));
    console.log('Press Ctrl+C to stop all servers');
  } catch (error) {
    console.error('Failed to start servers:', error);
    await shutdown();
    process.exit(1);
  }
}

main();
