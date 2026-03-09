#!/usr/bin/env tsx
/**
 * PLC Connection Test Script
 *
 * Tests the ffi-rs bindings to libplctag by connecting to a PLC,
 * creating tags, reading values, and monitoring state changes.
 *
 * Usage: npm run test:plc
 *
 * Requirements:
 * - libplctag.so (Linux), plctag.dll (Windows), or libplctag.dylib (macOS)
 *   must be available in the system library path or project directory
 * - PLC must be reachable at the configured IP address
 */

import {
  initLibrary,
  closeLibrary,
  isLibraryLoaded,
  getLibraryPath,
  createTag,
  plc_tag_destroy,
  plc_tag_read,
  plc_tag_get_int32,
  plc_tag_get_int8,
  plc_tag_get_float32,
  plc_tag_get_bit,
  plc_tag_shutdown,
  plc_tag_set_debug_level,
  PlcTagStatus,
  PlcTagDebugLevel,
  isStatusOk,
  isStatusError,
  getStatusMessage,
  isValidTagHandle,
  createTagReader,
  type TagValueChangeEvent,
} from "./lib/plc";

// ============================================================================
// Configuration
// ============================================================================

const PLC_CONFIG = {
  gateway: "192.168.20.40",
  path: "1,0",
};

// Common Allen-Bradley tag patterns for testing
// These are typical tags found in industrial PLC programs
const TEST_TAGS = [
  // Digital I/O tags (BOOL/SINT - 1 byte)
  { name: "Local:1:I.Data.0", elemSize: 1, description: "Digital Input Slot 1, Bit 0" },
  { name: "Local:1:I.Data.1", elemSize: 1, description: "Digital Input Slot 1, Bit 1" },
  { name: "Local:2:O.Data.0", elemSize: 1, description: "Digital Output Slot 2, Bit 0" },

  // Integer tags (DINT - 4 bytes)
  { name: "Program:MainProgram.Counter", elemSize: 4, description: "Program counter value" },
  { name: "Program:MainProgram.Timer_ACC", elemSize: 4, description: "Timer accumulator" },

  // Real/Float tags (REAL - 4 bytes)
  { name: "Program:MainProgram.Temperature", elemSize: 4, isFloat: true, description: "Temperature sensor" },
  { name: "Program:MainProgram.Pressure", elemSize: 4, isFloat: true, description: "Pressure reading" },
];

// Run duration in milliseconds
const RUN_DURATION_MS = 10000;

// ============================================================================
// Utility Functions
// ============================================================================

function log(message: string): void {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] ${message}`);
}

function logError(message: string): void {
  const timestamp = new Date().toISOString();
  console.error(`[${timestamp}] ERROR: ${message}`);
}

function logSuccess(message: string): void {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] SUCCESS: ${message}`);
}

