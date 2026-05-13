"use client"

import { createContext, useContext, useState, useEffect, ReactNode } from 'react'

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
}

const UserContext = createContext<UserContextType>({
  currentUser: null,
  setCurrentUser: () => {},
  logout: () => {},
  isLoading: true,
  isServerDevice: false,
})

export function UserProvider({ children }: { children: ReactNode }) {
  const [currentUser, setCurrentUserState] = useState<User | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [isMounted, setIsMounted] = useState(false)
  const [isServerDevice, setIsServerDevice] = useState(false)

  useEffect(() => {
    setIsMounted(true)
  }, [])

  // Resolve the session identity on mount.
  // Server machine (loopback IP) is auto-named "Server Laptop" and bypasses
  // the NamePrompt entirely. All other devices fall through to the normal
  // localStorage + NamePrompt flow.
  useEffect(() => {
    if (!isMounted) return

    let cancelled = false

    const resolveIdentity = async () => {
      let isServerDevice = false
      try {
        const res = await fetch('/api/device/identity', { cache: 'no-store' })
        if (res.ok) {
          const data = (await res.json()) as { isServerDevice?: boolean }
          isServerDevice = data.isServerDevice === true
        }
      } catch {
        // Network error — degrade gracefully to the existing flow.
      }

      if (cancelled) return

      setIsServerDevice(isServerDevice)

      if (isServerDevice) {
        // Force the canonical name regardless of what the user typed previously.
        const SERVER_NAME = 'Server Laptop'
        localStorage.setItem('tester-name', SERVER_NAME)
        localStorage.removeItem('tester-name-previous')
        setCurrentUserState({
          fullName: SERVER_NAME,
          isAdmin: true,
          loginTime: new Date()
        })
      } else {
        const stored = localStorage.getItem('tester-name')
        if (stored) {
          setCurrentUserState({
            fullName: stored,
            isAdmin: true,
            loginTime: new Date()
          })
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

  const logout = () => {
    // Save previous name so NamePrompt can show "Current: ..."
    const previousName = localStorage.getItem('tester-name')
    if (previousName) {
      localStorage.setItem('tester-name-previous', previousName)
    }
    setCurrentUserState(null)
    localStorage.removeItem('tester-name')
    // Clean up old auth keys if they exist
    localStorage.removeItem('currentUser')
    localStorage.removeItem('loginTime')
    localStorage.removeItem('authToken')
  }

  return (
    <UserContext.Provider value={{ currentUser, setCurrentUser, logout, isLoading, isServerDevice }}>
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
