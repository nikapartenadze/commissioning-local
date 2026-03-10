"use client"

import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { useUser } from "@/lib/user-context"
import { PinLogin } from "@/components/pin-login"
import { API_ENDPOINTS } from "@/lib/api-config"

export default function HomePage() {
  const router = useRouter()
  const { currentUser, isLoading } = useUser()
  const [redirecting, setRedirecting] = useState(false)

  // Fetch config and redirect when user is logged in
  useEffect(() => {
    if (!isLoading && currentUser && !redirecting) {
      setRedirecting(true)
      fetch(API_ENDPOINTS.configurationRuntime)
        .then(res => res.json())
        .then(data => {
          const subsystemId = data.subsystemId
          if (subsystemId && subsystemId !== '') {
            router.push(`/commissioning/${subsystemId}`)
          } else {
            // No subsystem configured - go to placeholder where config dialog opens
            router.push('/commissioning/_')
          }
        })
        .catch(() => {
          router.push('/commissioning/_')
        })
    }
  }, [currentUser, isLoading, router, redirecting])

  // Show loading while checking user state
  if (isLoading || redirecting) {
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

  // Show loading while fetching config
  return (
    <div className="min-h-screen bg-gradient-to-br from-background via-background to-muted/20">
      <div className="container mx-auto px-4 py-8">
        <div className="flex items-center justify-center h-64">
          <div className="text-center">
            <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary mx-auto mb-4"></div>
            <p className="text-muted-foreground">Loading configuration...</p>
          </div>
        </div>
      </div>
    </div>
  )
}
