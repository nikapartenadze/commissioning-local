"use client"

import { useState, useEffect } from "react"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Loader2, UserPlus, Key, UserX, Trash2, User, Shield } from "lucide-react"
import { useUser } from "@/lib/user-context"
import { useToast } from "@/hooks/use-toast"
import { API_ENDPOINTS } from "@/lib/api-config"

interface UserData {
  id: number
  fullName: string
  isAdmin: boolean
  isActive: boolean
  createdAt: string
  lastUsedAt: string | null
}

interface AdminPanelProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function AdminPanel({ open, onOpenChange }: AdminPanelProps) {
  const { currentUser } = useUser()
  const { toast } = useToast()
  const [users, setUsers] = useState<UserData[]>([])
  const [loading, setLoading] = useState(false)
  const [creating, setCreating] = useState(false)
  const [newUserName, setNewUserName] = useState("")
  const [newUserPin, setNewUserPin] = useState("")
  const [resetPinUserId, setResetPinUserId] = useState<number | null>(null)
  const [newPin, setNewPin] = useState("")

  useEffect(() => {
    if (open) {
      loadUsers()
    }
  }, [open])

  const loadUsers = async () => {
    try {
      setLoading(true)
      const response = await fetch(API_ENDPOINTS.users)
      if (response.ok) {
        const data = await response.json()
        setUsers(data)
      }
    } catch (error) {
      console.error('Error loading users:', error)
    } finally {
      setLoading(false)
    }
  }

