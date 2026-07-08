"use client"

/**
 * Ring Commissioning panel — on-demand, read-only, isolated.
 *
 * Two operator actions: Capture (read actual wiring → review against the print →
 * Confirm & Save Baseline) and Check (re-read → compare to the locked baseline).
 * Nothing runs unless a button is pressed. When SNMP is unconfigured/unreachable
 * the panel shows the reason as plain text — never an error, never affects the
 * rest of the Network page or the tool.
 */
import { useState } from 'react'
import { authFetch } from '@/lib/api-config'
import { verdictBadge, verdictHeadline } from '@/lib/ring-commissioning/verdict-format'
import type { RingCommissioningVerdict } from '@/lib/plc/network/ring-commissioning/compare'
import type { RingTopology } from '@/lib/plc/network/ring-commissioning/types'

interface Props { subsystemId?: number }
type Phase = 'idle' | 'capturing' | 'review' | 'checking'

export function RingCommissioningView({ subsystemId }: Props) {
  const [phase, setPhase] = useState<Phase>('idle')
  const [message, setMessage] = useState<string | null>(null)
  const [captured, setCaptured] = useState<{ ringName: string; topology: RingTopology } | null>(null)
  const [verdict, setVerdict] = useState<RingCommissioningVerdict | null>(null)
  const [approvedBy, setApprovedBy] = useState('')

  const body = subsystemId ? { subsystemId } : {}

  async function capture() {
    setPhase('capturing'); setMessage(null); setVerdict(null)
    try {
      const r = await authFetch('/api/network/ring/capture', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      const d = await r.json()
      if (!d.ok) { setMessage(d.reason); setPhase('idle'); return }
      setCaptured(d.ring); setPhase('review')
    } catch (e) { setMessage(e instanceof Error ? e.message : 'capture failed'); setPhase('idle') }
  }

  async function saveBaseline() {
    if (!captured) return
    try {
      const r = await authFetch('/api/network/ring/baseline', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...body, ringName: captured.ringName, topology: captured.topology, approvedBy }) })
      const d = await r.json()
      setMessage(d.ok ? 'Baseline approved and locked.' : d.reason)
      if (d.ok) setPhase('idle')
    } catch (e) { setMessage(e instanceof Error ? e.message : 'save failed') }
  }

  async function check() {
    if (!captured?.ringName) { setMessage('Capture a ring first (need its name).'); return }
    setPhase('checking'); setMessage(null)
    try {
      const r = await authFetch('/api/network/ring/check', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...body, ringName: captured.ringName }) })
      const d = await r.json()
      if (!d.ok) { setMessage(d.reason); setPhase('idle'); return }
      setVerdict(d.verdict); setPhase('idle')
    } catch (e) { setMessage(e instanceof Error ? e.message : 'check failed'); setPhase('idle') }
  }

  const issues = verdict ? [...verdict.links, ...verdict.leafVerdicts, ...verdict.terminationFaults].filter(l => l.kind !== 'match') : []

  return (
    <div className="border rounded-lg p-4 bg-card space-y-3">
      <div className="flex items-center gap-2">
        <h3 className="font-semibold text-sm">Ring Commissioning</h3>
        <span className="text-[10px] text-muted-foreground">on-demand · read-only · field-unverified</span>
      </div>
      <div className="flex gap-2">
        <button onClick={capture} disabled={phase === 'capturing'} className="px-3 py-1.5 text-sm rounded-md border bg-card hover:bg-accent disabled:opacity-50">
          {phase === 'capturing' ? 'Capturing…' : 'Capture Ring Topology'}
        </button>
        <button onClick={check} disabled={phase === 'checking'} className="px-3 py-1.5 text-sm rounded-md border bg-card hover:bg-accent disabled:opacity-50">
          {phase === 'checking' ? 'Checking…' : 'Check Ring'}
        </button>
      </div>

      {message && <p className="text-sm text-muted-foreground">{message}</p>}

      {phase === 'review' && captured && (
        <div className="space-y-2 border-t pt-3">
          <p className="text-sm">
            Captured <span className="font-mono">{captured.ringName}</span>: {captured.topology.links.length} switch links,{' '}
            {captured.topology.leaves.length} leaf placements, ring {captured.topology.ring.closed ? 'closed' : 'open'} ({captured.topology.ring.reason}).
          </p>
          <p className="text-xs text-amber-600">Confirm this matches the drawing before saving — this becomes the approved baseline.</p>
          <div className="flex items-center gap-2">
            <input value={approvedBy} onChange={e => setApprovedBy(e.target.value)} placeholder="Your name" className="px-2 py-1 text-sm rounded border bg-background" />
            <button onClick={saveBaseline} className="px-3 py-1.5 text-sm rounded-md border bg-primary/10 text-primary hover:bg-primary/20">Confirm &amp; Save Baseline</button>
          </div>
        </div>
      )}

      {verdict && (
        <div className="space-y-2 border-t pt-3">
          <p className={`text-sm font-medium ${verdict.healthy ? 'text-emerald-600' : 'text-red-600'}`}>{verdictHeadline(verdict)}</p>
          {issues.length === 0 && !verdict.healthy && <p className="text-xs text-muted-foreground">Ring not healthy — see headline.</p>}
          {issues.map((l, i) => {
            const b = verdictBadge(l.kind)
            return (
              <div key={i} className="text-xs flex items-center gap-2">
                <span className={`px-1.5 py-0.5 rounded ${b.color === 'red' ? 'bg-red-500/10 text-red-600' : b.color === 'amber' ? 'bg-amber-500/10 text-amber-600' : 'bg-muted text-muted-foreground'}`}>{b.label}</span>
                <span className="text-muted-foreground">{l.detail}</span>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
