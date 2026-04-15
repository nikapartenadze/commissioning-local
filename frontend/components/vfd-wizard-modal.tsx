"use client"

import { useState, useEffect, useRef, useCallback } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
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
  Speed_FPM: number | null
}

interface VfdWizardModalProps {
  device: VfdDevice
  plcConnected: boolean
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

async function readDeviceSts(deviceName: string): Promise<StsState> {
  try {
    const res = await fetch('/api/vfd-commissioning/read-tags', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ devices: [deviceName] }),
    })
    const data = await res.json()
    const sts = data.devices?.[deviceName]?.sts || {}
    return {
      Check_Allowed: sts.Check_Allowed ?? null,
      Valid_Map: sts.Valid_Map ?? null,
      Valid_HP: sts.Valid_HP ?? null,
      Valid_Direction: sts.Valid_Direction ?? null,
      Jogging: sts.Jogging ?? null,
      Track_Belt: sts.Track_Belt ?? null,
      Speed_FPM: sts.Speed_FPM ?? null,
    }
  } catch {
    return { Check_Allowed: null, Valid_Map: null, Valid_HP: null, Valid_Direction: null, Jogging: null, Track_Belt: null, Speed_FPM: null }
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
        The VFD module must have <strong>"Running"</strong> status in the IO tree before any checks can proceed.
        This is detected automatically from the PLC.
      </p>
      <div className="rounded-lg border-2 p-4 bg-card">
        <StsIndicator label="Check_Allowed (Network + Running)" value={sts.Check_Allowed} loading={loading} />
      </div>
      {allowed && (
        <div className="flex items-center gap-2 text-green-600 dark:text-green-400 text-sm font-medium">
          <CheckCircle2 className="h-4 w-4" />
          VFD is connected and running. Proceed to Check 1.
        </div>
      )}
      {!loading && !allowed && (
        <div className="flex items-center gap-2 text-amber-600 dark:text-amber-400 text-sm">
          <AlertTriangle className="h-4 w-4" />
          Waiting for VFD to come online...
        </div>
      )}
    </div>
  )
}

function Step1Content({ sts, loading, deviceName, plcConnected }: {
  sts: StsState; loading: boolean; deviceName: string; plcConnected: boolean
}) {
  const [sending, setSending] = useState(false)
  const [sent, setSent] = useState(false)

  const handleSend = async () => {
    setSending(true)
    try {
      await writeTag(deviceName, 'Valid_Map', 1, 'BOOL')
      setSent(true)
    } catch {}
    setSending(false)
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground leading-relaxed">
        Verify that this PLC tag is mapped to the correct physical VFD in the field.
      </p>

      <div className="rounded-lg border-2 border-amber-300 dark:border-amber-700 bg-amber-50/50 dark:bg-amber-950/20 p-4">
        <p className="text-sm font-semibold text-amber-800 dark:text-amber-200 mb-1">Action Required</p>
        <p className="text-sm text-amber-700 dark:text-amber-300">
          Have the technician press <strong>F1</strong> on the VFD keypad panel, then click the button below.
        </p>
      </div>

      <div className="flex items-center gap-3">
        <ActionButton
          label={sent ? "Sent Valid_Map" : "Send Valid_Map = 1"}
          icon={sent ? CheckCircle2 : Send}
          onClick={handleSend}
          disabled={!plcConnected}
          sending={sending}
          variant={sent ? 'outline' : 'primary'}
        />
      </div>

      <div className="rounded-lg border-2 p-4 bg-card space-y-2">
        <StsIndicator label="STS.Valid_Map" value={sts.Valid_Map} loading={loading} />
      </div>

      {sts.Valid_Map === true && (
        <div className="flex items-center gap-2 text-green-600 dark:text-green-400 text-sm font-medium">
          <CheckCircle2 className="h-4 w-4" />
          Identity verified. The PLC confirmed F1 was pressed and Valid_Map is set.
        </div>
      )}
    </div>
  )
}

