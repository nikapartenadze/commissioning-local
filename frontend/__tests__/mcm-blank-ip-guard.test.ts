/**
 * Test: blank-IP connect guard (central multi-MCM switching bug).
 *
 * A central deployment lists many MCMs in config.mcms[], most with a blank
 * `ip:""` until the operator fills each station in. Selecting/connecting an MCM
 * that has no IP must NOT fall through to a live PLC connect — the old behavior
 * dialed an empty host, failed, and scheduled a reconnect that hammered it
 * every few seconds, spamming disconnect broadcasts. The fix makes connectMcm()
 * return a terminal "No PLC IP configured" result WITHOUT creating or dialing a
 * client (and never schedules a reconnect).
 *
 * The guard returns before ensureLibrary()/createPlcClient(), so this test
 * needs no libplctag native binding.
 */
import { describe, it, expect } from 'vitest'
import { connectMcm, hasMcm } from '@/lib/mcm-registry'

describe('connectMcm blank-IP guard', () => {
  it('rejects an empty IP with a terminal, non-reconnecting result', async () => {
    const r = await connectMcm('9901', 'MCM-NOIP', { ip: '', path: '1,0' })
    expect(r.success).toBe(false)
    expect(r.plcReachable).toBe(false)
    // Terminal state — NOT 'error' (which the toolbar reads as "reconnecting…")
    expect(r.status).toBe('disconnected')
    expect(r.error).toMatch(/no plc ip configured/i)
    expect(r.error).toContain('MCM-NOIP')
  })

  it('rejects a whitespace-only IP the same way', async () => {
    const r = await connectMcm('9902', 'MCM-WS', { ip: '   ', path: '1,0' })
    expect(r.success).toBe(false)
    expect(r.status).toBe('disconnected')
    expect(r.error).toMatch(/no plc ip configured/i)
  })

  it('does NOT register a client for a blank-IP MCM (no dial, no retry loop)', async () => {
    await connectMcm('9903', 'MCM-NOIP-3', { ip: '', path: '1,0' })
    // The registry must not have created an entry — nothing to reconnect to.
    expect(hasMcm('9903')).toBe(false)
  })

  it('falls back to the subsystemId in the message when name is empty', async () => {
    const r = await connectMcm('9904', '', { ip: '', path: '1,0' })
    expect(r.error).toContain('9904')
  })
})
