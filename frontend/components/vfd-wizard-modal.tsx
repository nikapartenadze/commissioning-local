"use client"

import { useState, useEffect, useRef, useCallback } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import { useUser } from '@/lib/user-context'
import { useSignalR, type VfdTagUpdate as VfdTagUpdatePayload } from '@/lib/signalr-client'
import {
  X, Wifi, WifiOff, Loader2, CheckCircle2, XCircle, AlertTriangle,
  Zap, CircleDot, Send, Play, Square, ChevronRight, RotateCcw,
  Signal, Fingerprint, Gauge, ArrowRight, Settings2, Lock, Repeat, Ban,
} from 'lucide-react'
import { VfdBumpFailDialog } from '@/components/vfd-bump-fail-dialog'
import { type VfdBlockerParty } from '@/lib/blockers'
import { formatBumpBlockerCell, parseBumpBlockerCell } from '@/lib/vfd-bump-blocker'

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
  /** True while Jog_Start_TMR is timing — i.e. the bump pre-roll (5s on the current AOI). */
  Starting: boolean | null
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

async function writeTag(
  subsystemId: number,
  deviceName: string,
  field: string,
  value: number,
  dataType: 'BOOL' | 'REAL' | 'INT',
  pathScope?: 'HMI',
) {
  const res = await fetch('/api/vfd-commissioning/write-tag', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ subsystemId, deviceName, field, value, dataType, pathScope }),
  })
  return res.json()
}

/**
 * Write one or more L2 spreadsheet cells for the active VFD device.
 * Used by wizard steps to fill in Verify Identity, Motor HP, VFD HP, "Check Direction", etc.
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
 * Read the six commissioning L2 cells for one device.
 *
 * L2 cells are now the single source of truth for VFD commissioning state
 * (the old VfdCheckState table is gone). This is how Step 2 / Step 5 prefill
 * their inputs on reopen.
 */
interface L2CommissioningCells {
  verifyIdentity:      string | null
  motorHpField:        string | null
  vfdHpField:          string | null
  checkDirection:      string | null
  polarity:            string | null
  beltTracked:         string | null
  speedSetUp:          string | null
  controlsVerified:    string | null
  /**
   * Test Run / Verify Controls (new step 3) — cloud-synced stamp written when
   * the operator confirms the drive ran without an immediate fault. This is the
   * 4th readiness control the cloud reads (it replaced "Check Direction" in the
   * cloud's Ready gate — see lib/belt-tracking/derive-ready.ts). Non-empty,
   * non-"fail" ⇒ pass. Durable across laptops (unlike the local-only
   * VfdControlsVerified SQLite stamp). May be null on sheets that haven't yet
   * received the "Run Verified" column from cloud.
   */
  runVerified:         string | null
  /** Bump Test "Bump didn't work?" blocker stamp: "<stamp> · <party> · <description>". */
  bumpBlocker:         string | null
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

/**
 * The "Polarity" L2 cell stores the chosen drive direction polarity along
 * with the operator's initials+date stamp, e.g. "ASH 9/5 · Normal" or
 * "ASH 9/5 · Inverter". Mirrors the Speed Set Up cell convention.
 *
 * Normal   = `Drive_Outputs.DirectionCmd_0` (forward)
 * Inverter = `Drive_Outputs.DirectionCmd_1` (reverse)
 */
type Polarity = 'Normal' | 'Inverter'

function buildPolarityStamp(userName: string | undefined, polarity: Polarity): string {
  return `${buildInitialsStamp(userName)} · ${polarity}`
}

function parsePolarityStamp(stamp: string | null | undefined): Polarity | null {
  if (!stamp) return null
  if (/\bInverter\b/i.test(stamp)) return 'Inverter'
  if (/\bNormal\b/i.test(stamp)) return 'Normal'
  return null
}

/**
 * Active Bump Test blocker (Step 3). Persisted in the `Bump Blocker` L2 cell and
 * mirrored to the shared Devices.Blocker* columns via the device-blocker sync op.
 */
interface BumpBlocker {
  party: VfdBlockerParty
  description: string
}

/**
 * Fire the device-level bump-blocker sync op (set/clear). Fire-and-forget:
 * enqueue is the success criterion, cloud push is async/best-effort with a
 * background retry loop (same philosophy as IO result sync). On failure we only
 * console.warn — a blocked sync must NEVER block the operator's wizard action.
 */
async function postBumpBlockerOp(
  body:
    | { subsystemId: number; deviceName: string; op: 'set'; blockerResponsibleParty: string; blockerDescription: string; updatedBy?: string }
    | { subsystemId: number; deviceName: string; op: 'clear'; expectedParty: string; expectedDescription: string; updatedBy?: string },
): Promise<void> {
  try {
    const res = await fetch('/api/vfd-commissioning/bump-blocker', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!res.ok) {
      console.warn(`[Step3] bump-blocker ${body.op} op returned HTTP ${res.status}`)
    }
  } catch (err) {
    console.warn(`[Step3] bump-blocker ${body.op} op failed:`, err instanceof Error ? err.message : err)
  }
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
      status === 'locked' && "opacity-50",
    )}>
      <div className={cn(
        "h-7 w-7 rounded-full flex items-center justify-center text-xs font-bold border-2 shrink-0",
        status === 'done' && "bg-green-500 border-green-600 text-white",
        status === 'failed' && "bg-red-500 border-red-600 text-white",
        status === 'active' && "bg-primary border-primary text-primary-foreground",
        status === 'locked' && "bg-muted border-muted-foreground/30 text-muted-foreground",
      )}>
        {status === 'done' ? <CheckCircle2 className="h-4 w-4" /> :
         status === 'failed' ? <XCircle className="h-4 w-4" /> :
         status === 'locked' ? <Lock className="h-3.5 w-3.5" /> :
         /* 1-indexed to match the header which renders `Step {activeStep+1}` */
         stepNum + 1}
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
      <span className="text-sm font-medium text-foreground">{label}</span>
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
      <p className="text-sm text-foreground/80 leading-relaxed">
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
        <div className="flex items-center gap-2 text-green-700 dark:text-green-400 text-sm font-medium">
          <CheckCircle2 className="h-4 w-4" />
          VFD is online. Continue to step 1.
        </div>
      )}
      {!loading && !allowed && (
        // "Check_Allowed" stays low when the drive's AOI isn't enabled — and the
        // most common field cause is NOT the drive itself but an incomplete
        // E-stop check: until the safety circuit for this zone is healthy
        // (E-stops reset), the AOI holds the enable bit off, so the wizard can
        // never leave step 0. The old message only said "waiting for the VFD",
        // which sent techs hunting the drive instead of the E-stop check.
        <div className="space-y-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3">
          <div className="flex items-center gap-2 text-amber-700 dark:text-amber-400 text-sm font-medium">
            <AlertTriangle className="h-4 w-4 flex-shrink-0" />
            Waiting for the VFD to come online…
          </div>
          <p className="text-xs text-amber-800/90 dark:text-amber-300/90 leading-relaxed pl-6">
            If this stays off, the most likely cause is that the <strong>E-stop check
            for this zone hasn’t been completed yet</strong>. The drive’s AOI only
            enables once the safety circuit is healthy (all E-stops reset), so the
            tool can’t take the VFD online until then. Complete the E-stop check for
            this zone first, then come back to this step. (Also confirm the drive is
            powered and not faulted.)
          </p>
        </div>
      )}
    </div>
  )
}