function Step2Content({ sts, loading, deviceName, plcConnected }: {
  sts: StsState; loading: boolean; deviceName: string; plcConnected: boolean
}) {
  const [sending, setSending] = useState(false)
  const [sent, setSent] = useState(false)
  const [motorHp, setMotorHp] = useState('')
  const [driveHp, setDriveHp] = useState('')

  const handleSend = async () => {
    setSending(true)
    try {
      await writeTag(deviceName, 'Valid_MTR_HP', 1, 'BOOL')
      await writeTag(deviceName, 'Valid_APF_HP', 1, 'BOOL')
      setSent(true)
    } catch {}
    setSending(false)
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground leading-relaxed">
        Verify the motor HP and drive HP match the mechanical manifest.
        Read the motor faceplate and VFD label.
      </p>

      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-muted-foreground">Motor HP (faceplate)</label>
          <Input
            placeholder="e.g. 5.0"
            value={motorHp}
            onChange={e => setMotorHp(e.target.value)}
            className="h-10 font-mono"
          />
        </div>
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-muted-foreground">Drive HP (VFD label)</label>
          <Input
            placeholder="e.g. 5.0"
            value={driveHp}
            onChange={e => setDriveHp(e.target.value)}
            className="h-10 font-mono"
          />
        </div>
      </div>

      <div className="flex items-center gap-3">
        <ActionButton
          label={sent ? "HP Confirmed" : "Send Valid_MTR_HP + Valid_APF_HP = 1"}
          icon={sent ? CheckCircle2 : Send}
          onClick={handleSend}
          disabled={!plcConnected}
          sending={sending}
          variant={sent ? 'outline' : 'primary'}
        />
      </div>

      <div className="rounded-lg border-2 p-4 bg-card">
        <StsIndicator label="STS.Valid_HP" value={sts.Valid_HP} loading={loading} />
      </div>

      {sts.Valid_HP === true && (
        <div className="flex items-center gap-2 text-green-600 dark:text-green-400 text-sm font-medium">
          <CheckCircle2 className="h-4 w-4" />
          HP validated by PLC.
        </div>
      )}
    </div>
  )
}

function Step3Content({ sts, loading, deviceName, plcConnected }: {
  sts: StsState; loading: boolean; deviceName: string; plcConnected: boolean
}) {
  const [bumpSending, setBumpSending] = useState(false)
  const [dirSending, setDirSending] = useState(false)
  const [comment, setComment] = useState('')

  const handleBump = async () => {
    setBumpSending(true)
    try { await writeTag(deviceName, 'Bump', 1, 'BOOL') } catch {}
    setTimeout(() => setBumpSending(false), 1500)
  }

  const handleConfirmDirection = async () => {
    setDirSending(true)
    try { await writeTag(deviceName, 'Valid_Direction', 1, 'BOOL') } catch {}
    setDirSending(false)
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground leading-relaxed">
        Jog the motor for 1 second to verify it can run and check its rotation direction.
        The PLC uses one-shot protection — one click = exactly one 1-second pulse.
      </p>

      <div className="flex items-center gap-3">
        <Button
          disabled={!plcConnected || bumpSending}
          onClick={handleBump}
          className={cn(
            "h-14 px-8 text-lg font-black tracking-wider border-2 gap-3 transition-all",
            bumpSending
              ? "bg-amber-500 border-amber-600 text-white animate-pulse shadow-lg shadow-amber-500/30"
              : "bg-amber-100 border-amber-400 text-amber-900 hover:bg-amber-200 dark:bg-amber-900/60 dark:border-amber-500 dark:text-amber-200 dark:hover:bg-amber-800"
          )}
        >
          <Zap className="h-6 w-6" />
          {bumpSending ? "BUMPING..." : "BUMP MOTOR"}
        </Button>
      </div>

      <div className="rounded-lg border-2 p-4 bg-card space-y-2">
        <StsIndicator label="STS.Jogging" value={sts.Jogging} loading={loading} />
        <StsIndicator label="STS.Valid_Direction" value={sts.Valid_Direction} loading={loading} />
      </div>

      <div className="space-y-1.5">
        <label className="text-xs font-medium text-muted-foreground">Direction observation / comment</label>
        <Textarea
          placeholder="e.g. Motor running CW, belt moving forward..."
          value={comment}
          onChange={e => setComment(e.target.value)}
          className="min-h-[60px] text-sm"
        />
      </div>

      <div className="rounded-lg border-2 border-blue-200 dark:border-blue-800 bg-blue-50/50 dark:bg-blue-950/20 p-4">
        <p className="text-sm font-medium text-blue-800 dark:text-blue-200 mb-2">Is the motor direction correct?</p>
        <div className="flex items-center gap-3">
          <ActionButton
            label="Direction OK — Confirm"
            icon={CheckCircle2}
            onClick={handleConfirmDirection}
            disabled={!plcConnected}
            sending={dirSending}
          />
          <p className="text-xs text-muted-foreground">
            If reversed, fix polarity in VFD config before retesting.
          </p>
        </div>
      </div>

      {sts.Valid_Direction === true && (
        <div className="flex items-center gap-2 text-green-600 dark:text-green-400 text-sm font-medium">
          <CheckCircle2 className="h-4 w-4" />
          Direction confirmed by PLC.
        </div>
      )}
    </div>
  )
}

