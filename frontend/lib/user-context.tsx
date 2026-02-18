"use client"

import { createContext, useContext, useState, useEffect, ReactNode } from 'react'
import { logger } from '@/lib/logger'

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
}

const UserContext = createContext<UserContextType>({
  currentUser: null,
  setCurrentUser: () => {},
  logout: () => {},
  isLoading: true
})

export function UserProvider({ children }: { children: ReactNode }) {
  const [currentUser, setCurrentUserState] = useState<User | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [isMounted, setIsMounted] = useState(false)

  // Handle hydration - only run on client
  useEffect(() => {
    setIsMounted(true)
  }, [])

  // Load from localStorage on mount and check for auto-logout
  useEffect(() => {
    if (!isMounted) return

    const stored = localStorage.getItem('currentUser')
    const loginTime = localStorage.getItem('loginTime')

    if (stored && loginTime) {
      try {
        const user = JSON.parse(stored)
        const loginDate = new Date(loginTime)

        // Check if 8 hours have passed (auto-logout)
        const hoursSinceLogin = (Date.now() - loginDate.getTime()) / (1000 * 60 * 60)

        if (hoursSinceLogin < 8) {
          setCurrentUserState({
            ...user,
            loginTime: loginDate
          })
        } else {
          // Auto-logout after 8 hours
          localStorage.removeItem('currentUser')
          localStorage.removeItem('loginTime')
          localStorage.removeItem('authToken')
        }
      } catch (error) {
        console.error('Error loading user from localStorage:', error)
        localStorage.removeItem('currentUser')
        localStorage.removeItem('loginTime')
        localStorage.removeItem('authToken')
      }
    }

    setIsLoading(false)
  }, [isMounted])

  const setCurrentUser = (user: User | null) => {
    setCurrentUserState(user)
    if (user) {
      localStorage.setItem('currentUser', JSON.stringify({
        fullName: user.fullName,
        isAdmin: user.isAdmin
      }))
      localStorage.setItem('loginTime', new Date().toISOString())
      logger.log('User logged in:', user.fullName)
    } else {
      localStorage.removeItem('currentUser')
      localStorage.removeItem('loginTime')
    }
  }

  const logout = () => {
    setCurrentUserState(null)
    localStorage.removeItem('currentUser')
    localStorage.removeItem('loginTime')
    localStorage.removeItem('authToken')
  }

  return (
    <UserContext.Provider value={{ currentUser, setCurrentUser, logout, isLoading }}>
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

