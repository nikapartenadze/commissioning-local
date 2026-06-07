// @ts-nocheck — ffi-rs async return types don't match declared sync signatures (works at runtime)
/**
 * Node.js/TypeScript wrapper for libplctag using ffi-rs
 *
 * This module provides FFI bindings to the native libplctag C library
 * for communicating with Allen-Bradley PLCs via Ethernet/IP.
 */

import { open, close, define, DataType, load } from "ffi-rs";
import { platform } from "os";
import { join } from "path";
import {
  PlcTagStatus,
  PlcTagDebugLevel,
  type TagHandle,
  type PlcTagConfig,
  type PlcTagDebugLevelType,
  buildAttributeString,
  getStatusMessage,
  isStatusOk,
  isStatusPending,
  isStatusError,
  isValidTagHandle,
} from "./types";

// ============================================================================
// Library Loading
// ============================================================================

/** Library name based on platform */
const LIBRARY_NAME = "plctag";

/** Get the library file name based on the current platform */
function getLibraryFileName(): string {
  const os = platform();
  switch (os) {
    case "win32":
      return "plctag.dll";
    case "linux":
      return "libplctag.so";
    case "darwin":
      return "libplctag.dylib";
    default:
      throw new Error(`Unsupported platform: ${os}`);
  }
}

/** Possible search paths for the native library */
function getLibrarySearchPaths(): string[] {
  const fileName = getLibraryFileName();
  const paths: string[] = [];

  // Current working directory
  paths.push(join(process.cwd(), fileName));

  // Next to the script
  paths.push(join(__dirname, fileName));
  paths.push(join(__dirname, "..", fileName));
  paths.push(join(__dirname, "..", "..", fileName));

  // System library paths
  if (platform() === "linux") {
    paths.push(`/usr/lib/${fileName}`);
    paths.push(`/usr/local/lib/${fileName}`);
    paths.push(`/usr/lib/x86_64-linux-gnu/${fileName}`);
  } else if (platform() === "darwin") {
    paths.push(`/usr/local/lib/${fileName}`);
    paths.push(`/opt/homebrew/lib/${fileName}`);
  }

  // Just the library name (let the system find it)
  paths.push(fileName);

  return paths;
}

// ============================================================================
// FFI Definitions
// ============================================================================

let libraryLoaded = false;
let libraryPath: string | null = null;

/**
 * Initialize the libplctag library
 * Must be called before using any other functions
 *
 * @param customPath - Optional custom path to the library file
 * @throws Error if the library cannot be loaded
 */
export function initLibrary(customPath?: string): void {
  if (libraryLoaded) {
    return;
  }

  const searchPaths = customPath ? [customPath] : getLibrarySearchPaths();
  let lastError: Error | null = null;

  for (const path of searchPaths) {
    try {
      open({
        library: LIBRARY_NAME,
        path: path,
      });
      libraryPath = path;
      libraryLoaded = true;
      return;
    } catch (error) {
      lastError = error as Error;
      // Continue searching
    }
  }

  throw new Error(
    `Failed to load libplctag library. Searched paths: ${searchPaths.join(", ")}. Last error: ${lastError?.message}`
  );
}

/**
 * Close the libplctag library
 * Call this when done using the library to free resources
 */
export function closeLibrary(): void {
  if (libraryLoaded) {
    close(LIBRARY_NAME);
    libraryLoaded = false;
    libraryPath = null;
  }
}

/**
 * Check if the library is loaded
 */
export function isLibraryLoaded(): boolean {
  return libraryLoaded;
}

/**
 * Get the path to the loaded library
 */
export function getLibraryPath(): string | null {
  return libraryPath;
}

// ============================================================================
// Tag Lifecycle Functions
// ============================================================================

/**
 * Create a new tag
 *
 * @param attribStr - Attribute string defining the tag (e.g., "protocol=ab_eip&gateway=192.168.1.1&...")
 * @param timeout - Timeout in milliseconds (0 for non-blocking)
 * @returns Tag handle (>= 0) or error code (< 0)
 */
