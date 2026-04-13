import { Request, Response } from 'express'
import { spawn } from 'child_process'
import { resolveUpdateStatePath } from '@/lib/storage-paths'
import {
  compareVersions,
  fetchReleaseManifest,
  getCurrentAppVersion,
  readLocalUpdateState,
  resolveUpdateScriptPath,
} from '@/lib/update/update-utils'

export async function POST(req: Request, res: Response) {
  try {
    if (process.platform !== 'win32') {
      return res.status(400).json({ success: false, error: 'Host-managed update is only supported on Windows' })
    }

    const scriptPath = resolveUpdateScriptPath()
    if (!scriptPath) {
      return res.status(500).json({ success: false, error: 'Updater script is not packaged on this host' })
    }

    const currentState = readLocalUpdateState()
    if (currentState && ['checking', 'downloading', 'installing', 'restarting'].includes(currentState.status)) {
      return res.status(409).json({ success: false, error: 'An update is already in progress' })
    }

    const currentVersion = getCurrentAppVersion()
    const { manifest, error } = await fetchReleaseManifest()
    if (!manifest) {
      return res.status(400).json({ success: false, error: error || 'No update manifest available' })
    }

    if (compareVersions(manifest.version, currentVersion) <= 0) {
      return res.json({ success: true, message: 'Already on latest version', currentVersion, latestVersion: manifest.version })
    }

    const child = spawn(
      'powershell.exe',
      [
        '-NoProfile',
        '-ExecutionPolicy', 'Bypass',
        '-File', scriptPath,
        '-InstallerUrl', manifest.installerUrl,
        '-ExpectedVersion', manifest.version,
        '-StatePath', resolveUpdateStatePath(),
      ],
      {
        detached: true,
        stdio: 'ignore',
      }
    )
    child.unref()

    return res.json({
      success: true,
      message: `Update to ${manifest.version} started`,
      currentVersion,
      latestVersion: manifest.version,
    })
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to start update',
    })
  }
}
