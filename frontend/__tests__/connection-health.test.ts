import { describe, it, expect, beforeEach } from 'vitest'
import {
  classifyContact,
  deriveConnectionHealth,
  runProbe,
  recordCloudSuccess,
  recordCloudHttpFailure,
  recordCloudNetworkFailure,
  getRecordedContacts,
  _resetConnectionHealthStore,
  CONNECTION_FRESHNESS_MS,
  type CloudContact,
  type HealthInputs,
  type SseSnapshot,
  type ConnectionHealthState,
} from '@/lib/cloud/connection-health'

const NOW = 1_000_000

function inputs(partial: Partial<HealthInputs>): HealthInputs {
  return {
    now: NOW,
    cloudUrl: 'https://cloud.example',
    waitingCount: 0,
    contact: null,
    lastSuccess: null,
    sse: null,
    freshnessMs: CONNECTION_FRESHNESS_MS,
    ...partial,
  }
}

const sse = (state: SseSnapshot['state'], lastEventAt: number | null = null): SseSnapshot => ({ state, lastEventAt })

// ─── classifyContact: each state from its inputs ────────────────────────────

describe('classifyContact — one measured contact → one state', () => {
  const cases: Array<[CloudContact, ConnectionHealthState]> = [
    [{ at: NOW, kind: 'success' }, 'connected'],
    [{ at: NOW, kind: 'network', message: 'fetch failed' }, 'unreachable'],
    [{ at: NOW, kind: 'http', httpStatus: 401 }, 'auth_error'],
    [{ at: NOW, kind: 'http', httpStatus: 403 }, 'auth_error'],
    [{ at: NOW, kind: 'http', httpStatus: 500 }, 'server_error'],
    [{ at: NOW, kind: 'http', httpStatus: 503 }, 'server_error'],
    [{ at: NOW, kind: 'http', httpStatus: 429 }, 'server_error'],
    [{ at: NOW, kind: 'http', httpStatus: 400 }, 'server_error'],
    [{ at: NOW, kind: 'http', httpStatus: 404 }, 'server_error'],
  ]
  it.each(cases)('%o → %s', (contact, expected) => {
    expect(classifyContact(contact)).toBe(expected)
  })

  it('treats 403 (project-key mismatch) as auth_error, never as unreachable/server', () => {
    // The headline incident: apiPassword doesn't match the project key. It is
    // deterministic and needs a human, so it must be its own state.
    expect(classifyContact({ at: NOW, kind: 'http', httpStatus: 403 })).toBe('auth_error')
  })
})

// ─── deriveConnectionHealth: each state + the honesty guarantees ─────────────

describe('deriveConnectionHealth — measured state machine', () => {
  it('unknown when nothing has been measured and no stream exists', () => {
    const h = deriveConnectionHealth(inputs({}))
    expect(h.state).toBe('unknown')
    expect(h.lastSuccessAt).toBeNull()
  })

  it('NEVER reports connected from absence — unknown ≠ connected', () => {
    // No contact, and every non-connected SSE state, must not read as connected.
    for (const s of [null, sse('disconnected'), sse('connecting')] as Array<SseSnapshot | null>) {
      const h = deriveConnectionHealth(inputs({ sse: s }))
      expect(h.state).not.toBe('connected')
    }
    // Empty-input case specifically is 'unknown'.
    expect(deriveConnectionHealth(inputs({})).state).toBe('unknown')
  })

  it('connected from a fresh measured success, with lastSuccessAt', () => {
    const at = NOW - 8_000
    const h = deriveConnectionHealth(inputs({ contact: { at, kind: 'success' }, lastSuccess: { at, kind: 'success' } }))
    expect(h.state).toBe('connected')
    expect(h.lastSuccessAt).toBe(new Date(at).toISOString())
    expect(h.lastError).toBeNull()
  })

  it('connected from a live SSE stream even with no recorded contact yet', () => {
    const h = deriveConnectionHealth(inputs({ sse: sse('connected', NOW - 2_000) }))
    expect(h.state).toBe('connected')
    expect(h.lastSuccessAt).toBe(new Date(NOW - 2_000).toISOString())
  })

  it('auth_error when SSE reports auth-failed — decisive, even over a fresh success', () => {
    // A public health endpoint answering 200 must NOT mask a rejected key.
    const h = deriveConnectionHealth(
      inputs({ contact: { at: NOW, kind: 'success' }, lastSuccess: { at: NOW, kind: 'success' }, sse: sse('auth-failed') }),
    )
    expect(h.state).toBe('auth_error')
  })

  it('auth_error carries the real HTTP status from the measured contact', () => {
    const h = deriveConnectionHealth(inputs({ contact: { at: NOW, kind: 'http', httpStatus: 403, message: 'HTTP 403' } }))
    expect(h.state).toBe('auth_error')
    expect(h.lastError?.httpStatus).toBe(403)
  })

  it('server_error from a fresh 5xx contact', () => {
    const h = deriveConnectionHealth(inputs({ contact: { at: NOW, kind: 'http', httpStatus: 503, message: 'HTTP 503' } }))
    expect(h.state).toBe('server_error')
    expect(h.lastError?.httpStatus).toBe(503)
  })

  it('unreachable from a fresh network failure', () => {
    const h = deriveConnectionHealth(inputs({ contact: { at: NOW, kind: 'network', message: 'ECONNREFUSED' } }))
    expect(h.state).toBe('unreachable')
    expect(h.lastError?.message).toBe('ECONNREFUSED')
  })

  it('a STALE success is not connected — reports unreachable while SSE reconnects, keeping lastSuccessAt', () => {
    const at = NOW - 5 * 60_000 // 5 min ago, well past freshness
    const h = deriveConnectionHealth(
      inputs({ contact: { at, kind: 'success' }, lastSuccess: { at, kind: 'success' }, sse: sse('reconnecting') }),
    )
    expect(h.state).toBe('unreachable')
    expect(h.lastSuccessAt).toBe(new Date(at).toISOString())
  })

  it('recovery: an old failure contact but a live SSE stream reads connected', () => {
    const h = deriveConnectionHealth(
      inputs({ contact: { at: NOW - 10_000, kind: 'http', httpStatus: 500 }, sse: sse('connected', NOW - 1_000) }),
    )
    expect(h.state).toBe('connected')
    expect(h.lastError).toBeNull()
  })

  it('a failure older than the window still reports its failure (failures do not expire)', () => {
    const at = NOW - 10 * 60_000
    const h = deriveConnectionHealth(inputs({ contact: { at, kind: 'http', httpStatus: 502, message: 'HTTP 502' } }))
    expect(h.state).toBe('server_error')
  })

  it('passes through cloudUrl and waitingCount untouched', () => {
    const h = deriveConnectionHealth(inputs({ cloudUrl: 'https://x.test', waitingCount: 47 }))
    expect(h.cloudUrl).toBe('https://x.test')
    expect(h.waitingCount).toBe(47)
  })

  it('connected/unknown never carry a lastError; failures always do', () => {
    expect(deriveConnectionHealth(inputs({ sse: sse('connected') })).lastError).toBeNull()
    expect(deriveConnectionHealth(inputs({})).lastError).toBeNull()
    expect(deriveConnectionHealth(inputs({ contact: { at: NOW, kind: 'network' } })).lastError).not.toBeNull()
  })
})

