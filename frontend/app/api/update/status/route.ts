import { Request, Response } from 'express'
import type { AppUpdateStatusResponse } from '@/lib/cloud/types'
import {
  compareVersions,
  fetchReleaseManifest,
  getCurrentAppVersion,
  readLocalUpdateState,
  resolveUpdateScriptPath,
} from '@/lib/update/update-utils'

export async function GET(req: Request, res: Response) {
  try {
    const currentVersion = getCurrentAppVersion()
    const installState = readLocalUpdateState()
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
      installState: readLocalUpdateState(),
      supported: process.platform === 'win32' && !!resolveUpdateScriptPath(),
      error: error instanceof Error ? error.message : 'Failed to load update status',
    } satisfies AppUpdateStatusResponse)
  }
}
