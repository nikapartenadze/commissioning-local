import { useEffect, useState, useCallback } from 'react'
import { Link, Navigate } from 'react-router-dom'
import {
  ArrowLeft,
  Hexagon,
  KeyRound,
  Plus,
  ShieldCheck,
  Trash2,
  UserPlus,
  UserCheck,
  UserX,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { ThemeToggle } from '@/components/theme-toggle'
import { useUser } from '@/lib/user-context'
import { authFetch } from '@/lib/api-config'

/**
 * Account management (admin-only).
 *
 * Create commissioner accounts, enable/disable them, and reset PINs — so the
 * server can run with login enforced (AUTH_REQUIRED) instead of the per-device
 * "type your name" prompt. Lives at /settings/users. All mutations go through
 * the admin-gated /api/users endpoints.
 *
 * Works in open mode too (everyone is admin), so an admin can pre-create
 * accounts BEFORE flipping AUTH_REQUIRED on for the deployment.
 */

interface UserRow {
  id: number
  fullName: string
  isAdmin: boolean
  isActive: boolean
  createdAt: string | null
  lastUsedAt: string | null
}

export default function UsersSettingsPage() {
  const { authRequired, currentUser, isLoading } = useUser()
  const [users, setUsers] = useState<UserRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<number | null>(null)

  const refresh = useCallback(async () => {
    try {
      const r = await authFetch('/api/users')
      const data = await r.json()
      if (Array.isArray(data)) {
        setUsers(data as UserRow[])
        setError(null)
      } else if (data?.message) {
        setError(data.message)
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  const toggleActive = useCallback(async (u: UserRow) => {
    setBusyId(u.id)
    try {
      const r = await authFetch(`/api/users/${u.id}/toggle-active`, { method: 'PUT' })
      if (!r.ok) {
        const d = await r.json().catch(() => ({}))
        setError(d.message || `Could not ${u.isActive ? 'disable' : 'enable'} ${u.fullName}`)
      }
      await refresh()
    } finally {
      setBusyId(null)
    }
  }, [refresh])

  const resetPin = useCallback(async (u: UserRow) => {
    const pin = window.prompt(`New 6-digit PIN for ${u.fullName}:`)
    if (pin == null) return
    if (!/^\d{6}$/.test(pin)) {
      setError('PIN must be exactly 6 digits')
      return
    }
    setBusyId(u.id)
    try {
      const r = await authFetch(`/api/users/${u.id}/reset-pin`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ newPin: pin }),
      })
      const d = await r.json().catch(() => ({}))
      if (!r.ok) setError(d.message || 'Could not reset PIN')
      else setError(null)
    } finally {
      setBusyId(null)
    }
  }, [])

  const remove = useCallback(async (u: UserRow) => {
    if (!window.confirm(`Delete ${u.fullName}? This cannot be undone.`)) return
    setBusyId(u.id)
    try {
      const r = await authFetch(`/api/users/${u.id}`, { method: 'DELETE' })
      if (!r.ok) {
        const d = await r.json().catch(() => ({}))
        setError(d.message || 'Could not delete user')
      }
      await refresh()
    } finally {
      setBusyId(null)
    }
  }, [refresh])

  // Enforced-auth gate: redirect non-admins away. Wait for the probe to settle
  // to avoid a redirect flash.
  if (!isLoading && authRequired && currentUser && !currentUser.isAdmin) {
    return <Navigate to="/mcm" replace />
  }

  const fmtDate = (s: string | null) =>
    s ? new Date(s).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—'

  return (
    <div className="min-h-screen bg-background text-foreground font-sans relative">
      <div
        aria-hidden
        className="fixed inset-0 pointer-events-none opacity-[0.05]"
        style={{
          backgroundImage: 'radial-gradient(circle, currentColor 1px, transparent 1px)',
          backgroundSize: '28px 28px',
        }}
      />

      <header className="relative border-b border-border bg-card/40 backdrop-blur z-10">
        <div className="max-w-5xl mx-auto px-6 py-4 flex items-center justify-between">
          <Link
            to="/mcm"
            className="inline-flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.25em] text-muted-foreground hover:text-primary transition-colors"
          >
            <ArrowLeft className="w-3.5 h-3.5" />
            Stations
          </Link>
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 border border-primary/50 rounded-sm flex items-center justify-center bg-card">
              <Hexagon className="w-3.5 h-3.5 text-primary" />
            </div>
            <h1 className="text-xs font-semibold tracking-[0.3em] text-foreground">ACCOUNTS</h1>
          </div>
          <div className="flex items-center gap-4">
            <span className="font-mono text-[10px] uppercase tracking-[0.3em] text-muted-foreground">
              {users.length} USER{users.length === 1 ? '' : 'S'}
            </span>
            <ThemeToggle />
          </div>
        </div>
      </header>

      <main className="relative max-w-5xl mx-auto px-6 py-10 z-10 space-y-10">
        {!authRequired && (
          <div className="border border-primary/30 bg-primary/5 rounded-sm px-4 py-3 font-mono text-[12px] leading-relaxed text-muted-foreground">
            <span className="text-primary">Login is currently OFF.</span> Create accounts here, then set{' '}
            <span className="text-foreground">AUTH_REQUIRED=1</span> on the server to require PIN login (it replaces
            the per-device name prompt). Admins can&apos;t be disabled or deleted.
          </div>
        )}

        <AddUserForm onAdded={refresh} onError={setError} />

        {error && (
          <div className="border border-destructive/40 bg-destructive/5 px-4 py-3 rounded-sm font-mono text-sm text-destructive">
            {error}
          </div>
        )}

        <section>
          <div className="flex items-center gap-2 mb-6">
            <span className="font-mono text-xs text-primary">[</span>
            <h2 className="font-mono text-sm uppercase tracking-[0.35em] text-foreground">Accounts</h2>
            <span className="font-mono text-xs text-primary">]</span>
          </div>

          {loading ? (
            <div className="border border-border bg-card/40 rounded-sm p-10 text-center font-mono text-xs uppercase tracking-[0.3em] text-muted-foreground">
              Loading…
            </div>
          ) : users.length === 0 ? (
            <div className="border border-dashed border-border bg-card/30 rounded-sm p-10 text-center font-mono text-xs uppercase tracking-[0.3em] text-muted-foreground">
              None yet — add one above
            </div>
          ) : (
            <ul className="space-y-2">
              {users.map((u) => (
                <li
                  key={u.id}
                  className={cn(
                    'border border-border bg-card rounded-sm px-4 py-3 flex items-center gap-4',
                    !u.isActive && 'opacity-60'
                  )}
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-foreground truncate">{u.fullName}</span>
                      {u.isAdmin ? (
                        <span className="inline-flex items-center gap-1 font-mono text-[10px] uppercase tracking-[0.18em] text-primary border border-primary/40 rounded-sm px-1.5 py-0.5">
                          <ShieldCheck className="w-3 h-3" /> Admin
                        </span>
                      ) : (
                        <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground border border-border rounded-sm px-1.5 py-0.5">
                          Tester
                        </span>
                      )}
                      {!u.isActive && (
                        <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-destructive border border-destructive/40 rounded-sm px-1.5 py-0.5">
                          Disabled
                        </span>
                      )}
                    </div>
                    <div className="font-mono text-[11px] text-muted-foreground mt-0.5">
                      last seen {fmtDate(u.lastUsedAt)} · added {fmtDate(u.createdAt)}
                    </div>
                  </div>

                  <button
                    onClick={() => resetPin(u)}
                    disabled={busyId === u.id}
                    title="Reset PIN"
                    className="font-mono text-[11px] uppercase tracking-[0.16em] px-2.5 py-1.5 border border-border bg-background text-muted-foreground hover:border-primary/60 hover:text-primary transition-colors disabled:opacity-50 inline-flex items-center gap-1.5 rounded-sm"
                  >
                    <KeyRound className="w-3.5 h-3.5" /> PIN
                  </button>

                  {!u.isAdmin && (
                    <button
                      onClick={() => toggleActive(u)}
                      disabled={busyId === u.id}
                      title={u.isActive ? 'Disable account' : 'Enable account'}
                      className={cn(
                        'font-mono text-[11px] uppercase tracking-[0.16em] px-2.5 py-1.5 border bg-background transition-colors disabled:opacity-50 inline-flex items-center gap-1.5 rounded-sm',
                        u.isActive
                          ? 'border-border text-muted-foreground hover:border-destructive/60 hover:text-destructive'
                          : 'border-border text-success hover:border-success/60'
                      )}
                    >
                      {u.isActive ? <UserX className="w-3.5 h-3.5" /> : <UserCheck className="w-3.5 h-3.5" />}
                      {u.isActive ? 'Disable' : 'Enable'}
                    </button>
                  )}

                  {!u.isAdmin && (
                    <button
                      onClick={() => remove(u)}
                      disabled={busyId === u.id}
                      title="Delete account"
                      className="p-1.5 border border-border bg-background text-muted-foreground hover:border-destructive/60 hover:text-destructive transition-colors disabled:opacity-50 rounded-sm"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
      </main>
    </div>
  )
}

function AddUserForm({ onAdded, onError }: { onAdded: () => void; onError: (m: string | null) => void }) {
  const [name, setName] = useState('')
  const [pin, setPin] = useState('')
  const [busy, setBusy] = useState(false)
  const [ok, setOk] = useState<string | null>(null)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    onError(null)
    setOk(null)
    if (!name.trim()) return onError('Enter a name')
    if (!/^\d{6}$/.test(pin)) return onError('PIN must be exactly 6 digits')
    setBusy(true)
    try {
      const r = await authFetch('/api/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fullName: name.trim(), pin }),
      })
      const d = await r.json().catch(() => ({}))
      if (!r.ok) {
        onError(d.message || 'Could not create user')
        return
      }
      setOk(`Added ${name.trim()} — PIN ${pin}`)
      setName('')
      setPin('')
      onAdded()
    } finally {
      setBusy(false)
    }
  }

  const inputClass =
    'bg-background border border-border rounded-sm px-3 py-2 font-mono text-sm text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:border-primary/60 focus:ring-1 focus:ring-primary/30'

  return (
    <section className="border border-border bg-card/50 rounded-sm p-5">
      <div className="flex items-center gap-2 mb-4">
        <UserPlus className="w-4 h-4 text-primary" />
        <h2 className="font-mono text-sm uppercase tracking-[0.3em] text-foreground">Add Commissioner</h2>
      </div>
      <form onSubmit={submit} className="flex flex-wrap items-end gap-3">
        <label className="flex-1 min-w-[12rem]">
          <span className="block font-mono text-[10px] uppercase tracking-[0.25em] text-muted-foreground mb-1.5">Full name</span>
          <input className={cn(inputClass, 'w-full')} value={name} onChange={(e) => setName(e.target.value)} placeholder="Jane Doe" autoComplete="off" />
        </label>
        <label>
          <span className="block font-mono text-[10px] uppercase tracking-[0.25em] text-muted-foreground mb-1.5">6-digit PIN</span>
          <input
            className={cn(inputClass, 'w-32')}
            value={pin}
            onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 6))}
            inputMode="numeric"
            placeholder="••••••"
          />
        </label>
        <button
          type="submit"
          disabled={busy}
          className="font-mono text-[12px] uppercase tracking-[0.2em] px-4 py-2 bg-primary text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50 rounded-sm inline-flex items-center gap-1.5"
        >
          <Plus className="w-3.5 h-3.5" />
          {busy ? 'Adding…' : 'Add'}
        </button>
      </form>
      {ok && <p className="mt-3 font-mono text-[12px] text-success">{ok} — share the PIN with them.</p>}
    </section>
  )
}
