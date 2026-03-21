"use client"

import { useState, useEffect, useRef } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Label } from '@/components/ui/label'
import { useUser } from '@/lib/user-context'
import { Loader2, Delete, Check, Eye, EyeOff } from 'lucide-react'
import { API_ENDPOINTS } from '@/lib/api-config'
import { ThemeToggle } from '@/components/theme-toggle'

export function PinLogin() {
  const [pin, setPin] = useState('')
  const [showPin, setShowPin] = useState(false)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const { setCurrentUser } = useUser()
  const inputRef = useRef<HTMLInputElement>(null)

  const handleNumberClick = (num: string) => {
    if (pin.length < 6) {
      setPin(pin + num)
      setError('') // Clear error when user starts typing
    }
  }

  const handleBackspace = () => {
    setPin(pin.slice(0, -1))
    setError('')
  }

  const handleLogin = async () => {
    if (pin.length !== 6) {
      setError('PIN must be 6 digits')
      return
    }

    try {
      setLoading(true)
      setError('')

      const response = await fetch(API_ENDPOINTS.authLogin, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin }),
      })

      if (response.status === 429) {
        setError('Too many attempts. Please wait a moment.')
        setPin('')
        return
      }

      if (!response.ok) {
        setError('Invalid PIN')
        setPin('')
        return
      }

      const userData = await response.json()
      if (userData.token) {
        localStorage.setItem('authToken', userData.token)
        // Set cookie for middleware auth (middleware can't read localStorage)
        document.cookie = `authToken=${userData.token}; path=/; max-age=28800; SameSite=Lax`
      }
      setCurrentUser({
        fullName: userData.fullName,
        isAdmin: userData.isAdmin,
        loginTime: new Date(),
      })
    } catch {
      setError('Cannot connect to server')
      setPin('')
    } finally {
      setLoading(false)
    }
  }

  // Auto-focus input on mount
  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  return (
    <div className="flex items-center justify-center min-h-screen bg-gradient-to-br from-background via-background to-muted/20 relative">
      <div className="absolute top-4 right-4">
        <ThemeToggle />
      </div>
      <Card className="w-full max-w-md mx-4 shadow-2xl border-2 bg-card/95 backdrop-blur">
        <CardHeader className="text-center pb-4">
          <CardTitle className="text-3xl font-bold">IO Checkout Tool</CardTitle>
          <CardDescription>Enter your 6-digit PIN</CardDescription>
        </CardHeader>
        
        <CardContent className="space-y-6">
          {/* PIN Display with Toggle */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label htmlFor="pin">Enter 6-Digit PIN</Label>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setShowPin(!showPin)}
                className="h-6 px-2"
              >
                {showPin ? (
                  <>
                    <EyeOff className="h-4 w-4 mr-1" />
                    Hide
                  </>
                ) : (
                  <>
                    <Eye className="h-4 w-4 mr-1" />
                    Show
                  </>
                )}
              </Button>
            </div>
            <div
              className="relative flex justify-center items-center h-20 bg-muted/50 border-2 border-primary/30 rounded-lg cursor-text"
              onClick={() => inputRef.current?.focus()}
            >
              {/* Hidden input for keyboard/paste support */}
              <input
                ref={inputRef}
                type="text"
                inputMode="numeric"
                pattern="[0-9]*"
                autoComplete="one-time-code"
                autoFocus
                className="absolute opacity-0 w-full h-full cursor-text"
                value={pin}
                onChange={(e) => {
                  const digits = e.target.value.replace(/\D/g, '').slice(0, 6)
                  setPin(digits)
                  setError('')
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && pin.length === 6) {
                    handleLogin()
                  }
                }}
                disabled={loading}
              />
              <div className="flex gap-3 font-mono text-4xl font-bold pointer-events-none">
                {Array.from({ length: 6 }).map((_, i) => (
                  <span key={i} className="w-10 text-center">
                    {showPin ? (pin[i] || '·') : (pin[i] ? '●' : '·')}
                  </span>
                ))}
              </div>
            </div>
          </div>

          {/* Numpad */}
          <div className="grid grid-cols-3 gap-3">
            {[1, 2, 3, 4, 5, 6, 7, 8, 9].map(num => (
              <Button
                key={num}
                onClick={() => handleNumberClick(num.toString())}
                className="h-16 text-2xl font-bold bg-primary/10 hover:bg-primary/20 border-2 border-primary/30"
                variant="outline"
                disabled={loading}
              >
                {num}
              </Button>
            ))}
            <Button
              onClick={handleBackspace}
              className="h-16 bg-destructive/30 hover:bg-destructive/40 border-2 border-destructive text-destructive-foreground"
              variant="outline"
              disabled={loading || pin.length === 0}
            >
              <Delete className="h-6 w-6" />
            </Button>
            <Button
              onClick={() => handleNumberClick('0')}
              className="h-16 text-2xl font-bold bg-primary/10 hover:bg-primary/20 border-2 border-primary/30"
              variant="outline"
              disabled={loading}
            >
              0
            </Button>
            <Button
              onClick={handleLogin}
              className="h-16 bg-primary hover:bg-primary/90 text-primary-foreground"
              disabled={loading || pin.length !== 6}
            >
              {loading ? (
                <Loader2 className="h-6 w-6 animate-spin" />
              ) : (
                <Check className="h-6 w-6" />
              )}
            </Button>
          </div>

          {/* Error Message */}
          {error && (
            <div className="p-3 bg-destructive/10 border border-destructive/20 rounded-lg">
              <p className="text-sm text-destructive text-center font-medium">{error}</p>
            </div>
          )}

          {/* Help Text */}
          <div className="text-center text-xs text-muted-foreground space-y-2">
            <p>Need help? Contact your administrator</p>
            <p>Session expires after 8 hours</p>
            <a href="/guide" target="_blank" className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-blue-500/10 border border-blue-500/30 text-blue-500 hover:bg-blue-500/20 font-medium text-xs transition-colors">
              Read the Guide
            </a>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}

