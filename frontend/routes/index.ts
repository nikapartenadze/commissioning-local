import { Router } from 'express'
import { authMiddleware, adminMiddleware } from './middleware'

// Import route handlers
import * as authLogin from '@/app/api/auth/login/route'
import * as authVerify from '@/app/api/auth/verify/route'
import * as health from '@/app/api/health/route'
import * as configuration from '@/app/api/configuration/route'
import * as configConnect from '@/app/api/configuration/connect/route'
import * as configLogs from '@/app/api/configuration/logs/route'
import * as configRuntime from '@/app/api/configuration/runtime/route'
import * as configSwitch from '@/app/api/configuration/switch-subsystem/route'
import * as users from '@/app/api/users/route'
import * as usersActive from '@/app/api/users/active/route'
import * as userId from '@/app/api/users/[id]/route'
import * as userResetPin from '@/app/api/users/[id]/reset-pin/route'
import * as userToggleActive from '@/app/api/users/[id]/toggle-active/route'
import * as ios from '@/app/api/ios/route'
import * as iosStats from '@/app/api/ios/stats/route'
import * as iosReport from '@/app/api/ios/report/route'
import * as iosPopulateDevices from '@/app/api/ios/populate-devices/route'
import * as iosAssign from '@/app/api/ios/assign/route'
import * as iosAssignByKeyword from '@/app/api/ios/assign/by-keyword/route'
import * as ioById from '@/app/api/ios/[id]/route'
import * as ioTest from '@/app/api/ios/[id]/test/route'
import * as ioReset from '@/app/api/ios/[id]/reset/route'
import * as ioState from '@/app/api/ios/[id]/state/route'
import * as ioFireOutput from '@/app/api/ios/[id]/fire-output/route'
import * as ioPunchlist from '@/app/api/ios/[id]/punchlist/route'
import * as plcConnect from '@/app/api/plc/connect/route'
import * as plcDisconnect from '@/app/api/plc/disconnect/route'
import * as plcStatus from '@/app/api/plc/status/route'
import * as plcTags from '@/app/api/plc/tags/route'
import * as plcToggleTesting from '@/app/api/plc/toggle-testing/route'
import * as plcTestConnection from '@/app/api/plc/test-connection/route'
import * as plcFireOutput from '@/app/api/plc/fire-output/route'
import * as plcMarkPassed from '@/app/api/plc/mark-passed/route'
import * as plcMarkFailed from '@/app/api/plc/mark-failed/route'
import * as cloudPull from '@/app/api/cloud/pull/route'
import * as cloudSync from '@/app/api/cloud/sync/route'
import * as cloudSyncL2 from '@/app/api/cloud/sync-l2/route'
import * as cloudSyncPull from '@/app/api/cloud/sync-pull/route'
import * as cloudStatus from '@/app/api/cloud/status/route'
import * as cloudAutoSync from '@/app/api/cloud/auto-sync/route'
import * as cloudPullNetwork from '@/app/api/cloud/pull-network/route'
import * as cloudPullEstop from '@/app/api/cloud/pull-estop/route'
import * as cloudPullL2 from '@/app/api/cloud/pull-l2/route'
import * as updateStatus from '@/app/api/update/status/route'
import * as updateInstall from '@/app/api/update/install/route'
import * as history from '@/app/api/history/route'
import * as historyByIo from '@/app/api/history/[ioId]/route'
import * as historyExport from '@/app/api/history/export/route'
import * as backups from '@/app/api/backups/route'
import * as backupFile from '@/app/api/backups/[filename]/route'
import * as backupSync from '@/app/api/backups/[filename]/sync/route'
import * as diagnosticsFailureModes from '@/app/api/diagnostics/failure-modes/route'
import * as diagnosticsSteps from '@/app/api/diagnostics/steps/route'
import * as networkTopology from '@/app/api/network/topology/route'
import * as networkStatus from '@/app/api/network/status/route'
import * as networkChainStatus from '@/app/api/network/chain-status/route'
import * as networkDevices from '@/app/api/network/devices/route'
import * as networkModules from '@/app/api/network/modules/route'
import * as networkFiomPorts from '@/app/api/network/fiom-ports/route'
import * as changeRequests from '@/app/api/change-requests/route'
import * as changeRequestById from '@/app/api/change-requests/[id]/route'
import * as estopStatus from '@/app/api/estop/status/route'
import * as safetyZones from '@/app/api/safety/zones/route'
import * as safetyBypass from '@/app/api/safety/bypass/route'
import * as safetyStatus from '@/app/api/safety/status/route'
import * as safetyFire from '@/app/api/safety/fire/route'
import * as safetyOutputs from '@/app/api/safety/outputs/route'
import * as syncHealth from '@/app/api/sync/health/route'
import * as syncUpdate from '@/app/api/sync/update/route'
import * as syncSubsystem from '@/app/api/sync/subsystem/[subsystemId]/route'
import * as l2 from '@/app/api/l2/route'
import * as l2Cell from '@/app/api/l2/cell/route'
import * as l2Overview from '@/app/api/l2/overview/route'
import * as punchlists from '@/app/api/punchlists/route'
import * as projectIos from '@/app/api/project/[id]/ios/route'
import * as projectHistory from '@/app/api/project/[id]/history/route'
import * as vfdWriteTag from '@/app/api/vfd-commissioning/write-tag/route'
import * as vfdWriteTagsBatch from '@/app/api/vfd-commissioning/write-tags-batch/route'
import * as vfdReadTags from '@/app/api/vfd-commissioning/read-tags/route'
import * as vfdWizardOpen from '@/app/api/vfd-commissioning/wizard-open/route'
import * as vfdWizardClose from '@/app/api/vfd-commissioning/wizard-close/route'
import * as vfdState from '@/app/api/vfd-commissioning/state/route'
import * as vfdWriteL2Cells from '@/app/api/vfd-commissioning/write-l2-cells/route'
import * as vfdClear from '@/app/api/vfd-commissioning/clear/route'
import * as vfdTestWrite from '@/app/api/vfd-commissioning/test-write/route'
import * as vfdControlsVerified from '@/app/api/vfd-commissioning/controls-verified/route'
import * as deviceIdentity from '@/app/api/device/identity/route'

