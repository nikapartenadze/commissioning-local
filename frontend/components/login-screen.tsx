"use client"

import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { AutstandLogo } from "@/components/autstand-logo"
import { useUser } from "@/lib/user-context"

/**
 * Full-screen login, shown only when the server enforces auth (AUTH_REQUIRED).
 * Accepts a PIN (and an optional name for named login). On success it stores
 * the JWT and populates the user context; if the account is flagged
 * must-change-PIN, the change-PIN gate takes over next.
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
    <div className="fixed inset-0 z-[9999] bg-background/90 backdrop-blur-sm flex items-center justify-center">
      <div className="bg-card border rounded-lg shadow-lg p-8 w-full max-w-md mx-4">
        <AutstandLogo className="h-8 mx-auto mb-4" />
        <h2 className="text-2xl font-bold text-center mb-2">Sign in</h2>
        <p className="text-muted-foreground text-center mb-6">
          Enter your PIN to continue. Your name (optional) is recorded with test results.
        </p>
        <form onSubmit={submit} className="space-y-4">
          <div>
            <Input
              placeholder="Name (optional)"
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoComplete="username"
            />
          </div>
          <div>
            <Input
              autoFocus
              type="password"
              inputMode="numeric"
              placeholder="PIN"
              value={pin}
              onChange={(e) => {
                setPin(e.target.value)
                if (error) setError("")
              }}
              autoComplete="current-password"
              className={error ? "border-destructive" : ""}
            />
            {error && <p className="text-sm text-destructive mt-1">{error}</p>}
          </div>
          <Button type="submit" className="w-full" size="lg" disabled={busy}>
            {busy ? "Signing in…" : "Sign in"}
          </Button>
        </form>
      </div>
    </div>
  )
}
