"use client"

import { useState, useEffect, useRef, useCallback } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import { useUser } from '@/lib/user-context'
import {
  X, Wifi, WifiOff, Loader2, CheckCircle2, XCircle, AlertTriangle,
  Zap, CircleDot, Send, Play, Square, ChevronRight, RotateCcw,
  Signal, Fingerprint, Gauge, ArrowRight, Settings2,
} from 'lucide-react'

// ── Types ──────────────────────────────────────────────────────────

interface VfdDevice {
  id: number
  deviceName: string
  mcm: string
  subsystem: string
}

interface StsState {
  Check_Allowed: boolean | null
  Valid_Map: boolean | null
  Valid_HP: boolean | null
  Valid_Direction: boolean | null
  Jogging: boolean | null
  Track_Belt: boolean | null
  RVS: number | null
  KeypadButtonF1: boolean | null
}

/** Per-tag PLC read error messages, keyed by the same names as StsState. */
type StsErrors = Partial<Record<keyof StsState, string>>

interface VfdWizardModalProps {
  device: VfdDevice
  subsystemId: number
  plcConnected: boolean
  sheetName?: string  // L2 sheet name (e.g. "APF") — used to find the correct device row
  onClose: () => void
}

// ── Helpers ────────────────────────────────────────────────────────

async function writeTag(deviceName: string, field: string, value: number, dataType: 'BOOL' | 'REAL' | 'INT') {
  const res = await fetch('/api/vfd-commissioning/write-tag', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ deviceName, field, value, dataType }),
  })
  return res.json()
}

/**
 * Write one or more L2 spreadsheet cells for the active VFD device.
 * Used by wizard steps to fill in Motor HP, VFD HP, "Ready For Tracking", etc.
 */
async function writeL2Cells(
  deviceName: string,
  sheetName: string | undefined,
  updatedBy: string | undefined,
  cells: { columnName: string; value: string | null }[],
) {
  try {
    const res = await fetch('/api/vfd-commissioning/write-l2-cells', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceName, sheetName, updatedBy, cells }),
    })
    return res.json()
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * Build the "INITIALS DATE" stamp the way the L2 spreadsheet wants it.
 * "Andrew Smith Hayes" → "ASH"
 * "John Doe" → "JD"
 * "ASH" → "ASH" (already initials, kept as-is)
 * Date format: M/D (no leading zeros, no year) — e.g. "9/5"
 */
function buildInitialsStamp(fullName: string | undefined | null): string {
  const name = (fullName || '').trim()
  if (!name) return new Date().toLocaleDateString('en-US', { month: 'numeric', day: 'numeric' })

  // If already short (≤4 chars and uppercase), assume it's already initials
  let initials: string
  if (name.length <= 4 && name === name.toUpperCase()) {
    initials = name
  } else {
    initials = name
      .split(/\s+/)
      .map(w => w[0])
      .filter(Boolean)
      .join('')
      .toUpperCase()
  }

  const now = new Date()
  const dateStr = `${now.getMonth() + 1}/${now.getDate()}`
  return `${initials} ${dateStr}`
}

// HTTP polling removed — wizard now subscribes to VfdTagUpdate WebSocket messages
// pushed by the server-side polling reader (see openWizardReader in lib/vfd-wizard-reader.ts).

/**
 * Read the five commissioning L2 cells for one device.
 *
 * L2 cells are now the single source of truth for VFD commissioning state
 * (the old VfdCheckState table is gone). This is how Step 2 / Step 5 prefill
 * their inputs on reopen.
 */
interface L2CommissioningCells {
  motorHpField:     string | null
  vfdHpField:       string | null
  readyForTracking: string | null
  beltTracked:      string | null
  speedSetUp:       string | null
}

async function readL2CellsForDevice(deviceName: string): Promise<L2CommissioningCells | null> {
  try {
    const res = await fetch('/api/vfd-commissioning/state')
    if (!res.ok) return null
    const data = await res.json()
    const row = (data.states || []).find((s: any) => s.deviceName === deviceName)
    return row?.cells ?? null
  } catch {
    return null
  }
}

/**
 * The "Speed Set Up" L2 cell is an enriched stamp that carries both the
 * initials-date stamp AND the measured FPM↔RVS pair, so we don't need a
 * separate local table for those numbers.
 *
 * Format: "ASH 9/5 · 200 FPM @ 25.30 RVS"
 *
 * `parseSpeedStamp` is tolerant of legacy stamps that are initials-only
 * (e.g. older data from before this refactor) — it returns null in that case.
 */
function buildSpeedStamp(userName: string | undefined, fpm: number, rvs: number): string {
  const initials = buildInitialsStamp(userName)
  return `${initials} · ${fpm} FPM @ ${rvs.toFixed(2)} RVS`
}

function parseSpeedStamp(stamp: string | null | undefined): { fpm: number; rvs: number } | null {
  if (!stamp) return null
  const m = stamp.match(/(\d+(?:\.\d+)?)\s*FPM\s*@\s*(\d+(?:\.\d+)?)\s*RVS/i)
  if (!m) return null
  const fpm = parseFloat(m[1])
  const rvs = parseFloat(m[2])
  if (!Number.isFinite(fpm) || !Number.isFinite(rvs)) return null
  return { fpm, rvs }
}

// ── Sub-components ─────────────────────────────────────────────────

function StepIndicator({ stepNum, label, status, active }: {
  stepNum: number
  label: string
  status: 'locked' | 'active' | 'done' | 'failed'
  active: boolean
}) {
  return (
    <div className={cn(
      "flex items-center gap-2 px-3 py-2 rounded-lg transition-all text-sm cursor-default",
      active && "bg-primary/10 border border-primary/30",
      status === 'done' && !active && "opacity-70",
      status === 'locked' && "opacity-30",
    )}>
      <div className={cn(
        "h-7 w-7 rounded-full flex items-center justify-center text-xs font-bold border-2 shrink-0",
        status === 'done' && "bg-green-500 border-green-600 text-white",
        status === 'failed' && "bg-red-500 border-red-600 text-white",
        status === 'active' && "bg-primary border-primary text-primary-foreground",
        status === 'locked' && "bg-muted border-border text-muted-foreground",
      )}>
        {status === 'done' ? <CheckCircle2 className="h-4 w-4" /> :
         status === 'failed' ? <XCircle className="h-4 w-4" /> :
         stepNum}
      </div>
      <span className={cn("font-medium", active ? "text-foreground" : "text-muted-foreground")}>{label}</span>
    </div>
  )
}

