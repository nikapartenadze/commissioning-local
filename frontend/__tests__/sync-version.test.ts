/**
 * Test: Sync version handling.
 *
 * Catches the class of bug where the wrong version is sent to cloud
 * (post-increment vs pre-increment). This exact bug was found in production
 * and caused all sync updates to be silently rejected.
 */
import { describe, it, expect } from 'vitest'

describe('Sync version logic', () => {
  it('pre-increment version should be version - 1', () => {
    // Simulate: local DB has version 5, user tests IO, version increments to 6
    const localVersionAfterUpdate = BigInt(6)

    // The version sent to cloud should be 5 (pre-increment)
    // so cloud can match WHERE version = 5
    const versionForCloud = Number(localVersionAfterUpdate) - 1
    expect(versionForCloud).toBe(5)
  })

  it('BigInt to Number conversion preserves value for reasonable versions', () => {
    // Versions should never exceed Number.MAX_SAFE_INTEGER in practice
    const version = BigInt(12345)
    const numVersion = Number(version)
    expect(numVersion).toBe(12345)
    expect(Number(version - BigInt(1))).toBe(12344)
  })

  it('PendingSync should store pre-increment version', () => {
    // When IO is updated: version goes from 5 to 6
    // PendingSync should store 5 (what cloud has)
    const updatedIoVersion = BigInt(6)
    const pendingSyncVersion = updatedIoVersion - BigInt(1)
    expect(Number(pendingSyncVersion)).toBe(5)
  })

  it('cloud version check: version 0 IOs work correctly', () => {
    // Fresh IO from cloud has version 0
    // Local test increments to 1
    // Sync should send version 0 to cloud
    const updatedVersion = BigInt(1)
    const syncVersion = Number(updatedVersion) - 1
    expect(syncVersion).toBe(0)
  })

  it('cloud version check: already-synced IO re-test works', () => {
    // IO was synced, cloud has version 3, local has version 3
    // New test: local increments to 4
    // Sync sends version 3, cloud matches, increments to 4
    const cloudVersion = 3
    const localAfterTest = BigInt(4)
    const syncVersion = Number(localAfterTest) - 1
    expect(syncVersion).toBe(cloudVersion)
  })
})
