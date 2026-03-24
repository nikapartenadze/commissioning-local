"use client"

import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { CheckCircle2, XCircle, Loader2, Cloud, Upload } from "lucide-react"
import { useState } from "react"
import { API_ENDPOINTS, authFetch } from "@/lib/api-config"

interface CloudSyncDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  subsystemId: string
}

type SyncStatus = 'idle' | 'syncing' | 'success' | 'error'

export function CloudSyncDialog({ 
  open, 
  onOpenChange,
  subsystemId
}: CloudSyncDialogProps) {
  const [syncStatus, setSyncStatus] = useState<SyncStatus>('idle')
  const [uploadedCount, setUploadedCount] = useState(0)
  const [errorMessage, setErrorMessage] = useState("")

  const handleSync = async () => {
    try {
      setSyncStatus('syncing')
      setErrorMessage("")
      
      console.log('🔄 Uploading local test data to cloud...')
      
      const response = await authFetch(API_ENDPOINTS.cloudSync, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      })
      
      if (response.ok) {
        const result = await response.json()
        console.log('✅ Upload completed:', result)
        
        if (result.success) {
          setUploadedCount(result.syncedCount || 0)
          setSyncStatus('success')
        } else {
          console.error('❌ Upload returned success=false:', result)
          setErrorMessage(result.message || 'Upload failed - check backend logs')
          setSyncStatus('error')
        }
      } else {
        let errorMessage = 'Failed to sync to cloud'
        try {
          const error = await response.json()
          errorMessage = error.message || errorMessage
          console.error('❌ Upload failed:', error)
        } catch {
          const errorText = await response.text()
          errorMessage = `Status ${response.status}: ${errorText || 'Unknown error'}`
          console.error('❌ Upload failed:', response.status, errorText)
        }
        setErrorMessage(errorMessage)
        setSyncStatus('error')
      }
    } catch (error) {
      console.error('❌ Error during upload:', error)
      setErrorMessage(error instanceof Error ? error.message : 'Network error')
      setSyncStatus('error')
    }
  }

  const handleClose = () => {
    setSyncStatus('idle')
    setUploadedCount(0)
    setErrorMessage("")
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Cloud className="h-5 w-5" />
            Cloud Sync
          </DialogTitle>
        </DialogHeader>
        
        <div className="space-y-4">
          {/* Status Display */}
          {syncStatus === 'idle' && (
            <div className="space-y-4">
              <div className="p-4 bg-muted/50 rounded-lg border-2 border-primary/20">
                <div className="flex items-start gap-3">
                  <Upload className="h-5 w-5 text-primary mt-0.5 flex-shrink-0" />
                  <div className="space-y-1 flex-1">
                    <p className="text-sm font-medium">Upload Test Results</p>
                    <p className="text-xs text-muted-foreground">
                      This will upload all test results from <Badge variant="outline" className="mx-1">Subsystem {subsystemId}</Badge> to the remote server.
                    </p>
                  </div>
                </div>
              </div>

              <div className="space-y-2 text-xs text-muted-foreground bg-muted/30 p-3 rounded-lg">
                <p className="font-medium text-foreground mb-1">What gets synced:</p>
                <ul className="space-y-1 ml-4">
                  <li>• Test results (Pass/Fail status)</li>
                  <li>• Failure comments and notes</li>
                  <li>• Timestamps and test history</li>
                  <li>• Current IO states</li>
                </ul>
              </div>
            </div>
          )}

          {syncStatus === 'syncing' && (
            <div className="flex flex-col items-center justify-center py-8 space-y-4">
              <Loader2 className="h-12 w-12 animate-spin text-primary" />
              <div className="text-center space-y-1">
                <p className="font-medium">Syncing to cloud...</p>
                <p className="text-xs text-muted-foreground">Uploading test results</p>
              </div>
            </div>
          )}

          {syncStatus === 'success' && (
            <div className="flex flex-col items-center justify-center py-8 space-y-4">
              <div className="rounded-full bg-green-500/10 p-3">
                <CheckCircle2 className="h-12 w-12 text-green-500" />
              </div>
              <div className="text-center space-y-2">
                <p className="font-semibold text-lg">Successfully Synced!</p>
                <div className="space-y-1">
                  <p className="text-sm text-muted-foreground">
                    Uploaded <Badge variant="outline" className="mx-1 font-mono">{uploadedCount}</Badge> 
                    test {uploadedCount === 1 ? 'result' : 'results'}
                  </p>
                  <p className="text-sm text-muted-foreground">
                    from <Badge variant="outline" className="mx-1">Subsystem {subsystemId}</Badge>
                  </p>
                </div>
              </div>
            </div>
          )}

          {syncStatus === 'error' && (
            <div className="flex flex-col items-center justify-center py-8 space-y-4">
              <div className="rounded-full bg-destructive/10 p-3">
                <XCircle className="h-12 w-12 text-destructive" />
              </div>
              <div className="text-center space-y-2">
                <p className="font-semibold text-lg text-destructive">Sync Failed</p>
                <p className="text-sm text-muted-foreground max-w-xs">
                  {errorMessage}
                </p>
              </div>
            </div>
          )}
        </div>

        <DialogFooter className="flex gap-2">
          {syncStatus === 'idle' && (
            <>
              <Button variant="outline" onClick={handleClose}>
                Cancel
              </Button>
              <Button onClick={handleSync} className="gap-2">
                <Upload className="h-4 w-4" />
                Upload to Cloud
              </Button>
            </>
          )}

          {syncStatus === 'syncing' && (
            <Button variant="outline" disabled>
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              Syncing...
            </Button>
          )}

          {(syncStatus === 'success' || syncStatus === 'error') && (
            <Button onClick={handleClose} className="w-full">
              Close
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