/**
 * Wrap an async route handler so unhandled rejections are forwarded to Express error handling.
 */
function asyncHandler(fn: Function) {
  return (req: any, res: any, next: any) => {
    Promise.resolve(fn(req, res, next)).catch(next)
  }
}

export function createApiRouter(): Router {
  const router = Router()

  // ── Auth (no middleware — login is public) ─────────────────────
  router.post('/api/auth/login', asyncHandler(authLogin.POST))
  router.get('/api/auth/verify', asyncHandler(authVerify.GET))

  // ── Health ─────────────────────────────────────────────────────
  router.get('/api/health', asyncHandler(health.GET))

  // ── Configuration (admin for writes, open for reads) ───────────
  router.get('/api/configuration', asyncHandler(configuration.GET))
  router.put('/api/configuration', adminMiddleware, asyncHandler(configuration.PUT))
  router.post('/api/configuration/connect', authMiddleware, asyncHandler(configConnect.POST))
  router.get('/api/configuration/logs', asyncHandler(configLogs.GET))
  router.delete('/api/configuration/logs', asyncHandler(configLogs.DELETE))
  router.get('/api/configuration/runtime', asyncHandler(configRuntime.GET))
  router.post('/api/configuration/switch-subsystem', asyncHandler(configSwitch.POST))

  // ── Users (admin for management, auth for active list) ─────────
  router.get('/api/users', adminMiddleware, asyncHandler(users.GET))
  router.post('/api/users', adminMiddleware, asyncHandler(users.POST))
  router.get('/api/users/active', authMiddleware, asyncHandler(usersActive.GET))
  router.delete('/api/users/:id', adminMiddleware, asyncHandler(userId.DELETE))
  router.put('/api/users/:id/reset-pin', adminMiddleware, asyncHandler(userResetPin.PUT))
  router.put('/api/users/:id/toggle-active', adminMiddleware, asyncHandler(userToggleActive.PUT))

  // ── IOs ────────────────────────────────────────────────────────
  router.get('/api/ios', asyncHandler(ios.GET))
  router.get('/api/ios/stats', asyncHandler(iosStats.GET))
  router.get('/api/ios/report', authMiddleware, asyncHandler(iosReport.GET))
  router.post('/api/ios/populate-devices', asyncHandler(iosPopulateDevices.POST))
  router.put('/api/ios/assign', adminMiddleware, asyncHandler(iosAssign.PUT))
  router.put('/api/ios/assign/by-keyword', adminMiddleware, asyncHandler(iosAssignByKeyword.PUT))
  router.get('/api/ios/:id', asyncHandler(ioById.GET))
  router.put('/api/ios/:id', asyncHandler(ioById.PUT))
  router.post('/api/ios/:id/test', asyncHandler(ioTest.POST))
  router.post('/api/ios/:id/reset', authMiddleware, asyncHandler(ioReset.POST))
  router.get('/api/ios/:id/state', authMiddleware, asyncHandler(ioState.GET))
  router.post('/api/ios/:id/fire-output', authMiddleware, asyncHandler(ioFireOutput.POST))
  router.patch('/api/ios/:id/punchlist', authMiddleware, asyncHandler(ioPunchlist.PATCH))

  // ── PLC ────────────────────────────────────────────────────────
  router.post('/api/plc/connect', asyncHandler(plcConnect.POST))
  router.post('/api/plc/disconnect', asyncHandler(plcDisconnect.POST))
  router.get('/api/plc/status', asyncHandler(plcStatus.GET))
  router.get('/api/plc/tags', asyncHandler(plcTags.GET))
  router.post('/api/plc/toggle-testing', asyncHandler(plcToggleTesting.POST))
  router.get('/api/plc/toggle-testing', asyncHandler(plcToggleTesting.GET))
  router.post('/api/plc/test-connection', asyncHandler(plcTestConnection.POST))
  router.post('/api/plc/fire-output', asyncHandler(plcFireOutput.POST))
  router.post('/api/plc/mark-passed', asyncHandler(plcMarkPassed.POST))
  router.post('/api/plc/mark-failed', asyncHandler(plcMarkFailed.POST))

  // ── Cloud ──────────────────────────────────────────────────────
  router.post('/api/cloud/pull', asyncHandler(cloudPull.POST))
  router.post('/api/cloud/sync', asyncHandler(cloudSync.POST))
  router.get('/api/cloud/sync', asyncHandler(cloudSync.GET))
  router.post('/api/cloud/sync-l2', asyncHandler(cloudSyncL2.POST))
  router.get('/api/cloud/sync-l2', asyncHandler(cloudSyncL2.GET))
  router.get('/api/cloud/sync-pull', asyncHandler(cloudSyncPull.GET))
  router.get('/api/cloud/status', asyncHandler(cloudStatus.GET))
  router.post('/api/cloud/status', asyncHandler(cloudStatus.POST))
  router.post('/api/cloud/auto-sync', asyncHandler(cloudAutoSync.POST))
  router.delete('/api/cloud/auto-sync', asyncHandler(cloudAutoSync.DELETE))
  router.get('/api/cloud/auto-sync', asyncHandler(cloudAutoSync.GET))
  router.post('/api/cloud/pull-network', asyncHandler(cloudPullNetwork.POST))
  router.post('/api/cloud/pull-estop', asyncHandler(cloudPullEstop.POST))
  router.post('/api/cloud/pull-l2', asyncHandler(cloudPullL2.POST))

  // ── App Updates ───────────────────────────────────────────────────────────
  router.get('/api/update/status', asyncHandler(updateStatus.GET))
  router.post('/api/update/install', asyncHandler(updateInstall.POST))

  // ── History ────────────────────────────────────────────────────
  router.get('/api/history', asyncHandler(history.GET))
  router.get('/api/history/export', asyncHandler(historyExport.GET))
  router.get('/api/history/:ioId', asyncHandler(historyByIo.GET))

  // ── Backups ────────────────────────────────────────────────────
  router.get('/api/backups', asyncHandler(backups.GET))
  router.post('/api/backups', asyncHandler(backups.POST))
  router.get('/api/backups/:filename', asyncHandler(backupFile.GET))
  router.delete('/api/backups/:filename', asyncHandler(backupFile.DELETE))
  router.post('/api/backups/:filename/sync', asyncHandler(backupSync.POST))

  // ── Diagnostics ────────────────────────────────────────────────
  router.get('/api/diagnostics/failure-modes', asyncHandler(diagnosticsFailureModes.GET))
  router.get('/api/diagnostics/steps', asyncHandler(diagnosticsSteps.GET))

  // ── Network ────────────────────────────────────────────────────
  router.get('/api/network/topology', asyncHandler(networkTopology.GET))
  router.get('/api/network/status', asyncHandler(networkStatus.GET))
  router.get('/api/network/chain-status', asyncHandler(networkChainStatus.GET))
  router.get('/api/network/devices', asyncHandler(networkDevices.GET))
  router.get('/api/network/modules', asyncHandler(networkModules.GET))
  router.get('/api/network/fiom-ports', asyncHandler(networkFiomPorts.GET))

  // ── Change Requests ────────────────────────────────────────────
  router.get('/api/change-requests', asyncHandler(changeRequests.GET))
  router.post('/api/change-requests', asyncHandler(changeRequests.POST))
  router.put('/api/change-requests/:id', asyncHandler(changeRequestById.PUT))
  router.delete('/api/change-requests/:id', asyncHandler(changeRequestById.DELETE))

  // ── EStop ──────────────────────────────────────────────────────
  router.get('/api/estop/status', asyncHandler(estopStatus.GET))

  // ── Safety ─────────────────────────────────────────────────────
  router.get('/api/safety/zones', asyncHandler(safetyZones.GET))
  router.post('/api/safety/bypass', authMiddleware, asyncHandler(safetyBypass.POST))
  router.get('/api/safety/bypass', asyncHandler(safetyBypass.GET))
  router.get('/api/safety/status', asyncHandler(safetyStatus.GET))
  router.post('/api/safety/fire', authMiddleware, asyncHandler(safetyFire.POST))
  router.get('/api/safety/outputs', asyncHandler(safetyOutputs.GET))

  // ── Sync (cloud-facing endpoints) ─────────────────────────────
  router.get('/api/sync/health', asyncHandler(syncHealth.GET))
  router.post('/api/sync/update', asyncHandler(syncUpdate.POST))
  router.get('/api/sync/subsystem/:subsystemId', asyncHandler(syncSubsystem.GET))

  // ── L2 Functional Validation ───────────────────────────────────
  router.get('/api/l2', asyncHandler(l2.GET))
  router.get('/api/l2/overview', asyncHandler(l2Overview.GET))
  router.post('/api/l2/cell', asyncHandler(l2Cell.POST))

  // ── Punchlists ─────────────────────────────────────────────────
  router.get('/api/punchlists', asyncHandler(punchlists.GET))

  // ── Project ────────────────────────────────────────────────────
  router.get('/api/project/:id/ios', asyncHandler(projectIos.GET))
  router.get('/api/project/:id/history', asyncHandler(projectHistory.GET))

  // ── VFD Commissioning ─────────────────────────────────────────
  router.post('/api/vfd-commissioning/write-tag', asyncHandler(vfdWriteTag.POST))
  router.post('/api/vfd-commissioning/write-tags-batch', asyncHandler(vfdWriteTagsBatch.POST))
  router.post('/api/vfd-commissioning/read-tags', asyncHandler(vfdReadTags.POST))
  router.post('/api/vfd-commissioning/wizard-open', asyncHandler(vfdWizardOpen.POST))
  router.post('/api/vfd-commissioning/wizard-close', asyncHandler(vfdWizardClose.POST))
  router.post('/api/vfd-commissioning/write-l2-cells', asyncHandler(vfdWriteL2Cells.POST))
  router.get('/api/vfd-commissioning/state', asyncHandler(vfdState.GET))
  router.post('/api/vfd-commissioning/state', asyncHandler(vfdState.POST))
  router.post('/api/vfd-commissioning/clear', asyncHandler(vfdClear.POST))
  router.post('/api/vfd-commissioning/test-write', asyncHandler(vfdTestWrite.POST))
  router.get('/api/vfd-commissioning/test-write', asyncHandler(vfdTestWrite.GET))
  router.post('/api/vfd-commissioning/controls-verified', asyncHandler(vfdControlsVerified.POST))

  // ── Device Identity ───────────────────────────────────────────
  router.get('/api/device/identity', asyncHandler(deviceIdentity.GET))

  // ── Global Error Handler ──────────────────────────────────────
  // Catches all errors from asyncHandler() and prevents them from
  // becoming unhandled rejections that crash the process.
  router.use((err: any, req: any, res: any, _next: any) => {
    const status = err.status || err.statusCode || 500
    const message = err.message || 'Internal Server Error'
    const route = `${req.method} ${req.originalUrl || req.url}`

    // Log all server errors with full context
    if (status >= 500) {
      console.error(`[API] ${route} → ${status} ERROR: ${message}${err.stack ? '\n' + err.stack : ''}`)
    } else {
      console.warn(`[API] ${route} → ${status}: ${message}`)
    }

    // Don't leak internal error details in production
    if (!res.headersSent) {
      res.status(status).json({
        error: process.env.NODE_ENV === 'development' ? message : 'Internal Server Error',
      })
    }
  })

  return router
}
