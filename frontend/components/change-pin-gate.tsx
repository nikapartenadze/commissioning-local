"use client"

import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { AutstandLogo } from "@/components/autstand-logo"
import { useUser } from "@/lib/user-context"

/**
 * First-run gate: shown immediately after login when the account is flagged
 * must-change-PIN (the seeded default admin, Admin/111111). Forces the user to
 * replace the default PIN before they can use the app. Calls the self-service
 * POST /api/auth/change-pin (authenticated as the caller).
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
    <div className="fixed inset-0 z-[9999] bg-background/90 backdrop-blur-sm flex items-center justify-center">
      <div className="bg-card border rounded-lg shadow-lg p-8 w-full max-w-md mx-4">
        <AutstandLogo className="h-8 mx-auto mb-4" />
        <h2 className="text-2xl font-bold text-center mb-2">Set a new PIN</h2>
        <p className="text-muted-foreground text-center mb-6">
          This account is still using the default PIN. Choose a new 6-digit PIN to continue.
        </p>
        <form onSubmit={submit} className="space-y-4">
          <Input
            type="password"
            inputMode="numeric"
            placeholder="Current PIN"
            value={currentPin}
            onChange={(e) => { setCurrentPin(e.target.value); if (error) setError("") }}
            autoFocus
          />
          <Input
            type="password"
            inputMode="numeric"
            placeholder="New 6-digit PIN"
            value={newPin}
            onChange={(e) => { setNewPin(e.target.value); if (error) setError("") }}
          />
          <Input
            type="password"
            inputMode="numeric"
            placeholder="Confirm new PIN"
            value={confirmPin}
            onChange={(e) => { setConfirmPin(e.target.value); if (error) setError("") }}
            className={error ? "border-destructive" : ""}
          />
          {error && <p className="text-sm text-destructive">{error}</p>}
          <Button type="submit" className="w-full" size="lg" disabled={busy}>
            {busy ? "Saving…" : "Save new PIN"}
          </Button>
        </form>
      </div>
    </div>
  )
}
