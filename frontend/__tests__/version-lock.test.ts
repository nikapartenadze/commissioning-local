/**
 * Version lockout (FV-HARDENING-PLAN.md F7): a tool running below the
 * cloud-set minimum version must refuse mutating work, survive restarts while
 * offline (persisted policy), but FAIL OPEN when no policy has ever been seen
 * (offline-first tablets must keep working).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'

const { tmpDir, mockManifest } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const _os = require('os') as typeof import('os')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const _fs = require('fs') as typeof import('fs')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const _path = require('path') as typeof import('path')
  const d = _fs.mkdtempSync(_path.join(_os.tmpdir(), 'version-lock-test-'))
  return {
    tmpDir: d,
    mockManifest: { current: null as any },
  }
})

vi.mock('@/lib/storage-paths', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/storage-paths')>()
  return {
    ...actual,
    resolveUpdateStatePath: () => path.join(tmpDir, 'update-status.json'),
  }
})

vi.mock('@/lib/update/update-utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/update/update-utils')>()
  return {
    ...actual,
    getCurrentAppVersion: () => '2.42.10',
    fetchReleaseManifest: vi.fn(async () => mockManifest.current ?? { manifestUrl: 'x', manifest: null, error: 'unreachable' }),
  }
})

import {
  evaluateVersionLock,
  getVersionLockState,
  refreshVersionLock,
  resolveVersionLockPath,
  isVersionLockExempt,
  createVersionLockGuard,
  _resetVersionLockForTests,
  _setPolicyForTests,
  type VersionLockState,
} from '@/lib/update/version-lock'

beforeEach(() => {
  _resetVersionLockForTests()
  mockManifest.current = null
  try { fs.unlinkSync(resolveVersionLockPath()) } catch { /* absent */ }
})

// ── Pure evaluation matrix ──────────────────────────────────────────────────

describe('evaluateVersionLock — the lock decision matrix', () => {
  const cases: Array<{ current: string; min: string | null; locked: boolean; why: string }> = [
    { current: '2.42.10', min: '2.43.0', locked: true, why: 'below minimum → locked (the incident case)' },
    { current: '2.43.0', min: '2.43.0', locked: false, why: 'exactly minimum → allowed' },
    { current: '2.43.1', min: '2.43.0', locked: false, why: 'above minimum → allowed' },
    { current: '2.42.10', min: null, locked: false, why: 'no policy configured → allowed' },
    { current: '3.0.0', min: '2.43.0', locked: false, why: 'major above → allowed' },
    { current: '2.9.0', min: '2.43.0', locked: true, why: 'numeric (not lexicographic) compare: 9 < 43' },
    { current: 'v2.42.10', min: '2.43.0', locked: true, why: 'v-prefix tolerated' },
  ]
  for (const c of cases) {
    it(c.why, () => {
      const state = evaluateVersionLock(
        c.current,
        c.min === null ? null : { minVersion: c.min, lockMessage: null, fetchedAt: '' },
        'live',
      )
      expect(state.locked).toBe(c.locked)
    })
  }

  it('carries the operator-facing lockMessage through', () => {
    const state = evaluateVersionLock('1.0.0', { minVersion: '2.0.0', lockMessage: 'FV data-safety fix required', fetchedAt: '' }, 'live')
    expect(state.locked).toBe(true)
    expect(state.lockMessage).toBe('FV data-safety fix required')
  })
})

// ── Policy lifecycle: fetch, persist, restore, fail-open ────────────────────

describe('refreshVersionLock — policy lifecycle', () => {
  it('FAILS OPEN when no policy has ever been seen and the cloud is unreachable', async () => {
    mockManifest.current = { manifestUrl: 'x', manifest: null, error: 'offline' }
    const state = await refreshVersionLock()
    expect(state.locked).toBe(false)
    expect(state.policySource).toBe('none')
  })

  it('locks when the manifest advertises a minVersion above the running version', async () => {
    mockManifest.current = { manifestUrl: 'x', manifest: { version: '2.43.0', installerUrl: 'http://x/i.exe', minVersion: '2.43.0', lockMessage: 'update!' } }
    const state = await refreshVersionLock()
    expect(state.locked).toBe(true)
    expect(state.minVersion).toBe('2.43.0')
    expect(state.lockMessage).toBe('update!')
    expect(state.policySource).toBe('live')
  })

  it('a manifest WITHOUT policy fields unlocks nothing and breaks nothing (older cloud)', async () => {
    mockManifest.current = { manifestUrl: 'x', manifest: { version: '2.43.0', installerUrl: 'http://x/i.exe' } }
    const state = await refreshVersionLock()
    expect(state.locked).toBe(false)
    expect(state.minVersion).toBeNull()
  })

  it('keeps the last-seen policy in force when the cloud becomes unreachable (no self-unlock by going offline)', async () => {
    mockManifest.current = { manifestUrl: 'x', manifest: { version: '2.43.0', installerUrl: 'http://x/i.exe', minVersion: '2.43.0' } }
    await refreshVersionLock()
    mockManifest.current = { manifestUrl: 'x', manifest: null, error: 'offline' }
    const state = await refreshVersionLock()
    expect(state.locked).toBe(true)
  })

  it('persists the policy so a RESTART while offline stays locked', async () => {
    mockManifest.current = { manifestUrl: 'x', manifest: { version: '2.43.0', installerUrl: 'http://x/i.exe', minVersion: '2.43.0', lockMessage: 'm' } }
    await refreshVersionLock()
    expect(fs.existsSync(resolveVersionLockPath())).toBe(true)

    // Simulate a fresh process: module state wiped, disk re-read.
    _resetVersionLockForTests({ rereadDisk: true })
    const state = getVersionLockState()
    expect(state.locked).toBe(true)
    expect(state.policySource).toBe('persisted')
  })

  it('a withdrawn policy (minVersion null) also persists — restart stays unlocked', async () => {
    mockManifest.current = { manifestUrl: 'x', manifest: { version: '2.43.0', installerUrl: 'http://x/i.exe', minVersion: '2.43.0' } }
    await refreshVersionLock()
    mockManifest.current = { manifestUrl: 'x', manifest: { version: '2.43.0', installerUrl: 'http://x/i.exe', minVersion: null } }
    const state = await refreshVersionLock()
    expect(state.locked).toBe(false)

    _resetVersionLockForTests({ rereadDisk: true })
    expect(getVersionLockState().locked).toBe(false)
  })
})