function logWarning(message: string): void {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] WARNING: ${message}`);
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

// ============================================================================
// Main Test Functions
// ============================================================================

async function initializePlcLibrary(): Promise<boolean> {
  log("Initializing libplctag library...");

  try {
    initLibrary();

    if (!isLibraryLoaded()) {
      logError("Library loaded but isLibraryLoaded() returns false");
      return false;
    }

    const libPath = getLibraryPath();
    logSuccess(`Library loaded successfully from: ${libPath}`);

    // Set debug level (use WARN for testing, SPEW for troubleshooting)
    plc_tag_set_debug_level(PlcTagDebugLevel.PLCTAG_DEBUG_WARN);
    log("Debug level set to WARN");

    return true;
  } catch (error) {
    logError(`Failed to initialize library: ${error instanceof Error ? error.message : String(error)}`);
    log("");
    log("Troubleshooting tips:");
    log("  - Ensure libplctag is installed on your system");
    log("  - On Linux: sudo apt install libplctag or build from source");
    log("  - On Windows: Place plctag.dll in the project directory");
    log("  - On macOS: brew install libplctag or build from source");
    log("");
    return false;
  }
}

async function testTagCreation(): Promise<Map<string, number>> {
  log("");
  log("=".repeat(60));
  log("Testing Tag Creation");
  log("=".repeat(60));
  log(`Gateway: ${PLC_CONFIG.gateway}`);
  log(`Path: ${PLC_CONFIG.path}`);
  log("");

  const tagHandles = new Map<string, number>();
  let successCount = 0;
  let failCount = 0;

  for (const tagDef of TEST_TAGS) {
    log(`Creating tag: ${tagDef.name} (${tagDef.description})`);

    try {
      const handle = createTag({
        gateway: PLC_CONFIG.gateway,
        path: PLC_CONFIG.path,
        name: tagDef.name,
        elemSize: tagDef.elemSize,
        elemCount: 1,
        timeout: 5000,
      });

      if (isValidTagHandle(handle)) {
        logSuccess(`  Tag created with handle: ${handle}`);
        tagHandles.set(tagDef.name, handle);
        successCount++;
      } else {
        const errorMsg = getStatusMessage(handle);
        logWarning(`  Tag creation returned error code ${handle}: ${errorMsg}`);
        failCount++;
      }
    } catch (error) {
      logError(`  Exception creating tag: ${error instanceof Error ? error.message : String(error)}`);
      failCount++;
    }
  }

  log("");
  log(`Tag creation results: ${successCount} successful, ${failCount} failed`);

  return tagHandles;
}

async function readTagValues(tagHandles: Map<string, number>): Promise<void> {
  log("");
  log("=".repeat(60));
  log("Reading Tag Values");
  log("=".repeat(60));
  log("");

  if (tagHandles.size === 0) {
    logWarning("No tags available to read");
    return;
  }

  for (const [tagName, handle] of Array.from(tagHandles.entries())) {
    const tagDef = TEST_TAGS.find((t) => t.name === tagName);

    log(`Reading: ${tagName}`);

    try {
      // Read the tag with 5 second timeout
      const status = plc_tag_read(handle, 5000);

      if (!isStatusOk(status)) {
        logWarning(`  Read failed with status ${status}: ${getStatusMessage(status)}`);
        continue;
      }

      // Get the value based on element size
      let value: number;
      let formattedValue: string;

      if (tagDef?.isFloat) {
        value = plc_tag_get_float32(handle, 0);
        formattedValue = value.toFixed(2);
      } else if (tagDef?.elemSize === 4) {
        value = plc_tag_get_int32(handle, 0);
        formattedValue = value.toString();
      } else {
        // BOOL/SINT (1 byte)
        value = plc_tag_get_int8(handle, 0);
        formattedValue = value === 1 ? "TRUE (1)" : value === 0 ? "FALSE (0)" : value.toString();
      }

      logSuccess(`  Value: ${formattedValue}`);
    } catch (error) {
      logError(`  Exception reading tag: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