function Step4Content({ sts, loading, deviceName, plcConnected }: {
  sts: StsState; loading: boolean; deviceName: string; plcConnected: boolean
}) {
  const [rpm, setRpm] = useState('')
  const [startSending, setStartSending] = useState(false)
  const [stopSending, setStopSending] = useState(false)

  const handleStart = async () => {
    setStartSending(true)
    try {
      const rpmVal = parseFloat(rpm || '0')
      if (rpmVal > 0) await writeTag(deviceName, 'RPM', rpmVal, 'REAL')
      await writeTag(deviceName, 'Track_Belt', 1, 'BOOL')
    } catch {}
    setStartSending(false)
  }

  const handleStop = async () => {
    setStopSending(true)
    try { await writeTag(deviceName, 'Stop_Belt_Tracking', 1, 'BOOL') } catch {}
    setStopSending(false)
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground leading-relaxed">
        Run the conveyor continuously at a specified speed for the mechanical team to adjust belt tracking.
        Start and stop can also be controlled from the VFD keypad (F2 = start, F0 = stop).
      </p>

      <div className="flex items-center gap-3">
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-muted-foreground">RPM (0–30)</label>
          <Input
            type="number"
            min={0} max={30} step={0.1}
            placeholder="e.g. 15.0"
            value={rpm}
            onChange={e => setRpm(e.target.value)}
            className="h-10 w-32 font-mono"
          />
        </div>

        {sts.Track_Belt ? (
          <ActionButton label="Stop Tracking" icon={Square} onClick={handleStop} disabled={!plcConnected} sending={stopSending} variant="destructive" />
        ) : (
          <ActionButton label="Start Tracking" icon={Play} onClick={handleStart} disabled={!plcConnected || !rpm} sending={startSending} />
        )}
      </div>

      <div className="rounded-lg border-2 p-4 bg-card space-y-2">
        <StsIndicator label="STS.Track_Belt" value={sts.Track_Belt} loading={loading} />
        <div className="flex items-center gap-2 text-xs">
          <Gauge className="h-3 w-3 text-muted-foreground" />
          <span className="text-muted-foreground">STS.Speed_FPM</span>
          <span className="font-mono font-medium">{sts.Speed_FPM ?? '—'} FPM</span>
        </div>
      </div>

      <p className="text-xs text-muted-foreground">
        This check is complete when the mechanical team confirms belt tracking is done. Mark as complete manually.
      </p>
    </div>
  )
}

function Step5Content({ sts, loading, deviceName, plcConnected }: {
  sts: StsState; loading: boolean; deviceName: string; plcConnected: boolean
}) {
  const [fpm, setFpm] = useState('')
  const [sending, setSending] = useState(false)
  const [synced, setSynced] = useState(false)

  const handleSync = async () => {
    setSending(true)
    try {
      const fpmVal = parseInt(fpm || '0')
      await writeTag(deviceName, 'Speed_FPM', fpmVal, 'INT')
      await writeTag(deviceName, 'Sync_Speed', 1, 'BOOL')
      setSynced(true)
    } catch {}
    setSending(false)
  }

  const localFpm = parseInt(fpm || '0')
  const plcFpm = sts.Speed_FPM
  const outOfSync = synced && plcFpm !== null && localFpm !== plcFpm

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground leading-relaxed">
        Enter the tached conveyor speed in FPM (feet per minute) that corresponds to 60Hz for this VFD.
        The value is sent to the PLC only when you click Sync.
      </p>

      <div className="flex items-center gap-3">
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-muted-foreground">Speed FPM</label>
          <Input
            type="number"
            placeholder="e.g. 450"
            value={fpm}
            onChange={e => { setFpm(e.target.value); setSynced(false) }}
            className="h-10 w-32 font-mono"
          />
        </div>
        <ActionButton
          label={synced ? "Synced" : "Sync to PLC"}
          icon={synced ? CheckCircle2 : Send}
          onClick={handleSync}
          disabled={!plcConnected || !fpm}
          sending={sending}
          variant={synced ? 'outline' : 'primary'}
        />
      </div>

      {outOfSync && (
        <div className="flex items-center gap-2 text-amber-600 dark:text-amber-400 text-sm">
          <AlertTriangle className="h-4 w-4" />
          Out of sync — local FPM ({localFpm}) differs from PLC ({plcFpm})
        </div>
      )}

      <div className="rounded-lg border-2 p-4 bg-card">
        <div className="flex items-center gap-2 text-xs">
          <Gauge className="h-3 w-3 text-muted-foreground" />
          <span className="text-muted-foreground">STS.Speed_FPM</span>
          <span className="font-mono font-medium">{sts.Speed_FPM ?? '—'} FPM</span>
        </div>
      </div>
    </div>
  )
}