function Step1Content({ sts, loading, deviceName, subsystemId, plcConnected, sheetName, userName }: {
  sts: StsState; loading: boolean; deviceName: string; subsystemId: number; plcConnected: boolean
  sheetName?: string; userName?: string
}) {
  const [sending, setSending] = useState(false)
  const [lastError, setLastError] = useState<string | null>(null)
  const [sentOk, setSentOk] = useState(false)
  /** Latched: stays true once a rising edge of F1 is detected. */
  const [f1Detected, setF1Detected] = useState(false)
  const sendingRef = useRef(false)
  const f1WasPressedRef = useRef<boolean>(false)

  const f1Pressed = sts.KeypadButtonF1 === true
  const validMapDone = sts.Valid_Map === true

  // Confirm identity: send Valid_Map=1 to PLC + write "Verify Identity" L2 cell.
  const confirmIdentity = useCallback(async () => {
    if (sendingRef.current) return
    sendingRef.current = true
    setSending(true)
    setLastError(null)
    console.log(`[Step1] User confirmed F1 press — sending Valid_Map=1 to PLC...`)
    try {
      const result = await writeTag(subsystemId, deviceName, 'Valid_Map', 1, 'BOOL')
      if (result?.success === false) {
        console.error(`[Step1] Valid_Map write failed:`, result?.error)
        setLastError(result?.error || 'Write failed')
      } else {
        setSentOk(true)
        console.log(`[Step1] Valid_Map=1 sent successfully`)

        // Write "Verify Identity" L2 cell with initials stamp. NOT fire-and-forget:
        // Step 1 "done" is trusted from this L2 stamp on a CIP-saturated controller,
        // so a silently-failed stamp makes the wizard re-ask Identity forever.
        // Surface the failure like the Step 3 polarity pattern.
        const stamp = buildInitialsStamp(userName)
        const l2 = await writeL2Cells(deviceName, sheetName, userName, [
          { columnName: 'Verify Identity', value: stamp },
        ])
        const failedCells = (l2?.written || []).filter((w: any) => !w.ok)
        if (!l2?.success || failedCells.length > 0) {
          const why = failedCells.map((w: any) => w.error).filter(Boolean).join('; ') || l2?.error || 'write failed'
          console.warn('[Step1] Verify Identity L2 stamp FAILED:', why)
          setLastError(
            `Identity was confirmed on the PLC, but the "Verify Identity" record did NOT save (${why}). ` +
            `The wizard may re-ask this step until it saves — pull the latest data and confirm again.`,
          )
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`[Step1] Valid_Map write error:`, msg)
      setLastError(msg)
    } finally {
      sendingRef.current = false
      setSending(false)
    }
  }, [deviceName, sheetName, userName])

  // Detect F1 rising edge and latch it — user must manually confirm.
  // Re-arms after F1 is released so the user can re-press to retry.
  useEffect(() => {
    if (!plcConnected || validMapDone) return

    const wasPressed = f1WasPressedRef.current
    f1WasPressedRef.current = f1Pressed

    // Rising edge: F1 just went from FALSE/null to TRUE
    if (!wasPressed && f1Pressed) {
      console.log(`[Step1] F1 rising edge detected — waiting for user confirmation`)
      setF1Detected(true)
    }
  }, [f1Pressed, plcConnected, validMapDone])

  const showConfirmation = (f1Detected || f1Pressed) && !validMapDone && !sentOk

  return (
    <div className="space-y-4">
      <p className="text-sm text-foreground/80 leading-relaxed">
        Confirm this VFD in the tool matches the physical VFD in the field.
        Press <strong className="text-foreground">F1</strong> on the VFD keypad — the tool detects the keypad press and asks you to confirm.
      </p>

      {/* Live F1 keypad press indicator */}
      <div className={cn(
        "rounded-lg border p-4 transition-colors",
        f1Detected || f1Pressed
          ? "border-green-400 bg-green-50/60 dark:border-green-700 dark:bg-green-950/30"
          : "border-border bg-card",
      )}>
        <div className="flex items-center gap-3">
          <div className={cn(
            "h-11 w-11 rounded-md border flex items-center justify-center font-mono font-bold text-base transition-all",
            f1Pressed
              ? "bg-green-500 border-green-600 text-white"
              : f1Detected
                ? "bg-green-100 border-green-300 text-green-700 dark:bg-green-900/50 dark:border-green-700 dark:text-green-300"
                : "bg-muted border-border text-muted-foreground",
          )}>F1</div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold text-foreground">
              {f1Detected || f1Pressed
                ? (sentOk ? "F1 detected — identity confirmed" : "F1 press detected")
                : "Waiting for F1 press…"}
            </p>
            <p className="text-xs text-muted-foreground">
              {sending
                ? "Sending identity validation to PLC…"
                : sentOk
                  ? "Validated — waiting for PLC confirmation…"
                  : f1Detected || f1Pressed
                    ? "We detected a keypad press from the VFD"
                    : "Reading keypad input from the VFD"}
            </p>
          </div>
        </div>

        {/* Confirmation prompt — appears after F1 rising edge */}
        {showConfirmation && (
          <div className="mt-4 pt-3 border-t border-green-200 dark:border-green-800 space-y-3">
            <p className="text-sm font-semibold text-foreground">
              Did you just press F1 on{' '}
              <span className="font-mono text-primary">{deviceName}</span>?
            </p>
            <Button
              onClick={confirmIdentity}
              disabled={sending || !plcConnected}
              className={cn(
                "h-10 px-5 gap-2 font-semibold border-0",
                "bg-green-600 hover:bg-green-700 text-white",
                "dark:bg-green-600 dark:hover:bg-green-700 dark:text-white",
                sending && "animate-pulse",
              )}
            >
              {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
              Yes, I pressed it
            </Button>
          </div>
        )}
      </div>

      {lastError && (
        <div className="flex items-start gap-2 text-xs text-red-600 dark:text-red-400 rounded-lg border border-red-300 bg-red-50/50 dark:border-red-800 dark:bg-red-950/20 p-3">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
          <span>{lastError}</span>
        </div>
      )}

      {/* PLC confirmation — reads CTRL.STS.Valid_Map */}
      <StatusPill
        label="Identity verified"
        value={sts.Valid_Map}
        loading={loading}
        trueText="Yes"
        falseText="Not yet"
        pendingText="Checking…"
      />

      {validMapDone && (
        <div className="flex items-center gap-2 text-green-700 dark:text-green-400 text-sm font-medium">
          <CheckCircle2 className="h-4 w-4" />
          Identity confirmed. Continue to step 2.
        </div>
      )}
    </div>
  )
}

function Step2Content({ sts, loading, deviceName, subsystemId, plcConnected, sheetName, userName, onHpFilled }: {
  sts: StsState; loading: boolean; deviceName: string; subsystemId: number; plcConnected: boolean
  sheetName?: string; userName?: string
  /** Called after a successful Confirm HP write so the parent can gate the cascade on cell completeness, not just on STS.Valid_HP. */
  onHpFilled?: (motor: string, drive: string) => void
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
      const plcResult = await writeTag(subsystemId, deviceName, 'Valid_HP', 1, 'BOOL')
      if (plcResult?.success === false || plcResult?.error) {
        throw new Error(plcResult?.error || 'PLC write reported failure')
      }

      setSent(true)
      onHpFilled?.(motorHp, driveHp)
    } catch (err) {
      setConfirmError(err instanceof Error ? err.message : String(err))
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-foreground/80 leading-relaxed">
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

      {sts.Valid_HP === true && sent && (
        <div className="flex items-center gap-2 text-green-700 dark:text-green-400 text-sm font-medium">
          <CheckCircle2 className="h-4 w-4" />
          HP confirmed. Values saved. Continue to step 3.
        </div>
      )}

      {sts.Valid_HP === true && !sent && !canConfirm && (
        <div className="flex items-start gap-2 text-amber-700 dark:text-amber-400 text-xs rounded-lg border border-amber-300 bg-amber-50/50 dark:border-amber-800 dark:bg-amber-950/20 p-3">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
          <span>PLC confirms HP but the spreadsheet is empty. Enter the HP values and click <strong>Confirm HP</strong> to save them.</span>
        </div>
      )}
    </div>
  )
}

function Step3Content({ sts, loading, deviceName, subsystemId, plcConnected, sheetName, userName, initialPolarity, onPolaritySet, initialBumpBlocker, onBumpBlockerChange }: {
  sts: StsState; loading: boolean; deviceName: string; subsystemId: number; plcConnected: boolean
  sheetName?: string; userName?: string
  initialPolarity: Polarity | null
  onPolaritySet: (polarity: Polarity) => void
  /** Restored from the `Bump Blocker` L2 cell on wizard open; null = not blocked. */
  initialBumpBlocker: BumpBlocker | null
  /** Notify the parent so the at-a-glance state survives step navigation. */
  onBumpBlockerChange: (blocker: BumpBlocker | null) => void
}) {
  const [bumpSending, setBumpSending] = useState(false)
  const [comment, setComment] = useState('')
  const [bumpCount, setBumpCount] = useState(0)
  const [chosen, setChosen] = useState<Polarity | null>(initialPolarity)
  const [confirming, setConfirming] = useState<Polarity | null>(null)
  const [lastWriteError, setLastWriteError] = useState<string | null>(null)
  // Bump-fail blocker: dialog open state + the active blocker (red banner).
  const [bumpFailOpen, setBumpFailOpen] = useState(false)
  const [bumpBlocker, setBumpBlocker] = useState<BumpBlocker | null>(initialBumpBlocker)

  // Keep local banner in sync if the parent re-seeds it after an async L2 restore.
  useEffect(() => { setBumpBlocker(initialBumpBlocker) }, [initialBumpBlocker])

  const handleBump = async () => {
    setBumpSending(true)
    setLastWriteError(null)
    try {
      // CMD.Bump is gated by ONS(ONS.2) on rung 7 — only fires on rising edge.
      // If CMD.Bump is already 1 from a previous session, writing 1 again is a
      // no-op: ONS doesn't pulse, Starting never latches, motor never jogs.
      // Force the edge by writing 0 first, brief settle, then 1.
      const reset = await writeTag(subsystemId, deviceName, 'Bump', 0, 'BOOL')
      if (reset?.success === false) {
        setLastWriteError(`Bump (reset): ${reset?.error || 'write failed'}`)
        return
      }
      await new Promise(r => setTimeout(r, 120))
      const result = await writeTag(subsystemId, deviceName, 'Bump', 1, 'BOOL')
      if (result?.success === false) {
        setLastWriteError(`Bump: ${result?.error || 'write failed'}`)
      } else {
        setBumpCount(c => c + 1)
        if (process.env.NODE_ENV === 'development') console.log('[Step3] Sent Bump 0→1')
      }
    } catch (err) {
      setLastWriteError(`Bump: ${err instanceof Error ? err.message : String(err)}`)
    }
    setTimeout(() => setBumpSending(false), 1500)
  }

  /**
   * Record a Bump Test blocker from the VfdBumpFailDialog. Two persistence
   * paths, both best-effort and non-fatal:
   *   1. Write the durable `Bump Blocker` L2 cell (same write path + initials
   *      stamp Step 3 uses for "Check Direction"). If the sheet has no such
   *      column the write path returns ok:false for that cell (it does NOT
   *      throw) — we warn once and still fire the sync op.
   *   2. POST the device-level 'set' op so the shared Devices.Blocker* columns
   *      light up on the tracker + cloud dashboards.
   * Then show the red banner.
   */
  const handleBumpFailSubmit = async (party: VfdBlockerParty, description: string) => {
    const stamp = buildInitialsStamp(userName)
    const cellValue = formatBumpBlockerCell(stamp, party, description)

    // 1. Durable L2 cell — graceful skip when the column is absent.
    try {
      const l2 = await writeL2Cells(deviceName, sheetName, userName, [
        { columnName: 'Bump Blocker', value: cellValue },
      ])
      const failed = (l2?.written || []).filter((w: any) => !w.ok)
      if (failed.length > 0) {
        console.warn(
          `[Step3] "Bump Blocker" L2 cell not saved (${failed.map((w: any) => w.error || 'write failed').join(', ')}). ` +
          `The blocker still propagates to the device row; only the durable red-state restore is lost. ` +
          `Pull the latest L2 data from cloud to receive the missing column.`,
        )
      }
    } catch (err) {
      console.warn('[Step3] "Bump Blocker" L2 cell write error:', err instanceof Error ? err.message : err)
    }

    // 2. Device-level sync op (fire-and-forget).
    void postBumpBlockerOp({
      subsystemId,
      deviceName,
      op: 'set',
      blockerResponsibleParty: party,
      blockerDescription: description,
      updatedBy: userName,
    })

    // 3. Surface the red banner.
    const next: BumpBlocker = { party, description }
    setBumpBlocker(next)
    onBumpBlockerChange(next)
  }

  /**
   * Confirm direction + commit polarity in one atomic operator action:
   *   1. Write CMD.Reverse_Polarity / CMD.Normal_Polarity in one batch so
   *      they land in the same PLC scan (rung 13's SR latch settles cleanly).
   *   2. Write CMD.Valid_Direction = 1 — advances the wizard cascade.
   *   3. Stamp L2 cells: "Check Direction" with initials/date AND "Polarity"
   *      with "<INITIALS> <DATE> · Normal|Inverter".
   * Re-clickable until the operator leaves the step. PLC's Valid_Direction
   * stays true through polarity flips; only the routing (DirectionCmd_0 vs
   * DirectionCmd_1) changes.
   */
  const handleConfirm = async (polarity: Polarity) => {
    if (confirming) return
    setConfirming(polarity)
    setLastWriteError(null)
    try {
      const reverse = polarity === 'Inverter' ? 1 : 0
      const normal  = polarity === 'Normal'   ? 1 : 0
      const polRes = await fetch('/api/vfd-commissioning/write-tags-batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          subsystemId,
          deviceName,
          writes: [
            { field: 'Reverse_Polarity', value: reverse, dataType: 'BOOL' },
            { field: 'Normal_Polarity',  value: normal,  dataType: 'BOOL' },
          ],
        }),
      })
      const polJson = await polRes.json().catch(() => ({}))
      if (!polRes.ok || polJson?.success === false) {
        throw new Error(polJson?.error || `polarity write HTTP ${polRes.status}`)
      }

      // Now confirm direction. The PLC's Valid_Direction is gated on Valid_HP,
      // not on polarity — but we write polarity first so the latched routing
      // matches the operator's choice before the cascade locks Valid_Direction.
      const dirRes = await writeTag(subsystemId, deviceName, 'Valid_Direction', 1, 'BOOL')
      if (dirRes?.success === false) {
        throw new Error(`Valid_Direction: ${dirRes?.error || 'write failed'}`)
      }

      // Stamp both L2 cells. The Polarity stamp is NOT optional bookkeeping:
      // it is the ONLY durable record of the operator's choice. The PLC bits
      // live in volatile controller memory and every program download wipes
      // them to 0/0 — the background writer can only restore drives whose
      // stamp saved. Silent-swallowing this failure cost CDW5 three weeks of
      // verification work (May 2026) and sent belts backwards. Fail LOUDLY.
      const initials = buildInitialsStamp(userName)
      const polStamp = buildPolarityStamp(userName, polarity)
      try {
        const l2 = await writeL2Cells(deviceName, sheetName, userName, [
          { columnName: 'Check Direction', value: initials },
          { columnName: 'Polarity',        value: polStamp },
        ])
        const failed = (l2?.written || []).filter((w: any) => !w.ok)
        if (failed.length > 0) {
          console.warn('[Step3] L2 stamp write FAILED:', failed)
          const names = failed.map((w: any) => `"${w.columnName}" (${w.error || 'write failed'})`).join(', ')
          setLastWriteError(
            `Direction was set on the PLC, but the ${names} record did NOT save. ` +
            `Without the saved Polarity record this drive reverts to default direction ` +
            `after any PLC program download. Pull the latest data from cloud (Pull IOs) ` +
            `and press the direction button again.`,
          )
        }
      } catch (err) {
        console.warn('[Step3] L2 stamp write error:', err)
        setLastWriteError(
          `Direction was set on the PLC, but saving the Polarity record failed ` +
          `(${err instanceof Error ? err.message : String(err)}). ` +
          `It will not survive a PLC program download — re-confirm once the tool can save.`,
        )
      }

      setChosen(polarity)
      onPolaritySet(polarity)

      // Auto-clear any active bump blocker — confirming direction means the
      // motor moved correctly, so the recorded failure no longer applies.
      // Both clears are best-effort and NEVER block the polarity commit: the
      // PLC + Polarity stamp above are already done by the time we get here.
      if (bumpBlocker) {
        const active = bumpBlocker
        // Clear local banner immediately for responsive UI.
        setBumpBlocker(null)
        onBumpBlockerChange(null)
        // Empty the durable L2 cell (same write path; tolerant of missing column).
        try {
          await writeL2Cells(deviceName, sheetName, userName, [
            { columnName: 'Bump Blocker', value: '' },
          ])
        } catch (err) {
          console.warn('[Step3] clearing "Bump Blocker" L2 cell failed:', err instanceof Error ? err.message : err)
        }
        // Conditional clear of the shared Devices pair (cloud only nulls it if it
        // still matches what we recorded — never wipes a tracker re-triage).
        void postBumpBlockerOp({
          subsystemId,
          deviceName,
          op: 'clear',
          expectedParty: active.party,
          expectedDescription: active.description,
          updatedBy: userName,
        })
      }
    } catch (err) {
      setLastWriteError(err instanceof Error ? err.message : String(err))
    } finally {
      setConfirming(null)
    }
  }

  // Three-state phase derived from STS for the bump pill (see Step3Content
  // notes for AOI rev change — Jog_Start_TMR went 1s → 5s preset, so
  // Starting is true during the warm-up window; Jogging is true for the 1s
  // pulse. Idle = neither bit set.
  const bumpPhase: 'idle' | 'warming-up' | 'jogging' =
    sts.Jogging === true ? 'jogging'
    : sts.Starting === true ? 'warming-up'
    : 'idle'

  return (
    <div className="space-y-4">
      <p className="text-sm text-foreground/80 leading-relaxed">
        The belt is now tracked. Bump the motor to see which way it spins, then confirm the polarity.
        The drive warms up for a few seconds before pulsing for 1 second — that's the PLC's
        safety pre-roll. After bumping, click <strong>Forward → Set Normal</strong> if it
        spun the right way, or <strong>Reverse → Invert Polarity</strong> if it spun
        the opposite way. The PLC routes <code className="font-mono">DirectionCmd_0/1</code>
        accordingly and re-bumping verifies the new direction. Once direction and speed are
        set, the VFD is configured.
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
        <Button
          variant="outline"
          onClick={() => setBumpFailOpen(true)}
          className="h-12 px-4 text-sm font-semibold gap-2 border-2 border-red-300 text-red-700 hover:bg-red-50 hover:text-red-800 dark:border-red-800 dark:text-red-400 dark:hover:bg-red-950/30"
        >
          <Ban className="h-4 w-4" />
          Bump didn&apos;t work?
        </Button>
      </div>

      {/* Active bump blocker — red banner, styled like the "Confirm failed" box. */}
      {bumpBlocker && (
        <div className="rounded-lg border border-red-300 bg-red-50/60 dark:bg-red-950/30 dark:border-red-800 p-3 flex items-start gap-2">
          <Ban className="h-4 w-4 text-red-600 dark:text-red-400 shrink-0 mt-0.5" />
          <div className="space-y-0.5">
            <p className="text-xs font-semibold text-red-800 dark:text-red-300">
              Blocked — assigned to {bumpBlocker.party}: {bumpBlocker.description}
            </p>
            <p className="text-xs text-red-700/80 dark:text-red-400/80">
              Re-bump to retry. Confirming direction (Set Normal / Invert) clears this blocker.
            </p>
          </div>
        </div>
      )}

      <StatusPill
        label={
          bumpPhase === 'warming-up' ? 'Warming up — motor will jog in a moment'
          : 'Motor is jogging'
        }
        value={
          bumpPhase === 'warming-up' ? null
          : bumpPhase === 'jogging' ? true
          : sts.Jogging
        }
        loading={loading || bumpPhase === 'warming-up'}
        trueText="Yes"
        falseText="No"
        pendingText={bumpPhase === 'warming-up' ? 'Warming up…' : 'Checking…'}
      />

      <div className="space-y-1.5">
        <label className="text-xs font-medium text-muted-foreground">Direction observation (optional)</label>
        <Textarea
          placeholder="e.g. Motor running clockwise, belt moving forward…"
          value={comment}
          onChange={e => setComment(e.target.value)}
          className="min-h-[60px] text-sm"
        />
      </div>

      <div className="rounded-lg border bg-card p-4 space-y-3">
        <p className="text-sm font-medium text-foreground">Which direction did the motor spin?</p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          <ActionButton
            label={chosen === 'Normal' ? "Normal — Confirmed" : "Forward → Set Normal"}
            icon={chosen === 'Normal' ? CheckCircle2 : ArrowRight}
            onClick={() => handleConfirm('Normal')}
            disabled={!plcConnected || confirming !== null}
            sending={confirming === 'Normal'}
            variant={chosen === 'Normal' ? 'outline' : 'primary'}
          />
          <ActionButton
            label={chosen === 'Inverter' ? "Inverter — Confirmed" : "Reverse → Invert Polarity"}
            icon={chosen === 'Inverter' ? CheckCircle2 : Repeat}
            onClick={() => handleConfirm('Inverter')}
            disabled={!plcConnected || confirming !== null}
            sending={confirming === 'Inverter'}
            variant={chosen === 'Inverter' ? 'outline' : 'amber'}
          />
        </div>
        <p className="text-xs text-muted-foreground">
          Confirming the direction also writes <code className="font-mono">Valid_Direction</code>
          to the PLC and stamps the spreadsheet. Re-bump after switching to verify the new direction.
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

      {sts.Valid_Direction === true && chosen && (
        <div className="flex items-center gap-2 text-green-700 dark:text-green-400 text-sm font-medium">
          <CheckCircle2 className="h-4 w-4" />
          Direction confirmed — polarity set to <strong>{chosen}</strong>. Continue to Calibrate Speed.
        </div>
      )}

      <VfdBumpFailDialog
        open={bumpFailOpen}
        onOpenChange={setBumpFailOpen}
        deviceName={deviceName}
        onSubmit={handleBumpFailSubmit}
        onCancel={() => { /* nothing to undo — dialog just closes */ }}
      />
    </div>
  )
}


