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
      <Badge variant="outline" className="flex items-center gap-1.5 px-2 py-1 text-xs">
        <User className="h-3.5 w-3.5" />
        <span className="font-medium">{currentUser.fullName}</span>
      </Badge>
      <Button
        variant="ghost"
        size="sm"
        onClick={logout}
        title="Change tester name"
        className="h-8 px-2"
      >
        <RefreshCw className="h-3.5 w-3.5" />
        <span className="hidden sm:inline ml-1">Change</span>
      </Button>
    </div>
  )
}
