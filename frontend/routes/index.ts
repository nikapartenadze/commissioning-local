import { Router } from 'express'
import { authMiddleware, adminMiddleware } from './middleware'

// Import route handlers
import * as authLogin from '@/app/api/auth/login/route'
import * as authVerify from '@/app/api/auth/verify/route'
import * as authMode from '@/app/api/auth/mode/route'
import * as authChangePin from '@/app/api/auth/change-pin/route'
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
import * as ioAddressed from '@/app/api/ios/[id]/addressed/route'
import * as ioState from '@/app/api/ios/[id]/state/route'
import * as ioFireOutput from '@/app/api/ios/[id]/fire-output/route'
import * as ioPunchlist from '@/app/api/ios/[id]/punchlist/route'
import * as ioDependencies from '@/app/api/ios/[id]/dependencies/route'
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
import * as cloudSyncL2Items from '@/app/api/cloud/sync-l2/items/route'
import * as cloudSyncPull from '@/app/api/cloud/sync-pull/route'
import * as cloudStatus from '@/app/api/cloud/status/route'
import * as cloudAutoSync from '@/app/api/cloud/auto-sync/route'
import * as cloudPullNetwork from '@/app/api/cloud/pull-network/route'
import * as cloudPullEstop from '@/app/api/cloud/pull-estop/route'
import * as cloudStuck from '@/app/api/cloud/stuck/route'
import * as cloudPushForce from '@/app/api/cloud/push-force/route'
import * as cloudUnpark from '@/app/api/cloud/unpark/route'
import * as cloudPullL2 from '@/app/api/cloud/pull-l2/route'
import * as cloudPullMcmDiagram from '@/app/api/cloud/pull-mcm-diagram/route'
import * as cloudPullRoadmap from '@/app/api/cloud/pull-roadmap/route'
import * as cloudReconcile from '@/app/api/cloud/reconcile/route'
import * as guidedResetSubsystem from '@/app/api/guided/reset-subsystem/route'
import * as mcmDiagram from '@/app/api/mcm-diagram/[mcm]/route'
// ── central-tool: multi-MCM namespace ───────────────────────────
import * as mcmList from '@/app/api/mcm/route'
import * as mcmImportFromCloud from '@/app/api/mcm/import-from-cloud/route'
import * as mcmCloudConfig from '@/app/api/mcm/cloud-config/route'
import * as mcmPullAll from '@/app/api/mcm/pull-all/route'
import * as logsTail from '@/app/api/logs/tail/route'
import * as mcmConnectAll from '@/app/api/mcm/connect-all/route'
import * as mcmDisconnectAll from '@/app/api/mcm/disconnect-all/route'
import * as mcmEntry from '@/app/api/mcm/[subsystemId]/route'
import * as mcmPlcStatus from '@/app/api/mcm/[subsystemId]/plc/status/route'
import * as mcmPlcConnect from '@/app/api/mcm/[subsystemId]/plc/connect/route'
import * as mcmPlcDisconnect from '@/app/api/mcm/[subsystemId]/plc/disconnect/route'
import * as mcmPlcTags from '@/app/api/mcm/[subsystemId]/plc/tags/route'
import * as mcmPull from '@/app/api/mcm/[subsystemId]/pull/route'
import * as updateStatus from '@/app/api/update/status/route'
import * as updateInstall from '@/app/api/update/install/route'
import * as history from '@/app/api/history/route'
import * as historyByIo from '@/app/api/history/[ioId]/route'
import * as historyExport from '@/app/api/history/export/route'
import * as backups from '@/app/api/backups/route'
import * as backupFile from '@/app/api/backups/[filename]/route'
import * as diagnosticsFailureModes from '@/app/api/diagnostics/failure-modes/route'
import * as diagnosticsSteps from '@/app/api/diagnostics/steps/route'
import * as networkTopology from '@/app/api/network/topology/route'
import * as networkStatus from '@/app/api/network/status/route'
import * as networkChainStatus from '@/app/api/network/chain-status/route'
import * as networkDevices from '@/app/api/network/devices/route'
import * as networkModules from '@/app/api/network/modules/route'
import * as networkFiomPorts from '@/app/api/network/fiom-ports/route'
import * as ringCapture from '@/app/api/network/ring/capture/route'
import * as ringBaseline from '@/app/api/network/ring/baseline/route'
import * as ringCheck from '@/app/api/network/ring/check/route'
import * as changeRequests from '@/app/api/change-requests/route'
import * as changeRequestById from '@/app/api/change-requests/[id]/route'
import * as estopStatus from '@/app/api/estop/status/route'
import * as estopCheck from '@/app/api/estop/check/route'
import * as firmware from '@/app/api/firmware/route'
import * as firmwareScan from '@/app/api/firmware/scan/route'
import * as firmwareBaseline from '@/app/api/firmware/baseline/route'
import * as firmwareController from '@/app/api/firmware/controller/route'
import * as safetyZones from '@/app/api/safety/zones/route'
import * as safetyBypass from '@/app/api/safety/bypass/route'
import * as safetyStatus from '@/app/api/safety/status/route'
import * as safetyFire from '@/app/api/safety/fire/route'
import * as safetyOutputs from '@/app/api/safety/outputs/route'
import * as syncHealth from '@/app/api/sync/health/route'
import * as syncSubsystem from '@/app/api/sync/subsystem/[subsystemId]/route'
import * as syncQueue from '@/app/api/sync/queue/route'
import * as syncQueueActions from '@/app/api/sync/queue/actions/route'
import * as syncDiff from '@/app/api/sync/diff/route'
import * as syncDiffActions from '@/app/api/sync/diff/actions/route'
import * as l2 from '@/app/api/l2/route'
import * as l2Cell from '@/app/api/l2/cell/route'
import * as l2OutboxEvicted from '@/app/api/l2/outbox-evicted/route'
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
import * as vfdBumpBlocker from '@/app/api/vfd-commissioning/bump-blocker/route'
import * as vfdRefreshAddressed from '@/app/api/vfd-commissioning/refresh-addressed/route'
import * as guidedMapById from '@/app/api/maps/subsystem/[id]/route'
import * as guidedDevices from '@/app/api/guided/devices/route'
import * as guidedTest from '@/app/api/guided/test/route'
import * as guidedClear from '@/app/api/guided/clear/route'
import * as guidedDeviceByName from '@/app/api/guided/devices/[name]/route'
import * as guidedTasks from '@/app/api/guided/tasks/route'
import * as guidedTasksSteps from '@/app/api/guided/tasks/steps/route'
import * as guidedTasksSkip from '@/app/api/guided/tasks/skip/route'
import * as guidedTasksComplete from '@/app/api/guided/tasks/complete/route'
import * as guidedTasksClaim from '@/app/api/guided/tasks/claim/route'
import * as guidedSystemStatus from '@/app/api/guided/system-status/route'
import * as roadmap from '@/app/api/roadmap/route'
import * as subsystemsList from '@/app/api/subsystems/list/route'
// Controller management (Logix Designer SDK: program download / mode control)
import * as ctrlMgmtHealth from '@/app/api/controller-management/health/route'
import * as ctrlMgmtProjects from '@/app/api/controller-management/projects/route'
import * as ctrlMgmtCommPath from '@/app/api/controller-management/comm-path/route'
import * as ctrlMgmtStatus from '@/app/api/controller-management/status/route'
import * as ctrlMgmtMode from '@/app/api/controller-management/mode/route'
import * as ctrlMgmtDownload from '@/app/api/controller-management/download/route'
import * as ctrlMgmtUploadBatch from '@/app/api/controller-management/upload-batch/route'
import * as ctrlMgmtJob from '@/app/api/controller-management/job/route'
import * as sharepointStatus from '@/app/api/sharepoint/status/route'
import * as sharepointTest from '@/app/api/sharepoint/test/route'

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

  // ── Auth (no middleware — login + mode probe are public) ───────
  router.post('/api/auth/login', asyncHandler(authLogin.POST))
  router.get('/api/auth/verify', asyncHandler(authVerify.GET))
  // Open mode probe: client fetches this on boot to decide whether to show login.
  router.get('/api/auth/mode', asyncHandler(authMode.GET))
  // Self-service PIN change (first-run must-change + routine). Requires a valid token.
  router.post('/api/auth/change-pin', authMiddleware, asyncHandler(authChangePin.POST))

  // ── Health ─────────────────────────────────────────────────────
  router.get('/api/health', asyncHandler(health.GET))

  // ── Controller management (program download / mode via Logix SDK) ─
  // reads require a logged-in user; controller writes require admin and are
  // blocked on the server laptop. (Anon-admin in open mode, enforced once
  // AUTH_REQUIRED is on — same model as the MCM/config write routes.)
  router.get('/api/controller-management/health', asyncHandler(ctrlMgmtHealth.GET))
  router.get('/api/controller-management/projects', authMiddleware, asyncHandler(ctrlMgmtProjects.GET))
  router.post('/api/controller-management/comm-path', authMiddleware, asyncHandler(ctrlMgmtCommPath.POST))
  router.post('/api/controller-management/status', authMiddleware, asyncHandler(ctrlMgmtStatus.POST))
  router.post('/api/controller-management/mode', adminMiddleware, asyncHandler(ctrlMgmtMode.POST))
  router.post('/api/controller-management/download', adminMiddleware, asyncHandler(ctrlMgmtDownload.POST))
  router.post('/api/controller-management/upload-batch', adminMiddleware, asyncHandler(ctrlMgmtUploadBatch.POST))
  router.get('/api/controller-management/job', authMiddleware, asyncHandler(ctrlMgmtJob.GET))
  router.get('/api/sharepoint/status', authMiddleware, asyncHandler(sharepointStatus.GET))
  router.post('/api/sharepoint/test', authMiddleware, asyncHandler(sharepointTest.POST))

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
  // Workflow transition (no PLC required): mark a Failed IO as Addressed / ready to re-check.
  router.post('/api/ios/:id/addressed', authMiddleware, asyncHandler(ioAddressed.POST))
  router.get('/api/ios/:id/state', authMiddleware, asyncHandler(ioState.GET))
  router.post('/api/ios/:id/fire-output', authMiddleware, asyncHandler(ioFireOutput.POST))
  router.patch('/api/ios/:id/punchlist', authMiddleware, asyncHandler(ioPunchlist.PATCH))
  router.patch('/api/ios/:id/dependencies', authMiddleware, asyncHandler(ioDependencies.PATCH))

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
  router.post('/api/cloud/reconcile', asyncHandler(cloudReconcile.POST))
  router.post('/api/cloud/sync', asyncHandler(cloudSync.POST))
  router.get('/api/cloud/sync', asyncHandler(cloudSync.GET))
  router.post('/api/cloud/sync-l2', asyncHandler(cloudSyncL2.POST))
  router.get('/api/cloud/sync-l2', asyncHandler(cloudSyncL2.GET))
  router.get('/api/cloud/sync-l2/items', asyncHandler(cloudSyncL2Items.GET))
  router.delete('/api/cloud/sync-l2/items', asyncHandler(cloudSyncL2Items.DELETE))
  router.get('/api/cloud/sync-pull', asyncHandler(cloudSyncPull.GET))
  router.get('/api/cloud/status', asyncHandler(cloudStatus.GET))
  router.post('/api/cloud/status', asyncHandler(cloudStatus.POST))
  router.post('/api/cloud/auto-sync', asyncHandler(cloudAutoSync.POST))
  router.delete('/api/cloud/auto-sync', asyncHandler(cloudAutoSync.DELETE))
  router.get('/api/cloud/auto-sync', asyncHandler(cloudAutoSync.GET))
  router.post('/api/cloud/pull-network', asyncHandler(cloudPullNetwork.POST))
  router.post('/api/cloud/pull-estop', asyncHandler(cloudPullEstop.POST))
  router.get('/api/cloud/stuck', asyncHandler(cloudStuck.GET))
  router.post('/api/cloud/push-force', asyncHandler(cloudPushForce.POST))
  router.post('/api/cloud/unpark', asyncHandler(cloudUnpark.POST))
  router.post('/api/cloud/pull-l2', asyncHandler(cloudPullL2.POST))
  router.post('/api/cloud/pull-mcm-diagram', asyncHandler(cloudPullMcmDiagram.POST))
  router.post('/api/cloud/pull-roadmap', asyncHandler(cloudPullRoadmap.POST))
  router.get('/api/mcm-diagram/:mcm', asyncHandler(mcmDiagram.GET))

  // ── MCM Registry (central-tool multi-MCM) ─────────────────────
  router.get('/api/logs/tail', asyncHandler(logsTail.GET))
  // Reads + connect/test/pull are open to any logged-in user; configuration
  // writes (add/edit/remove MCM, cloud config, bulk import/pull) are admin-only.
  // NOTE: when AUTH_REQUIRED is off, adminMiddleware passes everyone (anon-admin),
  // so this gating is a no-op for the single-laptop / dev case.
  router.get('/api/mcm', asyncHandler(mcmList.GET))
  router.post('/api/mcm', adminMiddleware, asyncHandler(mcmList.POST))
  // Must precede the ':subsystemId' routes so the literal path isn't shadowed.
  router.post('/api/mcm/import-from-cloud', adminMiddleware, asyncHandler(mcmImportFromCloud.POST))
  router.get('/api/mcm/cloud-config', asyncHandler(mcmCloudConfig.GET))
  router.post('/api/mcm/cloud-config', adminMiddleware, asyncHandler(mcmCloudConfig.POST))
  router.post('/api/mcm/pull-all', adminMiddleware, asyncHandler(mcmPullAll.POST))
  router.post('/api/mcm/connect-all', asyncHandler(mcmConnectAll.POST))
  router.post('/api/mcm/disconnect-all', asyncHandler(mcmDisconnectAll.POST))
  router.get('/api/mcm/:subsystemId', asyncHandler(mcmEntry.GET))
  router.put('/api/mcm/:subsystemId', adminMiddleware, asyncHandler(mcmEntry.PUT))
  router.delete('/api/mcm/:subsystemId', adminMiddleware, asyncHandler(mcmEntry.DELETE))
  router.get('/api/mcm/:subsystemId/plc/status', asyncHandler(mcmPlcStatus.GET))
  router.post('/api/mcm/:subsystemId/plc/connect', asyncHandler(mcmPlcConnect.POST))
  router.post('/api/mcm/:subsystemId/plc/disconnect', asyncHandler(mcmPlcDisconnect.POST))
  router.get('/api/mcm/:subsystemId/plc/tags', asyncHandler(mcmPlcTags.GET))
  router.post('/api/mcm/:subsystemId/pull', asyncHandler(mcmPull.POST))

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
  // /api/backups/:filename/sync REMOVED (2026-07-08 forensics audit): dead code —
  // it queried table names that don't exist in the runtime schema (PendingSync /
  // TestHistory / Io instead of PendingSyncs / TestHistories / Ios), so it could
  // never have worked; nothing in the UI called it.

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
  // Ring Commissioning — on-demand, isolated, fail-safe (see specs/2026-07-08-*)
  router.post('/api/network/ring/capture', asyncHandler(ringCapture.POST))
  router.get('/api/network/ring/baseline', asyncHandler(ringBaseline.GET))
  router.post('/api/network/ring/baseline', asyncHandler(ringBaseline.POST))
  router.post('/api/network/ring/check', asyncHandler(ringCheck.POST))

  // ── Change Requests ────────────────────────────────────────────
  router.get('/api/change-requests', asyncHandler(changeRequests.GET))
  router.post('/api/change-requests', asyncHandler(changeRequests.POST))
  router.put('/api/change-requests/:id', asyncHandler(changeRequestById.PUT))
  router.delete('/api/change-requests/:id', asyncHandler(changeRequestById.DELETE))

  // ── EStop ──────────────────────────────────────────────────────
  router.get('/api/estop/status', asyncHandler(estopStatus.GET))
  router.post('/api/estop/check', asyncHandler(estopCheck.POST))

  // ── Firmware compliance ────────────────────────────────────────
  router.get('/api/firmware', asyncHandler(firmware.GET))
  router.get('/api/firmware/baseline', asyncHandler(firmwareBaseline.GET))
  router.get('/api/firmware/controller', asyncHandler(firmwareController.GET))
  router.post('/api/firmware/scan', asyncHandler(firmwareScan.POST))

  // ── Safety ─────────────────────────────────────────────────────
  router.get('/api/safety/zones', asyncHandler(safetyZones.GET))
  router.post('/api/safety/bypass', authMiddleware, asyncHandler(safetyBypass.POST))
  router.get('/api/safety/bypass', asyncHandler(safetyBypass.GET))
  router.get('/api/safety/status', asyncHandler(safetyStatus.GET))
  router.post('/api/safety/fire', authMiddleware, asyncHandler(safetyFire.POST))
  router.get('/api/safety/outputs', asyncHandler(safetyOutputs.GET))

  // ── Sync (cloud-facing endpoints) ─────────────────────────────
  router.get('/api/sync/health', asyncHandler(syncHealth.GET))
  // /api/sync/update REMOVED (2026-07-08 forensics audit): dead legacy route —
  // nothing called it, and it let anyone on the LAN rewrite Ios.Result with no
  // version bump, no TestHistories row, and no recovery-journal entry.
  router.get('/api/sync/subsystem/:subsystemId', asyncHandler(syncSubsystem.GET))
  // ── Sync Center (in-app queue triage: see/retry/discard stuck outbound rows) ─
  router.get('/api/sync/queue', asyncHandler(syncQueue.GET))
  router.post('/api/sync/queue/actions', asyncHandler(syncQueueActions.POST))
  router.get('/api/sync/diff', asyncHandler(syncDiff.GET))
  router.post('/api/sync/diff/actions', asyncHandler(syncDiffActions.POST))

  // ── L2 Functional Validation ───────────────────────────────────
  router.get('/api/l2', asyncHandler(l2.GET))
  router.get('/api/l2/overview', asyncHandler(l2Overview.GET))
  router.post('/api/l2/cell', asyncHandler(l2Cell.POST))
  router.post('/api/l2/outbox-evicted', asyncHandler(l2OutboxEvicted.POST))

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
  router.post('/api/vfd-commissioning/bump-blocker', asyncHandler(vfdBumpBlocker.POST))
  router.post('/api/vfd-commissioning/refresh-addressed', asyncHandler(vfdRefreshAddressed.POST))

  // ── Guided Mode (SVG-driven) ──────────────────────────────────
  router.get('/api/maps/subsystem/:id', asyncHandler(guidedMapById.GET))
  router.get('/api/guided/devices', asyncHandler(guidedDevices.GET))
  router.get('/api/guided/devices/:name', asyncHandler(guidedDeviceByName.GET))
  router.post('/api/guided/reset-subsystem', asyncHandler(guidedResetSubsystem.POST))
  router.post('/api/guided/test', asyncHandler(guidedTest.POST))
  router.post('/api/guided/clear', asyncHandler(guidedClear.POST))
  // Guided-Mode Task Pool (Phase→Segment→Task→Step priority engine)
  router.get('/api/guided/tasks', asyncHandler(guidedTasks.GET))
  router.get('/api/guided/tasks/steps', asyncHandler(guidedTasksSteps.GET))
  router.post('/api/guided/tasks/skip', asyncHandler(guidedTasksSkip.POST))
  router.post('/api/guided/tasks/complete', asyncHandler(guidedTasksComplete.POST))
  // Ephemeral multi-user task claims (same-MCM coordination, TTL'd in-memory)
  router.post('/api/guided/tasks/claim', asyncHandler(guidedTasksClaim.POST))
  // Live ring-health + system-running poll (committee D4/D5 gates)
  router.get('/api/guided/system-status', asyncHandler(guidedSystemStatus.GET))
  router.get('/api/roadmap', asyncHandler(roadmap.GET))

  // ── Subsystems list (MCM picker) ──────────────────────────────
  router.get('/api/subsystems/list', asyncHandler(subsystemsList.GET))

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