// ── Step definitions ───────────────────────────────────────────────

const STEPS = [
  { num: 0, label: 'Network Connection', icon: Signal },
  { num: 1, label: 'Verify Identity', icon: Fingerprint },
  { num: 2, label: 'Motor & Drive HP', icon: Settings2 },
  { num: 3, label: 'Bump Motor', icon: Zap },
  { num: 4, label: 'Track Belt', icon: Play },
  { num: 5, label: 'Setup Speed', icon: Gauge },
]

// ── Main Modal Component ───────────────────────────────────────────

export function VfdWizardModal({ device, plcConnected, onClose }: VfdWizardModalProps) {
  const [activeStep, setActiveStep] = useState(0)
  const [sts, setSts] = useState<StsState>({
    Check_Allowed: null, Valid_Map: null, Valid_HP: null,
    Valid_Direction: null, Jogging: null, Track_Belt: null, Speed_FPM: null,
  })
  const [stsLoading, setStsLoading] = useState(true)
  const pollRef = useRef<NodeJS.Timeout | null>(null)

  // Poll STS tags for this ONE device only
  useEffect(() => {
    if (!plcConnected) {
      setStsLoading(false)
      return
    }

    const poll = async () => {
      const data = await readDeviceSts(device.deviceName)
      setSts(data)
      setStsLoading(false)
    }

    poll()
    pollRef.current = setInterval(poll, 2500)
    return () => { if (pollRef.current) clearInterval(pollRef.current) }
  }, [plcConnected, device.deviceName])

  // Determine step statuses
  const getStepStatus = (stepNum: number): 'locked' | 'active' | 'done' | 'failed' => {
    if (stepNum === activeStep) return 'active'

    switch (stepNum) {
      case 0: return sts.Check_Allowed ? 'done' : (activeStep > 0 ? 'active' : 'active')
      case 1: return sts.Valid_Map ? 'done' : (sts.Check_Allowed ? (activeStep >= 1 ? 'active' : 'locked') : 'locked')
      case 2: return sts.Valid_HP ? 'done' : (sts.Valid_Map ? (activeStep >= 2 ? 'active' : 'locked') : 'locked')
      case 3: return sts.Valid_Direction ? 'done' : (sts.Valid_HP ? (activeStep >= 3 ? 'active' : 'locked') : 'locked')
      case 4: return sts.Valid_Direction ? (activeStep >= 4 ? 'active' : 'locked') : 'locked'
      case 5: return sts.Valid_Direction ? (activeStep >= 5 ? 'active' : 'locked') : 'locked'
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
    if (stepNum === 5) return sts.Valid_Direction === true
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
                Check {activeStep}: {STEPS[activeStep].label}
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
            {activeStep === 2 && <Step2Content sts={sts} loading={stsLoading} deviceName={device.deviceName} plcConnected={plcConnected} />}
            {activeStep === 3 && <Step3Content sts={sts} loading={stsLoading} deviceName={device.deviceName} plcConnected={plcConnected} />}
            {activeStep === 4 && <Step4Content sts={sts} loading={stsLoading} deviceName={device.deviceName} plcConnected={plcConnected} />}
            {activeStep === 5 && <Step5Content sts={sts} loading={stsLoading} deviceName={device.deviceName} plcConnected={plcConnected} />}
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
