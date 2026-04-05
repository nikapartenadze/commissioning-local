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

  useEffect(() => {
    setIsMounted(true)
  }, [])

  // Load tester name from localStorage on mount
  useEffect(() => {
    if (!isMounted) return

    const name = localStorage.getItem('tester-name')
    if (name) {
      setCurrentUserState({
        fullName: name,
        isAdmin: true,
        loginTime: new Date()
      })
    }
    setIsLoading(false)
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