export function plc_tag_create(attribStr: string, timeout: number): TagHandle {
  if (!libraryLoaded) {
    throw new Error("Library not loaded. Call initLibrary() first.");
  }

  return load({
    library: LIBRARY_NAME,
    funcName: "plc_tag_create",
    retType: DataType.I32,
    paramsType: [DataType.String, DataType.I32],
    paramsValue: [attribStr, timeout],
  });
}

/**
 * Create a tag from a configuration object
 *
 * @param config - Tag configuration
 * @returns Tag handle (>= 0) or error code (< 0)
 */
export function createTag(config: PlcTagConfig): TagHandle {
  const attribStr = buildAttributeString(config);
  return plc_tag_create(attribStr, config.timeout ?? 5000);
}

/**
 * Destroy a tag and free its resources
 *
 * @param tag - Tag handle
 * @returns Status code
 */
export function plc_tag_destroy(tag: TagHandle): number {
  if (!libraryLoaded) {
    throw new Error("Library not loaded. Call initLibrary() first.");
  }

  return load({
    library: LIBRARY_NAME,
    funcName: "plc_tag_destroy",
    retType: DataType.I32,
    paramsType: [DataType.I32],
    paramsValue: [tag],
  });
}

/**
 * Shutdown the entire libplctag library
 * Call this before exiting your application
 */
export function plc_tag_shutdown(): void {
  if (!libraryLoaded) {
    return;
  }

  load({
    library: LIBRARY_NAME,
    funcName: "plc_tag_shutdown",
    retType: DataType.Void,
    paramsType: [],
    paramsValue: [],
  });
}

// ============================================================================
// Read/Write Functions
// ============================================================================

/**
 * Read tag data from the PLC
 *
 * @param tag - Tag handle
 * @param timeout - Timeout in milliseconds (0 for non-blocking)
 * @returns Status code (PLCTAG_STATUS_OK on success, PLCTAG_STATUS_PENDING if async, or error)
 */
export function plc_tag_read(tag: TagHandle, timeout: number): number {
  if (!libraryLoaded) {
    throw new Error("Library not loaded. Call initLibrary() first.");
  }

  return load({
    library: LIBRARY_NAME,
    funcName: "plc_tag_read",
    retType: DataType.I32,
    paramsType: [DataType.I32, DataType.I32],
    paramsValue: [tag, timeout],
  });
}

/**
 * Write tag data to the PLC
 *
 * @param tag - Tag handle
 * @param timeout - Timeout in milliseconds (0 for non-blocking)
 * @returns Status code (PLCTAG_STATUS_OK on success, PLCTAG_STATUS_PENDING if async, or error)
 */
export function plc_tag_write(tag: TagHandle, timeout: number): number {
  if (!libraryLoaded) {
    throw new Error("Library not loaded. Call initLibrary() first.");
  }

  return load({
    library: LIBRARY_NAME,
    funcName: "plc_tag_write",
    retType: DataType.I32,
    paramsType: [DataType.I32, DataType.I32],
    paramsValue: [tag, timeout],
  });
}

/**
 * Get the current status of a tag operation
 *
 * @param tag - Tag handle
 * @returns Status code
 */
export function plc_tag_status(tag: TagHandle): number {
  if (!libraryLoaded) {
    throw new Error("Library not loaded. Call initLibrary() first.");
  }

  return load({
    library: LIBRARY_NAME,
    funcName: "plc_tag_status",
    retType: DataType.I32,
    paramsType: [DataType.I32],
    paramsValue: [tag],
  });
}

/**
 * Abort a pending tag operation
 *
 * @param tag - Tag handle
 * @returns Status code
 */
