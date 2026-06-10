"use client"

import { useState } from "react"
import { KeyRound } from "lucide-react"
import { Button } from "@/components/ui/button"
import { useUser } from "@/lib/user-context"
import { AuthFrame, Field, fieldClass } from "@/components/login-screen"

/**
 * First-run gate: shown immediately after login when the account is flagged
 * must-change-PIN (the seeded default admin, Admin/111111). Forces the user to
 * replace the default PIN before they can use the app. Calls the self-service
 * POST /api/auth/change-pin (authenticated as the caller). Shares the portal's
 * industrial auth frame with the login screen.
 */
export function ChangePinGate() {
  const { clearMustChangePin } = useUser()
  const [currentPin, setCurrentPin] = useState("")
  const [newPin, setNewPin] = useState("")
  const [confirmPin, setConfirmPin] = useState("")
  const [error, setError] = useState("")
  const [busy, setBusy] = useState(false)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!/^\d{6}$/.test(newPin)) {
      setError("New PIN must be exactly 6 digits")
      return
    }
    if (newPin !== confirmPin) {
      setError("New PIN and confirmation do not match")
      return
    }
    setBusy(true)
    setError("")
    try {
      const token = localStorage.getItem("authToken")
      const res = await fetch("/api/auth/change-pin", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ currentPin: currentPin.trim(), newPin }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        setError(data.message || "Could not change PIN")
        return
      }
      clearMustChangePin(data.token)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not change PIN")
    } finally {
      setBusy(false)
    }
  }

  return (
    <AuthFrame
      title="Set a New PIN"
      subtitle="Security · First Sign-In"
      hint="This account is still using the default PIN. Choose a new 6-digit PIN to continue."
    >
      <form onSubmit={submit} className="space-y-4">
        <Field label="Current PIN">
          <input
            type="password"
            inputMode="numeric"
            placeholder="••••••"
            value={currentPin}
            onChange={(e) => { setCurrentPin(e.target.value); if (error) setError("") }}
            autoFocus
            className={fieldClass}
          />
        </Field>
        <Field label="New 6-digit PIN">
          <input
            type="password"
            inputMode="numeric"
            placeholder="••••••"
            value={newPin}
            onChange={(e) => { setNewPin(e.target.value); if (error) setError("") }}
            className={fieldClass}
          />
        </Field>
        <Field label="Confirm New PIN" error={error}>
          <input
            type="password"
            inputMode="numeric"
            placeholder="••••••"
            value={confirmPin}
            onChange={(e) => { setConfirmPin(e.target.value); if (error) setError("") }}
            className={fieldClass + (error ? " border-destructive/70 focus:border-destructive/70 focus:ring-destructive/30" : "")}
          />
        </Field>
        <Button
          type="submit"
          className="w-full font-mono uppercase tracking-[0.2em] text-sm rounded-sm gap-2"
          size="lg"
          disabled={busy}
        >
          <KeyRound className="w-4 h-4" />
          {busy ? "Saving…" : "Save New PIN"}
        </Button>
      </form>
    </AuthFrame>
  )
}