// ── Express guard ───────────────────────────────────────────────────────────

function fakeReqRes(method: string, pathName: string) {
  const req: any = { method, path: pathName }
  const res: any = {
    statusCode: 200,
    body: undefined,
    status(c: number) { this.statusCode = c; return this },
    json(o: any) { this.body = o; return this },
  }
  const next = vi.fn()
  return { req, res, next }
}

const LOCKED: VersionLockState = {
  locked: true, currentVersion: '2.42.10', minVersion: '2.43.0', lockMessage: null, policySource: 'live',
}
const UNLOCKED: VersionLockState = { ...LOCKED, locked: false }

describe('version-lock Express guard', () => {
  it('blocks a mutating data route with 503 version_locked while locked', () => {
    const guard = createVersionLockGuard(() => LOCKED)
    const { req, res, next } = fakeReqRes('POST', '/api/l2/cell')
    guard(req, res, next)
    expect(next).not.toHaveBeenCalled()
    expect(res.statusCode).toBe(503)
    expect(res.body.error).toBe('version_locked')
    expect(res.body.minVersion).toBe('2.43.0')
  })

  it.each([
    ['POST', '/api/update/install'],
    ['POST', '/api/auth/login'],
    ['POST', '/api/config'],
    ['POST', '/api/cloud/status/refresh'],
    ['POST', '/api/logs/rotate'],
    ['POST', '/api/health/check'],
  ])('allowlisted %s %s passes through while locked', (method, p) => {
    const guard = createVersionLockGuard(() => LOCKED)
    const { req, res, next } = fakeReqRes(method, p)
    guard(req, res, next)
    expect(next).toHaveBeenCalled()
  })

  it('GET requests are never blocked (read-only stays available)', () => {
    const guard = createVersionLockGuard(() => LOCKED)
    const { req, res, next } = fakeReqRes('GET', '/api/l2')
    guard(req, res, next)
    expect(next).toHaveBeenCalled()
  })

  it('non-API paths (client assets) are never blocked', () => {
    const guard = createVersionLockGuard(() => LOCKED)
    const { req, res, next } = fakeReqRes('POST', '/some/client/route')
    guard(req, res, next)
    expect(next).toHaveBeenCalled()
  })

  it('everything passes when unlocked', () => {
    const guard = createVersionLockGuard(() => UNLOCKED)
    const { req, res, next } = fakeReqRes('POST', '/api/l2/cell')
    guard(req, res, next)
    expect(next).toHaveBeenCalled()
  })

  it('a lookalike prefix (/api/updates-feed) is NOT exempt', () => {
    expect(isVersionLockExempt('POST', '/api/update')).toBe(true)
    expect(isVersionLockExempt('POST', '/api/update/install')).toBe(true)
    expect(isVersionLockExempt('POST', '/api/updates-feed')).toBe(false)
  })

  it('blocks writes with 503 "updating" while an install is in flight — and releases when it ends', () => {
    let updating = true
    const guard = createVersionLockGuard(() => UNLOCKED, () => updating)
    let { req, res, next } = fakeReqRes('POST', '/api/l2/cell')
    guard(req, res, next)
    expect(next).not.toHaveBeenCalled()
    expect(res.statusCode).toBe(503)
    expect(res.body.error).toBe('updating')

    // Graceful fallback: install failed/finished → terminal state → writes flow.
    updating = false
    ;({ req, res, next } = fakeReqRes('POST', '/api/l2/cell'))
    guard(req, res, next)
    expect(next).toHaveBeenCalled()
  })

  it('the update/status/auth surface stays reachable during an update', () => {
    const guard = createVersionLockGuard(() => UNLOCKED, () => true)
    for (const p of ['/api/update/install', '/api/auth/login', '/api/health/check']) {
      const { req, res, next } = fakeReqRes('POST', p)
      guard(req, res, next)
      expect(next).toHaveBeenCalled()
    }
  })

  it('guard consults live state via _setPolicyForTests + getVersionLockState default', () => {
    _setPolicyForTests({ minVersion: '2.43.0', lockMessage: null, fetchedAt: '' }, 'live')
    const guard = createVersionLockGuard()
    const { req, res, next } = fakeReqRes('POST', '/api/ios/1/test')
    guard(req, res, next)
    expect(res.statusCode).toBe(503)
    expect(next).not.toHaveBeenCalled()
  })
})