async function monitorStateChanges(tagHandles: Map<string, number>, durationMs: number): Promise<void> {
  log("");
  log("=".repeat(60));
  log(`Monitoring State Changes (${formatDuration(durationMs)})`);
  log("=".repeat(60));
  log("");

  if (tagHandles.size === 0) {
    logWarning("No tags available to monitor");
    return;
  }

  // Create tag reader service
  const tagReader = createTagReader({
    pollIntervalMs: 100, // 100ms polling for testing
    readTimeoutMs: 2000,
    batchSize: 10,
    maxConcurrentReaders: 4,
  });

  // Set connection parameters
  tagReader.setConnection(PLC_CONFIG.gateway, PLC_CONFIG.path);

  // Set up event listeners
  tagReader.on("tagValueChanged", (event: TagValueChangeEvent) => {
    log(`STATE CHANGE: ${event.name} changed from ${event.oldValue} to ${event.newValue}`);
  });

  tagReader.on("connectionStatusChanged", (isConnected: boolean) => {
    if (isConnected) {
      logSuccess("Connection restored");
    } else {
      logWarning("Connection lost");
    }
  });

  tagReader.on("error", (error: Error, tagName?: string) => {
    logError(`${tagName ? `[${tagName}] ` : ""}${error.message}`);
  });

  tagReader.on("readCycleComplete", (cycleTimeMs: number, successCount: number, failCount: number) => {
    // Only log if there are failures (to reduce noise)
    if (failCount > 0) {
      logWarning(`Read cycle: ${cycleTimeMs}ms, success: ${successCount}, failed: ${failCount}`);
    }
  });

  // Create tags in the reader
  log("Creating tags in TagReaderService...");
  const tagNames = Array.from(tagHandles.keys());

  // Note: We're creating new tags through the reader instead of reusing handles
  // This tests the full tag creation flow
  const boolTagNames = TEST_TAGS.filter((t) => t.elemSize === 1).map((t) => t.name);

  if (boolTagNames.length > 0) {
    const result = await tagReader.createTags(boolTagNames);
    log(`Created ${result.successful.length} tags, ${result.failed.length} failed`);

    if (result.successful.length > 0) {
      // Start reading
      log("Starting continuous read loop...");
      await tagReader.startReading();

      // Monitor for the specified duration
      log(`Monitoring for ${formatDuration(durationMs)}... (waiting for state changes)`);
      await new Promise((resolve) => setTimeout(resolve, durationMs));

      // Stop reading
      tagReader.stopReading();
      log("Stopped reading");

      // Show stats
      const stats = tagReader.getPerformanceStats();
      log(`Performance: ${stats.totalCycles} cycles, avg ${stats.avgCycleTimeMs.toFixed(1)}ms per cycle`);
    }
  } else {
    logWarning("No boolean tags available for monitoring");
  }

  // Clean up
  tagReader.dispose();
}

function cleanupTags(tagHandles: Map<string, number>): void {
  log("");
  log("=".repeat(60));
  log("Cleaning Up");
  log("=".repeat(60));
  log("");

  let destroyedCount = 0;

  for (const [tagName, handle] of Array.from(tagHandles.entries())) {
    try {
      const status = plc_tag_destroy(handle);
      if (isStatusOk(status)) {
        destroyedCount++;
      } else {
        logWarning(`Failed to destroy tag ${tagName}: ${getStatusMessage(status)}`);
      }
    } catch (error) {
      logError(`Exception destroying tag ${tagName}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  log(`Destroyed ${destroyedCount} tag handles`);
}

function shutdownLibrary(): void {
  try {
    plc_tag_shutdown();
    closeLibrary();
    log("Library shutdown complete");
  } catch (error) {
    logError(`Exception during shutdown: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// ============================================================================
// Main Entry Point
// ============================================================================

async function main(): Promise<void> {
  console.log("");
  console.log("=".repeat(60));
  console.log("PLC Connection Test - libplctag via ffi-rs");
  console.log("=".repeat(60));
  console.log("");

  const startTime = Date.now();

  // Initialize library
  const initialized = await initializePlcLibrary();
  if (!initialized) {
    process.exit(1);
  }

  let tagHandles = new Map<string, number>();

  try {
    // Create test tags
    tagHandles = await testTagCreation();

    // Read initial values
    await readTagValues(tagHandles);

    // Monitor state changes
    await monitorStateChanges(tagHandles, RUN_DURATION_MS);
  } catch (error) {
    logError(`Unhandled exception: ${error instanceof Error ? error.message : String(error)}`);
    if (error instanceof Error && error.stack) {
      console.error(error.stack);
    }
  } finally {
    // Always clean up
    cleanupTags(tagHandles);
    shutdownLibrary();

    const totalTime = Date.now() - startTime;
    log("");
    log(`Test completed in ${formatDuration(totalTime)}`);
    console.log("");
  }
}

// Handle uncaught errors
process.on("uncaughtException", (error) => {
  logError(`Uncaught exception: ${error.message}`);
  console.error(error.stack);
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  logError(`Unhandled rejection: ${reason}`);
  process.exit(1);
});

// Handle graceful shutdown
process.on("SIGINT", () => {
  log("");
  log("Received SIGINT, shutting down...");
  shutdownLibrary();
  process.exit(0);
});

process.on("SIGTERM", () => {
  log("");
  log("Received SIGTERM, shutting down...");
  shutdownLibrary();
  process.exit(0);
});

// Run the test
main().catch((error) => {
  logError(`Fatal error: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
