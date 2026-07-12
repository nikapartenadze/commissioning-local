'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { ShieldAlert, Download, Loader2, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'

/**
 * Full-screen, NON-dismissible version-lockout overlay (FV-HARDENING-PLAN.md F7).
 *
 * Shown when the cloud's minimum-version policy says this tool is too old to
 * be trusted with commissioning data (the 2026-07-11 FV loss came from a box
 * quietly running a version with a known destructive bug). While visible, the
 * server is also 503ing every mutating API call — this overlay is the honest
 * UI for that state, with the one action that fixes it: Update now.
 *
 * Lock-state sources (either flips it):
 *  - poll of GET /api/update/status (allowlisted while locked), every 30s
 *  - `version-lock-changed` window event from the PLC WS client (HeartbeatAck)
 *
 * It never unlocks client-side by itself: only a fresh state with locked:false
 * (i.e. the tool now runs >= minVersion, or the policy was withdrawn) hides it.
 * After a successful update the service restarts; the WS client's
 * version-change detection full-reloads onto fresh assets.
 */

interface VersionLockInfo {
  locked: boolean
  currentVersion: string
  minVersion: string | null
  lockMessage: string | null
  quarantined?: boolean
  quarantineMessage?: string | null
}

type InstallPhase = 'idle' | 'launching' | 'in-progress' | 'launch-failed'

export function VersionLockedOverlay() {
  const [lock, setLock] = useState<VersionLockInfo | null>(null)
  const [phase, setPhase] = useState<InstallPhase>('idle')
  const [installMessage, setInstallMessage] = useState<string | null>(null)
  const wasLockedRef = useRef(false)

  const applyStatus = useCallback((status: any) => {
    const vl = status?.versionLock
    if (vl && typeof vl.locked === 'boolean') {
      if (wasLockedRef.current && !vl.locked) {
        // Lock cleared (updated past minVersion, or policy withdrawn). Reload
        // so the operator is guaranteed fresh assets + unblocked API state.
        window.location.reload()
        return
      }
      wasLockedRef.current = vl.locked
      setLock(vl)
    }
    const st = status?.installState?.status
    if (st === 'checking' || st === 'downloading' || st === 'installing' || st === 'restarting') {
      setPhase('in-progress')
      setInstallMessage(status?.installState?.message ?? null)
    } else if (st === 'error') {
      setPhase(p => (p === 'in-progress' || p === 'launching' ? 'launch-failed' : p))
      setInstallMessage(status?.installState?.message ?? null)
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | null = null
    const poll = async () => {
      try {
        const res = await fetch('/api/update/status', { cache: 'no-store' })
        if (!cancelled && res.ok) applyStatus(await res.json())
      } catch { /* server unreachable — the connection guard handles that */ }
      if (!cancelled) timer = setTimeout(poll, wasLockedRef.current ? 10_000 : 30_000)
    }
    void poll()
    // Fast path: the WS client relays HeartbeatAck.versionLock as a window event.
    const onWsLock = (e: Event) => {
      const detail = (e as CustomEvent).detail
      if (detail) applyStatus({ versionLock: detail })
    }
    window.addEventListener('version-lock-changed', onWsLock)
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
      window.removeEventListener('version-lock-changed', onWsLock)
    }
  }, [applyStatus])

  const startUpdate = useCallback(async () => {
    setPhase('launching')
    setInstallMessage(null)
    try {
      const res = await fetch('/api/update/install', { method: 'POST' })
      const body = await res.json().catch(() => ({}))
      if (res.ok && body?.success) {
        setPhase('in-progress')
        setInstallMessage(body?.message ?? 'Installer launched — the tool will restart itself.')
      } else {
        setPhase('launch-failed')
        setInstallMessage(body?.error ?? body?.message ?? `HTTP ${res.status}`)
      }
    } catch (e) {
      setPhase('launch-failed')
      setInstallMessage(e instanceof Error ? e.message : 'network error')
    }
  }, [])

  if (!lock?.locked) return null

  return (
    <div
      role="alertdialog"
      aria-modal="true"
      aria-live="assertive"
      aria-label="Tool version locked — update required"
      className="fixed inset-0 z-[9998] flex items-center justify-center bg-slate-950/85 backdrop-blur-sm"
      onKeyDownCapture={(e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation() } }}
    >
      <div className="mx-4 max-w-lg rounded-xl border-2 border-amber-500/70 bg-card p-6 text-center shadow-2xl">
        <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-amber-500/15">
          <ShieldAlert className="h-7 w-7 text-amber-500" />
        </div>
        <h2 className="text-lg font-bold text-foreground">
          {lock.quarantined ? 'Tool paused by administrator' : 'Update required to continue'}
        </h2>
        <p className="mt-2 text-sm text-muted-foreground">
          {lock.quarantined
            ? (lock.quarantineMessage
              ?? 'This tool has been remotely paused by the administrator — contact the commissioning lead. Work already saved on this machine keeps syncing.')
            : lock.lockMessage
              ?? 'This version of the commissioning tool has been locked out because a newer version contains required data-safety fixes.'}
        </p>
        {!lock.quarantined && (
          <p className="mt-3 text-sm font-medium text-foreground">
            Running <span className="font-mono">{lock.currentVersion}</span> — minimum allowed{' '}
            <span className="font-mono">{lock.minVersion ?? '?'}</span>
          </p>
        )}

        {lock.quarantined ? (
          <p className="mt-5 text-xs text-muted-foreground">
            Updating does not clear a quarantine — only the administrator can release this tool.
            The screen clears itself automatically when released (checked every heartbeat).
          </p>
        ) : phase === 'in-progress' ? (
          <div className="mt-5 flex flex-col items-center gap-2">
            <Loader2 className="h-6 w-6 animate-spin text-amber-500" />
            <p className="text-sm text-muted-foreground">
              {installMessage ?? 'Updating…'} The tool restarts itself when done — this screen
              will be replaced automatically.
            </p>
          </div>
        ) : (
          <div className="mt-5 flex flex-col items-center gap-3">
            <Button size="lg" onClick={startUpdate} disabled={phase === 'launching'}>
              {phase === 'launching'
                ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Starting update…</>
                : <><Download className="mr-2 h-4 w-4" /> Update now</>}
            </Button>
            {phase === 'launch-failed' && (
              <p className="text-sm text-red-500">
                Update could not start: {installMessage ?? 'unknown error'}. Try again, or install
                the latest version manually from the cloud downloads page.
              </p>
            )}
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="inline-flex items-center gap-1 text-xs text-muted-foreground underline-offset-2 hover:underline"
            >
              <RefreshCw className="h-3 w-3" /> Re-check
            </button>
          </div>
        )}

        <p className="mt-4 text-xs text-muted-foreground">
          Testing is blocked until the update completes — queued work already saved on this machine
          keeps syncing to the cloud in the background.
        </p>
      </div>
    </div>
  )
}
