"use client"

import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { useUser } from "@/lib/user-context"
import { PinLogin } from "@/components/pin-login"
import { API_ENDPOINTS } from "@/lib/api-config"

export default function HomePage() {
  const router = useRouter()
  const { currentUser, isLoading } = useUser()
  const [configError, setConfigError] = useState(false)

  useEffect(() => {
    if (!isLoading && currentUser) {
      // Fetch active subsystem from backend config instead of hardcoding
      fetch(API_ENDPOINTS.configurationRuntime)
        .then(res => res.json())
        .then(data => {
          const subsystemId = data.subsystemId
          if (subsystemId && subsystemId !== '') {
            router.push(`/commissioning/${subsystemId}`)
          } else {
            // No subsystem configured — show config needed message
            setConfigError(true)
          }
        })
        .catch(() => {
          // Backend not reachable — try with a fallback
          setConfigError(true)
        })
    }
  }, [currentUser, isLoading, router])

  // Show loading while checking user state
  if (isLoading) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-background via-background to-muted/20">
        <div className="container mx-auto px-4 py-8">
          <div className="flex items-center justify-center h-64">
            <div className="text-center">
              <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary mx-auto mb-4"></div>
              <p className="text-muted-foreground">Loading...</p>
            </div>
          </div>
        </div>
      </div>
    )
  }

  // Show login if no user
  if (!currentUser) {
    return <PinLogin />
  }

  // No subsystem configured — prompt to configure
  if (configError) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-background via-background to-muted/20">
        <div className="container mx-auto px-4 py-8">
          <div className="flex items-center justify-center h-64">
            <div className="text-center max-w-md">
              <div className="rounded-full h-16 w-16 bg-yellow-100 dark:bg-yellow-900/30 flex items-center justify-center mx-auto mb-4">
                <svg className="h-8 w-8 text-yellow-600 dark:text-yellow-400" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126ZM12 15.75h.007v.008H12v-.008Z" />
                </svg>
              </div>
              <h2 className="text-xl font-semibold mb-2">PLC Configuration Required</h2>
              <p className="text-muted-foreground mb-6">
                No PLC connection is configured yet. Open the PLC configuration to set the IP address, path, and subsystem ID.
              </p>
              <p className="text-sm text-muted-foreground">
                Use the settings icon in the toolbar after the page loads, or check that the backend is running on port 5000.
              </p>
            </div>
          </div>
        </div>
      </div>
    )
  }

  // Show redirecting message while navigating
  return (
    <div className="min-h-screen bg-gradient-to-br from-background via-background to-muted/20">
      <div className="container mx-auto px-4 py-8">
        <div className="flex items-center justify-center h-64">
          <div className="text-center">
            <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary mx-auto mb-4"></div>
            <p className="text-muted-foreground">Redirecting to testing page...</p>
          </div>
        </div>
      </div>
    </div>
  )
}
