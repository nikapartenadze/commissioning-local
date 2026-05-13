"use client"

import { useEffect, useState } from "react"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { CheckCircle2, XCircle, Loader2, Cloud, Upload, RefreshCw, ChevronDown, ChevronRight } from "lucide-react"
import { API_ENDPOINTS, authFetch } from "@/lib/api-config"
import type { CloudSyncStatusResponse } from "@/lib/cloud/types"

interface CloudSyncDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  subsystemId: string
  initialStatus?: CloudSyncStatusResponse | null
}

type SyncTarget = 'io' | 'l2'
type SyncStatus = 'idle' | 'syncing' | 'success' | 'error'

interface L2PendingItem {
  id: number
  cloudDeviceId: number
  cloudColumnId: number
  pendingValue: string | null
  baseVersion: number
  updatedBy: string | null
  retryCount: number
  lastError: string | null
  createdAt: string
  localDeviceId: number | null
  deviceName: string | null
  mcm: string | null
  localColumnId: number | null
  columnName: string | null
  sheetName: string | null
  sheetDisplayName: string | null
  localValue: string | null
  localVersion: number | null
  localUpdatedAt: string | null
}

export function CloudSyncDialog({
  open,
  onOpenChange,
  subsystemId,
  initialStatus = null,
}: CloudSyncDialogProps) {
  const [syncStatus, setSyncStatus] = useState<SyncStatus>('idle')
  const [syncTarget, setSyncTarget] = useState<SyncTarget>('io')
  const [uploadedCount, setUploadedCount] = useState(0)
  const [errorMessage, setErrorMessage] = useState("")
  const [statusLoading, setStatusLoading] = useState(false)
  const [operationalStatus, setOperationalStatus] = useState<CloudSyncStatusResponse | null>(initialStatus)
  const [itemsExpanded, setItemsExpanded] = useState(false)
  const [pendingItems, setPendingItems] = useState<L2PendingItem[] | null>(null)
  const [itemsLoading, setItemsLoading] = useState(false)
  const [itemsError, setItemsError] = useState<string | null>(null)

  const loadStatus = async () => {
    try {
      setStatusLoading(true)
      const response = await authFetch(API_ENDPOINTS.cloudStatus)
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`)
      }
      const data = await response.json() as CloudSyncStatusResponse
      setOperationalStatus(data)
    } catch (error) {
      setOperationalStatus(prev => prev ?? {
        connected: false,
        pendingSyncCount: 0,
        error: error instanceof Error ? error.message : 'Failed to load sync status',
      })
    } finally {
      setStatusLoading(false)
    }
  }

  const loadPendingItems = async () => {
    try {
      setItemsLoading(true)
      setItemsError(null)
      const response = await authFetch(API_ENDPOINTS.cloudSyncL2Items)
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`)
      }
      const data = await response.json() as { items: L2PendingItem[] }
      setPendingItems(Array.isArray(data.items) ? data.items : [])
    } catch (error) {
      setItemsError(error instanceof Error ? error.message : 'Failed to load pending items')
      setPendingItems([])
    } finally {
      setItemsLoading(false)
    }
  }

  useEffect(() => {
    if (!open) return
    setOperationalStatus(initialStatus)
    loadStatus()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initialStatus?.connected, initialStatus?.pendingSyncCount, initialStatus?.totalPendingCount, initialStatus?.lastPushAt, initialStatus?.lastPullAt])

  const handleSync = async (target: SyncTarget = 'io') => {
    try {
      setSyncTarget(target)
      setSyncStatus('syncing')
      setErrorMessage("")

      const endpoint = target === 'l2' ? API_ENDPOINTS.cloudSyncL2 : API_ENDPOINTS.cloudSync
      const response = await authFetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      })

      if (response.ok) {
        const result = await response.json()
        if (result.success) {
          setUploadedCount(result.syncedCount || 0)
          setSyncStatus('success')
        } else {
          const failMsg = result.errors?.join(', ') || result.message || 'Upload failed - check backend logs'
          if (result.syncedCount > 0) {
            // Partial success — some synced, some failed
            setUploadedCount(result.syncedCount)
            setErrorMessage(`${result.syncedCount} synced, ${result.failedCount} failed: ${failMsg}`)
            setSyncStatus('error')
          } else {
            setErrorMessage(failMsg)
            setSyncStatus('error')
          }
        }
      } else {
        let nextErrorMessage = 'Failed to sync to cloud'
        try {
          const error = await response.json()
          nextErrorMessage = error.message || error.error || nextErrorMessage
        } catch {
          const errorText = await response.text()
          nextErrorMessage = `Status ${response.status}: ${errorText || 'Unknown error'}`
        }
        setErrorMessage(nextErrorMessage)
        setSyncStatus('error')
      }
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Network error')
      setSyncStatus('error')
    } finally {
      await loadStatus()
      // If the items panel is open, refresh it too so the user sees what
      // actually drained vs what's still stuck after the click.
      if (itemsExpanded) {
        await loadPendingItems()
      }
    }
  }

  const handleClose = () => {
    setSyncStatus('idle')
    setUploadedCount(0)
    setErrorMessage("")
    setItemsExpanded(false)
    setPendingItems(null)
    setItemsError(null)
    onOpenChange(false)
  }

  const toggleItemsExpanded = () => {
    const next = !itemsExpanded
    setItemsExpanded(next)
    if (next && pendingItems === null) {
      void loadPendingItems()
    }
  }

  const pendingIo = operationalStatus?.pendingIoSyncCount ?? operationalStatus?.pendingSyncCount ?? 0
  const pendingL2 = operationalStatus?.pendingL2SyncCount ?? 0
  const pendingChangeRequests = operationalStatus?.pendingChangeRequestCount ?? 0
  const totalPending = operationalStatus?.totalPendingCount ?? (pendingIo + pendingL2 + pendingChangeRequests)
  const lastPush = operationalStatus?.lastPushAt ? new Date(operationalStatus.lastPushAt).toLocaleString() : 'Never'
  const lastPull = operationalStatus?.lastPullAt ? new Date(operationalStatus.lastPullAt).toLocaleString() : 'Never'

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Cloud className="h-5 w-5" />
            Cloud Sync
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <div className="flex items-center justify-between gap-3 rounded-lg border p-3 bg-muted/30">
            <div className="space-y-1">
              <div className="text-sm font-medium">
                Subsystem <Badge variant="outline" className="ml-1">{subsystemId || 'Not set'}</Badge>
              </div>
              <div className="text-xs text-muted-foreground">
                IO sync preserves ordered test events and history. Functional validation sync converges to the latest saved cell value.
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Badge variant={operationalStatus?.connected ? 'default' : 'secondary'}>
                {operationalStatus?.connected ? 'Connected' : operationalStatus?.connectionState || 'Offline'}
              </Badge>
              <Button variant="outline" size="sm" onClick={loadStatus} disabled={statusLoading}>
                {statusLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
              </Button>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div className="rounded-lg border p-3">
              <div className="text-xs uppercase tracking-wide text-muted-foreground">IO Queue</div>
              <div className="mt-1 text-2xl font-bold">{pendingIo}</div>
              <div className="text-xs text-muted-foreground">Ordered test changes waiting for cloud ack</div>
            </div>
            <div className="rounded-lg border p-3">
              <div className="text-xs uppercase tracking-wide text-muted-foreground">Functional Validation Queue</div>
              <div className="mt-1 text-2xl font-bold">{pendingL2}</div>
              <div className="text-xs text-muted-foreground">Latest-value cell updates waiting for retry</div>
            </div>
            <div className="rounded-lg border p-3">
              <div className="text-xs uppercase tracking-wide text-muted-foreground">Change Requests</div>
              <div className="mt-1 text-2xl font-bold">{pendingChangeRequests}</div>
              <div className="text-xs text-muted-foreground">Local requests still awaiting cloud acknowledgement</div>
            </div>
          </div>

          <div className={`rounded-lg border p-3 ${totalPending > 0 ? 'border-amber-300 bg-amber-50 dark:border-amber-800/50 dark:bg-amber-950/30' : 'bg-muted/20'}`}>
            <div className="text-sm font-medium">
              {totalPending > 0 ? 'Safe mode active' : 'Queues are clean'}
            </div>
            <div className="text-xs text-muted-foreground mt-1">
              {totalPending > 0
                ? `Local unsynced data exists (${totalPending} total pending). Cloud pull stays blocked until these rows are acknowledged.`
                : 'No local queues are blocking cloud pull.'}
            </div>
            {operationalStatus?.error && (
              <div className="text-xs text-amber-700 dark:text-amber-300 mt-2">
                {operationalStatus.error}
              </div>
            )}
          </div>

          <div className="rounded-lg border">
            <button
              type="button"
              onClick={toggleItemsExpanded}
              className="w-full flex items-center justify-between gap-2 px-3 py-2 text-sm font-medium hover:bg-muted/30 transition-colors"
            >
              <span className="flex items-center gap-2">
                {itemsExpanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                FV Queue Details
                {pendingL2 > 0 && <Badge variant="secondary" className="ml-1">{pendingL2}</Badge>}
              </span>
              {itemsExpanded && (
                <span
                  role="button"
                  tabIndex={0}
                  onClick={(e) => { e.stopPropagation(); void loadPendingItems() }}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.stopPropagation(); void loadPendingItems() } }}
                  className="inline-flex items-center justify-center h-7 w-7 rounded-md hover:bg-muted cursor-pointer"
                  aria-label="Refresh pending items"
                >
                  {itemsLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
                </span>
              )}
            </button>

            {itemsExpanded && (
              <div className="border-t">
                {itemsError && (
                  <div className="px-3 py-2 text-xs text-destructive">{itemsError}</div>
                )}
                {!itemsError && itemsLoading && pendingItems === null && (
                  <div className="px-3 py-4 text-xs text-muted-foreground flex items-center gap-2">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading queue…
                  </div>
                )}
                {!itemsError && pendingItems !== null && pendingItems.length === 0 && (
                  <div className="px-3 py-4 text-xs text-muted-foreground">FV queue is empty.</div>
                )}
                {!itemsError && pendingItems !== null && pendingItems.length > 0 && (
                  <div className="max-h-72 overflow-auto">
                    <table className="w-full text-xs">
                      <thead className="bg-muted/30 sticky top-0">
                        <tr className="text-left">
                          <th className="px-3 py-2 font-medium">Device · Column</th>
                          <th className="px-3 py-2 font-medium">Local Value</th>
                          <th className="px-3 py-2 font-medium">v (local/base)</th>
                          <th className="px-3 py-2 font-medium">Retries</th>
                          <th className="px-3 py-2 font-medium">Last Error</th>
                        </tr>
                      </thead>
                      <tbody>
                        {pendingItems.map((it) => {
                          const sheet = it.sheetDisplayName || it.sheetName || '—'
                          const device = it.deviceName || `cloudDev#${it.cloudDeviceId}`
                          const col = it.columnName || `cloudCol#${it.cloudColumnId}`
                          const value = it.localValue ?? it.pendingValue
                          const stuck = (it.retryCount ?? 0) >= 3
                          return (
                            <tr key={it.id} className={`border-t ${stuck ? 'bg-amber-50/40 dark:bg-amber-950/20' : ''}`}>
                              <td className="px-3 py-2 align-top">
                                <div className="font-mono font-medium">{device}</div>
                                <div className="text-muted-foreground">{sheet} · {col}</div>
                              </td>
                              <td className="px-3 py-2 align-top max-w-[18rem] break-words">
                                {value === null ? <span className="italic text-muted-foreground">(empty)</span> : <span className="font-mono">{value}</span>}
                                {it.updatedBy && <div className="text-muted-foreground mt-0.5">by {it.updatedBy}</div>}
                              </td>
                              <td className="px-3 py-2 align-top font-mono whitespace-nowrap">
                                {it.localVersion ?? '?'} / {it.baseVersion}
                              </td>
                              <td className="px-3 py-2 align-top">
                                <span className={stuck ? 'font-semibold text-amber-700 dark:text-amber-400' : ''}>
                                  {it.retryCount ?? 0}
                                </span>
                              </td>
                              <td className="px-3 py-2 align-top max-w-[16rem] break-words">
                                {it.lastError ? <span className="text-muted-foreground">{it.lastError}</span> : <span className="text-muted-foreground italic">—</span>}
                              </td>
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
                <div className="px-3 py-2 text-[11px] text-muted-foreground border-t">
                  Rebased rows clear on the next push attempt. Rows highlighted in amber have retried ≥3 times.
                </div>
              </div>
            )}
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
            <div className="rounded-lg border p-3">
              <div className="font-medium">Last Push</div>
              <div className="text-xs text-muted-foreground mt-1">{lastPush}</div>
              <div className="text-xs text-muted-foreground mt-1">{operationalStatus?.lastPushResult || 'No push result recorded yet'}</div>
            </div>
            <div className="rounded-lg border p-3">
              <div className="font-medium">Last Pull</div>
              <div className="text-xs text-muted-foreground mt-1">{lastPull}</div>
              <div className="text-xs text-muted-foreground mt-1">{operationalStatus?.lastPullResult || 'No pull result recorded yet'}</div>
            </div>
          </div>

          <div className="rounded-lg border p-3 bg-muted/20 space-y-1">
            <div className="text-sm font-medium">Storage Contract</div>
            <div className="text-xs text-muted-foreground">Config, database, backups, and logs resolve from the same storage root.</div>
            <div className="text-xs font-mono break-all">{operationalStatus?.configPath || 'Config path unavailable'}</div>
            <div className="text-xs font-mono break-all">{operationalStatus?.databasePath || 'Database path unavailable'}</div>
            <div className="text-xs font-mono break-all">{operationalStatus?.backupsPath || 'Backups path unavailable'}</div>
          </div>

          {syncStatus === 'syncing' && (
            <div className="flex flex-col items-center justify-center py-6 space-y-4">
              <Loader2 className="h-12 w-12 animate-spin text-primary" />
              <div className="text-center space-y-1">
                <p className="font-medium">
                  {syncTarget === 'l2' ? 'Syncing FV queue to cloud...' : 'Syncing IO queue to cloud...'}
                </p>
                <p className="text-xs text-muted-foreground">
                  {syncTarget === 'l2'
                    ? 'Pushing latest cell values for each pending item'
                    : 'Functional validation and change requests continue retrying in the background'}
                </p>
              </div>
            </div>
          )}

          {syncStatus === 'success' && (
            <div className="flex flex-col items-center justify-center py-6 space-y-4">
              <div className="rounded-full bg-green-500/10 p-3">
                <CheckCircle2 className="h-12 w-12 text-green-500" />
              </div>
              <div className="text-center space-y-2">
                <p className="font-semibold text-lg">
                  {syncTarget === 'l2' ? 'FV Queue Synced' : 'IO Queue Synced'}
                </p>
                <p className="text-sm text-muted-foreground">
                  Uploaded <Badge variant="outline" className="mx-1 font-mono">{uploadedCount}</Badge>
                  pending {syncTarget === 'l2' ? 'FV' : 'IO'} {uploadedCount === 1 ? 'change' : 'changes'}
                </p>
              </div>
            </div>
          )}

          {syncStatus === 'error' && (
            <div className="flex flex-col items-center justify-center py-6 space-y-4">
              <div className="rounded-full bg-destructive/10 p-3">
                <XCircle className="h-12 w-12 text-destructive" />
              </div>
              <div className="text-center space-y-2">
                <p className="font-semibold text-lg text-destructive">Sync Failed</p>
                <p className="text-sm text-muted-foreground max-w-xl">
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
                Close
              </Button>
              <Button onClick={() => handleSync('l2')} variant="secondary" className="gap-2" disabled={statusLoading || pendingL2 === 0}>
                <Upload className="h-4 w-4" />
                Sync FV Queue{pendingL2 > 0 ? ` (${pendingL2})` : ''}
              </Button>
              <Button onClick={() => handleSync('io')} className="gap-2" disabled={statusLoading || pendingIo === 0}>
                <Upload className="h-4 w-4" />
                Sync IO Queue{pendingIo > 0 ? ` (${pendingIo})` : ''}
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