export function plc_tag_abort(tag: TagHandle): number {
  if (!libraryLoaded) {
    throw new Error("Library not loaded. Call initLibrary() first.");
  }

  return load({
    library: LIBRARY_NAME,
    funcName: "plc_tag_abort",
    retType: DataType.I32,
    paramsType: [DataType.I32],
    paramsValue: [tag],
  });
}

// ============================================================================
// Data Access Functions - Size
// ============================================================================

/**
 * Get the size of tag data in bytes
 *
 * @param tag - Tag handle
 * @returns Size in bytes, or error code if negative
 */
export function plc_tag_get_size(tag: TagHandle): number {
  if (!libraryLoaded) {
    throw new Error("Library not loaded. Call initLibrary() first.");
  }

  return load({
    library: LIBRARY_NAME,
    funcName: "plc_tag_get_size",
    retType: DataType.I32,
    paramsType: [DataType.I32],
    paramsValue: [tag],
  });
}

/**
 * Set the size of tag data in bytes
 *
 * @param tag - Tag handle
 * @param newSize - New size in bytes
 * @returns Status code
 */
export function plc_tag_set_size(tag: TagHandle, newSize: number): number {
  if (!libraryLoaded) {
    throw new Error("Library not loaded. Call initLibrary() first.");
  }

  return load({
    library: LIBRARY_NAME,
    funcName: "plc_tag_set_size",
    retType: DataType.I32,
    paramsType: [DataType.I32, DataType.I32],
    paramsValue: [tag, newSize],
  });
}

// ============================================================================
// Bulk Data Copy
// ============================================================================

/**
 * Copy a range of bytes from the tag's data buffer into a caller-supplied
 * Buffer with a single FFI call. The C signature is
 *   int plc_tag_get_raw_bytes(int32_t tag_id, int offset, uint8_t *buffer, int length)
 * and ffi-rs fills `out` in place via the DataType.U8Array parameter binding.
 *
 * This is the bulk-read fast path used by the network poller and the @tags
 * browse parser. Reading N bytes by issuing N × plc_tag_get_uint8() costs N
 * full FFI round-trips (~100–500 µs each) — each of which blocks the Node.js
 * event loop. For a 108-byte UDT × 32 ports × ~25 fields per port, that was
 * ~830 sync FFI calls per device per poll cycle = seconds of event-loop
 * block per cycle. One bulk copy is a single FFI call.
 *
 * @param tag - tag handle
 * @param offset - byte offset into the tag's data buffer
 * @param out - destination Buffer (Buffer.alloc(N)); will be filled in place
 * @returns status code (PLCTAG_STATUS_OK on success, negative on error)
 */
export function plc_tag_get_raw_bytes(
  tag: TagHandle,
  offset: number,
  out: Buffer,
): number {
  if (!libraryLoaded) {
    throw new Error("Library not loaded. Call initLibrary() first.");
  }

  return load({
    library: LIBRARY_NAME,
    funcName: "plc_tag_get_raw_bytes",
    retType: DataType.I32,
    paramsType: [DataType.I32, DataType.I32, DataType.U8Array, DataType.I32],
    paramsValue: [tag, offset, out, out.length],
  });
}

// ============================================================================
// Data Access Functions - Bit
// ============================================================================

/**
 * Get a single bit from the tag's data buffer
 *
 * @param tag - Tag handle
 * @param offsetBit - Bit offset (0-indexed)
 * @returns 0 or 1, or negative error code
 */
export function plc_tag_get_bit(tag: TagHandle, offsetBit: number): number {
  if (!libraryLoaded) {
    throw new Error("Library not loaded. Call initLibrary() first.");
  }

  return load({
    library: LIBRARY_NAME,
    funcName: "plc_tag_get_bit",
    retType: DataType.I32,
    paramsType: [DataType.I32, DataType.I32],
    paramsValue: [tag, offsetBit],
  });
}

/**
 * Set a single bit in the tag's data buffer
 *
 * @param tag - Tag handle
 * @param offsetBit - Bit offset (0-indexed)
 * @param value - Value to set (0 or 1)
 * @returns Status code
 */
