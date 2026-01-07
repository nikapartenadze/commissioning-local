"use client"

import { useState } from "react"
import { useUser } from "@/lib/user-context"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { User, LogOut, Settings } from "lucide-react"
import { AdminPanel } from "@/components/admin-panel"

export function UserMenu() {
  const { currentUser, logout } = useUser()
  const [showAdminPanel, setShowAdminPanel] = useState(false)

  if (!currentUser) {
    return null
  }

  return (
    <>
      <div className="flex items-center gap-2">
        {/* Current User Badge */}
        <Badge variant="outline" className="flex items-center gap-2 px-3 py-2">
          <User className="h-4 w-4" />
          <span className="font-medium">{currentUser.fullName}</span>
          {currentUser.isAdmin && (
            <Badge variant="secondary" className="ml-1 text-xs">Admin</Badge>
          )}
        </Badge>

        {/* Admin Panel Button (only for admins) */}
        {currentUser.isAdmin && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => setShowAdminPanel(true)}
            className="flex items-center gap-2"
          >
            <Settings className="h-4 w-4" />
            <span className="hidden sm:inline">Manage Users</span>
          </Button>
        )}

        {/* Logout Button */}
        <Button
          variant="ghost"
          size="sm"
          onClick={logout}
          className="flex items-center gap-2"
        >
          <LogOut className="h-4 w-4" />
          <span className="hidden sm:inline">Logout</span>
        </Button>
      </div>

      {/* Admin Panel Dialog */}
      {currentUser.isAdmin && (
        <AdminPanel
          open={showAdminPanel}
          onOpenChange={setShowAdminPanel}
        />
      )}
    </>
  )
}