function Step4Content({ sts, stsErrors, loading, deviceName, subsystemId, plcConnected, sheetName, userName, onComplete, isComplete }: {
  sts: StsState
  stsErrors: StsErrors
  loading: boolean
  deviceName: string
  subsystemId: number
  plcConnected: boolean
  sheetName?: string
  userName?: string
  onComplete: () => void
  isComplete: boolean
}) {
  const [sending, setSending] = useState(false)
  const [writeError, setWriteError] = useState<string | null>(null)
  // Electrical/controls fault path: the drive faulted or won't run during the
  // Test Run. Reuses the same device-blocker dialog + sync op as the post-track
  // Bump Test, so a pre-track electrical/controls fault is routed to the
  // responsible vendor exactly like a bump failure.
  const [faultDialogOpen, setFaultDialogOpen] = useState(false)
  const [faultBlocker, setFaultBlocker] = useState<BumpBlocker | null>(null)

  // Record a Test Run fault blocker. Mirrors Step3Content.handleBumpFailSubmit:
  // durable "Bump Blocker" L2 cell (graceful skip if absent) + the device-level
  // 'set' sync op so the shared Devices.Blocker* columns light up. Best-effort,
  // never fatal.
  const handleFaultSubmit = async (party: VfdBlockerParty, description: string) => {
    const stamp = buildInitialsStamp(userName)
    const cellValue = formatBumpBlockerCell(stamp, party, description)
    try {
      const l2 = await writeL2Cells(deviceName, sheetName, userName, [
        { columnName: 'Bump Blocker', value: cellValue },
      ])
      const failed = (l2?.written || []).filter((w: any) => !w.ok)
      if (failed.length > 0) {
        console.warn(
          `[Step4/TestRun] "Bump Blocker" L2 cell not saved (${failed.map((w: any) => w.error || 'write failed').join(', ')}). ` +
          `The blocker still propagates to the device row.`,
        )
      }
    } catch (err) {
      console.warn('[Step4/TestRun] "Bump Blocker" L2 cell write error:', err instanceof Error ? err.message : err)
    }
    void postBumpBlockerOp({
      subsystemId,
      deviceName,
      op: 'set',
      blockerResponsibleParty: party,
      blockerDescription: description,
      updatedBy: userName,
    })
    setFaultBlocker({ party, description })
  }

  // Confirm the drive runs without an immediate fault → READY FOR TRACKING.
  // Writes the cloud-synced "Run Verified" L2 cell (the cloud's 4th readiness
  // control — see lib/belt-tracking/derive-ready.ts), then calls onComplete so
  // the parent persists the local SQLite VfdControlsVerified flag and flips
  // check4Complete. The L2 cell is the durable, cross-laptop record; the local
  // table is kept as a belt-and-suspenders fallback.
  const handleConfirm = async () => {
    setSending(true)
    setWriteError(null)
    try {
      // Stamp "Run Verified" — any non-empty, non-"fail" value reads as pass on
      // the cloud. Same write path + auto-sync as every other commissioning cell.
      const stamp = buildInitialsStamp(userName)
      const l2 = await writeL2Cells(deviceName, sheetName, userName, [
        { columnName: 'Run Verified', value: stamp },
      ])
      const failed = (l2?.written || []).filter((w: any) => !w.ok)
      if (failed.length > 0) {
        // Column may not be deployed to this sheet yet. Warn (not fatal) — the
        // local SQLite flag still records readiness; only the cloud Ready gate
        // misses it until the column is pulled from cloud.
        console.warn(
          `[Step3/TestRun] "Run Verified" L2 cell not saved ` +
          `(${failed.map((w: any) => w.error || 'write failed').join(', ')}). ` +
          `The conveyor is still marked ready locally; the cloud Ready gate will ` +
          `not see it until the "Run Verified" column is pulled from cloud.`,
        )
        setWriteError(
          'Marked ready locally, but the "Run Verified" record did not sync to cloud ' +
          '(column missing on this sheet). Pull the latest L2 data from cloud so the ' +
          'cloud Ready gate picks it up.',
        )
      }
    } catch (err) {
      console.warn('[Step3/TestRun] "Run Verified" L2 write error:', err instanceof Error ? err.message : err)
      setWriteError(
        `Marked ready locally, but saving the "Run Verified" record failed ` +
        `(${err instanceof Error ? err.message : String(err)}).`,
      )
    } finally {
      setSending(false)
    }
    // Always flip local state + persist the local SQLite flag, even if the L2
    // write degraded — readiness must NEVER be blocked by a sync hiccup.
    onComplete()
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-foreground/80 leading-relaxed">
        Run the drive and confirm it starts <strong>without an immediate fault</strong>, and that the VFD keypad controls (F0 / F1 / F2) respond. This catches electrical / controls problems <em>before</em> the mechanical team tracks the belt. When it runs clean, mark the conveyor <strong>Ready for Tracking</strong>.
      </p>

      <div className="rounded-lg border bg-amber-50/50 dark:bg-amber-950/20 border-amber-200 dark:border-amber-800 p-4 space-y-2">
        <p className="text-sm font-semibold text-amber-900 dark:text-amber-100">Verify these keypad controls</p>
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

      {/* Live speed — still useful for verifying F0/F2 work */}
      <div className="rounded-lg border bg-card p-4 space-y-3">
        <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Live Status</p>
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
          </p>
        )}
      </div>

      {/* Electrical / controls fault path — record a device blocker if the drive
          faults or won't run during the Test Run. Same dialog + sync op as the
          post-track Bump Test step. */}
      <div className="flex items-center gap-3">
        <Button
          variant="outline"
          onClick={() => setFaultDialogOpen(true)}
          className="h-10 px-4 text-sm font-semibold gap-2 border-2 border-red-300 text-red-700 hover:bg-red-50 hover:text-red-800 dark:border-red-800 dark:text-red-400 dark:hover:bg-red-950/30"
        >
          <Ban className="h-4 w-4" />
          Drive faulted / won&apos;t run?
        </Button>
      </div>

      {faultBlocker && (
        <div className="rounded-lg border border-red-300 bg-red-50/60 dark:bg-red-950/30 dark:border-red-800 p-3 flex items-start gap-2">
          <Ban className="h-4 w-4 text-red-600 dark:text-red-400 shrink-0 mt-0.5" />
          <div className="space-y-0.5">
            <p className="text-xs font-semibold text-red-800 dark:text-red-300">
              Blocked — assigned to {faultBlocker.party}: {faultBlocker.description}
            </p>
            <p className="text-xs text-red-700/80 dark:text-red-400/80">
              Resolve the fault, then re-run the drive and mark it ready. This blocker is recorded against the device row.
            </p>
          </div>
        </div>
      )}

      {/*
        TODO(PLC): The pre-track Test Run needs the motor to actually run so the
        operator can see it start without a fault — but at this point in the new
        flow Valid_Direction has NOT been committed yet (polarity is set in the
        post-track Bump Test step). If the run/jog command (Bump / a run
        setpoint) is gated on Valid_Direction at the PLC/AOI level, the drive
        won't move here. Permitting a provisional jog before Valid_Direction is a
        hardware / L5X question for the PLC owner — out of scope for this UI
        change. This step does NOT hard-require Valid_Direction in the cascade.
      */}
      <div className="pt-2 border-t">
        {isComplete ? (
          <div className="rounded-lg border border-green-300 bg-green-50/50 dark:border-green-800 dark:bg-green-950/20 p-4">
            <div className="flex items-center gap-2 mb-1">
              <CheckCircle2 className="h-4 w-4 text-green-600 dark:text-green-400 shrink-0" />
              <p className="text-sm font-semibold text-green-800 dark:text-green-200">Run verified — Ready for Tracking</p>
            </div>
            <p className="text-sm text-green-700 dark:text-green-300">
              The drive ran without an immediate fault. Notify the mechanical team that this conveyor is ready for belt tracking. Bump / polarity and speed calibration unlock after the belt is tracked.
            </p>
          </div>
        ) : (
          <>
            <p className="text-sm text-muted-foreground mb-3">
              Once the drive runs clean and F0 / F1 / F2 controls respond, mark this conveyor <strong>Ready for Tracking</strong>.
            </p>
            <ActionButton
              label="Run Verified — Ready for Tracking"
              icon={CheckCircle2}
              onClick={handleConfirm}
              disabled={!plcConnected}
              sending={sending}
              variant="primary"
            />
          </>
        )}

        {writeError && (
          <div className="mt-3 flex items-start gap-2 text-xs text-amber-700 dark:text-amber-400 rounded-lg border border-amber-300 bg-amber-50/50 dark:border-amber-800 dark:bg-amber-950/20 p-3">
            <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
            <span>{writeError}</span>
          </div>
        )}

        <p className="text-xs text-muted-foreground mt-3">
          The mechanical team will mark the <strong>Belt Tracked</strong> column when tracking is complete. <strong>Bump Test / polarity</strong> and <strong>speed calibration</strong> unlock after that.
        </p>
      </div>

      <VfdBumpFailDialog
        open={faultDialogOpen}
        onOpenChange={setFaultDialogOpen}
        deviceName={deviceName}
        title="Drive faulted / won't run — record blocker"
        onSubmit={handleFaultSubmit}
        onCancel={() => { /* nothing to undo — dialog just closes */ }}
      />
    </div>
  )
}

