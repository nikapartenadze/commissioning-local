"use client"

import { useUser } from "@/lib/user-context"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { User, RefreshCw } from "lucide-react"

export function UserMenu() {
  const { currentUser, logout } = useUser()

  if (!currentUser) {
    return null
  }

  return (
    <div className="flex items-center gap-2">
      <Badge variant="outline" className="flex items-center gap-2 px-3 py-2">
        <User className="h-4 w-4" />
        <span className="font-medium">{currentUser.fullName}</span>
      </Badge>
      <Button
        variant="ghost"
        size="sm"
        onClick={logout}
        title="Change tester name"
      >
        <RefreshCw className="h-4 w-4" />
        <span className="hidden sm:inline ml-1">Change</span>
      </Button>
    </div>
  )
}
