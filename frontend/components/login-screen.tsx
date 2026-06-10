"use client"

import { useState } from "react"
import { Hexagon, LogIn } from "lucide-react"
import { Button } from "@/components/ui/button"
import { AutstandLogo } from "@/components/autstand-logo"
import { useUser } from "@/lib/user-context"

/**
 * Full-screen login, shown only when the server enforces auth (AUTH_REQUIRED).
 * Accepts a PIN (and an optional name for named login). On success it stores
 * the JWT and populates the user context; if the account is flagged
 * must-change-PIN, the change-PIN gate takes over next.
 *
 * Styled to match the central portal (dotted grid, accent strip, corner
 * brackets, hexagon mark, mono labels) so it's a coherent first impression.
 */
export function LoginScreen() {
  const { onLoggedIn } = useUser()
  const [name, setName] = useState("")
  const [pin, setPin] = useState("")
  const [error, setError] = useState("")
  const [busy, setBusy] = useState(false)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    const trimmedPin = pin.trim()
    if (!trimmedPin) {
      setError("Enter your PIN")
      return
    }
    setBusy(true)
    setError("")
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fullName: name.trim() || undefined,
          pin: trimmedPin,
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        if (res.status === 429) {
          setError(data.message || "Too many attempts. Please wait and try again.")
        } else {
          setError(data.message || "Invalid credentials")
        }
        return
      }
      onLoggedIn({
        token: data.token,
        fullName: data.fullName,
        isAdmin: data.isAdmin === true,
        mustChangePin: data.mustChangePin === true,
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : "Login failed")
    } finally {
      setBusy(false)
    }
  }

  return (
    <AuthFrame
      title="Sign In"
      subtitle="Central Commissioning Station"
      hint="Enter your PIN to continue. Your name (optional) is recorded with test results."
    >
      <form onSubmit={submit} className="space-y-4">
        <Field label="Name (optional)">
          <input
            placeholder="Your name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoComplete="username"
            className={fieldClass}
          />
        </Field>
        <Field label="PIN" error={error}>
          <input
            autoFocus
            type="password"
            inputMode="numeric"
            placeholder="••••••"
            value={pin}
            onChange={(e) => {
              setPin(e.target.value)
              if (error) setError("")
            }}
            autoComplete="current-password"
            className={fieldClass + (error ? " border-destructive/70 focus:border-destructive/70 focus:ring-destructive/30" : "")}
          />
        </Field>
        <Button
          type="submit"
          className="w-full font-mono uppercase tracking-[0.2em] text-sm rounded-sm gap-2"
          size="lg"
          disabled={busy}
        >
          <LogIn className="w-4 h-4" />
          {busy ? "Signing in…" : "Sign In"}
        </Button>
      </form>
    </AuthFrame>
  )
}

// ── shared industrial frame for the auth screens ────────────────────────────

const fieldClass =
  "w-full bg-background border border-border rounded-sm px-3 py-2.5 font-mono text-sm text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:border-primary/60 focus:ring-1 focus:ring-primary/30 transition-colors"

export function AuthFrame({
  title,
  subtitle,
  hint,
  children,
}: {
  title: string
  subtitle: string
  hint: string
  children: React.ReactNode
}) {
  return (
    <div className="fixed inset-0 z-[9999] bg-background text-foreground flex items-center justify-center px-4">
      {/* dotted grid backdrop — matches the portal */}
      <div
        aria-hidden
        className="absolute inset-0 pointer-events-none opacity-[0.05]"
        style={{
          backgroundImage:
            "radial-gradient(circle, currentColor 1px, transparent 1px)",
          backgroundSize: "28px 28px",
        }}
      />
      <div className="relative w-full max-w-md border border-primary/30 bg-card rounded-sm shadow-2xl shadow-black/30">
        <CornerBrackets />
        <div className="h-[3px] bg-primary/60" />
        <div className="p-8">
          <div className="flex flex-col items-center text-center mb-7">
            <div className="w-11 h-11 border border-primary/50 rounded-sm flex items-center justify-center bg-card mb-4">
              <Hexagon className="w-5 h-5 text-primary" />
            </div>
            <h2 className="font-mono text-lg uppercase tracking-[0.28em] text-foreground">
              {title}
            </h2>
            <p className="mt-1.5 font-mono text-[11px] uppercase tracking-[0.24em] text-primary/80">
              {subtitle}
            </p>
            <p className="mt-3 text-sm text-muted-foreground leading-relaxed max-w-xs">
              {hint}
            </p>
          </div>
          {children}
          <div className="mt-7 flex items-center justify-center">
            <AutstandLogo className="h-5 opacity-60" />
          </div>
        </div>
      </div>
    </div>
  )
}

export function Field({
  label,
  error,
  children,
}: {
  label: string
  error?: string
  children: React.ReactNode
}) {
  return (
    <label className="block">
      <span className="block font-mono text-[10px] uppercase tracking-[0.25em] text-muted-foreground mb-1.5">
        {label}
      </span>
      {children}
      {error && <p className="mt-1.5 text-sm text-destructive">{error}</p>}
    </label>
  )
}

export { fieldClass }

export function CornerBrackets() {
  const c = "absolute w-3 h-3 border-primary/50"
  return (
    <div aria-hidden className="pointer-events-none">
      <span className={`${c} top-0 left-0 border-t border-l`} />
      <span className={`${c} top-0 right-0 border-t border-r`} />
      <span className={`${c} bottom-0 left-0 border-b border-l`} />
      <span className={`${c} bottom-0 right-0 border-b border-r`} />
    </div>
  )
}
