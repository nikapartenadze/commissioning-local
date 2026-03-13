"use client"

import { useState, useEffect } from "react"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Loader2, UserPlus, Key, UserX, Trash2, User, Shield, Database, Download, CloudUpload, Plus } from "lucide-react"
import { useUser } from "@/lib/user-context"
import { useToast } from "@/hooks/use-toast"
import { API_ENDPOINTS, authFetch } from "@/lib/api-config"

interface BackupData {
  filename: string
  path: string
  size: number
  createdAt: string
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i]
}

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

  // Backup state
  const [backups, setBackups] = useState<BackupData[]>([])
  const [backupsLoading, setBackupsLoading] = useState(false)
  const [creatingBackup, setCreatingBackup] = useState(false)
  const [syncingBackup, setSyncingBackup] = useState<string | null>(null)
  const [syncRemoteUrl, setSyncRemoteUrl] = useState("")
  const [syncApiPassword, setSyncApiPassword] = useState("")
  const [syncSubsystemId, setSyncSubsystemId] = useState("")
  const [showSyncForm, setShowSyncForm] = useState<string | null>(null)

  useEffect(() => {
    if (open) {
      loadUsers()
      loadBackups()
    }
  }, [open])

  const loadUsers = async () => {
    try {
      setLoading(true)
      const response = await authFetch(API_ENDPOINTS.users)
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

  const loadBackups = async () => {
    try {
      setBackupsLoading(true)
      const response = await authFetch(API_ENDPOINTS.backups)
      if (response.ok) {
        const data = await response.json()
        setBackups(data.backups || [])
      }
    } catch (error) {
      console.error('Error loading backups:', error)
    } finally {
      setBackupsLoading(false)
    }
  }

  const handleCreateBackup = async () => {
    try {
      setCreatingBackup(true)
      const response = await authFetch(API_ENDPOINTS.backups, {
        method: 'POST',
        body: JSON.stringify({ reason: 'manual' }),
      })
      if (response.ok) {
        await loadBackups()
        toast({ title: "Backup Created", description: "Database backup created successfully" })
      } else {
        const error = await response.json()
        toast({ title: "Error", description: error.error || 'Failed to create backup', variant: "destructive" })
      }
    } catch (error) {
      toast({ title: "Error", description: "Error creating backup", variant: "destructive" })
    } finally {
      setCreatingBackup(false)
    }
  }

  const handleDownloadBackup = (filename: string) => {
    window.open(API_ENDPOINTS.backupByFilename(filename), '_blank')
  }

  const handleDeleteBackup = async (filename: string) => {
    if (!confirm(`Delete backup "${filename}"?`)) return
    try {
      const response = await authFetch(API_ENDPOINTS.backupByFilename(filename), { method: 'DELETE' })
      if (response.ok) {
        await loadBackups()
        toast({ title: "Backup Deleted", description: "Backup deleted successfully" })
      } else {
        const error = await response.json()
        toast({ title: "Error", description: error.error || 'Failed to delete backup', variant: "destructive" })
      }
    } catch (error) {
      toast({ title: "Error", description: "Error deleting backup", variant: "destructive" })
    }
  }

  const handleSyncBackup = async (filename: string) => {
    if (!syncRemoteUrl) {
      toast({ title: "Error", description: "Remote URL is required", variant: "destructive" })
      return
    }
    try {
      setSyncingBackup(filename)
      const response = await authFetch(API_ENDPOINTS.backupSync(filename), {
        method: 'POST',
        body: JSON.stringify({
          remoteUrl: syncRemoteUrl,
          apiPassword: syncApiPassword,
          subsystemId: syncSubsystemId ? parseInt(syncSubsystemId, 10) : undefined,
        }),
      })
      const data = await response.json()
      if (data.success) {
        toast({
          title: "Sync Complete",
          description: `Synced ${data.syncedPending} pending updates and ${data.syncedHistories} test histories`,
        })
        setShowSyncForm(null)
      } else {
        toast({
          title: "Sync Issues",
          description: data.errors?.join('; ') || data.error || 'Sync completed with errors',
          variant: "destructive",
        })
      }
    } catch (error) {
      toast({ title: "Error", description: "Error syncing backup", variant: "destructive" })
    } finally {
      setSyncingBackup(null)
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
      const response = await authFetch(API_ENDPOINTS.users, {
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
      const response = await authFetch(API_ENDPOINTS.userResetPin(userId), {
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
      const response = await authFetch(API_ENDPOINTS.userToggleActive(userId), {
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
      const response = await authFetch(API_ENDPOINTS.userById(userId), {
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
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
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
          {/* Database Backups */}
          <Card>
            <CardHeader>
              <CardTitle className="text-lg flex items-center gap-2">
                <Database className="h-5 w-5" />
                Database Backups
              </CardTitle>
              <CardDescription>
                Manage database backups. Backups are created automatically before cloud pulls.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <Button onClick={handleCreateBackup} disabled={creatingBackup} className="w-full">
                {creatingBackup ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Creating...
                  </>
                ) : (
                  <>
                    <Plus className="mr-2 h-4 w-4" />
                    Create Backup
                  </>
                )}
              </Button>

              {backupsLoading ? (
                <div className="flex justify-center py-4">
                  <Loader2 className="h-6 w-6 animate-spin" />
                </div>
              ) : backups.length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-4">No backups found</p>
              ) : (
                <div className="space-y-2">
                  {backups.map(backup => (
                    <Card key={backup.filename}>
                      <CardContent className="p-3">
                        <div className="flex items-center justify-between gap-2">
                          <div className="min-w-0 flex-1">
                            <p className="text-sm font-medium truncate">{backup.filename}</p>
                            <p className="text-xs text-muted-foreground">
                              {formatBytes(backup.size)} &middot; {new Date(backup.createdAt).toLocaleString()}
                            </p>
                          </div>
                          <div className="flex items-center gap-1 shrink-0">
                            <Button size="sm" variant="outline" onClick={() => handleDownloadBackup(backup.filename)}>
                              <Download className="h-4 w-4" />
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => {
                                setShowSyncForm(showSyncForm === backup.filename ? null : backup.filename)
                              }}
                            >
                              <CloudUpload className="h-4 w-4" />
                            </Button>
                            <Button size="sm" variant="destructive" onClick={() => handleDeleteBackup(backup.filename)}>
                              <Trash2 className="h-4 w-4" />
                            </Button>
                          </div>
                        </div>

                        {showSyncForm === backup.filename && (
                          <div className="mt-3 space-y-2 border-t pt-3">
                            <div className="space-y-1">
                              <Label className="text-xs">Remote URL</Label>
                              <Input
                                value={syncRemoteUrl}
                                onChange={(e) => setSyncRemoteUrl(e.target.value)}
                                placeholder="https://commissioning.example.com"
                                className="h-8 text-sm"
                              />
                            </div>
                            <div className="grid grid-cols-2 gap-2">
                              <div className="space-y-1">
                                <Label className="text-xs">API Password</Label>
                                <Input
                                  type="password"
                                  value={syncApiPassword}
                                  onChange={(e) => setSyncApiPassword(e.target.value)}
                                  placeholder="Password"
                                  className="h-8 text-sm"
                                />
                              </div>
                              <div className="space-y-1">
                                <Label className="text-xs">Subsystem ID</Label>
                                <Input
                                  value={syncSubsystemId}
                                  onChange={(e) => setSyncSubsystemId(e.target.value.replace(/\D/g, ''))}
                                  placeholder="ID"
                                  className="h-8 text-sm"
                                />
                              </div>
                            </div>
                            <Button
                              size="sm"
                              className="w-full"
                              onClick={() => handleSyncBackup(backup.filename)}
                              disabled={syncingBackup === backup.filename || !syncRemoteUrl}
                            >
                              {syncingBackup === backup.filename ? (
                                <>
                                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                                  Syncing...
                                </>
                              ) : (
                                <>
                                  <CloudUpload className="mr-2 h-4 w-4" />
                                  Sync to Cloud
                                </>
                              )}
                            </Button>
                          </div>
                        )}
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