export function plc_tag_set_bit(tag: TagHandle, offsetBit: number, value: number): number {
  if (!libraryLoaded) {
    throw new Error("Library not loaded. Call initLibrary() first.");
  }

  return load({
    library: LIBRARY_NAME,
    funcName: "plc_tag_set_bit",
    retType: DataType.I32,
    paramsType: [DataType.I32, DataType.I32, DataType.I32],
    paramsValue: [tag, offsetBit, value],
  });
}

// ============================================================================
// Data Access Functions - 8-bit
// ============================================================================

/**
 * Get an unsigned 8-bit integer from the tag's data buffer
 *
 * @param tag - Tag handle
 * @param offset - Byte offset
 * @returns Unsigned 8-bit value (0-255)
 */
export function plc_tag_get_uint8(tag: TagHandle, offset: number): number {
  if (!libraryLoaded) {
    throw new Error("Library not loaded. Call initLibrary() first.");
  }

  return load({
    library: LIBRARY_NAME,
    funcName: "plc_tag_get_uint8",
    retType: DataType.U8,
    paramsType: [DataType.I32, DataType.I32],
    paramsValue: [tag, offset],
  });
}

/**
 * Set an unsigned 8-bit integer in the tag's data buffer
 *
 * @param tag - Tag handle
 * @param offset - Byte offset
 * @param value - Value to set (0-255)
 * @returns Status code
 */
export function plc_tag_set_uint8(tag: TagHandle, offset: number, value: number): number {
  if (!libraryLoaded) {
    throw new Error("Library not loaded. Call initLibrary() first.");
  }

  return load({
    library: LIBRARY_NAME,
    funcName: "plc_tag_set_uint8",
    retType: DataType.I32,
    paramsType: [DataType.I32, DataType.I32, DataType.U8],
    paramsValue: [tag, offset, value],
  });
}

/**
 * Get a signed 8-bit integer from the tag's data buffer
 *
 * @param tag - Tag handle
 * @param offset - Byte offset
 * @returns Signed 8-bit value (-128 to 127)
 */
export function plc_tag_get_int8(tag: TagHandle, offset: number): number {
  if (!libraryLoaded) {
    throw new Error("Library not loaded. Call initLibrary() first.");
  }

  return load({
    library: LIBRARY_NAME,
    funcName: "plc_tag_get_int8",
    retType: DataType.I32,
    paramsType: [DataType.I32, DataType.I32],
    paramsValue: [tag, offset],
  });
}

/**
 * Set a signed 8-bit integer in the tag's data buffer
 *
 * @param tag - Tag handle
 * @param offset - Byte offset
 * @param value - Value to set (-128 to 127)
 * @returns Status code
 */
export function plc_tag_set_int8(tag: TagHandle, offset: number, value: number): number {
  if (!libraryLoaded) {
    throw new Error("Library not loaded. Call initLibrary() first.");
  }

  return load({
    library: LIBRARY_NAME,
    funcName: "plc_tag_set_int8",
    retType: DataType.I32,
    paramsType: [DataType.I32, DataType.I32, DataType.I32],
    paramsValue: [tag, offset, value],
  });
}

// ============================================================================
// Data Access Functions - 16-bit
// ============================================================================

/**
 * Get a signed 16-bit integer from the tag's data buffer
 *
 * @param tag - Tag handle
 * @param offset - Byte offset
 * @returns Signed 16-bit value
 */
export function plc_tag_get_int16(tag: TagHandle, offset: number): number {
  if (!libraryLoaded) {
    throw new Error("Library not loaded. Call initLibrary() first.");
  }

  return load({
    library: LIBRARY_NAME,
    funcName: "plc_tag_get_int16",
    retType: DataType.I16,
    paramsType: [DataType.I32, DataType.I32],
    paramsValue: [tag, offset],
  });
}

