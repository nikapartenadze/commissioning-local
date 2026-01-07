#!/usr/bin/env node

/**
 * PLC WebSocket Server
 * Runs alongside the Next.js app to provide real-time PLC communication
 */

const WebSocket = require('ws');
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();
const port = process.env.PLC_WS_PORT || 3001;

// Create WebSocket server
const wss = new WebSocket.Server({ port });

console.log(`🔌 PLC WebSocket server listening on port ${port}`);

// Store connected clients
const clients = new Map();
let updateInterval = null;

// Handle new connections
wss.on('connection', (ws) => {
  console.log('🔌 New PLC WebSocket client connected');
  
  ws.on('message', (data) => {
    try {
      const message = JSON.parse(data.toString());
      handleMessage(ws, message);
    } catch (error) {
      console.error('Error parsing WebSocket message:', error);
    }
  });

  ws.on('close', () => {
    console.log('🔌 PLC WebSocket client disconnected');
    clients.delete(ws);
    
    // Stop updates if no clients
    if (clients.size === 0 && updateInterval) {
      clearInterval(updateInterval);
      updateInterval = null;
      console.log('🛑 Stopped real-time updates (no clients)');
    }
  });

  ws.on('error', (error) => {
    console.error('PLC WebSocket error:', error);
    clients.delete(ws);
  });
});

function handleMessage(ws, message) {
  switch (message.type) {
    case 'config':
      clients.set(ws, message.data);
      console.log('📋 PLC configuration received:', message.data);
      startRealTimeUpdates();
      break;
    case 'watchdog-ping':
      handleWatchdogPing(ws);
      break;
  }
}

function handleWatchdogPing(ws) {
  // Send watchdog response
  ws.send(JSON.stringify({
    type: 'watchdog-status',
    data: { active: true, timestamp: new Date().toISOString() }
  }));
}

function startRealTimeUpdates() {
  if (updateInterval) return;
  
  console.log('🔄 Starting real-time IO updates');
  
  updateInterval = setInterval(async () => {
    await broadcastIoUpdates();
  }, 1000); // Update every second
}

async function broadcastIoUpdates() {
  if (clients.size === 0) return;

  try {
    // Get all IOs from database
    // Note: state is not stored in database - it's a runtime PLC value
    const ios = await prisma.io.findMany({
      select: {
        id: true,
        name: true,
        result: true,
        timestamp: true,
        comments: true
      }
    });

    // Simulate real-time state changes (state comes from PLC, not database)
    const iosWithSimulatedState = ios.map(io => ({
      ...io,
      state: simulateIoState(io.name || '', null) // State is simulated/generated, not from DB
    }));

    // Broadcast to all connected clients
    const message = JSON.stringify({
      type: 'io-update',
      data: iosWithSimulatedState
    });

    clients.forEach((config, ws) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(message);
      }
    });
  } catch (error) {
    console.error('Error broadcasting IO updates:', error);
  }
}

function simulateIoState(ioName, currentState) {
  // Simulate realistic PLC states
  // Note: currentState parameter is unused - state is generated, not from database
  // In production, this would read actual PLC states
  
  // Simulate realistic PLC states like the C# app
  if (ioName.includes(':O.') || ioName.includes('.O.') || ioName.includes('.Outputs.')) {
    // Output - simulate on/off states with visual indicators
    return Math.random() > 0.7 ? 'ON' : 'OFF';
  } else if (ioName.includes(':I.') || ioName.includes('.I.')) {
    // Input - simulate various states with visual indicators
    const states = ['HIGH', 'LOW', 'PULSE', 'STABLE'];
    return states[Math.floor(Math.random() * states.length)];
  } else {
    // Other types - simulate basic states
    return Math.random() > 0.5 ? 'ACTIVE' : 'INACTIVE';
  }
}

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n🛑 Shutting down PLC WebSocket server...');
  
  if (updateInterval) {
    clearInterval(updateInterval);
  }
  
  wss.close(() => {
    console.log('✅ PLC WebSocket server stopped');
    process.exit(0);
  });
});

process.on('SIGTERM', () => {
  console.log('\n🛑 Received SIGTERM, shutting down gracefully...');
  
  if (updateInterval) {
    clearInterval(updateInterval);
  }
  
  wss.close(() => {
    console.log('✅ PLC WebSocket server stopped');
    process.exit(0);
  });
});