// ─── The measured store round-trips ─────────────────────────────────────────

describe('connection-health store', () => {
  beforeEach(() => _resetConnectionHealthStore())

  it('records success / http / network and remembers the last success separately', () => {
    recordCloudSuccess(NOW - 5_000)
    recordCloudHttpFailure(403, 'HTTP 403', NOW)
    const s = getRecordedContacts()
    expect(s.last?.kind).toBe('http')
    expect(s.last?.httpStatus).toBe(403)
    // The last SUCCESS survives a later failure — so lastSuccessAt stays honest.
    expect(s.lastSuccess?.kind).toBe('success')
    expect(s.lastSuccess?.at).toBe(NOW - 5_000)
  })

  it('a network failure updates last but not lastSuccess', () => {
    recordCloudSuccess(NOW - 1_000)
    recordCloudNetworkFailure('offline', NOW)
    const s = getRecordedContacts()
    expect(s.last?.kind).toBe('network')
    expect(s.lastSuccess?.at).toBe(NOW - 1_000)
  })
})

// ─── The probe times out rather than hanging ────────────────────────────────

describe('runProbe — never hangs', () => {
  it('aborts a hung request within the timeout and classifies it unreachable', async () => {
    // A fetch that never resolves on its own, only rejecting when aborted (like
    // the real one). If runProbe did not enforce its own timeout, this would
    // hang until the vitest testTimeout killed the whole run.
    const hangingFetch: typeof fetch = (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal ?? null
        const fail = () => reject(signal?.reason ?? new DOMException('aborted', 'AbortError'))
        if (signal) {
          if (signal.aborted) fail()
          else signal.addEventListener('abort', fail)
        }
      })

    const start = Date.now()
    const { contact, state } = await runProbe({ url: 'https://cloud.example', apiKey: 'k', timeoutMs: 100, fetchImpl: hangingFetch })
    const elapsed = Date.now() - start

    expect(state).toBe('unreachable')
    expect(contact.kind).toBe('network')
    expect(contact.message).toMatch(/timed out/)
    // Proves it resolved by its own budget, not by hanging.
    expect(elapsed).toBeLessThan(2_000)
  })

  it('classifies a live 200 as connected', async () => {
    const okFetch: typeof fetch = async () => ({ ok: true, status: 200 } as unknown as Response)
    const { state } = await runProbe({ url: 'https://cloud.example/', apiKey: 'k', fetchImpl: okFetch })
    expect(state).toBe('connected')
  })

  it('classifies a live 403 as auth_error and preserves the status', async () => {
    const forbidden: typeof fetch = async () => ({ ok: false, status: 403 } as unknown as Response)
    const { state, contact } = await runProbe({ url: 'https://cloud.example', apiKey: 'bad', fetchImpl: forbidden })
    expect(state).toBe('auth_error')
    expect(contact.httpStatus).toBe(403)
  })

  it('classifies a live 500 as server_error', async () => {
    const boom: typeof fetch = async () => ({ ok: false, status: 500 } as unknown as Response)
    const { state } = await runProbe({ url: 'https://cloud.example', apiKey: 'k', fetchImpl: boom })
    expect(state).toBe('server_error')
  })
})
