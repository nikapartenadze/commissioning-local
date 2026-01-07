"use client"

import { useState, useEffect } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Label } from '@/components/ui/label'
import { useUser } from '@/lib/user-context'
import { Loader2, Delete, Check, Eye, EyeOff } from 'lucide-react'

export function PinLogin() {
  const [pin, setPin] = useState('')
  const [showPin, setShowPin] = useState(false)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const { setCurrentUser } = useUser()

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

      // First, get all users and try to match by PIN
      const usersResponse = await fetch('http://localhost:5000/api/users/active')
      if (!usersResponse.ok) {
        setError('Cannot connect to server')
        setPin('')
        setLoading(false)
        return
      }

      const users = await usersResponse.json()

      // Try to login with each user's name until we find a match
      let loggedIn = false
      for (const user of users) {
        const response = await fetch('http://localhost:5000/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ fullName: user.fullName, pin })
        })

        if (response.ok) {
          const userData = await response.json()
          setCurrentUser({
            fullName: userData.fullName,
            isAdmin: userData.isAdmin,
            loginTime: new Date()
          })
          loggedIn = true
          break
        }
      }

      if (!loggedIn) {
        setError('Invalid PIN')
        setPin('')
      }
    } catch (err) {
      setError('Login failed - cannot connect to backend')
      setPin('')
    } finally {
      setLoading(false)
    }
  }

  const handlePaste = (e: ClipboardEvent) => {
    e.preventDefault()
    const pastedText = e.clipboardData?.getData('text') || ''
    const digits = pastedText.replace(/\D/g, '').slice(0, 6)
    if (digits.length > 0) {
      setPin(digits)
      setError('')
    }
  }

  const handleKeyPress = (e: KeyboardEvent) => {
    if (e.key >= '0' && e.key <= '9') {
      handleNumberClick(e.key)
    } else if (e.key === 'Backspace') {
      handleBackspace()
    } else if (e.key === 'Enter' && pin.length === 6) {
      handleLogin()
    }
  }

  useEffect(() => {
    window.addEventListener('keydown', handleKeyPress)
    window.addEventListener('paste', handlePaste as any)
    return () => {
      window.removeEventListener('keydown', handleKeyPress)
      window.removeEventListener('paste', handlePaste as any)
    }
  }, [pin])

  return (
    <div className="flex items-center justify-center min-h-screen bg-gradient-to-br from-background via-background to-muted/20">
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
            <div className="flex justify-center items-center h-20 bg-muted/50 border-2 border-primary/30 rounded-lg">
              <div className="flex gap-3 font-mono text-4xl font-bold">
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
          <div className="text-center text-xs text-muted-foreground">
            <p>Need help? Contact your administrator</p>
            <p className="mt-1">Session expires after 8 hours</p>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}