/**
 * Set a signed 16-bit integer in the tag's data buffer
 *
 * @param tag - Tag handle
 * @param offset - Byte offset
 * @param value - Value to set
 * @returns Status code
 */
export function plc_tag_set_int16(tag: TagHandle, offset: number, value: number): number {
  if (!libraryLoaded) {
    throw new Error("Library not loaded. Call initLibrary() first.");
  }

  return load({
    library: LIBRARY_NAME,
    funcName: "plc_tag_set_int16",
    retType: DataType.I32,
    paramsType: [DataType.I32, DataType.I32, DataType.I16],
    paramsValue: [tag, offset, value],
  });
}

// ============================================================================
// Data Access Functions - 32-bit
// ============================================================================

/**
 * Get a signed 32-bit integer from the tag's data buffer
 *
 * @param tag - Tag handle
 * @param offset - Byte offset
 * @returns Signed 32-bit value
 */
export function plc_tag_get_int32(tag: TagHandle, offset: number): number {
  if (!libraryLoaded) {
    throw new Error("Library not loaded. Call initLibrary() first.");
  }

  return load({
    library: LIBRARY_NAME,
    funcName: "plc_tag_get_int32",
    retType: DataType.I32,
    paramsType: [DataType.I32, DataType.I32],
    paramsValue: [tag, offset],
  });
}

/**
 * Set a signed 32-bit integer in the tag's data buffer
 *
 * @param tag - Tag handle
 * @param offset - Byte offset
 * @param value - Value to set
 * @returns Status code
 */
export function plc_tag_set_int32(tag: TagHandle, offset: number, value: number): number {
  if (!libraryLoaded) {
    throw new Error("Library not loaded. Call initLibrary() first.");
  }

  return load({
    library: LIBRARY_NAME,
    funcName: "plc_tag_set_int32",
    retType: DataType.I32,
    paramsType: [DataType.I32, DataType.I32, DataType.I32],
    paramsValue: [tag, offset, value],
  });
}

/**
 * Get an unsigned 32-bit integer from the tag's data buffer
 *
 * @param tag - Tag handle
 * @param offset - Byte offset
 * @returns Unsigned 32-bit value
 */
export function plc_tag_get_uint32(tag: TagHandle, offset: number): number {
  if (!libraryLoaded) {
    throw new Error("Library not loaded. Call initLibrary() first.");
  }

  return load({
    library: LIBRARY_NAME,
    funcName: "plc_tag_get_uint32",
    retType: DataType.U32,
    paramsType: [DataType.I32, DataType.I32],
    paramsValue: [tag, offset],
  });
}

// ============================================================================
// Data Access Functions - Float
// ============================================================================

/**
 * Get a 32-bit float from the tag's data buffer
 *
 * @param tag - Tag handle
 * @param offset - Byte offset
 * @returns 32-bit float value
 */
export function plc_tag_get_float32(tag: TagHandle, offset: number): number {
  if (!libraryLoaded) {
    throw new Error("Library not loaded. Call initLibrary() first.");
  }

  return load({
    library: LIBRARY_NAME,
    funcName: "plc_tag_get_float32",
    retType: DataType.Float,
    paramsType: [DataType.I32, DataType.I32],
    paramsValue: [tag, offset],
  });
}

/**
 * Set a 32-bit float in the tag's data buffer
 *
 * @param tag - Tag handle
 * @param offset - Byte offset
 * @param value - Value to set
 * @returns Status code
 */
export function plc_tag_set_float32(tag: TagHandle, offset: number, value: number): number {
  if (!libraryLoaded) {
    throw new Error("Library not loaded. Call initLibrary() first.");
  }

  return load({
    library: LIBRARY_NAME,
    funcName: "plc_tag_set_float32",
    retType: DataType.I32,
    paramsType: [DataType.I32, DataType.I32, DataType.Float],
    paramsValue: [tag, offset, value],
  });
}

