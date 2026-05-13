"use client"

import { ShieldAlert } from "lucide-react"
import { useUser } from "@/lib/user-context"

/**
 * Sticky banner shown at the top of every page when this browser is running
 * on the Server Laptop (loopback IP). The Server Laptop is the sync and
 * PLC-broker host; operators on it should not author test results. Backend
 * middleware noTestingOnServerLaptop refuses pass/fail/fire actions from
 * loopback, so this banner exists to set expectations rather than carry the
 * enforcement.
 */
export function ServerLaptopBanner() {
  const { isServerDevice, isLoading } = useUser()
  if (isLoading || !isServerDevice) return null

  return (
    <div
      role="alert"
      className="sticky top-0 z-50 w-full border-b border-amber-300 bg-amber-50 px-4 py-2 text-sm text-amber-900 shadow-sm dark:border-amber-800/60 dark:bg-amber-950/70 dark:text-amber-100"
    >
      <div className="mx-auto flex max-w-7xl items-center gap-2">
        <ShieldAlert className="h-4 w-4 shrink-0" />
        <div className="flex-1">
          <span className="font-semibold">Server Laptop — testing disabled.</span>{" "}
          This machine is the sync hub. Mark IOs, fire outputs, and run wizard steps
          from a Client Laptop browser. Test actions from this device will be refused
          by the server.
        </div>
      </div>
    </div>
  )
}
