"use client"

import { useEffect, useState } from "react"
import { useNavigate } from "react-router-dom"

export default function CommissioningIndex() {
  const navigate = useNavigate()
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    // Fetch config to get subsystemId
    fetch("/api/configuration/runtime")
      .then(res => res.json())
      .then(data => {
        if (data.subsystemId && data.subsystemId !== '') {
          // Redirect to the subsystem page
          navigate(`/commissioning/${data.subsystemId}`, { replace: true })
        } else {
          // No subsystem configured - go to placeholder page where user can configure
          navigate('/commissioning/_', { replace: true })
        }
      })
      .catch(() => {
        navigate('/commissioning/_', { replace: true })
      })
      .finally(() => setLoading(false))
  }, [navigate])

  return (
    <div className="min-h-screen flex items-center justify-center">
      <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
    </div>
  )
}