function Step5Content({ sts, stsErrors, loading, deviceName, subsystemId, plcConnected, sheetName, userName, onSpeedLogged }: {
  sts: StsState; stsErrors: StsErrors; loading: boolean; deviceName: string; subsystemId: number; plcConnected: boolean
  sheetName?: string; userName?: string; onSpeedLogged?: () => void
}) {
  void subsystemId // accepted for API parity; no longer used — state lives in L2

  const [fpm, setFpm] = useState('')
  const [sending, setSending] = useState(false)
  const [runAt30Sending, setRunAt30Sending] = useState(false)
  const [runAt30Sent, setRunAt30Sent] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Soft amber warning, distinct from `error`. Used when the measurement was
  // recorded successfully but a non-fatal caveat applies — e.g. the drive's
  // HMI.Speed_At_30rev tag doesn't exist on this controller, so we couldn't
  // push the RVS to the AOI but still stamped the spreadsheet.
  const [warning, setWarning] = useState<string | null>(null)
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

  // Send Run_At_30_RVS command — PLC sets CommandedVelocity to 29.99 (≈30 RVS).
  // Rung 19: XIC(Valid_Direction)[XIC(CMD.Run_At_30_RVS) ONS MOVE(29.99, CommandedVelocity), ...]
  // ONS(ONS.8) only fires on a rising edge of CMD.Run_At_30_RVS, so if the bit
  // is already 1 from a previous session/click, writing 1 again is a no-op —
  // velocity doesn't change. Force the edge by writing 0 first, brief settle,
  // then 1. Same pattern as the Bump fix.
  const handleRunAt30 = async () => {
    if (!plcConnected) return
    setRunAt30Sending(true)
    setError(null)
    try {
      const reset = await writeTag(subsystemId, deviceName, 'Run_At_30_RVS', 0, 'BOOL')
      if (reset?.success === false) {
        setError(`Run_At_30_RVS (reset): ${reset?.error || 'write failed'}`)
        return
      }
      await new Promise(r => setTimeout(r, 120))
      const result = await writeTag(subsystemId, deviceName, 'Run_At_30_RVS', 1, 'BOOL')
      if (result?.success === false) {
        setError(result?.error || 'Write failed')
      } else {
        setRunAt30Sent(true)
        console.log('[Step5] Sent Run_At_30_RVS 0→1')
        setTimeout(() => setRunAt30Sent(false), 3000)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
    setRunAt30Sending(false)
  }

  const handleLog = async () => {
    if (!plcConnected || !fpm) return
    setSending(true)
    setError(null)
    setWarning(null)
    try {
      // STS.RVS is now continuously updated by Rung 14:
      // MOVE(Drive_Outputs.CommandedVelocity, CTRL.STS.RVS) — always runs when Valid_Direction is true.
      // No need to send a Log_RVS command — just read the live value.
      const capturedRvs = stsRef.current.RVS
      const fpmVal = parseInt(fpm || '0')

      if (capturedRvs == null) {
        setError('PLC did not return a current RVS value')
        setSending(false)
        return
      }

      // 1. Write the calibrated RVS to the drive's HMI tag so the APF AOI
      //    picks it up automatically — replaces the old workflow where
      //    operators had to copy the cloud value by hand into the AOI.
      //    This is BEST-EFFORT: some controllers (older AOI revs, partial
      //    maps) simply don't expose HMI.Speed_At_30rev. When the tag exists
      //    we write it; when it doesn't, we do NOT abort — the operator still
      //    needs the measured FPM↔RVS pair recorded on the spreadsheet. Any
      //    failure here (HTTP error response OR a thrown fetch/parse error)
      //    becomes a soft amber warning, not a red error, and we fall through
      //    to stamp L2 anyway.
      let plcWarning: string | null = null
      const tagPath = `${deviceName}.HMI.Speed_At_30rev`
      try {
        const plcResult = await writeTag(subsystemId, deviceName, 'Speed_At_30rev', capturedRvs, 'REAL', 'HMI')
        if (plcResult?.success === false || plcResult?.error) {
          plcWarning = `Couldn't write ${tagPath} on the controller (${plcResult?.error || 'tag missing'}). The measurement was still saved to the spreadsheet — set the RVS in the AOI manually if this drive needs it.`
          console.warn(`[Step5] ${plcWarning}`)
        }
      } catch (writeErr) {
        plcWarning = `Couldn't write ${tagPath} on the controller (${writeErr instanceof Error ? writeErr.message : String(writeErr)}). The measurement was still saved to the spreadsheet — set the RVS in the AOI manually if this drive needs it.`
        console.warn(`[Step5] ${plcWarning}`)
      }

      // 2. Stamp "Speed Set Up" with the enriched format so the FPM↔RVS pair is
      //    persisted inside the L2 cell — no separate local table needed.
      const stamp = buildSpeedStamp(userName, fpmVal, capturedRvs)
      const l2Result = await writeL2Cells(deviceName, sheetName, userName, [
        { columnName: 'Speed Set Up', value: stamp },
      ])
      console.log('[Step5] writeL2Cells result:', JSON.stringify(l2Result))
      if (!l2Result?.success) {
        const failed = (l2Result?.written || []).filter((w: any) => !w.ok)
        throw new Error(l2Result?.error || (failed.length > 0 ? failed.map((f: any) => f.error).join(', ') : 'Spreadsheet write failed'))
      }

      setLastResult({ fpm: fpmVal, rvs: capturedRvs, ts: Date.now() })
      if (plcWarning) setWarning(plcWarning)
      onSpeedLogged?.()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
    setSending(false)
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-foreground/80 leading-relaxed">
        Calibrate the FPM ↔ RVS pair at 30 RVS. <strong>Start the belt from the VFD keypad (F1) first</strong> — this step only changes the speed setpoint of a belt that is already running. Then click <em>Send 30 RVS Setpoint</em>, tach the actual belt FPM, and click <em>Save Measurement</em>. The FPM/RVS pair is recorded on the commissioning spreadsheet, and the captured RVS is also pushed to <code className="font-mono">{deviceName}.HMI.Speed_At_30rev</code> on the drive when that tag is available so the APF AOI picks it up automatically.
      </p>

      {/* Live current speed from PLC — STS.RVS is continuously updated */}
      <div className={cn(
        "rounded-lg border bg-card p-4",
        stsErrors.RVS && "border-amber-300 bg-amber-50/40 dark:border-amber-800 dark:bg-amber-950/20",
      )}>
        <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">Current motor speed (live from PLC)</p>
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

      {/* Send 30 RVS setpoint — writes CMD.Run_At_30_RVS to the AOI */}
      <div className="rounded-lg border bg-card p-4 space-y-2">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-sm font-semibold">Send 30 RVS speed setpoint</p>
            <p className="text-xs text-muted-foreground">
              Writes the AOI's commanded velocity to 30 RVS. The belt must already be running (start it from the VFD keypad with F1). This command does <strong>not</strong> start a stopped belt — it only changes the speed of one that's already moving.
            </p>
          </div>
          <ActionButton
            label={runAt30Sent ? "Setpoint Sent" : "Send 30 RVS Setpoint"}
            icon={runAt30Sent ? CheckCircle2 : Play}
            onClick={handleRunAt30}
            disabled={!plcConnected}
            sending={runAt30Sending}
            variant={runAt30Sent ? 'outline' : 'amber'}
          />
        </div>
      </div>

      <div className="rounded-lg border bg-card p-4 space-y-3">
        <div>
          <p className="text-sm font-semibold">Record the FPM ↔ RVS pair</p>
          <p className="text-xs text-muted-foreground mt-0.5">
            Records the measured FPM and PLC RVS to the commissioning spreadsheet, and pushes the captured RVS to <code className="font-mono">{deviceName}.HMI.Speed_At_30rev</code> on the drive when that tag is available so the APF AOI picks it up automatically. If the drive doesn't expose that tag you'll see an amber warning to set the RVS in the AOI manually — the spreadsheet is still stamped.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">Tached FPM</label>
            <Input
              type="number"
              placeholder="e.g. 450"
              value={fpm}
              onChange={e => { setFpm(e.target.value); setError(null); setWarning(null) }}
              className="h-10 w-28 font-mono"
            />
          </div>
          <div className="self-end">
            <ActionButton
              label="Save Measurement"
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

      {warning && !error && (
        <div className="flex items-start gap-2 text-xs text-amber-700 dark:text-amber-400 rounded-lg border border-amber-300 dark:border-amber-800 bg-amber-50/50 dark:bg-amber-950/20 p-3">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
          <span>{warning}</span>
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

// ── New (reworked) flow ordering ────────────────────────────────────
// The wizard was reordered (2026-06) so polarity/direction is set AFTER the
// mechanic tracks the belt, not before. The new sequence is:
//
//   0 VFD Online
//   1 Identity Check
//   2 Horsepower Check
//   3 Test Run / Verify Controls   — confirm the drive RUNS without an
//                                     immediate fault → READY FOR TRACKING.
//                                     Writes the cloud-synced "Run Verified" L2
//                                     cell (the cloud's 4th readiness control,
//                                     which replaced "Check Direction").
//   --- [GATE: Belt Tracked] mechanic tracks the belt (reversible) ---
//   4 Bump Test / Polarity         — was step 3; now gated on beltTrackedDone.
//                                     Still writes Valid_Direction + "Check
//                                     Direction" + "Polarity" and keeps the
//                                     bump-fail blocker path.
//   5 Calibrate Speed              — still gated on beltTrackedDone.
//
// IMPORTANT: the *component* names (Step3Content/Step4Content) are deliberately
// NOT renamed to keep the diff reviewable. The mapping is:
//   STEPS[3] "Test Run / Verify Controls" → Step4Content (the old controls step)
//   STEPS[4] "Bump Test"                  → Step3Content (the old bump step)
// The render switch (activeStep===N) below wires each index to its component.
const STEPS = [
  { num: 0, label: 'VFD Online', icon: Signal },
  { num: 1, label: 'Identity Check', icon: Fingerprint },
  { num: 2, label: 'Horsepower Check', icon: Settings2 },
  // Test Run: prove the drive runs without an immediate electrical/controls
  // fault, then hand the conveyor to the mechanical team for belt tracking.
  { num: 3, label: 'Test Run', icon: Play },
  // Bump Test now ALSO captures polarity — the "Set Normal" / "Invert Polarity"
  // buttons confirm direction and write the Polarity L2 cell in the same action.
  // It now happens AFTER belt tracking, so it is gated on beltTrackedDone.
  { num: 4, label: 'Bump Test', icon: Zap },
  { num: 5, label: 'Calibrate Speed', icon: Gauge },
]

// ── Main Modal Component ───────────────────────────────────────────

export function VfdWizardModal({ device, subsystemId, plcConnected, sheetName, onClose }: VfdWizardModalProps) {
  const { currentUser } = useUser()
  const userName = currentUser?.fullName
  // Dedicated signalR instance for this wizard. Each useSignalR() call opens
  // its own WebSocket — cheap (one per open wizard), and the win is that we
  // inherit the shared hook's exponential-backoff reconnect, heartbeat, and
  // visibility-change recovery. The previous bespoke `new WebSocket(...)`
  // had none of that, which is why a single network blip used to freeze the
  // wizard until the operator reloaded the page.
  const signalR = useSignalR()
  const [activeStep, setActiveStep] = useState(0)
  const [sts, setSts] = useState<StsState>({
    Check_Allowed: null, Valid_Map: null, Valid_HP: null,
    Valid_Direction: null, Jogging: null, Starting: null, RVS: null,
    KeypadButtonF1: null,
  })
  const [stsErrors, setStsErrors] = useState<StsErrors>({})
  const [stsLoading, setStsLoading] = useState(true)
  // Test Run / Verify Controls (step index 3 in the reworked order) — the
  // operator confirmed the drive ran without an immediate fault → Ready for
  // Tracking. Cloud-synced via the "Run Verified" L2 cell, and also persisted
  // in the local VfdControlsVerified DB table (same-laptop fallback). The flag
  // name `check4Complete` / `setCheck4Complete` is kept to avoid churning
  // unrelated callers; it now means "Test Run done" and gates belt tracking.
  const [check4Complete, setCheck4Complete] = useState(false)
  // Polarity — derived from the L2 cell `Polarity` (Normal | Inverter). Set in
  // the post-track Bump Test step (index 4). Locked open after the operator
  // commits a choice; surfaced in the sidebar at-a-glance.
  const [polaritySetDone, setPolaritySetDone] = useState<Polarity | null>(null)
  // Bump Test "Bump didn't work?" blocker — restored from the `Bump Blocker` L2
  // cell. Held at the parent so the red state survives step navigation and feeds
  // the Step3Content banner the same way `initialPolarity` flows.
  const [bumpBlocker, setBumpBlocker] = useState<BumpBlocker | null>(null)
  // Step 2 (HP) is "really done" only when both HP cells are filled in L2 *and*
  // the PLC has Valid_HP=true. Tracking the cells here so the cascade can gate
  // on actual data being recorded, not just on the PLC bit being latched (which
  // can be true on test data without anyone ever clicking Confirm HP).
  const [hpFieldsFilled, setHpFieldsFilled] = useState(false)
  // Step 1 (Identity) / Step 3 (Direction) durable completion, restored from the
  // L2 "Verify Identity" / "Check Direction" cells. These steps used to derive
  // "done" *purely* from the live STS.Valid_Map / STS.Valid_Direction PLC reads,
  // so on a saturated/unreachable controller a single read timeout (or a PLC
  // power-cycle that dropped the latch) made an already-commissioned VFD demand
  // re-verification — "sometimes it asks, sometimes not". The spreadsheet stamp
  // is the durable record of "a human did this step once"; trusting it makes the
  // step survive read blips, exactly like HP/Controls/Speed already do.
  const [identityDone, setIdentityDone] = useState(false)
  const [directionDone, setDirectionDone] = useState(false)
  // Belt Tracked is a manual entry (filled by the mechanical team, not from
  // PLC). In the reworked flow BOTH the Bump Test (index 4) and Calibrate Speed
  // (index 5) steps are locked until the Belt Tracked L2 cell is filled.
  const [beltTrackedDone, setBeltTrackedDone] = useState(false)
  // Speed Set Up tracks whether Calibrate Speed (index 5) was completed.
  const [speedSetUpDone, setSpeedSetUpDone] = useState(false)
  // ── Clear Test button (header) ───────────────────────────────────
  // Inline two-click confirm so we don't need a confirm-modal component.
  // First click arms the button for 4 s; second click within that window
  // POSTs /api/vfd-commissioning/clear and resets local wizard state.
  const [clearArmed, setClearArmed] = useState(false)
  const [clearing, setClearing] = useState(false)
  const clearTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => { if (clearTimerRef.current) clearTimeout(clearTimerRef.current) }, [])
  useEffect(() => {
    readL2CellsForDevice(device.deviceName).then(cells => {
      console.log(`[VFD Wizard] Restoring state for ${device.deviceName}:`, {
        polarity: cells?.polarity ?? null,
        beltTracked: cells?.beltTracked ?? null,
        controlsVerified: cells?.controlsVerified ?? null,
        speedSetUp: cells?.speedSetUp ?? null,
      })
      // Step 1 "Verify Identity" / Step 3 "Check Direction" — durable proof the
      // step was completed once. Lets the cascade keep them done even when the
      // live STS read times out on a busy controller.
      if (cells?.verifyIdentity?.trim()) setIdentityDone(true)
      if (cells?.checkDirection?.trim()) setDirectionDone(true)
      // Step 4 "Polarity" — restore from L2 cell. Tolerates legacy stamps.
      const parsedPolarity = parsePolarityStamp(cells?.polarity)
      if (parsedPolarity) setPolaritySetDone(parsedPolarity)
      // Step 3 "Bump Blocker" — restore the active blocker (red banner). Tolerant
      // of the column being absent (cells.bumpBlocker stays null → no banner).
      const parsedBlocker = parseBumpBlockerCell(cells?.bumpBlocker)
      setBumpBlocker(parsedBlocker ? { party: parsedBlocker.party as VfdBlockerParty, description: parsedBlocker.description } : null)
      // Step 2 HP cell completeness — both must be non-empty for the cascade
      // to consider the step done.
      setHpFieldsFilled(Boolean(cells?.motorHpField?.trim() && cells?.vfdHpField?.trim()))

      if (cells?.beltTracked?.trim()) setBeltTrackedDone(true)
      // Test Run / Verify Controls (step 3) — now has a cloud-synced "Run
      // Verified" L2 cell, so it restores durably across laptops (the local
      // VfdControlsVerified stamp is a same-laptop fallback). Also infer from
      // downstream proof: if Belt Tracked or Speed Set Up are filled, Test Run
      // *must* have happened — those steps gate on it. (The "Run Verified" cell
      // is itself a ready-gate control, but unlike Check Direction it is ONLY
      // ever written by this step, so trusting it does not create the
      // false-positive the old four-cell inference avoided.)
      const inferredTestRunDone =
        Boolean(cells?.runVerified?.trim()) ||
        Boolean(cells?.controlsVerified) ||
        Boolean(cells?.beltTracked?.trim()) ||
        Boolean(cells?.speedSetUp?.trim())
      if (inferredTestRunDone) setCheck4Complete(true)
      // Calibrate Speed (step 5) — mark done if the L2 cell already has a value.
      if (cells?.speedSetUp?.trim()) setSpeedSetUpDone(true)
    })
  }, [device.deviceName])
  // Server-side reader pushes VFD STS updates every ~50 ms while the wizard is
  // open. We:
  //   1. Open the reader via HTTP (server creates persistent handles + starts polling)
  //   2. Subscribe to the shared WebSocket's onVfdTagUpdate dispatch (filter by deviceName)
  //   3. Heartbeat the reader every 60 s so the server's 120 s idle sweeper doesn't reap it
  //   4. Close the reader on unmount
  // The WebSocket lifecycle (open/close/reconnect/heartbeat/health) is owned by
  // the shared useSignalR hook above — we just attach a callback and trust it.
  // If the socket drops and reconnects, our subscription survives (the
  // callback set is independent of the socket lifecycle), the server resumes
  // pushing VfdTagUpdate broadcasts, and the wizard recovers without any
  // operator action. This is the fix for "wizard freezes until I reload".
  useEffect(() => {
    if (!plcConnected) {
      setStsLoading(false)
      return
    }

    let cancelled = false
    let lastSummaryLog = 0

    const handleVfdTagUpdate = (msg: VfdTagUpdatePayload) => {
      if (cancelled || msg.deviceName !== device.deviceName) return
      const s = msg.sts || {}
      const errs = (msg.errors || {}) as StsErrors

      // Always-on throttled console summary (1 line / sec) so field issues are
      // visible without rebuilding for dev mode.
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
          `Starting=${s.Starting}`,
          `RVS=${s.RVS}`,
          Object.keys(errs).length ? `errors=${JSON.stringify(errs)}` : '',
        )
      }

      setSts({
        Check_Allowed: typeof s.Check_Allowed === 'boolean' ? s.Check_Allowed : null,
        Valid_Map: typeof s.Valid_Map === 'boolean' ? s.Valid_Map : null,
        Valid_HP: typeof s.Valid_HP === 'boolean' ? s.Valid_HP : null,
        Valid_Direction: typeof s.Valid_Direction === 'boolean' ? s.Valid_Direction : null,
        Jogging: typeof s.Jogging === 'boolean' ? s.Jogging : null,
        Starting: typeof s.Starting === 'boolean' ? s.Starting : null,
        RVS: typeof s.RVS === 'number' ? s.RVS : null,
        KeypadButtonF1: typeof s.KeypadButtonF1 === 'boolean' ? s.KeypadButtonF1 : null,
      })
      setStsErrors(errs)
      setStsLoading(false)
    }

    // Subscribe to the shared dispatcher BEFORE opening the reader, so any
    // broadcast that lands between the open response and us wiring the handler
    // still gets picked up.
    signalR.onVfdTagUpdate(handleVfdTagUpdate)
    // Make sure our underlying WebSocket is actually open. The hook is idempotent
    // if already connected; if not, it kicks off the connect + reconnect machine.
    signalR.connect()

    const openReader = () => fetch('/api/vfd-commissioning/wizard-open', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceName: device.deviceName, subsystemId }),
    }).then(r => r.json()).then(result => {
      if (cancelled) return
      if (!result?.success) {
        console.error('[VfdWizard] Failed to open reader:', result?.error)
        setStsLoading(false)
      }
    }).catch(err => {
      if (cancelled) return
      console.error('[VfdWizard] Open request failed:', err)
      setStsLoading(false)
    })

    openReader()

    // On WebSocket reconnect, re-call wizard-open immediately. Two scenarios:
    //   - Server-side reader still alive (normal blip): the call is a cheap
    //     no-op that just touches lastUsedMs.
    //   - Server was restarted: the reader is gone, and without this we'd
    //     wait up to 60s for the next heartbeat to re-create it (wizard data
    //     stale all that time). Re-calling here closes the gap.
    const handleReconnected = () => {
      if (cancelled) return
      console.log(`[VfdWizard ${device.deviceName}] WS reconnected — refreshing reader`)
      openReader()
    }
    signalR.onReconnected(handleReconnected)

    // Heartbeat: re-call wizard-open every 60s to prevent the 120s idle timeout
    // from reaping the reader while mechanics work on belt tracking, etc. Also
    // serves as the recovery path if the server was restarted — the next
    // heartbeat re-creates the reader transparently.
    const heartbeat = setInterval(() => {
      fetch('/api/vfd-commissioning/wizard-open', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceName: device.deviceName, subsystemId }),
      }).catch(() => { /* ignore */ })
    }, 60_000)

    return () => {
      cancelled = true
      clearInterval(heartbeat)
      signalR.offVfdTagUpdate(handleVfdTagUpdate)
      signalR.offReconnected(handleReconnected)
      fetch('/api/vfd-commissioning/wizard-close', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceName: device.deviceName, subsystemId }),
      }).catch(() => { /* ignore */ })
    }
  }, [
    plcConnected, device.deviceName,
    signalR.connect, signalR.onVfdTagUpdate, signalR.offVfdTagUpdate,
    signalR.onReconnected, signalR.offReconnected,
  ])

  // ── Cascade gating ───────────────────────────────────────────────
  // Each step's "own" criterion. `true` = passed, `false` = explicitly
  // failed/cleared, `null` = not yet known (transient — read pending,
  // PLC handle reconnecting, etc.). We *never* drop a step from done →
  // locked on a null; only an explicit `false` regresses it. Without
  // this latch, a momentary STS glitch flashes the cascade red and
  // snaps the operator back to step 1.
  // Six steps, REWORKED ORDER (2026-06). Index → step:
  //   0 VFD Online      — Check_Allowed
  //   1 Identity Check  — identityDone || Valid_Map
  //   2 Horsepower      — Valid_HP AND both HP cells filled
  //   3 Test Run        — check4Complete (drive ran clean → Ready for Tracking).
  //                       Durably restored from the "Run Verified" L2 cell (and
  //                       the local VfdControlsVerified fallback).
  //   4 Bump Test       — (directionDone || Valid_Direction) AND beltTrackedDone.
  //                       Polarity/direction is now set AFTER the mechanic tracks
  //                       the belt, so this step is GATED on the Belt Tracked
  //                       cell being filled. Until then it stays `null` (locked),
  //                       NOT `false` (which would flash the cascade red).
  //   5 Calibrate Speed — speedSetUpDone AND beltTrackedDone (still post-track).
  //
  // For steps that require an operator-typed/clicked record AND a PLC bit:
  //   Step 2 (HP)   — gated on Valid_HP AND both HP cells filled. The PLC bit
  //                   alone is too loose; on test data Valid_HP can be true
  //                   from a prior commissioning, but until the operator
  //                   actually types HP and clicks Confirm, the spreadsheet
  //                   stays blank. Without this, the cascade marks the step
  //                   green and the operator walks past without typing.
  //   Step 4 (Bump) — gated on Valid_Direction ALONE for the polarity record
  //                   (Polarity L2 cell optional — see below) AND on
  //                   beltTrackedDone for the new post-track ordering. Pressing
  //                   Forward/Reverse records the polarity choice (and is what
  //                   writes Valid_Direction to the PLC on a fresh device), but a
  //                   recorded polarity is NOT required to advance. On a
  //                   reopened/already-tracked device the PLC has
  //                   Valid_Direction latched while the Polarity L2 cell may
  //                   never have restored — requiring it stranded operators on
  //                   Bump Test with no way forward. Polarity is now optional.
  const stepDoneOwn: Array<boolean | null> = [
    sts.Check_Allowed,
    // Identity: durable L2 stamp wins. Once "Verify Identity" is recorded the
    // step stays done regardless of a transient STS.Valid_Map read timeout or a
    // PLC power-cycle (the validation writer re-asserts the bit separately).
    identityDone || sts.Valid_Map === true ? true
      : sts.Valid_Map === false ? false
      : null,
    sts.Valid_HP === true && hpFieldsFilled ? true
      : sts.Valid_HP === false ? false
      : null,
    // Test Run / Verify Controls — operator confirmed the drive ran without an
    // immediate fault. No PLC bit gates this (the drive may run before
    // Valid_Direction is committed — see TODO(PLC) in Step4Content).
    check4Complete ? true : null,
    // Bump Test / Polarity — now GATED on beltTrackedDone. Even with
    // Valid_Direction latched, the step stays locked (null) until the mechanic
    // fills the Belt Tracked cell. Direction itself uses the durable-L2-wins
    // treatment (directionDone || Valid_Direction) like Identity.
    beltTrackedDone
      ? (directionDone || sts.Valid_Direction === true ? true
         : sts.Valid_Direction === false ? false
         : null)
      : null,
    // Calibrate Speed — also gated on beltTrackedDone (unchanged post-track gate).
    beltTrackedDone && speedSetUpDone ? true : null,
  ]
  const lastTrueRef = useRef<boolean[]>([false, false, false, false, false, false])
  const stepKey = stepDoneOwn.map(v => v === true ? '1' : v === false ? '0' : '?').join('')
  useEffect(() => {
    for (let i = 0; i < stepDoneOwn.length; i++) {
      const v = stepDoneOwn[i]
      if (v === true) lastTrueRef.current[i] = true
      else if (v === false) lastTrueRef.current[i] = false
      // null → leave cached value alone
    }
  }, [stepKey]) // eslint-disable-line react-hooks/exhaustive-deps

  // Cascade: step N is only "done" if every step ≤ N is done by its own
  // criterion. The moment any step regresses, every downstream step
  // collapses to "locked" so the operator can't keep mashing buttons
  // past a broken prerequisite.
  const stepDone: boolean[] = []
  {
    let ok = true
    for (let i = 0; i < 6; i++) {
      ok = ok && lastTrueRef.current[i]
      stepDone.push(ok)
    }
  }
  const firstBadIndex = stepDone.findIndex(d => !d) // -1 = all done

  // Auto-snap activeStep back if it sits past a broken prerequisite.
  useEffect(() => {
    if (firstBadIndex !== -1 && activeStep > firstBadIndex) setActiveStep(firstBadIndex)
  }, [firstBadIndex, activeStep])

  const handleClearTest = useCallback(async () => {
    if (!clearArmed) {
      setClearArmed(true)
      if (clearTimerRef.current) clearTimeout(clearTimerRef.current)
      clearTimerRef.current = setTimeout(() => setClearArmed(false), 4000)
      return
    }
    if (clearTimerRef.current) { clearTimeout(clearTimerRef.current); clearTimerRef.current = null }
    setClearArmed(false)
    setClearing(true)
    try {
      const res = await fetch('/api/vfd-commissioning/clear', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          deviceName: device.deviceName,
          sheetName,
          clearPlc: plcConnected,
          updatedBy: userName,
          subsystemId,
        }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      // Clean slate. STS bits will follow from the WS reader once the PLC
      // Invalidate_* pulses propagate; until then the cascade keeps the
      // operator on whichever step is the first not-yet-reset.
      setActiveStep(0)
      setPolaritySetDone(null)
      setBumpBlocker(null)
      setCheck4Complete(false)
      setSpeedSetUpDone(false)
      setBeltTrackedDone(false)
      setHpFieldsFilled(false)
      setIdentityDone(false)
      setDirectionDone(false)
      // Re-arm the auto-backfill so it can run again if STS is still high.
      backfilledRef.current = false
      // Same for the HMI.Speed_At_30rev backfill — the L2 stamp it reads
      // from is about to be NULL'd, so it will naturally no-op on re-run,
      // but resetting the guard keeps the logic symmetric.
      speedBackfilledRef.current = false
      // Refresh from L2 — cells should all be NULL now; mirror the mount
      // useEffect's restore logic so any racing cell still in flight is
      // honoured rather than ignored.
      readL2CellsForDevice(device.deviceName).then(cells => {
        const parsedPolarity = parsePolarityStamp(cells?.polarity)
        if (parsedPolarity) setPolaritySetDone(parsedPolarity)
        const parsedBlocker = parseBumpBlockerCell(cells?.bumpBlocker)
        setBumpBlocker(parsedBlocker ? { party: parsedBlocker.party as VfdBlockerParty, description: parsedBlocker.description } : null)
        if (cells?.verifyIdentity?.trim()) setIdentityDone(true)
        if (cells?.checkDirection?.trim()) setDirectionDone(true)
        setHpFieldsFilled(Boolean(cells?.motorHpField?.trim() && cells?.vfdHpField?.trim()))
        if (cells?.beltTracked?.trim()) setBeltTrackedDone(true)
        const inferredTestRunDone =
          Boolean(cells?.runVerified?.trim()) ||
          Boolean(cells?.controlsVerified) ||
          Boolean(cells?.beltTracked?.trim()) ||
          Boolean(cells?.speedSetUp?.trim())
        if (inferredTestRunDone) setCheck4Complete(true)
        if (cells?.speedSetUp?.trim()) setSpeedSetUpDone(true)
      })
    } catch (err) {
      console.error('[VfdWizard] Clear failed:', err)
    } finally {
      setClearing(false)
    }
  }, [clearArmed, device.deviceName, sheetName, plcConnected, userName])

  const getStepStatus = (stepNum: number): 'locked' | 'active' | 'done' | 'failed' => {
    if (stepNum === activeStep) return 'active'
    if (stepDone[stepNum]) return 'done'
    // Distinguish a regression (red) from an unreached step (grey/locked).
    // Only flag 'failed' on the first broken step *and* only when its bit
    // is explicitly false — never on a transient null/loading.
    if (stepNum === firstBadIndex && stepDoneOwn[stepNum] === false) return 'failed'
    return 'locked'
  }

  // Navigable: any step up to and including the first broken one. Past
  // that, the cascade has collapsed and the step is locked.
  const canGoTo = (stepNum: number): boolean => {
    if (stepNum === 0) return true
    return firstBadIndex === -1 || stepNum <= firstBadIndex
  }

  // Auto-advance when STS confirms current step
  useEffect(() => {
    if (activeStep === 0 && sts.Check_Allowed === true) setActiveStep(1)
  }, [sts.Check_Allowed, activeStep])

  // Inverse-backfill: push the cached RVS from a prior wizard session into
  // the drive's HMI.Speed_At_30rev tag. The L2 "Speed Set Up" cell already
  // carries the RVS inside its enriched stamp ("ASH 9/5 · 200 FPM @ 25.30
  // RVS"), so VFDs that were calibrated before this PLC write was wired up
  // can be brought into sync without a re-run.
  //
  // One-shot per wizard open (re-armed by Clear Test). Best-effort: a
  // missing/older AOI without the HMI struct returns tag-not-found, which
  // we log but do NOT surface — the operator can still re-run Step 5 to
  // get a clean error path.
  const speedBackfilledRef = useRef(false)
  useEffect(() => {
    if (speedBackfilledRef.current) return
    if (!plcConnected) return
    speedBackfilledRef.current = true
    readL2CellsForDevice(device.deviceName).then(cells => {
      const parsed = parseSpeedStamp(cells?.speedSetUp)
      if (!parsed) return
      console.log(`[VfdWizard] Backfilling ${device.deviceName}.HMI.Speed_At_30rev = ${parsed.rvs} from cached stamp`)
      fetch('/api/vfd-commissioning/write-tag', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          subsystemId,
          deviceName: device.deviceName,
          field: 'Speed_At_30rev',
          value: parsed.rvs,
          dataType: 'REAL',
          pathScope: 'HMI',
        }),
      })
        .then(r => r.json().catch(() => ({})))
        .then(result => {
          if (result?.success) {
            console.log(`[VfdWizard] Backfill OK: ${device.deviceName}.HMI.Speed_At_30rev = ${parsed.rvs}`)
          } else {
            console.warn(`[VfdWizard] Backfill failed for ${device.deviceName}.HMI.Speed_At_30rev:`, result?.error)
          }
        })
        .catch(err => console.warn(`[VfdWizard] Backfill request error for ${device.deviceName}:`, err))
    }).catch(() => { /* best-effort */ })
  }, [plcConnected, device.deviceName])

  // Auto-backfill L2 cells for steps the PLC has already validated. The
  // wizard's Confirm buttons normally write the audit stamps, but if a VFD
  // was commissioned in a prior session — or the operator opened the
  // wizard on a device the cascade marks as already-done and never clicks
  // through Step 1's "Yes, I pressed it" — the L2 cells stay blank even
  // though the PLC state says it was completed. We catch the obvious gaps
  // here so the spreadsheet matches PLC truth without manual rework.
  //
  // Only stamp from PLC bits that are unambiguous (Valid_Map ⇒ Identity
  // confirmed; Valid_Direction ⇒ direction confirmed). We do NOT auto-fill
  // Polarity — there's no way to tell from PLC state alone whether the
  // operator chose Normal vs Inverter, so we leave that one for the
  // explicit click in Step 4.
  const backfilledRef = useRef(false)
  useEffect(() => {
    if (backfilledRef.current) return
    if (!sheetName || !userName) return
    // Wait until we have at least one confirmed PLC bit to act on.
    if (sts.Valid_Map == null && sts.Valid_Direction == null) return

    backfilledRef.current = true
    readL2CellsForDevice(device.deviceName).then(cells => {
      if (!cells) return
      const toWrite: { columnName: string; value: string }[] = []
      const stamp = buildInitialsStamp(userName)

      // Step 1: Valid_Map true but "Verify Identity" not stamped.
      if (sts.Valid_Map === true && !cells.verifyIdentity?.trim()) {
        toWrite.push({ columnName: 'Verify Identity', value: stamp })
      }
      // Step 4 (Bump Test): Valid_Direction true but "Check Direction" not stamped.
      if (sts.Valid_Direction === true && !cells.checkDirection?.trim()) {
        toWrite.push({ columnName: 'Check Direction', value: stamp })
      }

      if (toWrite.length > 0) {
        console.log(`[VfdWizard] Auto-backfilling ${toWrite.length} L2 cell(s) for ${device.deviceName}: ${toWrite.map(c => c.columnName).join(', ')}`)
        writeL2Cells(device.deviceName, sheetName, userName, toWrite).then(r => {
          const failed = (r?.written || []).filter((w: any) => !w.ok)
          if (!r?.success || failed.length > 0) {
            // Loud, and re-arm so a later PLC-bit change in this mount retries —
            // a swallowed backfill failure left the stamp missing with no trace.
            console.warn(`[VfdWizard] Auto-backfill FAILED for ${device.deviceName}:`, r?.error || failed)
            backfilledRef.current = false
          }
        })
      }
    })
  }, [sts.Valid_Map, sts.Valid_Direction, device.deviceName, sheetName, userName])

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

          {/* At-a-glance status — visible on every step so the operator doesn't
              have to navigate back to Bump Test or Test Run to find out
              whether polarity was reversed or whether the belt is ready for
              the mechanical team to track. Polarity comes from the L2 cell
              committed in the post-track Bump Test step; tracking state combines
              the operator's Test Run / "Run Verified" click with the mechanical
              team's Belt Tracked stamp. */}
          <div className="px-4 py-3 border-b space-y-2.5 bg-muted/20">
            <div>
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold mb-1">Polarity</p>
              <div className="flex items-center gap-1.5">
                <div className={cn(
                  "h-2 w-2 rounded-full shrink-0",
                  polaritySetDone === 'Normal' && "bg-green-500",
                  polaritySetDone === 'Inverter' && "bg-amber-500",
                  polaritySetDone === null && "bg-muted-foreground/40",
                )} />
                <span className={cn(
                  "text-xs font-medium",
                  polaritySetDone === 'Normal' && "text-green-700 dark:text-green-400",
                  polaritySetDone === 'Inverter' && "text-amber-700 dark:text-amber-400",
                  polaritySetDone === null && "text-muted-foreground",
                )}
                  title={
                    polaritySetDone === 'Inverter'
                      ? 'Drive direction was reversed — DirectionCmd_1 routed by the AOI'
                      : polaritySetDone === 'Normal'
                        ? 'Drive runs forward — DirectionCmd_0 routed by the AOI'
                        : 'Polarity not yet committed in the Bump Test step (after belt tracking)'
                  }
                >
                  {polaritySetDone === null ? 'Not set' : polaritySetDone === 'Normal' ? 'Normal' : 'Reversed'}
                </span>
              </div>
            </div>
            <div>
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold mb-1">Tracking</p>
              <div className="flex items-center gap-1.5">
                <div className={cn(
                  "h-2 w-2 rounded-full shrink-0",
                  beltTrackedDone && "bg-green-500",
                  !beltTrackedDone && check4Complete && "bg-blue-500",
                  !beltTrackedDone && !check4Complete && "bg-muted-foreground/40",
                )} />
                <span className={cn(
                  "text-xs font-medium",
                  beltTrackedDone && "text-green-700 dark:text-green-400",
                  !beltTrackedDone && check4Complete && "text-blue-700 dark:text-blue-400",
                  !beltTrackedDone && !check4Complete && "text-muted-foreground",
                )}
                  title={
                    beltTrackedDone
                      ? 'Mechanical team marked Belt Tracked — Bump Test + Calibrate Speed unlocked'
                      : check4Complete
                        ? 'Run verified — waiting for the mechanical team to track the belt'
                        : 'Finish the Test Run step before handing over for tracking'
                  }
                >
                  {beltTrackedDone ? 'Tracked' : check4Complete ? 'Ready' : 'Not ready'}
                </span>
              </div>
            </div>
          </div>

          <nav className="flex-1 p-2 space-y-1 overflow-y-auto">
            {STEPS.map(step => {
              const status = getStepStatus(step.num)
              const clickable = canGoTo(step.num)
              const isLocked = status === 'locked'
              return (
                <div
                  key={step.num}
                  title={isLocked ? "Complete the previous step first to unlock this check" : undefined}
                >
                  <button
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
                </div>
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
            <div className="flex items-center gap-1">
              <Button
                variant="ghost"
                size="sm"
                onClick={handleClearTest}
                disabled={clearing}
                className={cn(
                  "h-8 px-2 text-xs gap-1.5",
                  clearArmed && "text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-950/30 hover:bg-red-100 dark:hover:bg-red-950/50",
                )}
                title={clearArmed ? "Click again to confirm — clears all test data for this VFD" : "Clear all test data for this VFD"}
              >
                {clearing
                  ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  : <RotateCcw className="h-3.5 w-3.5" />}
                {clearArmed ? "Confirm clear" : "Clear test"}
              </Button>
              <Button variant="ghost" size="sm" onClick={onClose} className="h-8 w-8 p-0">
                <X className="h-4 w-4" />
              </Button>
            </div>
          </div>

          {/* Step content */}
          <div className="flex-1 overflow-y-auto px-6 py-5">
            {activeStep === 0 && <Step0Content sts={sts} loading={stsLoading} />}
            {activeStep === 1 && <Step1Content sts={sts} loading={stsLoading} deviceName={device.deviceName} subsystemId={subsystemId} plcConnected={plcConnected} sheetName={sheetName} userName={userName} />}
            {activeStep === 2 && <Step2Content sts={sts} loading={stsLoading} deviceName={device.deviceName} subsystemId={subsystemId} plcConnected={plcConnected} sheetName={sheetName} userName={userName} onHpFilled={() => setHpFieldsFilled(true)} />}
            {/* REWORKED ORDER: index 3 = Test Run / Verify Controls (Step4Content),
                index 4 = Bump Test / Polarity (Step3Content, now post-track). The
                component names are unchanged for a reviewable diff. */}
            {activeStep === 3 && <Step4Content sts={sts} stsErrors={stsErrors} loading={stsLoading} deviceName={device.deviceName} subsystemId={subsystemId} plcConnected={plcConnected} sheetName={sheetName} userName={userName} onComplete={() => {
              setCheck4Complete(true)
              // Persist to local DB so reopening the wizard remembers this even
              // if the cloud-synced "Run Verified" L2 cell didn't land (column
              // missing on the sheet). The L2 write happens inside Step4Content.
              fetch('/api/vfd-commissioning/controls-verified', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ deviceName: device.deviceName, completedBy: userName }),
              })
                .then(r => {
                  if (!r.ok) console.error('[VFD Controls] POST failed:', r.status)
                  else console.log('[VFD Controls] Saved for', device.deviceName)
                })
                .catch(err => console.error('[VFD Controls] POST error:', err))
            }} isComplete={check4Complete} />}
            {activeStep === 4 && <Step3Content sts={sts} loading={stsLoading} deviceName={device.deviceName} subsystemId={subsystemId} plcConnected={plcConnected} sheetName={sheetName} userName={userName} initialPolarity={polaritySetDone} onPolaritySet={(p) => setPolaritySetDone(p)} initialBumpBlocker={bumpBlocker} onBumpBlockerChange={setBumpBlocker} />}
            {activeStep === 5 && <Step5Content sts={sts} stsErrors={stsErrors} loading={stsLoading} deviceName={device.deviceName} subsystemId={subsystemId} plcConnected={plcConnected} sheetName={sheetName} userName={userName} onSpeedLogged={() => setSpeedSetUpDone(true)} />}
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
              <div
                className="relative group"
                title={!canGoTo(activeStep + 1) ? "This check is not available until the current step is finished" : undefined}
              >
                <Button
                  size="sm"
                  disabled={!canGoTo(activeStep + 1)}
                  onClick={() => setActiveStep(prev => Math.min(5, prev + 1))}
                  className="h-9 gap-1"
                >
                  Next <ChevronRight className="h-3.5 w-3.5" />
                </Button>
                {!canGoTo(activeStep + 1) && (
                  <div className="absolute bottom-full right-0 mb-2 hidden group-hover:block pointer-events-none z-20">
                    <div className="bg-popover text-popover-foreground text-xs font-medium rounded-md px-3 py-2 shadow-lg border whitespace-nowrap">
                      Complete the current step to continue
                    </div>
                  </div>
                )}
              </div>
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
