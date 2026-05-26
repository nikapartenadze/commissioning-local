import { Request, Response } from 'express'
import type { AppUpdateStatusResponse } from '@/lib/cloud/types'
import {
  compareVersions,
  fetchReleaseManifest,
  getCurrentAppVersion,
  getEffectiveUpdateState,
  resolveUpdateScriptPath,
} from '@/lib/update/update-utils'

export async function GET(req: Request, res: Response) {
  try {
    const currentVersion = getCurrentAppVersion()
    // Effective (not raw) state: a stale non-terminal status reads as `error`
    // so the toolbar pill un-sticks instead of showing "Updating…" forever.
    const installState = getEffectiveUpdateState()
    const { manifestUrl, manifest, error } = await fetchReleaseManifest()
    const latestVersion = manifest?.version
    const updateAvailable = !!latestVersion && compareVersions(latestVersion, currentVersion) > 0

    return res.json({
      currentVersion,
      manifestUrl: manifestUrl || undefined,
      manifestConfigured: !!manifestUrl,
      updateAvailable,
      latestVersion,
      installerUrl: manifest?.installerUrl,
      publishedAt: manifest?.publishedAt,
      notes: manifest?.notes,
      installState,
      supported: process.platform === 'win32' && !!resolveUpdateScriptPath(),
      error,
    } satisfies AppUpdateStatusResponse)
  } catch (error) {
    return res.status(500).json({
      currentVersion: getCurrentAppVersion(),
      manifestConfigured: false,
      updateAvailable: false,
      installState: getEffectiveUpdateState(),
      supported: process.platform === 'win32' && !!resolveUpdateScriptPath(),
      error: error instanceof Error ? error.message : 'Failed to load update status',
    } satisfies AppUpdateStatusResponse)
  }
}
