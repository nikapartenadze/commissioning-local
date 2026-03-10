#!/usr/bin/env tsx

/**
 * TypeScript Development Server Startup
 *
 * Spawns the WebSocket server and Next.js dev server.
 *
 * Usage: npx tsx scripts/start-server.ts
 */

import { spawn, ChildProcess } from 'child_process';
import path from 'path';

const NEXTJS_PORT = parseInt(process.env.PORT || '3020', 10);
const WS_PORT = parseInt(process.env.PLC_WS_PORT || '3002', 10);

console.log('='.repeat(60));
console.log('Development Server');
console.log('='.repeat(60));
console.log(`Next.js port: ${NEXTJS_PORT}`);
console.log(`WebSocket port: ${WS_PORT}`);
console.log('='.repeat(60));

let wsProcess: ChildProcess | null = null;
let nextProcess: ChildProcess | null = null;
let isShuttingDown = false;

function startWebSocketServer(): void {
  console.log('[WebSocket] Starting PLC WebSocket server...');

  wsProcess = spawn('node', [path.join(__dirname, 'plc-websocket-server.js')], {
    env: { ...process.env, PLC_WS_PORT: WS_PORT.toString() },
    stdio: ['ignore', 'pipe', 'pipe'],
    cwd: path.join(__dirname, '..'),
  });

  wsProcess.stdout?.on('data', (data: Buffer) => {
    const output = data.toString().trim();
    if (output) console.log(`[WebSocket] ${output}`);
  });

  wsProcess.stderr?.on('data', (data: Buffer) => {
    const output = data.toString().trim();
    if (output) console.error(`[WebSocket] ${output}`);
  });

  wsProcess.on('close', (code) => {
    if (!isShuttingDown && code !== 0) {
      console.error(`[WebSocket] Process exited with code ${code}`);
    }
  });
}

function startNextJs(): Promise<void> {
  return new Promise((resolve) => {
    console.log('[Next.js] Starting development server...');

    nextProcess = spawn('npx', ['next', 'dev', '-p', NEXTJS_PORT.toString()], {
      env: { ...process.env, PORT: NEXTJS_PORT.toString(), PLC_WS_PORT: WS_PORT.toString() },
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: true,
      cwd: path.join(__dirname, '..'),
    });

    let resolved = false;

    nextProcess.stdout?.on('data', (data: Buffer) => {
      const output = data.toString().trim();
      if (output) {
        output.split('\n')
          .filter(l => !l.includes('ExperimentalWarning') && l.trim())
          .forEach(l => console.log(`[Next.js] ${l}`));
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

    nextProcess.on('close', (code) => {
      if (!isShuttingDown && code !== 0 && code !== null) {
        console.error(`[Next.js] Process exited with code ${code}`);
        shutdown();
      }
    });

    setTimeout(() => { if (!resolved) { resolved = true; resolve(); } }, 15000);
  });
}

async function shutdown(): Promise<void> {
  if (isShuttingDown) return;
  isShuttingDown = true;

  console.log('\nShutting down servers...');

  if (wsProcess && !wsProcess.killed) {
    try { wsProcess.kill('SIGTERM'); } catch {}
  }
  if (nextProcess && !nextProcess.killed) {
    try { nextProcess.kill('SIGTERM'); } catch {}
  }

  console.log('Shutdown complete');
  setTimeout(() => process.exit(0), 2000);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

async function main(): Promise<void> {
  try {
    startWebSocketServer();
    await startNextJs();

    console.log('='.repeat(60));
    console.log('All servers started successfully');
    console.log(`> Next.js:   http://localhost:${NEXTJS_PORT}`);
    console.log(`> WebSocket: ws://localhost:${WS_PORT}`);
    console.log('='.repeat(60));
    console.log('Press Ctrl+C to stop');
  } catch (error) {
    console.error('Failed to start servers:', error);
    await shutdown();
    process.exit(1);
  }
}

main();
