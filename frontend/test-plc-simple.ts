#!/usr/bin/env tsx
/**
 * Simple PLC Connection Test
 *
 * Usage:
 *   npm run test:plc:simple                    # Just test connection
 *   npm run test:plc:simple -- --tag MyTag     # Test specific tag
 */

import {
  initLibrary,
  closeLibrary,
  getLibraryPath,
  createTag,
  plc_tag_destroy,
  plc_tag_read,
  plc_tag_get_bit,
  plc_tag_get_int32,
  PlcTagStatus,
  isStatusOk,
  getStatusMessage,
  isValidTagHandle,
} from "./lib/plc";

// Parse CLI args
const args = process.argv.slice(2);
const tagIndex = args.indexOf('--tag');
const tagName = tagIndex !== -1 ? args[tagIndex + 1] : null;

const PLC_IP = process.env.PLC_IP || "192.168.20.40";
const PLC_PATH = process.env.PLC_PATH || "1,0";

console.log("\n=== Node.js PLC Test (ffi-rs + libplctag) ===\n");

try {
  // 1. Load library
  initLibrary();
  console.log(`✓ Library loaded: ${getLibraryPath()}`);

  // 2. Test connection by creating a simple tag
  console.log(`\nConnecting to PLC at ${PLC_IP} (path: ${PLC_PATH})...`);

  if (tagName) {
    // Test specific tag
    console.log(`\nTesting tag: ${tagName}`);

    const attribStr = `protocol=ab_eip&gateway=${PLC_IP}&path=${PLC_PATH}&name=${tagName}&elem_size=4&elem_count=1`;
    const handle = createTag({
      protocol: "ab_eip",
      gateway: PLC_IP,
      path: PLC_PATH,
      name: tagName,
      elemSize: 4,
      elemCount: 1,
      timeout: 5000,
    });

    if (isValidTagHandle(handle)) {
      console.log(`✓ Tag created (handle: ${handle})`);

      // Read the tag
      const readStatus = plc_tag_read(handle, 1000);
      if (isStatusOk(readStatus)) {
        const value = plc_tag_get_int32(handle, 0);
        const bit0 = plc_tag_get_bit(handle, 0);
        console.log(`✓ Tag value: ${value} (bit 0: ${bit0})`);
      } else {
        console.log(`✗ Read failed: ${getStatusMessage(readStatus)}`);
      }

      plc_tag_destroy(handle);
    } else {
      console.log(`✗ Tag creation failed: ${getStatusMessage(handle)}`);

      // Check if it's a connection error vs tag not found
      if (handle === PlcTagStatus.PLCTAG_ERR_NOT_FOUND) {
        console.log("  → PLC connected but tag doesn't exist");
      } else if (handle === PlcTagStatus.PLCTAG_ERR_TIMEOUT) {
        console.log("  → Connection timeout - check PLC IP/path");
      }
    }
  } else {
    // Just verify we can connect (try a non-existent tag, expect NOT_FOUND)
    const testHandle = createTag({
      protocol: "ab_eip",
      gateway: PLC_IP,
      path: PLC_PATH,
      name: "__CONNECTION_TEST__",
      elemSize: 1,
      elemCount: 1,
      timeout: 5000,
    });

    if (testHandle === PlcTagStatus.PLCTAG_ERR_NOT_FOUND) {
      console.log("✓ PLC connection successful (test tag not found as expected)");
    } else if (testHandle === PlcTagStatus.PLCTAG_ERR_TIMEOUT) {
      console.log("✗ Connection timeout - PLC not reachable");
    } else if (isValidTagHandle(testHandle)) {
      console.log("✓ PLC connection successful");
      plc_tag_destroy(testHandle);
    } else {
      console.log(`✗ Connection failed: ${getStatusMessage(testHandle)}`);
    }

    console.log("\nTo test a specific tag, run:");
    console.log("  npm run test:plc:simple -- --tag YourTagName");
  }

} catch (error) {
  console.error("Error:", error);
} finally {
  closeLibrary();
  console.log("\n✓ Cleanup complete\n");
}
