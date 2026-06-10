"use client"

import { createContext, useContext, useState, useEffect, useCallback, ReactNode } from 'react'

interface User {
  fullName: string
  isAdmin: boolean
  loginTime: Date
}

interface UserContextType {
  currentUser: User | null
  setCurrentUser: (user: User | null) => void
  logout: () => void
  isLoading: boolean
  /**
   * True when this browser is running on the Server Laptop itself (loopback
   * IP). Used to gate testing UI — the Server Laptop is sync/PLC-broker only,
   * not a testing terminal. Authoritative enforcement lives in the API
   * middleware noTestingOnServerLaptop; this flag is for UX (hide buttons,
   * show a banner) so users aren't pointed at actions that will 403.
   */
  isServerDevice: boolean
  /**
   * True when the server enforces login (AUTH_REQUIRED set). Surfaced from
   * GET /api/auth/mode on boot. When false, the app behaves exactly as before
   * (no login screen, everything open). When true and there's no valid token,
   * the app shell renders the login screen.
   */
  authRequired: boolean
  /** True when auth is required but no valid session exists yet. */
  needsLogin: boolean
  /** First-run: the logged-in admin must set a new PIN before proceeding. */
  mustChangePin: boolean
  /** Records a successful login from the login screen (stores token + user). */
  onLoggedIn: (data: {
    token: string
    fullName: string
    isAdmin: boolean
    mustChangePin?: boolean
  }) => void
  /** Clears the must-change-PIN gate (and optionally rotates the token). */
  clearMustChangePin: (newToken?: string) => void
}

const UserContext = createContext<UserContextType>({
  currentUser: null,
  setCurrentUser: () => {},
  logout: () => {},
  isLoading: true,
  isServerDevice: false,
  authRequired: false,
  needsLogin: false,
  mustChangePin: false,
  onLoggedIn: () => {},
  clearMustChangePin: () => {},
})

const TOKEN_KEY = 'authToken'

// Decode a JWT payload without verifying (the server is authoritative; this is
// only to populate UI state like isAdmin/fullName from a stored token).
function decodeJwt(token: string): { sub?: string; fullName?: string; isAdmin?: boolean; exp?: number } | null {
  try {
    const part = token.split('.')[1]
    if (!part) return null
    const json = atob(part.replace(/-/g, '+').replace(/_/g, '/'))
    return JSON.parse(json)
  } catch {
    return null
  }
}

function isExpired(payload: { exp?: number } | null): boolean {
  if (!payload || typeof payload.exp !== 'number') return false
  return Date.now() >= payload.exp * 1000
}

