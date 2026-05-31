/**
 * Test: the app-side gateway-client speaks the protocol correctly and degrades
 * gracefully when the plc-gateway is unreachable or errors — a transient
 * gateway blip must surface as "not connected", never a thrown request handler.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import http from 'http'

let gatewayClient: typeof import('@/lib/plc/gateway-client').gatewayClient
let server: http.Server
let port = 0

function readBody(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve) => {
    let b = ''
    req.on('data', (c) => (b += c))
    req.on('end', () => {
      try { resolve(JSON.parse(b || '{}')) } catch { resolve({}) }
    })
  })
}

beforeAll(async () => {
  server = http.createServer(async (req, res) => {
    const url = req.url || ''
    res.setHeader('Content-Type', 'application/json')
    if (req.method === 'GET' && url === '/health') {
      return res.end(JSON.stringify({ ok: true, service: 'plc-gateway', version: 'test', uptimeSec: 1, mcmCount: 1, connectedCount: 1 }))
    }
    if (req.method === 'GET' && url === '/state') {
      return res.end(JSON.stringify({
        mcms: [{ subsystemId: '41', name: 'MCM01', ip: '10.0.0.1', path: '1,0', connected: true, status: 'connected', tagCount: 1 }],
        aggregate: { anyConnected: true, connectedCount: 1, totalCount: 1, totalTagCount: 1 },
        tags: [{ id: 1, name: 'T', state: 'TRUE', subsystemId: '41' }],
        network: [],
      }))
    }
    if (req.method === 'POST' && /\/mcm\/.+\/connect$/.test(url)) {
      const body = await readBody(req)
      return res.end(JSON.stringify({ success: true, status: 'connected', tagsSuccessful: (body.tags || []).length }))
    }
    if (req.method === 'POST' && /\/mcm\/.+\/io\/write$/.test(url)) {
      const body = await readBody(req)
      return res.end(JSON.stringify({ connected: true, success: true, currentState: body.value === 1 }))
    }
    if (req.method === 'POST' && /\/mcm\/.+\/disconnect$/.test(url)) {
      return res.end(JSON.stringify({ success: true }))
    }
    if (req.method === 'GET' && /\/mcm\/.+\/status$/.test(url)) {
      // Simulate an error path that still returns structured JSON.
      res.statusCode = 500
      return res.end(JSON.stringify(null))
    }
    res.statusCode = 404
    res.end(JSON.stringify({ error: 'not found' }))
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  port = (server.address() as any).port
  process.env.GATEWAY_URL = `http://127.0.0.1:${port}`
  ;({ gatewayClient } = await import('@/lib/plc/gateway-client'))
})

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()))
})

describe('gateway-client protocol', () => {
  it('getState parses the snapshot', async () => {
    const s = await gatewayClient.getState()
    expect(s.mcms).toHaveLength(1)
    expect(s.mcms[0].subsystemId).toBe('41')
    expect(s.aggregate.anyConnected).toBe(true)
    expect(s.tags[0].state).toBe('TRUE')
  })

  it('connect forwards tags and parses the result', async () => {
    const r = await gatewayClient.connect('41', 'MCM01', { ip: '10.0.0.1', path: '1,0' }, [
      { id: 1, name: 'T' } as any,
    ])
    expect(r.success).toBe(true)
    expect(r.status).toBe('connected')
    expect(r.tagsSuccessful).toBe(1)
  })

  it('writeIo returns connectivity + state', async () => {
    const r = await gatewayClient.writeIo('41', { id: 1, name: 'T' }, 1)
    expect(r.connected).toBe(true)
    expect(r.success).toBe(true)
    expect(r.currentState).toBe(true)
  })

  it('getStatus surfaces a 500 body without throwing', async () => {
    const r = await gatewayClient.getStatus('41')
    expect(r).toBeNull()
  })
})

describe('gateway-client graceful degradation', () => {
  it('returns EMPTY_STATE when the gateway is unreachable', async () => {
    // Point at a dead port via a fresh module instance.
    const { vi } = await import('vitest')
    vi.resetModules()
    process.env.GATEWAY_URL = 'http://127.0.0.1:1' // nothing listens here
    const fresh = await import('@/lib/plc/gateway-client')
    const s = await fresh.gatewayClient.getState()
    expect(s.mcms).toHaveLength(0)
    expect(s.aggregate.anyConnected).toBe(false)
    const w = await fresh.gatewayClient.writeIo('41', { id: 1, name: 'T' }, 1)
    expect(w.connected).toBe(false)
    expect(w.success).toBe(false)
  })
})