  const handleCreateUser = async () => {
    if (!newUserName.trim() || newUserPin.length !== 6) {
      toast({
        title: "Invalid Input",
        description: "Please enter a valid name and 6-digit PIN",
        variant: "destructive"
      })
      return
    }

    try {
      setCreating(true)
      const response = await fetch(API_ENDPOINTS.users, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fullName: newUserName,
          pin: newUserPin,
          createdByAdmin: currentUser?.fullName || 'Admin'
        })
      })

      if (response.ok) {
        setNewUserName("")
        setNewUserPin("")
        await loadUsers()
        toast({
          title: "User Created",
          description: `User "${newUserName}" has been created successfully`,
        })
      } else {
        const error = await response.json()
        toast({
          title: "Error",
          description: error.message || 'Failed to create user',
          variant: "destructive"
        })
      }
    } catch (error) {
      toast({
        title: "Error",
        description: "Error creating user",
        variant: "destructive"
      })
    } finally {
      setCreating(false)
    }
  }

  const handleResetPin = async (userId: number) => {
    if (newPin.length !== 6) {
      toast({
        title: "Invalid PIN",
        description: "PIN must be 6 digits",
        variant: "destructive"
      })
      return
    }

    try {
      const response = await fetch(API_ENDPOINTS.userResetPin(userId), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          newPin: newPin,
          resetByAdmin: currentUser?.fullName || 'Admin'
        })
      })

      if (response.ok) {
        setResetPinUserId(null)
        setNewPin("")
        toast({
          title: "PIN Reset",
          description: "PIN has been reset successfully",
        })
      } else {
        const error = await response.json()
        toast({
          title: "Error",
          description: error.message || 'Failed to reset PIN',
          variant: "destructive"
        })
      }
    } catch (error) {
      toast({
        title: "Error",
        description: "Error resetting PIN",
        variant: "destructive"
      })
    }
  }

  const handleToggleActive = async (userId: number) => {
    try {
      const response = await fetch(API_ENDPOINTS.userToggleActive(userId), {
        method: 'PUT'
      })

      if (response.ok) {
        await loadUsers()
        toast({
          title: "Status Updated",
          description: "User status has been updated successfully",
        })
      } else {
        const error = await response.json()
        toast({
          title: "Error",
          description: error.message || 'Failed to toggle user status',
          variant: "destructive"
        })
      }
    } catch (error) {
      toast({
        title: "Error",
        description: "Error toggling user status",
        variant: "destructive"
      })
    }
  }

  const handleDeleteUser = async (userId: number, userName: string) => {
    if (!confirm(`Are you sure you want to delete user "${userName}"?`)) {
      return
    }

    try {
      const response = await fetch(API_ENDPOINTS.userById(userId), {
        method: 'DELETE'
      })

      if (response.ok) {
        await loadUsers()
        toast({
          title: "User Deleted",
          description: `User "${userName}" has been deleted successfully`,
        })
      } else {
        const error = await response.json()
        toast({
          title: "Error",
          description: error.message || 'Failed to delete user',
          variant: "destructive"
        })
      }
    } catch (error) {
      toast({
        title: "Error",
        description: "Error deleting user",
        variant: "destructive"
      })
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Shield className="h-5 w-5" />
            User Management
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-6">
          {/* Create New User */}
          <Card>
            <CardHeader>
              <CardTitle className="text-lg flex items-center gap-2">
                <UserPlus className="h-5 w-5" />
                Create New User
              </CardTitle>
              <CardDescription>
                Add a new user to the system. Each PIN must be unique.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="newUserName">Full Name</Label>
                  <Input
                    id="newUserName"
                    value={newUserName}
                    onChange={(e) => setNewUserName(e.target.value)}
                    placeholder="John Smith"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="newUserPin">6-Digit PIN</Label>
                  <Input
                    id="newUserPin"
                    type="password"
                    maxLength={6}
                    value={newUserPin}
                    onChange={(e) => setNewUserPin(e.target.value.replace(/\D/g, ''))}
                    placeholder="123456"
                  />
                </div>
              </div>
              <Button
                onClick={handleCreateUser}
                disabled={creating || !newUserName.trim() || newUserPin.length !== 6}
                className="w-full"
              >
                {creating ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Creating...
                  </>
                ) : (
                  <>
                    <UserPlus className="mr-2 h-4 w-4" />
                    Create User
                  </>
                )}
              </Button>
            </CardContent>
          </Card>

          {/* User List */}
          <Card>
            <CardHeader>
              <CardTitle className="text-lg">Existing Users</CardTitle>
              <CardDescription>
                Manage user accounts and permissions. PINs are securely encrypted and cannot be viewed - you can only reset them to a new PIN.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {loading ? (
                <div className="flex justify-center py-8">
                  <Loader2 className="h-8 w-8 animate-spin" />
                </div>
              ) : (
                <div className="space-y-3">
                  {users.map(user => (
                    <Card key={user.id} className={!user.isActive ? 'opacity-60' : ''}>
                      <CardContent className="p-4">
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-3">
                            <User className="h-5 w-5 text-muted-foreground" />
                            <div>
                              <div className="flex items-center gap-2">
                                <span className="font-medium">{user.fullName}</span>
                                {user.isAdmin && (
                                  <Badge variant="secondary">Admin</Badge>
                                )}
                                {!user.isActive && (
                                  <Badge variant="destructive">Inactive</Badge>
                                )}
                              </div>
                              <div className="text-xs text-muted-foreground">
                                {user.lastUsedAt 
                                  ? `Last used: ${new Date(user.lastUsedAt).toLocaleString()}`
                                  : 'Never used'}
                              </div>
                            </div>
                          </div>

                          <div className="flex items-center gap-2">
                            {/* Reset PIN */}
                            {resetPinUserId === user.id ? (
                              <div className="flex items-center gap-2">
                                <Input
                                  type="password"
                                  maxLength={6}
                                  value={newPin}
                                  onChange={(e) => setNewPin(e.target.value.replace(/\D/g, ''))}
                                  placeholder="New PIN"
                                  className="w-24"
                                />
                                <Button
                                  size="sm"
                                  onClick={() => handleResetPin(user.id)}
                                  disabled={newPin.length !== 6}
                                >
                                  Save
                                </Button>
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  onClick={() => {
                                    setResetPinUserId(null)
                                    setNewPin("")
                                  }}
                                >
                                  Cancel
                                </Button>
                              </div>
                            ) : (
                              <>
                                <Button
                                  size="sm"
                                  variant="outline"
                                  onClick={() => setResetPinUserId(user.id)}
                                >
                                  <Key className="h-4 w-4 mr-1" />
                                  Reset PIN
                                </Button>
                                {!user.isAdmin && (
                                  <Button
                                    size="sm"
                                    variant="outline"
                                    onClick={() => handleToggleActive(user.id)}
                                  >
                                    <UserX className="h-4 w-4 mr-1" />
                                    {user.isActive ? 'Deactivate' : 'Activate'}
                                  </Button>
                                )}
                                {!user.isAdmin && (
                                  <Button
                                    size="sm"
                                    variant="destructive"
                                    onClick={() => handleDeleteUser(user.id, user.fullName)}
                                  >
                                    <Trash2 className="h-4 w-4" />
                                  </Button>
                                )}
                              </>
                            )}
                          </div>
                        </div>
                      </CardContent>
                    </Card>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </DialogContent>
    </Dialog>
  )
}