export function UserProvider({ children }: { children: ReactNode }) {
  const [currentUser, setCurrentUserState] = useState<User | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [isMounted, setIsMounted] = useState(false)
  const [isServerDevice, setIsServerDevice] = useState(false)
  const [authRequired, setAuthRequired] = useState(false)
  const [needsLogin, setNeedsLogin] = useState(false)
  const [mustChangePin, setMustChangePin] = useState(false)

  useEffect(() => {
    setIsMounted(true)
  }, [])

  // authFetch dispatches 'auth:unauthorized' when a 401 invalidates the stored
  // token. Drop the session and return to the login screen (only meaningful
  // under enforced auth — open mode never gets here).
  useEffect(() => {
    if (typeof window === 'undefined') return
    const onUnauthorized = () => {
      setCurrentUserState(null)
      setMustChangePin(false)
      setNeedsLogin(true)
    }
    window.addEventListener('auth:unauthorized', onUnauthorized)
    return () => window.removeEventListener('auth:unauthorized', onUnauthorized)
  }, [])

  // Resolve the session identity on mount.
  //
  // Boot order:
  //  1. Probe GET /api/auth/mode for whether login is enforced.
  //  2a. AUTH OFF (default): exactly the previous behavior — server-device gets
  //      the canonical "Server Laptop" identity, everyone else falls through to
  //      the localStorage tester-name flow. No login screen, isAdmin stays true.
  //  2b. AUTH ON: read a stored JWT; if valid, populate the user from its claims;
  //      otherwise flag needsLogin so the shell shows the login screen.
  useEffect(() => {
    if (!isMounted) return

    let cancelled = false

    const resolveIdentity = async () => {
      // 1. Mode probe (open endpoint, no auth).
      let required = false
      try {
        const res = await fetch('/api/auth/mode', { cache: 'no-store' })
        if (res.ok) {
          const data = (await res.json()) as { required?: boolean }
          required = data.required === true
        }
      } catch {
        // Network error — degrade to open mode (previous behavior).
      }

      if (cancelled) return
      setAuthRequired(required)

      if (required) {
        // Enforced auth: identity comes from a stored JWT, not the device.
        const token = localStorage.getItem(TOKEN_KEY)
        const payload = token ? decodeJwt(token) : null
        if (token && payload && !isExpired(payload)) {
          setCurrentUserState({
            fullName: payload.fullName || 'User',
            isAdmin: payload.isAdmin === true,
            loginTime: new Date(),
          })
          setNeedsLogin(false)
        } else {
          if (token) localStorage.removeItem(TOKEN_KEY)
          setCurrentUserState(null)
          setNeedsLogin(true)
        }
        setIsLoading(false)
        return
      }

      // 2a. Open mode — unchanged legacy flow.
      let serverDevice = false
      try {
        const res = await fetch('/api/device/identity', { cache: 'no-store' })
        if (res.ok) {
          const data = (await res.json()) as { isServerDevice?: boolean }
          serverDevice = data.isServerDevice === true
        }
      } catch {
        // ignore
      }

      if (cancelled) return
      setIsServerDevice(serverDevice)

      if (serverDevice) {
        const SERVER_NAME = 'Server Laptop'
        localStorage.setItem('tester-name', SERVER_NAME)
        localStorage.removeItem('tester-name-previous')
        setCurrentUserState({ fullName: SERVER_NAME, isAdmin: true, loginTime: new Date() })
      } else {
        const stored = localStorage.getItem('tester-name')
        if (stored) {
          setCurrentUserState({ fullName: stored, isAdmin: true, loginTime: new Date() })
        }
      }
      setIsLoading(false)
    }

    resolveIdentity()

    return () => {
      cancelled = true
    }
  }, [isMounted])

  const setCurrentUser = (user: User | null) => {
    setCurrentUserState(user)
    if (user) {
      localStorage.setItem('tester-name', user.fullName)
    } else {
      localStorage.removeItem('tester-name')
    }
  }

  const onLoggedIn = useCallback(
    (data: { token: string; fullName: string; isAdmin: boolean; mustChangePin?: boolean }) => {
      localStorage.setItem(TOKEN_KEY, data.token)
      localStorage.setItem('tester-name', data.fullName)
      setCurrentUserState({
        fullName: data.fullName,
        isAdmin: data.isAdmin === true,
        loginTime: new Date(),
      })
      setNeedsLogin(false)
      setMustChangePin(data.mustChangePin === true)
    },
    []
  )

  const clearMustChangePin = useCallback((newToken?: string) => {
    if (newToken) localStorage.setItem(TOKEN_KEY, newToken)
    setMustChangePin(false)
  }, [])

  const logout = useCallback(() => {
    // Save previous name so NamePrompt can show "Current: ..."
    const previousName = localStorage.getItem('tester-name')
    if (previousName) {
      localStorage.setItem('tester-name-previous', previousName)
    }
    setCurrentUserState(null)
    setMustChangePin(false)
    localStorage.removeItem('tester-name')
    localStorage.removeItem(TOKEN_KEY)
    // Clean up old auth keys if they exist
    localStorage.removeItem('currentUser')
    localStorage.removeItem('loginTime')
    // When auth is enforced, drop straight back to the login screen.
    if (authRequired) setNeedsLogin(true)
  }, [authRequired])

  return (
    <UserContext.Provider
      value={{
        currentUser,
        setCurrentUser,
        logout,
        isLoading,
        isServerDevice,
        authRequired,
        needsLogin,
        mustChangePin,
        onLoggedIn,
        clearMustChangePin,
      }}
    >
      {children}
    </UserContext.Provider>
  )
}

export const useUser = () => {
  const context = useContext(UserContext)
  if (!context) {
    throw new Error('useUser must be used within a UserProvider')
  }
  return context
}