function StsIndicator({ label, value, loading }: { label: string; value: boolean | null; loading: boolean }) {
  return (
    <div className="flex items-center gap-2 text-xs">
      <div className={cn(
        "h-2.5 w-2.5 rounded-full shrink-0",
        loading && "bg-muted animate-pulse",
        !loading && value === true && "bg-green-500",
        !loading && value === false && "bg-red-500",
        !loading && value === null && "bg-muted-foreground/30",
      )} />
      <span className="text-muted-foreground">{label}</span>
      {!loading && value !== null && (
        <span className={cn("font-mono font-medium", value ? "text-green-600 dark:text-green-400" : "text-red-600 dark:text-red-400")}>
          {value ? 'TRUE' : 'FALSE'}
        </span>
      )}
    </div>
  )
}

/**
 * Friendly status pill — for end users. Shows a clear "X is Y" label with green/red dot.
 * No raw tag names, no TRUE/FALSE. Used in step content panels.
 */
function StatusPill({
  label,
  value,
  loading,
  trueText = 'OK',
  falseText = 'Not yet',
  pendingText = 'Checking…',
}: {
  label: string
  value: boolean | null
  loading: boolean
  trueText?: string
  falseText?: string
  pendingText?: string
}) {
  const isOn = !loading && value === true
  const isOff = !loading && value === false
  const isUnknown = loading || value === null
  return (
    <div className={cn(
      "flex items-center justify-between gap-3 rounded-lg border px-3 py-2.5",
      isOn && "border-green-300 bg-green-50/60 dark:border-green-800 dark:bg-green-950/30",
      isOff && "border-border bg-card",
      isUnknown && "border-border bg-card",
    )}>
      <span className="text-sm font-medium">{label}</span>
      <div className="flex items-center gap-2">
        <div className={cn(
          "h-2.5 w-2.5 rounded-full shrink-0",
          isOn && "bg-green-500",
          isOff && "bg-muted-foreground/30",
          isUnknown && "bg-muted animate-pulse",
        )} />
        <span className={cn(
          "text-xs font-medium",
          isOn && "text-green-700 dark:text-green-400",
          isOff && "text-muted-foreground",
          isUnknown && "text-muted-foreground",
        )}>
          {isOn ? trueText : isOff ? falseText : pendingText}
        </span>
      </div>
    </div>
  )
}

function ActionButton({ label, icon: Icon, onClick, disabled, variant, sending }: {
  label: string
  icon: any
  onClick: () => void
  disabled?: boolean
  variant?: 'primary' | 'amber' | 'destructive' | 'outline'
  sending?: boolean
}) {
  const v = variant || 'primary'
  return (
    <Button
      disabled={disabled || sending}
      onClick={onClick}
      className={cn(
        "h-11 px-5 text-sm font-semibold gap-2 border-2 transition-all",
        sending && "animate-pulse",
        v === 'primary' && "bg-primary border-primary text-primary-foreground hover:bg-primary/90",
        v === 'amber' && "bg-amber-500 border-amber-600 text-white hover:bg-amber-600 dark:bg-amber-400 dark:border-amber-500 dark:text-black",
        v === 'destructive' && "bg-red-600 border-red-700 text-white hover:bg-red-700",
        v === 'outline' && "bg-card border-border text-foreground hover:bg-muted",
      )}
    >
      {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Icon className="h-4 w-4" />}
      {label}
    </Button>
  )
}

// ── Step content components ────────────────────────────────────────

function Step0Content({ sts, loading }: { sts: StsState; loading: boolean }) {
  const allowed = sts.Check_Allowed === true
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground leading-relaxed">
        The VFD must be online and running before any checks can be performed.
        The tool checks this automatically.
      </p>

      <StatusPill
        label="VFD is online"
        value={sts.Check_Allowed}
        loading={loading}
        trueText="Yes"
        falseText="No"
        pendingText="Checking…"
      />

      {allowed && (
        <div className="flex items-center gap-2 text-green-600 dark:text-green-400 text-sm font-medium">
          <CheckCircle2 className="h-4 w-4" />
          VFD is online. Continue to step 1.
        </div>
      )}
      {!loading && !allowed && (
        <div className="flex items-center gap-2 text-amber-600 dark:text-amber-400 text-sm">
          <AlertTriangle className="h-4 w-4" />
          Waiting for the VFD to come online…
        </div>
      )}
    </div>
  )
}

