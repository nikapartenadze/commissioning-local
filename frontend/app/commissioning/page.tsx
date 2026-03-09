"use client"

import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"

export default function CommissioningIndex() {
  const router = useRouter()
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    // Fetch config to get subsystemId
    fetch("/api/configuration/runtime")
      .then(res => res.json())
      .then(data => {
        if (data.subsystemId && data.subsystemId !== '') {
          // Redirect to the subsystem page
          router.replace(`/commissioning/${data.subsystemId}`)
        } else {
          // No subsystem configured - go to placeholder page where user can configure
          router.replace('/commissioning/_')
        }
      })
      .catch(() => {
        router.replace('/commissioning/_')
      })
      .finally(() => setLoading(false))
  }, [router])

  return (
    <div className="min-h-screen flex items-center justify-center">
      <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
    </div>
  )
}