/**
 * Get a 64-bit float from the tag's data buffer
 *
 * @param tag - Tag handle
 * @param offset - Byte offset
 * @returns 64-bit float value
 */
export function plc_tag_get_float64(tag: TagHandle, offset: number): number {
  if (!libraryLoaded) {
    throw new Error("Library not loaded. Call initLibrary() first.");
  }

  return load({
    library: LIBRARY_NAME,
    funcName: "plc_tag_get_float64",
    retType: DataType.Double,
    paramsType: [DataType.I32, DataType.I32],
    paramsValue: [tag, offset],
  });
}

/**
 * Set a 64-bit float in the tag's data buffer
 *
 * @param tag - Tag handle
 * @param offset - Byte offset
 * @param value - Value to set
 * @returns Status code
 */
export function plc_tag_set_float64(tag: TagHandle, offset: number, value: number): number {
  if (!libraryLoaded) {
    throw new Error("Library not loaded. Call initLibrary() first.");
  }

  return load({
    library: LIBRARY_NAME,
    funcName: "plc_tag_set_float64",
    retType: DataType.I32,
    paramsType: [DataType.I32, DataType.I32, DataType.Double],
    paramsValue: [tag, offset, value],
  });
}

// ============================================================================
// Thread Safety Functions
// ============================================================================

/**
 * Lock a tag for exclusive access
 *
 * @param tag - Tag handle
 * @returns Status code
 */
export function plc_tag_lock(tag: TagHandle): number {
  if (!libraryLoaded) {
    throw new Error("Library not loaded. Call initLibrary() first.");
  }

  return load({
    library: LIBRARY_NAME,
    funcName: "plc_tag_lock",
    retType: DataType.I32,
    paramsType: [DataType.I32],
    paramsValue: [tag],
  });
}

/**
 * Unlock a tag
 *
 * @param tag - Tag handle
 * @returns Status code
 */
export function plc_tag_unlock(tag: TagHandle): number {
  if (!libraryLoaded) {
    throw new Error("Library not loaded. Call initLibrary() first.");
  }

  return load({
    library: LIBRARY_NAME,
    funcName: "plc_tag_unlock",
    retType: DataType.I32,
    paramsType: [DataType.I32],
    paramsValue: [tag],
  });
}

// ============================================================================
// Debug and Version Functions
// ============================================================================

/**
 * Set the debug level for the library
 *
 * @param level - Debug level (use PlcTagDebugLevel constants)
 */
export function plc_tag_set_debug_level(level: PlcTagDebugLevelType): void {
  if (!libraryLoaded) {
    throw new Error("Library not loaded. Call initLibrary() first.");
  }

  load({
    library: LIBRARY_NAME,
    funcName: "plc_tag_set_debug_level",
    retType: DataType.Void,
    paramsType: [DataType.I32],
    paramsValue: [level],
  });
}

/**
 * Check if the library version meets minimum requirements
 *
 * @param reqMajor - Required major version
 * @param reqMinor - Required minor version
 * @param reqPatch - Required patch version
 * @returns PLCTAG_STATUS_OK if version is sufficient, error code otherwise
 */
export function plc_tag_check_lib_version(
  reqMajor: number,
  reqMinor: number,
  reqPatch: number
): number {
  if (!libraryLoaded) {
    throw new Error("Library not loaded. Call initLibrary() first.");
  }

  return load({
    library: LIBRARY_NAME,
    funcName: "plc_tag_check_lib_version",
    retType: DataType.I32,
    paramsType: [DataType.I32, DataType.I32, DataType.I32],
    paramsValue: [reqMajor, reqMinor, reqPatch],
  });
}

/**
 * Get an integer attribute from a tag
 *
 * @param tag - Tag handle
 * @param attribName - Attribute name
 * @param defaultValue - Default value if attribute not found
 * @returns Attribute value or default
 */