function Step1Content({ sts, loading, deviceName, plcConnected }: {
  sts: StsState; loading: boolean; deviceName: string; plcConnected: boolean
}) {
  const [sending, setSending] = useState(false)
  const [sentCount, setSentCount] = useState(0)
  const [lastError, setLastError] = useState<string | null>(null)
  const lastSentMsRef = useRef<number>(0)
  const f1WasPressedRef = useRef<boolean>(false)

  const f1Pressed = sts.KeypadButtonF1 === true
  const validMapDone = sts.Valid_Map === true

  // Send Valid_Map=1 to PLC. Manual button uses this; auto-trigger uses this.
  const sendValidMap = async (reason: string) => {
    if (!plcConnected || sending) return
    setSending(true)
    setLastError(null)
    try {
      const result = await writeTag(deviceName, 'Valid_Map', 1, 'BOOL')
      if (result?.success === false) {
        setLastError(result?.error || 'Write failed')
      } else {
        setSentCount(c => c + 1)
        lastSentMsRef.current = Date.now()
        if (process.env.NODE_ENV === 'development') {
          console.log(`[Step1] Sent Valid_Map=1 (${reason})`)
        }
      }
    } catch (err) {
      setLastError(err instanceof Error ? err.message : String(err))
    } finally {
      setSending(false)
    }
  }

  // Auto-send on the rising edge of F1: when F1 transitions from not-pressed to pressed.
  // Re-arms after F1 is released so the user can re-press to retry if Valid_Map didn't latch.
  useEffect(() => {
    if (!plcConnected || validMapDone) return

    const wasPressed = f1WasPressedRef.current
    f1WasPressedRef.current = f1Pressed

    // Rising edge detected: F1 just went from FALSE to TRUE
    if (!wasPressed && f1Pressed) {
      // Debounce: don't auto-send more than once per second
      if (Date.now() - lastSentMsRef.current < 1000) return
      sendValidMap('auto: F1 rising edge')
    }
  }, [f1Pressed, plcConnected, validMapDone])

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground leading-relaxed">
        Confirm this VFD in the tool matches the physical VFD in the field.
      </p>

      <div className="rounded-lg border bg-amber-50/50 dark:bg-amber-950/20 border-amber-200 dark:border-amber-800 p-4">
        <p className="text-sm font-semibold text-amber-900 dark:text-amber-100 mb-1">What to do</p>
        <p className="text-sm text-amber-800 dark:text-amber-200">
          Ask the technician to press <strong>F1</strong> on the VFD keypad. The tool watches the keypad live and validates the map automatically the moment F1 is detected. If the auto-validate misses, use the manual button.
        </p>
      </div>

      {/* Live F1 keypad press indicator */}
      <div className={cn(
        "rounded-lg border p-4 transition-colors",
        f1Pressed ? "border-green-400 bg-green-50/60 dark:border-green-700 dark:bg-green-950/30" : "bg-card"
      )}>
        <div className="flex items-center gap-3">
          <div className={cn(
            "h-11 w-11 rounded-md border flex items-center justify-center font-mono font-bold text-base transition-all",
            f1Pressed ? "bg-green-500 border-green-600 text-white" : "bg-muted border-border text-muted-foreground"
          )}>F1</div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold">
              {f1Pressed ? "F1 is being pressed" : "Waiting for F1 press…"}
            </p>
            <p className="text-xs text-muted-foreground">Reading keypad input from the VFD</p>
          </div>
        </div>
      </div>

      {/* Manual fallback */}
      <div className="rounded-lg border bg-card p-4 space-y-2">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-sm font-semibold">Validate the map manually</p>
            <p className="text-xs text-muted-foreground">
              {sentCount > 0
                ? <>Validated {sentCount} time{sentCount !== 1 ? 's' : ''} so far.</>
                : <>Click if auto-validation didn't trigger.</>}
            </p>
          </div>
          <ActionButton
            label={sending ? 'Validating…' : 'Validate Map'}
            icon={CheckCircle2}
            onClick={() => sendValidMap('manual')}
            disabled={!plcConnected}
            sending={sending}
          />
        </div>
        {lastError && (
          <div className="flex items-start gap-2 text-xs text-red-600 dark:text-red-400">
            <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
            <span>{lastError}</span>
          </div>
        )}
      </div>

      {/* PLC confirmation */}
      <StatusPill
        label="Map is valid"
        value={sts.Valid_Map}
        loading={loading}
        trueText="Yes"
        falseText="Not yet"
        pendingText="Checking…"
      />

      {validMapDone && (
        <div className="flex items-center gap-2 text-green-600 dark:text-green-400 text-sm font-medium">
          <CheckCircle2 className="h-4 w-4" />
          Identity confirmed. Continue to step 2.
        </div>
      )}
    </div>
  )
}

