"use client"

import { useEffect } from "react"
import { useRouter } from "next/navigation"
import { useUser } from "@/lib/user-context"
import { PinLogin } from "@/components/pin-login"

export default function HomePage() {
  const router = useRouter()
  const { currentUser, isLoading } = useUser()
  
  useEffect(() => {
    // Only redirect if user is logged in
    if (!isLoading && currentUser) {
      router.push('/commissioning/16')
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