export function plc_tag_get_int_attribute(
  tag: TagHandle,
  attribName: string,
  defaultValue: number
): number {
  if (!libraryLoaded) {
    throw new Error("Library not loaded. Call initLibrary() first.");
  }

  return load({
    library: LIBRARY_NAME,
    funcName: "plc_tag_get_int_attribute",
    retType: DataType.I32,
    paramsType: [DataType.I32, DataType.String, DataType.I32],
    paramsValue: [tag, attribName, defaultValue],
  });
}

/**
 * Set an integer attribute on a tag
 *
 * @param tag - Tag handle
 * @param attribName - Attribute name
 * @param newValue - New value
 * @returns Status code
 */
export function plc_tag_set_int_attribute(
  tag: TagHandle,
  attribName: string,
  newValue: number
): number {
  if (!libraryLoaded) {
    throw new Error("Library not loaded. Call initLibrary() first.");
  }

  return load({
    library: LIBRARY_NAME,
    funcName: "plc_tag_set_int_attribute",
    retType: DataType.I32,
    paramsType: [DataType.I32, DataType.String, DataType.I32],
    paramsValue: [tag, attribName, newValue],
  });
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Wait for a tag operation to complete (polling-based)
 * Uses exponential backoff to reduce CPU load
 *
 * @param tag - Tag handle
 * @param timeoutMs - Maximum time to wait in milliseconds
 * @returns Final status code
 */
export async function waitForStatus(tag: TagHandle, timeoutMs: number): Promise<number> {
  const startTime = Date.now();
  let pollDelay = 5; // Start with 5ms
  const maxPollDelay = 100; // Max 100ms between polls
  const maxIterations = 1000; // Safety limit to prevent infinite loops
  let iterations = 0;

  while (iterations < maxIterations) {
    iterations++;

    // Check timeout FIRST
    const elapsed = Date.now() - startTime;
    if (elapsed > timeoutMs) {
      return PlcTagStatus.PLCTAG_ERR_TIMEOUT;
    }

    try {
      const status = plc_tag_status(tag);

      if (!isStatusPending(status)) {
        return status;
      }
    } catch {
      return PlcTagStatus.PLCTAG_ERR_BAD_STATUS;
    }

    // Exponential backoff
    await new Promise((resolve) => setTimeout(resolve, pollDelay));
    pollDelay = Math.min(pollDelay * 1.5, maxPollDelay);
  }

  // Exceeded max iterations - treat as timeout
  return PlcTagStatus.PLCTAG_ERR_TIMEOUT;
}

/**
 * Read a tag with automatic status waiting
 *
 * @param tag - Tag handle
 * @param timeoutMs - Timeout in milliseconds
 * @returns Status code
 */
export async function readTagAsync(tag: TagHandle, timeoutMs: number = 5000): Promise<number> {
  const status = plc_tag_read(tag, 0); // Non-blocking

  if (isStatusError(status) && !isStatusPending(status)) {
    return status;
  }

  return waitForStatus(tag, timeoutMs);
}

/**
 * Initiate non-blocking reads on a whole BATCH of tags and resolve all of
 * their final statuses with a SINGLE status-sweep loop.
 *
 * Why this exists (2026-06-07 central-server soak, 19 concurrent MCMs):
 * readTagAsync() runs one waitForStatus() per tag — its own setTimeout
 * backoff chain and promise machinery PER TAG. One reader polling ~1,300
 * tags per 75 ms cycle multiplied by 19 registry PlcClients produced
 * hundreds of thousands of timers/sec; the Node event loop saturated
 * (health p50 ~650 ms, p99 3.9 s) while CPU sat half-idle. This helper
 * issues the same plc_tag_read(…, 0) initiations — identical CIP traffic
 * and in-flight concurrency — but polls ALL still-pending handles from one
 * shared timer tick, collapsing O(tags) timer chains per batch into O(1).
 *
 * Per-tag read latency is unchanged: libplctag completes each read in its
 * own threads; the sweep notices completions within ≤tick ms (5–25 ms),
 * the same order as the old per-tag backoff. State-change detection stays
 * instant — this changes bookkeeping, not CIP behavior.
 *
 * @returns one final status per input handle, same order as `tags`.
 */
export async function readTagsBatchAsync(tags: TagHandle[], timeoutMs: number = 5000): Promise<number[]> {
  const statuses: number[] = new Array(tags.length).fill(PlcTagStatus.PLCTAG_ERR_BAD_STATUS);
  const pending = new Set<number>(); // indices into `tags`

  for (let i = 0; i < tags.length; i++) {
    try {
      const st = plc_tag_read(tags[i], 0); // Non-blocking initiate
      if (isStatusPending(st)) {
        pending.add(i);
      } else {
        statuses[i] = st;
      }
    } catch {
      statuses[i] = PlcTagStatus.PLCTAG_ERR_BAD_STATUS;
    }
  }

  const start = Date.now();
  let tick = 5; // ms — same starting cadence as waitForStatus
  while (pending.size > 0) {
    const elapsed = Date.now() - start;
    if (elapsed > timeoutMs) {
      for (const i of pending) statuses[i] = PlcTagStatus.PLCTAG_ERR_TIMEOUT;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, tick));
    tick = Math.min(tick * 1.5, 25); // cap low — one timer serves the whole batch
    for (const i of Array.from(pending)) {
      try {
        const st = plc_tag_status(tags[i]);
        if (!isStatusPending(st)) {
          statuses[i] = st;
          pending.delete(i);
        }
      } catch {
        statuses[i] = PlcTagStatus.PLCTAG_ERR_BAD_STATUS;
        pending.delete(i);
      }
    }
  }

  return statuses;
}