function Step2Content({ sts, loading, deviceName, subsystemId, plcConnected, sheetName, userName }: {
  sts: StsState; loading: boolean; deviceName: string; subsystemId: number; plcConnected: boolean
  sheetName?: string; userName?: string
}) {
  // subsystemId accepted for API parity with other steps but no longer used here —
  // commissioning state is read/written through L2 cells exclusively.
  void subsystemId

  const [sending, setSending] = useState(false)
  const [sent, setSent] = useState(false)
  const [motorHp, setMotorHp] = useState('')
  const [driveHp, setDriveHp] = useState('')
  const [l2Status, setL2Status] = useState<string | null>(null)
  const [confirmError, setConfirmError] = useState<string | null>(null)

  // Prefill HP inputs from the L2 spreadsheet (single source of truth).
  useEffect(() => {
    let cancelled = false
    readL2CellsForDevice(deviceName).then(cells => {
      if (cancelled || !cells) return
      if (cells.motorHpField) setMotorHp(cells.motorHpField)
      if (cells.vfdHpField) setDriveHp(cells.vfdHpField)
    })
    return () => { cancelled = true }
  }, [deviceName])

  const canConfirm = motorHp.trim() !== '' && driveHp.trim() !== ''

  const handleConfirm = async () => {
    if (!canConfirm) return
    setSending(true)
    setL2Status(null)
    setConfirmError(null)
    try {
      // 1. Write HP values to the L2 spreadsheet. This is the durable record —
      //    cloud-synced, shows up in the customer's commissioning report.
      const l2Result = await writeL2Cells(deviceName, sheetName, userName, [
        { columnName: 'Motor HP (Field)', value: motorHp },
        { columnName: 'VFD HP (Field)', value: driveHp },
      ])
      if (!l2Result?.success) {
        const failed = (l2Result?.written || []).filter((w: any) => !w.ok)
        const msg = l2Result?.error || (failed.length > 0 ? `Spreadsheet: ${failed.map((f: any) => f.error).join(', ')}` : 'Spreadsheet write failed')
        throw new Error(msg)
      }
      setL2Status('Saved to spreadsheet')

      // 2. Send Valid_HP pulse to PLC — trips STS.Valid_HP so the user can advance.
      const plcResult = await writeTag(deviceName, 'Valid_HP', 1, 'BOOL')
      if (plcResult?.success === false || plcResult?.error) {
        throw new Error(plcResult?.error || 'PLC write reported failure')
      }

      setSent(true)
    } catch (err) {
      setConfirmError(err instanceof Error ? err.message : String(err))
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground leading-relaxed">
        Confirm the motor and drive horsepower match the mechanical spec.
        Read the motor faceplate and the VFD label, enter the values, then click Confirm.
      </p>

      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-muted-foreground">Motor HP (from faceplate)</label>
          <Input
            type="number"
            step={0.1}
            placeholder="e.g. 5.0"
            value={motorHp}
            onChange={e => { setMotorHp(e.target.value); setSent(false) }}
            className="h-10 font-mono"
          />
        </div>
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-muted-foreground">Drive HP (from VFD label)</label>
          <Input
            type="number"
            step={0.1}
            placeholder="e.g. 5.0"
            value={driveHp}
            onChange={e => { setDriveHp(e.target.value); setSent(false) }}
            className="h-10 font-mono"
          />
        </div>
      </div>

      <div className="flex items-center gap-3">
        <ActionButton
          label={sent ? "HP Confirmed" : "Confirm HP"}
          icon={sent ? CheckCircle2 : CheckCircle2}
          onClick={handleConfirm}
          disabled={!plcConnected || !canConfirm}
          sending={sending}
          variant={sent ? 'outline' : 'primary'}
        />
        {!canConfirm && <p className="text-xs text-muted-foreground">Enter both Motor HP and Drive HP first.</p>}
      </div>

      <StatusPill
        label="HP is confirmed"
        value={sts.Valid_HP}
        loading={loading}
        trueText="Yes"
        falseText="Not yet"
        pendingText="Checking…"
      />

      {confirmError && (
        <div className="rounded-lg border border-red-300 bg-red-50/60 dark:bg-red-950/30 dark:border-red-800 p-3 flex items-start gap-2">
          <XCircle className="h-4 w-4 text-red-600 dark:text-red-400 shrink-0 mt-0.5" />
          <div className="space-y-0.5">
            <p className="text-xs font-semibold text-red-800 dark:text-red-300">Confirm failed</p>
            <p className="text-xs text-red-700 dark:text-red-400">{confirmError}</p>
          </div>
        </div>
      )}

      {l2Status && (
        <p className="text-xs text-muted-foreground">{l2Status}</p>
      )}

      {sts.Valid_HP === true && (
        <div className="flex items-center gap-2 text-green-600 dark:text-green-400 text-sm font-medium">
          <CheckCircle2 className="h-4 w-4" />
          HP confirmed. Values saved. Continue to step 3.
        </div>
      )}
    </div>
  )
}

function Step3Content({ sts, loading, deviceName, plcConnected, sheetName, userName }: {
  sts: StsState; loading: boolean; deviceName: string; plcConnected: boolean
  sheetName?: string; userName?: string
}) {
  const [bumpSending, setBumpSending] = useState(false)
  const [dirSending, setDirSending] = useState(false)
  const [comment, setComment] = useState('')
  const [bumpCount, setBumpCount] = useState(0)
  const [dirCount, setDirCount] = useState(0)
  const [lastWriteError, setLastWriteError] = useState<string | null>(null)

  const handleBump = async () => {
    setBumpSending(true)
    setLastWriteError(null)
    try {
      const result = await writeTag(deviceName, 'Bump', 1, 'BOOL')
      if (result?.success === false) {
        setLastWriteError(`Bump: ${result?.error || 'write failed'}`)
      } else {
        setBumpCount(c => c + 1)
        if (process.env.NODE_ENV === 'development') console.log('[Step3] Sent Bump=1')
      }
    } catch (err) {
      setLastWriteError(`Bump: ${err instanceof Error ? err.message : String(err)}`)
    }
    setTimeout(() => setBumpSending(false), 1500)
  }

  const handleConfirmDirection = async () => {
    setDirSending(true)
    setLastWriteError(null)
    try {
      const result = await writeTag(deviceName, 'Valid_Direction', 1, 'BOOL')
      if (result?.success === false) {
        setLastWriteError(`Valid_Direction: ${result?.error || 'write failed'}`)
      } else {
        setDirCount(c => c + 1)
        if (process.env.NODE_ENV === 'development') console.log('[Step3] Sent Valid_Direction=1')

        // Stamp "Ready For Tracking" in the L2 spreadsheet — INITIALS DATE
        const stamp = buildInitialsStamp(userName)
        writeL2Cells(deviceName, sheetName, userName, [
          { columnName: 'Ready For Tracking', value: stamp },
        ]).catch(() => { /* best-effort */ })
      }
    } catch (err) {
      setLastWriteError(`Valid_Direction: ${err instanceof Error ? err.message : String(err)}`)
    }
    setDirSending(false)
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground leading-relaxed">
        Jog the motor for 1 second to check that it runs and to see which direction it spins. The PLC limits the jog to a single 1-second pulse no matter how many times you click.
      </p>

      <div className="flex items-center gap-3">
        <Button
          disabled={!plcConnected || bumpSending}
          onClick={handleBump}
          className={cn(
            "h-12 px-6 text-base font-bold tracking-wide gap-2",
            bumpSending
              ? "bg-amber-500 hover:bg-amber-500 text-white animate-pulse"
              : "bg-amber-500 hover:bg-amber-600 text-white"
          )}
        >
          <Zap className="h-5 w-5" />
          {bumpSending ? "Bumping…" : "Bump Motor"}
        </Button>
        {bumpCount > 0 && (
          <span className="text-xs text-muted-foreground">Bumped {bumpCount} time{bumpCount !== 1 ? 's' : ''}</span>
        )}
      </div>

      <div className="space-y-2">
        <StatusPill
          label="Motor is jogging"
          value={sts.Jogging}
          loading={loading}
          trueText="Yes"
          falseText="No"
          pendingText="Checking…"
        />
      </div>

      <div className="space-y-1.5">
        <label className="text-xs font-medium text-muted-foreground">Direction observation (optional)</label>
        <Textarea
          placeholder="e.g. Motor running clockwise, belt moving forward…"
          value={comment}
          onChange={e => setComment(e.target.value)}
          className="min-h-[60px] text-sm"
        />
      </div>

      <div className="rounded-lg border bg-card p-4 space-y-2">
        <p className="text-sm font-medium">Did the motor spin in the correct direction?</p>
        <div className="flex items-center gap-3">
          <ActionButton
            label={dirCount > 0 ? `Re-confirm Direction (×${dirCount})` : "Yes — Confirm Direction"}
            icon={CheckCircle2}
            onClick={handleConfirmDirection}
            disabled={!plcConnected}
            sending={dirSending}
          />
        </div>
        <p className="text-xs text-muted-foreground">
          If the motor is spinning the wrong way, fix the polarity in the VFD config before retesting. Don't confirm.
        </p>
      </div>

      {lastWriteError && (
        <div className="flex items-start gap-2 text-xs text-red-600 dark:text-red-400 rounded-lg border border-red-300 bg-red-50/50 dark:border-red-800 dark:bg-red-950/20 p-3">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
          <span>{lastWriteError}</span>
        </div>
      )}

      <StatusPill
        label="Direction is confirmed"
        value={sts.Valid_Direction}
        loading={loading}
        trueText="Yes"
        falseText="Not yet"
        pendingText="Checking…"
      />

      {sts.Valid_Direction === true && (
        <div className="flex items-center gap-2 text-green-600 dark:text-green-400 text-sm font-medium">
          <CheckCircle2 className="h-4 w-4" />
          Direction confirmed. Continue to step 4.
        </div>
      )}
    </div>
  )
}

function Step4Content({ sts, stsErrors, loading, deviceName, plcConnected, sheetName, userName, onComplete, isComplete }: {
  sts: StsState
  stsErrors: StsErrors
  loading: boolean
  deviceName: string
  plcConnected: boolean
  sheetName?: string
  userName?: string
  onComplete: () => void
  isComplete: boolean
}) {
  const [overrideRpm, setOverrideRpm] = useState('')
  const [overrideSending, setOverrideSending] = useState(false)
  const [overrideSent, setOverrideSent] = useState(false)
  const [overrideError, setOverrideError] = useState<string | null>(null)
  const [overrideLastWrite, setOverrideLastWrite] = useState<{ rvs: number; ts: number } | null>(null)

  const handleOverride = async () => {
    if (!plcConnected || !overrideRpm) return
    setOverrideSending(true)
    setOverrideError(null)
    try {
      const rvsVal = parseFloat(overrideRpm)
      // ORDER MATTERS: write RVS value FIRST so it's settled in the PLC register,
      // THEN write Override_RVS=1 to trigger the one-shot (ONS.6 in rung 11).
      // The PLC clears CTRL.CMD to 0 every scan via FLL(0,CTRL.CMD,1) in rung 15,
      // so Override_RVS only stays high for ~1 scan — the one-shot must catch
      // the rising edge with RVS already at the desired value.
      const res = await fetch('/api/vfd-commissioning/write-tags-batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          deviceName,
          writes: [
            { field: 'RVS', value: rvsVal, dataType: 'REAL' },
            { field: 'Override_RVS', value: 1, dataType: 'BOOL' },
          ],
        }),
      })
      const data = await res.json()
      if (!res.ok || data.success === false) {
        const failed = (data.writes || []).filter((w: any) => !w.ok)
        const msg = data.error || failed.map((f: any) => `${f.tagPath}: ${f.error}`).join('; ') || 'unknown'
        setOverrideError(msg)
        if (process.env.NODE_ENV === 'development') console.error('[Step4] Override failed:', data)
      } else {
        setOverrideSent(true)
        setOverrideLastWrite({ rvs: rvsVal, ts: Date.now() })
        if (process.env.NODE_ENV === 'development') console.log('[Step4] Sent Override_RVS=1 + RVS=' + rvsVal, data)
        setTimeout(() => setOverrideSent(false), 2000)
      }
    } catch (err) {
      setOverrideError(err instanceof Error ? err.message : String(err))
    }
    setOverrideSending(false)
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground leading-relaxed">
        Hand the conveyor over to the mechanical team. They run the belt using the VFD keypad while adjusting tracking.
      </p>

      <div className="rounded-lg border bg-amber-50/50 dark:bg-amber-950/20 border-amber-200 dark:border-amber-800 p-4 space-y-2">
        <p className="text-sm font-semibold text-amber-900 dark:text-amber-100">Keypad controls for the mechanical team</p>
        <ul className="text-sm text-amber-800 dark:text-amber-200 space-y-1.5">
          <li className="flex items-center gap-2.5">
            <kbd className="font-mono font-bold bg-amber-100 dark:bg-amber-900/50 px-2 py-0.5 rounded border border-amber-300 dark:border-amber-700 text-xs min-w-[24px] text-center">F1</kbd>
            <span>Start / Stop the belt (toggle)</span>
          </li>
          <li className="flex items-center gap-2.5">
            <kbd className="font-mono font-bold bg-amber-100 dark:bg-amber-900/50 px-2 py-0.5 rounded border border-amber-300 dark:border-amber-700 text-xs min-w-[24px] text-center">F2</kbd>
            <span>Increase speed</span>
          </li>
          <li className="flex items-center gap-2.5">
            <kbd className="font-mono font-bold bg-amber-100 dark:bg-amber-900/50 px-2 py-0.5 rounded border border-amber-300 dark:border-amber-700 text-xs min-w-[24px] text-center">F0</kbd>
            <span>Decrease speed</span>
          </li>
        </ul>
      </div>

      <div className="rounded-lg border bg-red-50/50 dark:bg-red-950/20 border-red-200 dark:border-red-800 p-4 flex items-start gap-3">
        <AlertTriangle className="h-4 w-4 text-red-600 dark:text-red-400 shrink-0 mt-0.5" />
        <div className="text-sm">
          <p className="font-semibold text-red-800 dark:text-red-200">Safety</p>
          <p className="text-red-700 dark:text-red-300 mt-0.5">
            The tool cannot start or stop the belt. Mechanics may have hands on the conveyor — only the keypad controls the motor.
          </p>
        </div>
      </div>

      {/* Speed override */}
      <div className="rounded-lg border bg-card p-4 space-y-3">
        <div>
          <p className="text-sm font-semibold">Set the speed directly</p>
          <p className="text-xs text-muted-foreground mt-0.5">
            Useful when the speed has drifted or the belt was stuck. Type the RVS value and click Set.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <Input
            type="number"
            min={0} max={30} step={0.1}
            placeholder="e.g. 15.0"
            value={overrideRpm}
            onChange={e => setOverrideRpm(e.target.value)}
            className="h-10 w-28 font-mono"
          />
          <ActionButton
            label={overrideSent ? "Speed Set" : "Set Speed"}
            icon={overrideSent ? CheckCircle2 : Send}
            onClick={handleOverride}
            disabled={!plcConnected || !overrideRpm}
            sending={overrideSending}
            variant={overrideSent ? 'outline' : 'primary'}
          />
        </div>
      </div>

      {overrideError && (
        <div className="flex items-start gap-2 text-xs text-red-600 dark:text-red-400 rounded-lg border border-red-300 dark:border-red-800 bg-red-50/50 dark:bg-red-950/20 p-3">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
          <div>
            <p className="font-semibold">Failed to set speed</p>
            <p className="break-all mt-0.5">{overrideError}</p>
          </div>
        </div>
      )}

      {overrideLastWrite && !overrideError && (
        <div className="flex items-center gap-2 text-xs text-green-600 dark:text-green-400 rounded-lg border border-green-300 dark:border-green-800 bg-green-50/50 dark:bg-green-950/20 p-3">
          <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
          <span>Speed set to <strong>{overrideLastWrite.rvs} RVS</strong> at {new Date(overrideLastWrite.ts).toLocaleTimeString()}</span>
        </div>
      )}

      <div className="rounded-lg border bg-card p-4 space-y-3">
        <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Live Status</p>
        <StatusPill
          label="Belt is tracking"
          value={sts.Track_Belt}
          loading={loading}
          trueText="Running"
          falseText="Stopped"
          pendingText="Checking…"
        />
        <div className={cn(
          "flex items-center justify-between rounded-lg border px-3 py-2.5 bg-card",
          stsErrors.RVS && "border-amber-300 bg-amber-50/40 dark:border-amber-800 dark:bg-amber-950/20",
        )}>
          <span className="text-sm font-medium">Current speed</span>
          <span className="font-mono font-semibold text-base">
            {sts.RVS != null ? sts.RVS.toFixed(2) : '—'} <span className="text-xs text-muted-foreground">RVS</span>
          </span>
        </div>
        {stsErrors.RVS && (
          <p className="text-[11px] text-amber-700 dark:text-amber-400 leading-snug">
            <strong>Can't read STS.RVS from PLC:</strong> {stsErrors.RVS}.
            Verify the AOI version on this controller exposes <code className="font-mono">CTRL.STS.RVS</code> (REAL).
          </p>
        )}
      </div>

      <div className="pt-2 border-t">
        <p className="text-sm text-muted-foreground mb-3">
          When the mechanical team is finished tracking the belt, mark this step complete.
        </p>
        <ActionButton
          label={isComplete ? "Tracking Done" : "Mark Tracking Done"}
          icon={CheckCircle2}
          onClick={() => {
            // Stamp "Belt Tracked" in L2 spreadsheet on first completion
            if (!isComplete) {
              const stamp = buildInitialsStamp(userName)
              writeL2Cells(deviceName, sheetName, userName, [
                { columnName: 'Belt Tracked', value: stamp },
              ]).catch(() => { /* best-effort */ })
            }
            onComplete()
          }}
          variant={isComplete ? 'outline' : 'primary'}
        />
      </div>
    </div>
  )
}

