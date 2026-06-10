import { useEffect, useState, useCallback } from 'react'
import { Link, Navigate } from 'react-router-dom'
import {
  ArrowLeft,
  Check,
  Cloud,
  Download,
  Eye,
  EyeOff,
  Hexagon,
  KeyRound,
  Pencil,
  Plus,
  Save,
  Trash2,
  X,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { ThemeToggle } from '@/components/theme-toggle'
import { useUser } from '@/lib/user-context'
import { authFetch } from '@/lib/api-config'

/**
 * MCM connection management.
 *
 * Add, edit, and remove the controllers the central-tool serves. Lives at
 * /settings/mcms; reachable from the landing-page header. Mutations go
 * through /api/mcm and /api/mcm/:subsystemId.
 *
 * Admin-only under enforced auth: testers who navigate here directly are
 * redirected to the MCM landing page. In open mode (auth not required) everyone
 * is an admin, so this is fully accessible exactly as before.
 */

interface McmRow {
  subsystemId: string
  name: string
  ip: string
  path: string
  enabled: boolean
  connected: boolean
  status: string
  tagCount: number
}

const POLL_MS = 3000

export default function McmSettingsPage() {
  const { authRequired, currentUser, isLoading } = useUser()
  const [mcms, setMcms] = useState<McmRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      const r = await authFetch('/api/mcm')
      const data = await r.json()
      if (Array.isArray(data?.mcms)) {
        setMcms(data.mcms as McmRow[])
        setError(null)
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    refresh()
    const id = setInterval(refresh, POLL_MS)
    return () => clearInterval(id)
  }, [refresh])

  // Enforced-auth gate: redirect non-admins away from the config surface.
  // Wait for the mode/identity probe to settle to avoid a redirect flash.
  if (!isLoading && authRequired && currentUser && !currentUser.isAdmin) {
    return <Navigate to="/mcm" replace />
  }

  return (
    <div className="min-h-screen bg-background text-foreground font-sans relative">
      <div
        aria-hidden
        className="fixed inset-0 pointer-events-none opacity-[0.05]"
        style={{
          backgroundImage:
            'radial-gradient(circle, currentColor 1px, transparent 1px)',
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
            <h1 className="text-xs font-semibold tracking-[0.3em] text-foreground">
              MCM CONFIGURATION
            </h1>
          </div>
          <div className="flex items-center gap-4">
            <span className="font-mono text-[10px] uppercase tracking-[0.3em] text-muted-foreground">
              {mcms.length} CONFIGURED
            </span>
            <ThemeToggle />
          </div>
        </div>
      </header>

      <main className="relative max-w-5xl mx-auto px-6 py-10 z-10 space-y-10">
        <CloudConnectionPanel onImported={refresh} />

        <AddMcmForm onAdded={refresh} />

        <section>
          <div className="flex items-center gap-2 mb-6">
            <span className="font-mono text-xs text-primary">[</span>
            <h2 className="font-mono text-sm uppercase tracking-[0.35em] text-foreground">
              Configured Stations
            </h2>
            <span className="font-mono text-xs text-primary">]</span>
          </div>

          {loading ? (
            <div className="border border-border bg-card/40 rounded-sm p-10 text-center font-mono text-xs uppercase tracking-[0.3em] text-muted-foreground">
              Loading…
            </div>
          ) : error ? (
            <div className="border border-destructive/40 bg-destructive/5 p-4 rounded-sm font-mono text-sm text-destructive">
              {error}
            </div>
          ) : mcms.length === 0 ? (
            <div className="border border-dashed border-border bg-card/30 rounded-sm p-10 text-center font-mono text-xs uppercase tracking-[0.3em] text-muted-foreground">
              None yet — add one above
            </div>
          ) : (
            <ul className="space-y-3">
              {mcms.map((mcm) => (
                <McmEditableRow key={mcm.subsystemId} mcm={mcm} onChanged={refresh} />
              ))}
            </ul>
          )}
        </section>
      </main>
    </div>
  )
}

// ── cloud connection (project API key) ─────────────────────────────────────

interface CloudProject {
  ok: boolean
  error?: string
  projectId?: number
  projectName?: string
  subsystemCount?: number
}

function CloudConnectionPanel({ onImported }: { onImported: () => void }) {
  const [remoteUrl, setRemoteUrl] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [apiKeySet, setApiKeySet] = useState(false)
  const [showKey, setShowKey] = useState(false)
  const [project, setProject] = useState<CloudProject | null>(null)
  const [saving, setSaving] = useState(false)
  const [importing, setImporting] = useState(false)
  const [pulling, setPulling] = useState(false)
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)

  const load = useCallback(async () => {
    try {
      const r = await authFetch('/api/mcm/cloud-config')
      const d = await r.json()
      if (d?.success) {
        setRemoteUrl(d.remoteUrl || '')
        setApiKeySet(Boolean(d.apiKeySet))
        setProject(d.project || null)
      }
    } catch {
      /* leave fields blank on load error */
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  async function save() {
    setSaving(true)
    setMsg(null)
    try {
      const body: Record<string, string> = {}
      if (remoteUrl.trim()) body.remoteUrl = remoteUrl.trim()
      if (apiKey.trim()) body.apiPassword = apiKey.trim()
      if (!body.apiPassword && !apiKeySet) {
        setMsg({ kind: 'err', text: 'Enter the project API key first' })
        return
      }
      const r = await authFetch('/api/mcm/cloud-config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const d = await r.json()
      if (!d?.success) {
        setMsg({ kind: 'err', text: d?.error || 'Save failed' })
        return
      }
      setProject(d.project || null)
      if (apiKey.trim()) setApiKeySet(true)
      setApiKey('')
      if (d.project?.ok) {
        setMsg({ kind: 'ok', text: `Connected to ${d.project.projectName} — ${d.project.subsystemCount} station(s) available` })
      } else {
        setMsg({ kind: 'err', text: d.project?.error || 'Key saved but cloud could not be verified' })
      }
    } catch (e) {
      setMsg({ kind: 'err', text: e instanceof Error ? e.message : String(e) })
    } finally {
      setSaving(false)
    }
  }

  async function importStations() {
    setImporting(true)
    setMsg(null)
    try {
      const r = await authFetch('/api/mcm/import-from-cloud', { method: 'POST' })
      const d = await r.json()
      if (!d?.success) {
        setMsg({ kind: 'err', text: d?.error || 'Import failed' })
        return
      }
      const added = (d.added || []).length
      const updated = (d.updated || []).length
      setMsg({
        kind: 'ok',
        text: `Imported ${d.projectName ?? 'project'}: ${added} added, ${updated} updated (${d.total} total stations). Fill each station's PLC IP, then Connect.`,
      })
      onImported()
      load()
    } catch (e) {
      setMsg({ kind: 'err', text: e instanceof Error ? e.message : String(e) })
    } finally {
      setImporting(false)
    }
  }

  async function pullAll() {
    setPulling(true)
    setMsg(null)
    try {
      const r = await authFetch('/api/mcm/pull-all', { method: 'POST' })
      const d = await r.json()
      if (!d?.success) {
        setMsg({ kind: 'err', text: d?.error || 'Pull failed' })
        return
      }
      const failed = (d.results || []).filter((x: { ok: boolean }) => !x.ok)
      setMsg({
        kind: failed.length ? 'err' : 'ok',
        text:
          `Pulled IOs for ${d.pulled}/${d.total} stations` +
          (failed.length ? ` — failed: ${failed.map((x: { name: string }) => x.name).join(', ')}` : ''),
      })
      onImported()
    } catch (e) {
      setMsg({ kind: 'err', text: e instanceof Error ? e.message : String(e) })
    } finally {
      setPulling(false)
    }
  }

  return (
    <section className="border border-primary/30 bg-card rounded-sm relative">
      <CornerBrackets />
      <div className="h-[3px] bg-primary/60" />
      <div className="p-5 space-y-5">
        <div className="flex items-center gap-2">
          <Cloud className="w-4 h-4 text-primary" />
          <h2 className="font-mono text-sm uppercase tracking-[0.35em] text-foreground">
            Cloud Connection
          </h2>
        </div>

        <p className="font-mono text-[11px] leading-relaxed text-muted-foreground">
          The central tool serves ONE cloud project. The project is chosen by its
          API key — paste it below and Save. Then <strong className="text-foreground">Import stations</strong> to
          fetch that project's MCM list, and <strong className="text-foreground">Pull all IOs</strong> to download
          every station's IO data into this laptop.
        </p>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <label className="block sm:col-span-2">
            <span className="font-mono text-[10px] uppercase tracking-[0.25em] text-muted-foreground mb-1.5 inline-flex items-center gap-1.5">
              <KeyRound className="w-3 h-3" /> Project API Key
              {apiKeySet && (
                <span className="text-success">· a key is currently saved</span>
              )}
            </span>
            <div className="relative">
              <input
                type={showKey ? 'text' : 'password'}
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder={apiKeySet ? '•••••••• (leave blank to keep current)' : 'paste project API key'}
                className="w-full bg-background border border-border rounded-sm px-3 py-2 pr-10 font-mono text-sm text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:border-primary/60 focus:ring-1 focus:ring-primary/30 transition-colors"
              />
              <button
                type="button"
                onClick={() => setShowKey((s) => !s)}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                aria-label={showKey ? 'Hide key' : 'Show key'}
              >
                {showKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
          </label>

          <label className="block sm:col-span-2">
            <span className="block font-mono text-[10px] uppercase tracking-[0.25em] text-muted-foreground mb-1.5">
              Cloud URL
            </span>
            <input
              type="text"
              value={remoteUrl}
              onChange={(e) => setRemoteUrl(e.target.value)}
              placeholder="https://commissioning.autstand.com"
              className="w-full bg-background border border-border rounded-sm px-3 py-2 font-mono text-sm text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:border-primary/60 focus:ring-1 focus:ring-primary/30 transition-colors"
            />
          </label>
        </div>

        {project && (
          <div
            className={cn(
              'font-mono text-[11px] px-3 py-2 rounded-sm border',
              project.ok
                ? 'border-success/40 bg-success/5 text-success'
                : 'border-destructive/30 bg-destructive/5 text-destructive'
            )}
          >
            {project.ok
              ? `Active project: ${project.projectName} (#${project.projectId}) · ${project.subsystemCount} station(s)`
              : `Cloud: ${project.error}`}
          </div>
        )}

        {msg && (
          <div
            className={cn(
              'font-mono text-[11px] px-3 py-2 rounded-sm border',
              msg.kind === 'ok'
                ? 'border-success/40 bg-success/5 text-success'
                : 'border-destructive/30 bg-destructive/5 text-destructive'
            )}
          >
            {msg.text}
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2 pt-2 border-t border-border/60">
          <button
            onClick={save}
            disabled={saving}
            className="font-mono text-[11px] uppercase tracking-[0.2em] px-4 py-1.5 bg-primary text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50 inline-flex items-center gap-1.5 rounded-sm"
          >
            <Save className="w-3 h-3" />
            {saving ? 'Saving…' : 'Save & Verify Key'}
          </button>
          <button
            onClick={importStations}
            disabled={importing || !apiKeySet}
            title={apiKeySet ? '' : 'Save a valid API key first'}
            className="font-mono text-[11px] uppercase tracking-[0.2em] px-4 py-1.5 border border-border hover:bg-muted transition-colors disabled:opacity-40 inline-flex items-center gap-1.5 rounded-sm"
          >
            <Download className="w-3 h-3" />
            {importing ? 'Importing…' : 'Import stations'}
          </button>
          <button
            onClick={pullAll}
            disabled={pulling || !apiKeySet}
            title={apiKeySet ? '' : 'Save a valid API key first'}
            className="font-mono text-[11px] uppercase tracking-[0.2em] px-4 py-1.5 border border-border hover:bg-muted transition-colors disabled:opacity-40 inline-flex items-center gap-1.5 rounded-sm"
          >
            <Cloud className="w-3 h-3" />
            {pulling ? 'Pulling all IOs…' : 'Pull all IOs'}
          </button>
        </div>
      </div>
    </section>
  )
}

// ── add new ───────────────────────────────────────────────────────────────

function AddMcmForm({ onAdded }: { onAdded: () => void }) {
  const [open, setOpen] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [subsystemId, setSubsystemId] = useState('')
  const [name, setName] = useState('')
  const [ip, setIp] = useState('')
  const [path, setPath] = useState('1,0')

  function reset() {
    setSubsystemId('')
    setName('')
    setIp('')
    setPath('1,0')
    setErr(null)
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setErr(null)
    setSubmitting(true)
    try {
      const r = await authFetch('/api/mcm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          subsystemId: subsystemId.trim(),
          name: name.trim() || `MCM ${subsystemId.trim()}`,
          ip: ip.trim(),
          path: path.trim() || '1,0',
        }),
      })
      const data = await r.json()
      if (!data.success) {
        setErr(data.error || 'Failed to add MCM')
        return
      }
      reset()
      setOpen(false)
      onAdded()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setSubmitting(false)
    }
  }

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="w-full border border-dashed border-border hover:border-primary/60 bg-card/30 hover:bg-card/60 rounded-sm py-6 transition-colors font-mono text-xs uppercase tracking-[0.3em] text-muted-foreground hover:text-primary inline-flex items-center justify-center gap-2"
      >
        <Plus className="w-3.5 h-3.5" />
        Add MCM
      </button>
    )
  }

  return (
    <form onSubmit={submit} className="border border-primary/30 bg-card rounded-sm relative">
      <CornerBrackets />
      <div className="h-[3px] bg-primary/60" />
      <div className="p-5 space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="font-mono text-xs text-primary">[</span>
            <h3 className="font-mono text-xs uppercase tracking-[0.3em] text-foreground">
              New Station
            </h3>
            <span className="font-mono text-xs text-primary">]</span>
          </div>
          <button
            type="button"
            onClick={() => {
              reset()
              setOpen(false)
            }}
            className="text-muted-foreground hover:text-foreground"
            aria-label="Cancel"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Field
            label="Subsystem ID"
            placeholder="37"
            value={subsystemId}
            onChange={setSubsystemId}
            required
          />
          <Field
            label="Display Name"
            placeholder="MCM03"
            value={name}
            onChange={setName}
          />
          <Field
            label="IP Address"
            placeholder="192.168.5.106"
            value={ip}
            onChange={setIp}
            required
          />
          <Field label="Path" placeholder="1,0" value={path} onChange={setPath} />
        </div>

        {err && (
          <div className="font-mono text-[11px] text-destructive border border-destructive/30 bg-destructive/5 px-3 py-2 rounded-sm">
            {err}
          </div>
        )}

        <div className="flex items-center justify-end gap-2 pt-2 border-t border-border/60">
          <button
            type="button"
            onClick={() => {
              reset()
              setOpen(false)
            }}
            className="font-mono text-[11px] uppercase tracking-[0.2em] px-3 py-1.5 border border-border hover:bg-muted transition-colors rounded-sm"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={submitting}
            className="font-mono text-[11px] uppercase tracking-[0.2em] px-4 py-1.5 bg-primary text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50 inline-flex items-center gap-1.5 rounded-sm"
          >
            <Save className="w-3 h-3" />
            {submitting ? 'Saving…' : 'Save Station'}
          </button>
        </div>
      </div>
    </form>
  )
}

// ── one row ───────────────────────────────────────────────────────────────

function McmEditableRow({
  mcm,
  onChanged,
}: {
  mcm: McmRow
  onChanged: () => void
}) {
  const [editing, setEditing] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const [name, setName] = useState(mcm.name)
  const [ip, setIp] = useState(mcm.ip)
  const [path, setPath] = useState(mcm.path)

  // keep local edit state in sync if upstream changes mid-edit
  useEffect(() => {
    if (!editing) {
      setName(mcm.name)
      setIp(mcm.ip)
      setPath(mcm.path)
    }
  }, [mcm.name, mcm.ip, mcm.path, editing])

  async function save() {
    setSubmitting(true)
    setErr(null)
    try {
      const r = await authFetch(`/api/mcm/${mcm.subsystemId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim(), ip: ip.trim(), path: path.trim() }),
      })
      const data = await r.json()
      if (!data.success) {
        setErr(data.error || 'Save failed')
        return
      }
      setEditing(false)
      onChanged()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setSubmitting(false)
    }
  }

  async function remove() {
    setSubmitting(true)
    setErr(null)
    try {
      const r = await authFetch(`/api/mcm/${mcm.subsystemId}`, { method: 'DELETE' })
      const data = await r.json()
      if (!data.success) {
        setErr(data.error || 'Delete failed')
        return
      }
      setConfirming(false)
      onChanged()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <li className="border border-border bg-card rounded-sm relative">
      <CornerBrackets />
      <div className={cn('h-[3px]', mcm.connected ? 'bg-success/80' : 'bg-border')} />

      <div className="p-5">
        {!editing ? (
          <div className="flex items-start justify-between gap-6">
            <div className="space-y-2 min-w-0 flex-1">
              <div className="flex items-center gap-3">
                <h3 className="font-mono text-xl font-semibold text-foreground tracking-tight">
                  {mcm.name}
                </h3>
                <span className="font-mono text-[10px] uppercase tracking-[0.25em] text-muted-foreground">
                  #{mcm.subsystemId}
                </span>
                <span
                  className={cn(
                    'font-mono text-[10px] uppercase tracking-[0.25em]',
                    mcm.connected ? 'text-success' : 'text-muted-foreground'
                  )}
                >
                  · {mcm.connected ? 'Online' : 'Offline'}
                </span>
              </div>
              <dl className="grid grid-cols-2 sm:grid-cols-4 gap-x-4 gap-y-1 text-[11px] font-mono">
                <KV label="IP" value={mcm.ip} />
                <KV label="Path" value={mcm.path} />
                <KV
                  label="Tags"
                  value={mcm.tagCount > 0 ? String(mcm.tagCount) : '—'}
                />
                <KV label="Subsys" value={mcm.subsystemId} />
              </dl>
            </div>

            <div className="flex items-center gap-2 flex-shrink-0">
              {!confirming ? (
                <>
                  <button
                    onClick={() => setEditing(true)}
                    className="font-mono text-[11px] uppercase tracking-[0.2em] px-3 py-1.5 border border-border hover:bg-muted transition-colors inline-flex items-center gap-1.5 rounded-sm"
                  >
                    <Pencil className="w-3 h-3" />
                    Edit
                  </button>
                  <button
                    onClick={() => setConfirming(true)}
                    className="font-mono text-[11px] uppercase tracking-[0.2em] px-3 py-1.5 border border-border hover:border-destructive/60 hover:text-destructive transition-colors inline-flex items-center gap-1.5 rounded-sm"
                  >
                    <Trash2 className="w-3 h-3" />
                    Remove
                  </button>
                </>
              ) : (
                <>
                  <span className="font-mono text-[11px] uppercase tracking-[0.2em] text-destructive">
                    Confirm?
                  </span>
                  <button
                    onClick={remove}
                    disabled={submitting}
                    className="font-mono text-[11px] uppercase tracking-[0.2em] px-3 py-1.5 bg-destructive text-destructive-foreground hover:bg-destructive/90 transition-colors disabled:opacity-50 inline-flex items-center gap-1.5 rounded-sm"
                  >
                    <Check className="w-3 h-3" />
                    Yes
                  </button>
                  <button
                    onClick={() => setConfirming(false)}
                    className="font-mono text-[11px] uppercase tracking-[0.2em] px-3 py-1.5 border border-border hover:bg-muted transition-colors rounded-sm"
                  >
                    No
                  </button>
                </>
              )}
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="flex items-center gap-3 mb-2">
              <h3 className="font-mono text-xl font-semibold text-foreground tracking-tight">
                {mcm.name}
              </h3>
              <span className="font-mono text-[10px] uppercase tracking-[0.25em] text-muted-foreground">
                #{mcm.subsystemId} · editing
              </span>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <Field label="Display Name" value={name} onChange={setName} />
              <Field label="IP Address" value={ip} onChange={setIp} />
              <Field label="Path" value={path} onChange={setPath} />
            </div>

            {err && (
              <div className="font-mono text-[11px] text-destructive border border-destructive/30 bg-destructive/5 px-3 py-2 rounded-sm">
                {err}
              </div>
            )}

            <div className="flex items-center justify-end gap-2 pt-3 border-t border-border/60">
              <button
                onClick={() => {
                  setEditing(false)
                  setErr(null)
                }}
                className="font-mono text-[11px] uppercase tracking-[0.2em] px-3 py-1.5 border border-border hover:bg-muted transition-colors rounded-sm"
              >
                Cancel
              </button>
              <button
                onClick={save}
                disabled={submitting}
                className="font-mono text-[11px] uppercase tracking-[0.2em] px-4 py-1.5 bg-primary text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50 inline-flex items-center gap-1.5 rounded-sm"
              >
                <Save className="w-3 h-3" />
                {submitting ? 'Saving…' : 'Save'}
              </button>
            </div>
          </div>
        )}

        {err && !editing && (
          <div className="font-mono text-[11px] text-destructive border border-destructive/30 bg-destructive/5 px-3 py-2 rounded-sm mt-3">
            {err}
          </div>
        )}
      </div>
    </li>
  )
}

// ── primitives ────────────────────────────────────────────────────────────

function Field({
  label,
  value,
  onChange,
  placeholder,
  required,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  placeholder?: string
  required?: boolean
}) {
  return (
    <label className="block">
      <span className="block font-mono text-[10px] uppercase tracking-[0.25em] text-muted-foreground mb-1.5">
        {label}
        {required && <span className="text-primary ml-1">*</span>}
      </span>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        required={required}
        className="w-full bg-background border border-border rounded-sm px-3 py-2 font-mono text-sm text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:border-primary/60 focus:ring-1 focus:ring-primary/30 transition-colors"
      />
    </label>
  )
}

function KV({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-[9px] uppercase tracking-[0.25em] text-muted-foreground">
        {label}
      </dt>
      <dd className="text-foreground truncate">{value}</dd>
    </div>
  )
}

function CornerBrackets() {
  const base = 'absolute w-2.5 h-2.5 border-primary/40 pointer-events-none'
  return (
    <>
      <span className={cn(base, 'top-0 left-0 border-t border-l')} />
      <span className={cn(base, 'top-0 right-0 border-t border-r')} />
      <span className={cn(base, 'bottom-0 left-0 border-b border-l')} />
      <span className={cn(base, 'bottom-0 right-0 border-b border-r')} />
    </>
  )
}