/**
 * Write a tag with automatic status waiting
 *
 * @param tag - Tag handle
 * @param timeoutMs - Timeout in milliseconds
 * @returns Status code
 */
export async function writeTagAsync(tag: TagHandle, timeoutMs: number = 5000): Promise<number> {
  const status = plc_tag_write(tag, 0); // Non-blocking

  if (isStatusError(status) && !isStatusPending(status)) {
    return status;
  }

  return waitForStatus(tag, timeoutMs);
}

/**
 * Create a tag without blocking the event loop.
 *
 * `plc_tag_create(attrib, 0)` returns a handle immediately with status
 * PENDING; the CIP session/handshake completes in libplctag's own threads
 * while we poll via waitForStatus. Contrast with createTag(), whose
 * synchronous timeout parks the WHOLE Node event loop for the round-trip
 * (the VFD validation writer doing 338 of those every 10 s was the
 * 2026-06-05 MCM02 "tool frozen, all API calls take 10 s" incident).
 *
 * Returns the handle and the FINAL status. On any non-OK status the caller
 * MUST still plc_tag_destroy() a non-negative handle — unlike the sync
 * create, a failed async create usually has a live handle to clean up.
 * A negative handle means creation failed before a handle existed; the
 * handle value itself is then the error code.
 */
export async function createTagAsync(
  config: PlcTagConfig,
  timeoutMs: number = 5000,
): Promise<{ handle: TagHandle; status: number }> {
  const attribStr = buildAttributeString(config);
  const handle = plc_tag_create(attribStr, 0); // Non-blocking

  if (handle < 0) {
    // Immediate failure — error code returned in place of a handle.
    return { handle, status: handle };
  }

  const status = await waitForStatus(handle, timeoutMs);
  return { handle, status };
}

// ============================================================================
// Re-exports from types
// ============================================================================

export {
  PlcTagStatus,
  PlcTagDebugLevel,
  type TagHandle,
  type PlcTagConfig,
  type PlcTagStatusCode,
  type PlcTagDebugLevelType,
  buildAttributeString,
  getStatusMessage,
  isStatusOk,
  isStatusPending,
  isStatusError,
  isValidTagHandle,
} from "./types";