function Step5Content({ sts, stsErrors, loading, deviceName, subsystemId, plcConnected, sheetName, userName }: {
  sts: StsState; stsErrors: StsErrors; loading: boolean; deviceName: string; subsystemId: number; plcConnected: boolean
  sheetName?: string; userName?: string
}) {
  void subsystemId // accepted for API parity; no longer used — state lives in L2

  const [fpm, setFpm] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [lastResult, setLastResult] = useState<{ fpm: number; rvs: number; ts: number } | null>(null)

  // Keep a ref in sync with the latest `sts` so async handlers see live values
  // instead of the stale closure from when the button was clicked.
  const stsRef = useRef(sts)
  useEffect(() => { stsRef.current = sts }, [sts])

  // Prefill from the L2 "Speed Set Up" stamp. It's an enriched stamp that
  // carries the FPM↔RVS pair — e.g. "ASH 9/5 · 200 FPM @ 25.30 RVS". Legacy
  // stamps without the pair (just initials+date) are tolerated: we just
  // don't get the lastResult card until the user re-logs.
  useEffect(() => {
    let cancelled = false
    readL2CellsForDevice(deviceName).then(cells => {
      if (cancelled || !cells) return
      const parsed = parseSpeedStamp(cells.speedSetUp)
      if (parsed) {
        setLastResult({ fpm: parsed.fpm, rvs: parsed.rvs, ts: 0 })
        setFpm(String(parsed.fpm))
      }
    })
    return () => { cancelled = true }
  }, [deviceName])

  const handleLog = async () => {
    if (!plcConnected || !fpm) return
    setSending(true)
    setError(null)
    try {
      // Tell the PLC to capture its current commanded velocity into STS.RVS
      // (Rung 14 in the AOI: ONS on Log_RVS → MOVE Drive_Outputs.CommandedVelocity to STS.RVS)
      const result = await writeTag(deviceName, 'Log_RVS', 1, 'BOOL')
      if (result?.success === false) {
        setError(result?.error || 'Write failed')
        setSending(false)
        return
      }

      // Wait briefly for the PLC to capture and STS.RVS to update via the polling broadcast
      await new Promise(resolve => setTimeout(resolve, 600))

      // Read via ref so we pick up the latest broadcast (closure `sts` is stale)
      const capturedRvs = stsRef.current.RVS
      const fpmVal = parseInt(fpm || '0')

      if (capturedRvs == null) {
        setError('PLC did not return a current RVS value')
        setSending(false)
        return
      }

      // Stamp "Speed Set Up" with the enriched format so the FPM↔RVS pair is
      // persisted inside the L2 cell — no separate local table needed.
      const stamp = buildSpeedStamp(userName, fpmVal, capturedRvs)
      const l2Result = await writeL2Cells(deviceName, sheetName, userName, [
        { columnName: 'Speed Set Up', value: stamp },
      ])
      if (!l2Result?.success) {
        const failed = (l2Result?.written || []).filter((w: any) => !w.ok)
        throw new Error(l2Result?.error || (failed.length > 0 ? failed.map((f: any) => f.error).join(', ') : 'Spreadsheet write failed'))
      }

      setLastResult({ fpm: fpmVal, rvs: capturedRvs, ts: Date.now() })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
    setSending(false)
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground leading-relaxed">
        After tracking is done, calibrate the speed. Have mechanics measure the belt speed in FPM with a tachometer at the current motor RVS, type it below, then click Log Speed.
      </p>

      <div className="rounded-lg border bg-blue-50/50 dark:bg-blue-950/20 border-blue-200 dark:border-blue-800 p-3 flex items-start gap-2">
        <AlertTriangle className="h-4 w-4 text-blue-600 dark:text-blue-400 shrink-0 mt-0.5" />
        <p className="text-xs text-blue-800 dark:text-blue-200">
          <strong>Best practice:</strong> ask mechanics to measure FPM at <strong>30 RVS</strong> — gives the most accurate ratio.
        </p>
      </div>

      {/* Live current speed from PLC */}
      <div className={cn(
        "rounded-lg border bg-card p-4",
        stsErrors.RVS && "border-amber-300 bg-amber-50/40 dark:border-amber-800 dark:bg-amber-950/20",
      )}>
        <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">Current motor speed (from PLC)</p>
        <p className="font-mono text-2xl font-bold">
          {sts.RVS != null ? sts.RVS.toFixed(2) : '—'}
          <span className="text-sm text-muted-foreground font-normal ml-1.5">RVS</span>
        </p>
        {stsErrors.RVS && (
          <p className="mt-2 text-[11px] text-amber-700 dark:text-amber-400 leading-snug">
            <strong>PLC tag read failed:</strong> {stsErrors.RVS}.
            The reader couldn't fetch <code className="font-mono">CBT_{deviceName}.CTRL.STS.RVS</code>.
            Check that the AOI on this controller exposes that field as REAL.
          </p>
        )}
      </div>

      <div className="rounded-lg border bg-card p-4 space-y-3">
        <div>
          <p className="text-sm font-semibold">Log the FPM measurement</p>
          <p className="text-xs text-muted-foreground mt-0.5">
            Type the FPM the mechanic just tached, then click Log Speed. The tool captures the current RVS from the PLC and stores the pair.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">Tached FPM</label>
            <Input
              type="number"
              placeholder="e.g. 450"
              value={fpm}
              onChange={e => { setFpm(e.target.value); setError(null) }}
              className="h-10 w-28 font-mono"
            />
          </div>
          <div className="self-end">
            <ActionButton
              label="Log Speed"
              icon={Send}
              onClick={handleLog}
              disabled={!plcConnected || !fpm}
              sending={sending}
            />
          </div>
        </div>
      </div>

      {error && (
        <div className="flex items-start gap-2 text-xs text-red-600 dark:text-red-400 rounded-lg border border-red-300 dark:border-red-800 bg-red-50/50 dark:bg-red-950/20 p-3">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
          <span>{error}</span>
        </div>
      )}

      {lastResult && !error && (
        <div className="rounded-lg border border-green-300 bg-green-50/50 dark:border-green-800 dark:bg-green-950/20 p-4">
          <div className="flex items-center gap-2 mb-2">
            <CheckCircle2 className="h-4 w-4 text-green-600 dark:text-green-400 shrink-0" />
            <p className="text-sm font-semibold text-green-800 dark:text-green-200">Speed logged</p>
          </div>
          <div className="grid grid-cols-2 gap-3 text-sm">
            <div>
              <p className="text-xs text-muted-foreground">Belt speed (measured)</p>
              <p className="font-mono font-bold">{lastResult.fpm} <span className="font-normal text-xs text-muted-foreground">FPM</span></p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Motor speed (PLC)</p>
              <p className="font-mono font-bold">{lastResult.rvs.toFixed(2)} <span className="font-normal text-xs text-muted-foreground">RVS</span></p>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ── Step definitions ───────────────────────────────────────────────

const STEPS = [
  { num: 0, label: 'VFD Online', icon: Signal },
  { num: 1, label: 'Identity Check', icon: Fingerprint },
  { num: 2, label: 'Horsepower Check', icon: Settings2 },
  { num: 3, label: 'Bump Test', icon: Zap },
  { num: 4, label: 'Belt Tracking', icon: Play },
  { num: 5, label: 'Calibrate Speed', icon: Gauge },
]

// ── Main Modal Component ───────────────────────────────────────────

export function VfdWizardModal({ device, subsystemId, plcConnected, sheetName, onClose }: VfdWizardModalProps) {
  const { currentUser } = useUser()
  const userName = currentUser?.fullName
  const [activeStep, setActiveStep] = useState(0)
  const [sts, setSts] = useState<StsState>({
    Check_Allowed: null, Valid_Map: null, Valid_HP: null,
    Valid_Direction: null, Jogging: null, Track_Belt: null, RVS: null,
    KeypadButtonF1: null,
  })
  const [stsErrors, setStsErrors] = useState<StsErrors>({})
  const [stsLoading, setStsLoading] = useState(true)
  const [check4Complete, setCheck4Complete] = useState(false)
  // Server-side reader pushes VFD STS tag updates over WebSocket every ~100ms.
  // Wizard does NOT HTTP-poll. We:
  //   1. Open the reader on mount (server creates persistent handles + starts polling)
  //   2. Subscribe to 'VfdTagUpdate' WebSocket messages for this device
  //   3. Close the reader on unmount (frees handles)
  useEffect(() => {
    if (!plcConnected) {
      setStsLoading(false)
      return
    }

    let cancelled = false
    let ws: WebSocket | null = null

    // Step 1: Tell the server to open the reader for this device
    fetch('/api/vfd-commissioning/wizard-open', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceName: device.deviceName }),
    }).then(r => r.json()).then(result => {
      if (cancelled) return
      if (!result.success) {
        console.error('[VfdWizard] Failed to open reader:', result.error)
        setStsLoading(false)
        return
      }

      // Step 2: Open WebSocket subscription
      const wsProto = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
      const wsUrl = `${wsProto}//${window.location.host}/ws`
      ws = new WebSocket(wsUrl)

      let lastSummaryLog = 0
      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data)
          if (msg.type === 'VfdTagUpdate' && msg.deviceName === device.deviceName) {
            const s = msg.sts || {}
            const errs = (msg.errors || {}) as StsErrors

            // Always-on throttled console summary (1 line / sec) so field issues
            // are visible without rebuilding for dev mode.
            const now = Date.now()
            if (now - lastSummaryLog > 1000) {
              lastSummaryLog = now
              // eslint-disable-next-line no-console
              console.log(
                `[VfdWizard ${device.deviceName}]`,
                `Check_Allowed=${s.Check_Allowed}`,
                `Valid_Map=${s.Valid_Map}`,
                `Valid_HP=${s.Valid_HP}`,
                `Valid_Direction=${s.Valid_Direction}`,
                `Jogging=${s.Jogging}`,
                `Track_Belt=${s.Track_Belt}`,
                `RVS=${s.RVS}`,
                Object.keys(errs).length ? `errors=${JSON.stringify(errs)}` : '',
              )
            }

            setSts({
              Check_Allowed: s.Check_Allowed ?? null,
              Valid_Map: s.Valid_Map ?? null,
              Valid_HP: s.Valid_HP ?? null,
              Valid_Direction: s.Valid_Direction ?? null,
              Jogging: s.Jogging ?? null,
              Track_Belt: s.Track_Belt ?? null,
              RVS: s.RVS ?? null,
              KeypadButtonF1: s.KeypadButtonF1 ?? null,
            })
            setStsErrors(errs)
            setStsLoading(false)
          }
        } catch { /* ignore parse errors */ }
      }

      ws.onerror = (err) => console.error('[VfdWizard] WebSocket error:', err)
    }).catch(err => {
      console.error('[VfdWizard] Open request failed:', err)
      setStsLoading(false)
    })

    // Cleanup: close WebSocket + tell server to dispose reader
    return () => {
      cancelled = true
      if (ws) { try { ws.close() } catch { /* ignore */ } }
      fetch('/api/vfd-commissioning/wizard-close', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceName: device.deviceName }),
      }).catch(() => { /* ignore */ })
    }
  }, [plcConnected, device.deviceName])

  // Determine step statuses
  const getStepStatus = (stepNum: number): 'locked' | 'active' | 'done' | 'failed' => {
    if (stepNum === activeStep) return 'active'

    switch (stepNum) {
      case 0: return sts.Check_Allowed ? 'done' : (activeStep > 0 ? 'active' : 'active')
      case 1: return sts.Valid_Map ? 'done' : (sts.Check_Allowed ? (activeStep >= 1 ? 'active' : 'locked') : 'locked')
      case 2: return sts.Valid_HP ? 'done' : (sts.Valid_Map ? (activeStep >= 2 ? 'active' : 'locked') : 'locked')
      case 3: return sts.Valid_Direction ? 'done' : (sts.Valid_HP ? (activeStep >= 3 ? 'active' : 'locked') : 'locked')
      case 4: return check4Complete ? 'done' : (sts.Valid_Direction ? (activeStep >= 4 ? 'active' : 'locked') : 'locked')
      case 5: return check4Complete ? (activeStep >= 5 ? 'active' : 'locked') : 'locked'
      default: return 'locked'
    }
  }

  // Can user navigate to a step?
  const canGoTo = (stepNum: number): boolean => {
    if (stepNum === 0) return true
    if (stepNum === 1) return sts.Check_Allowed === true
    if (stepNum === 2) return sts.Valid_Map === true
    if (stepNum === 3) return sts.Valid_HP === true
    if (stepNum === 4) return sts.Valid_Direction === true
    if (stepNum === 5) return check4Complete === true
    return false
  }

  // Auto-advance when STS confirms current step
  useEffect(() => {
    if (activeStep === 0 && sts.Check_Allowed === true) setActiveStep(1)
  }, [sts.Check_Allowed, activeStep])

  // Handle escape key
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [onClose])

  return (
    <div className="fixed inset-0 z-50 flex">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />

      {/* Modal */}
      <div className="relative z-10 flex w-full max-w-4xl mx-auto my-4 sm:my-8 bg-background border rounded-xl shadow-2xl overflow-hidden">
        {/* Left sidebar — step navigation */}
        <div className="w-56 shrink-0 border-r bg-card flex flex-col">
          <div className="p-4 border-b">
            <div className="flex items-center gap-2 mb-1">
              <Zap className="h-4 w-4 text-amber-500" />
              <span className="text-sm font-bold">VFD Check</span>
            </div>
            <p className="font-mono text-xs font-semibold text-primary truncate">{device.deviceName}</p>
            <p className="text-[10px] text-muted-foreground truncate">{device.mcm}</p>
          </div>

          <nav className="flex-1 p-2 space-y-1 overflow-y-auto">
            {STEPS.map(step => {
              const status = getStepStatus(step.num)
              const clickable = canGoTo(step.num)
              return (
                <button
                  key={step.num}
                  onClick={() => clickable && setActiveStep(step.num)}
                  disabled={!clickable}
                  className="w-full text-left"
                >
                  <StepIndicator
                    stepNum={step.num}
                    label={step.label}
                    status={status}
                    active={activeStep === step.num}
                  />
                </button>
              )
            })}
          </nav>

          {/* PLC status */}
          <div className="p-3 border-t">
            <div className={cn(
              "flex items-center gap-2 px-2.5 py-1.5 rounded-md text-xs font-medium",
              plcConnected
                ? "bg-green-50 text-green-700 dark:bg-green-950/40 dark:text-green-400"
                : "bg-muted text-muted-foreground"
            )}>
              {plcConnected ? <Wifi className="h-3.5 w-3.5" /> : <WifiOff className="h-3.5 w-3.5" />}
              {plcConnected ? "PLC Connected" : "PLC Offline"}
            </div>
          </div>
        </div>

        {/* Right content area */}
        <div className="flex-1 flex flex-col min-w-0">
          {/* Header */}
          <div className="flex items-center justify-between px-6 py-4 border-b">
            <div>
              <h2 className="text-lg font-bold flex items-center gap-2">
                {(() => { const Icon = STEPS[activeStep].icon; return <Icon className="h-5 w-5 text-primary" /> })()}
                Step {activeStep + 1}: {STEPS[activeStep].label}
              </h2>
              <p className="text-xs text-muted-foreground mt-0.5">
                <span className="font-mono">{device.deviceName}</span>
                {device.mcm && <> &middot; {device.mcm}</>}
              </p>
            </div>
            <Button variant="ghost" size="sm" onClick={onClose} className="h-8 w-8 p-0">
              <X className="h-4 w-4" />
            </Button>
          </div>

          {/* Step content */}
          <div className="flex-1 overflow-y-auto px-6 py-5">
            {activeStep === 0 && <Step0Content sts={sts} loading={stsLoading} />}
            {activeStep === 1 && <Step1Content sts={sts} loading={stsLoading} deviceName={device.deviceName} plcConnected={plcConnected} />}
            {activeStep === 2 && <Step2Content sts={sts} loading={stsLoading} deviceName={device.deviceName} subsystemId={subsystemId} plcConnected={plcConnected} sheetName={sheetName} userName={userName} />}
            {activeStep === 3 && <Step3Content sts={sts} loading={stsLoading} deviceName={device.deviceName} plcConnected={plcConnected} sheetName={sheetName} userName={userName} />}
            {activeStep === 4 && <Step4Content sts={sts} stsErrors={stsErrors} loading={stsLoading} deviceName={device.deviceName} plcConnected={plcConnected} sheetName={sheetName} userName={userName} onComplete={() => setCheck4Complete(prev => !prev)} isComplete={check4Complete} />}
            {activeStep === 5 && <Step5Content sts={sts} stsErrors={stsErrors} loading={stsLoading} deviceName={device.deviceName} subsystemId={subsystemId} plcConnected={plcConnected} sheetName={sheetName} userName={userName} />}
          </div>

          {/* Footer navigation */}
          <div className="flex items-center justify-between px-6 py-3 border-t bg-card">
            <Button
              variant="outline"
              size="sm"
              disabled={activeStep === 0}
              onClick={() => setActiveStep(prev => Math.max(0, prev - 1))}
              className="h-9"
            >
              Back
            </Button>

            <div className="flex items-center gap-1.5">
              {STEPS.map((_, i) => (
                <div key={i} className={cn(
                  "h-1.5 rounded-full transition-all",
                  i === activeStep ? "w-6 bg-primary" : "w-1.5",
                  i !== activeStep && getStepStatus(i) === 'done' && "bg-green-500",
                  i !== activeStep && getStepStatus(i) !== 'done' && "bg-muted-foreground/25",
                )} />
              ))}
            </div>

            {activeStep < 5 ? (
              <Button
                size="sm"
                disabled={!canGoTo(activeStep + 1)}
                onClick={() => setActiveStep(prev => Math.min(5, prev + 1))}
                className="h-9 gap-1"
              >
                Next <ChevronRight className="h-3.5 w-3.5" />
              </Button>
            ) : (
              <Button size="sm" onClick={onClose} className="h-9">
                Done
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
