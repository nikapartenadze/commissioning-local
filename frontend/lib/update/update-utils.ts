import fs from 'fs'
import path from 'path'
import { configService } from '@/lib/config'
import { resolveUpdateStatePath } from '@/lib/storage-paths'

export interface ReleaseManifest {
  version: string
  installerUrl: string
  publishedAt?: string
  notes?: string
}

export interface LocalUpdateState {
  status: 'idle' | 'checking' | 'downloading' | 'installing' | 'restarting' | 'success' | 'error'
  message?: string
  version?: string
  startedAt?: string
  completedAt?: string
  installerUrl?: string
}

export function getCurrentAppVersion(): string {
  if (process.env.APP_VERSION && process.env.APP_VERSION.trim()) {
    return process.env.APP_VERSION.trim()
  }

  try {
    const packageJsonPath = path.resolve(process.cwd(), 'package.json')
    const parsed = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')) as { version?: string }
    if (parsed.version) return parsed.version
  } catch {
    // ignore
  }

  return '0.0.0-dev'
}

export function compareVersions(a: string, b: string): number {
  const left = a.replace(/^v/i, '').split('.').map(part => parseInt(part, 10) || 0)
  const right = b.replace(/^v/i, '').split('.').map(part => parseInt(part, 10) || 0)
  const max = Math.max(left.length, right.length)

  for (let i = 0; i < max; i++) {
    const l = left[i] ?? 0
    const r = right[i] ?? 0
    if (l > r) return 1
    if (l < r) return -1
  }

  return 0
}

export async function getUpdateManifestUrl(): Promise<string> {
  if (process.env.UPDATE_MANIFEST_URL && process.env.UPDATE_MANIFEST_URL.trim()) {
    return process.env.UPDATE_MANIFEST_URL.trim()
  }

  const config = await configService.getConfig()
  const configuredUrl = (config as any).updateManifestUrl
  if (typeof configuredUrl === 'string' && configuredUrl.trim()) {
    return configuredUrl.trim()
  }

  return ''
}

export async function fetchReleaseManifest(): Promise<{ manifestUrl: string; manifest: ReleaseManifest | null; error?: string }> {
  const manifestUrl = await getUpdateManifestUrl()
  if (!manifestUrl) {
    return { manifestUrl: '', manifest: null, error: 'Update manifest URL is not configured' }
  }

  try {
    const response = await fetch(manifestUrl, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(10000),
    })

    if (!response.ok) {
      return { manifestUrl, manifest: null, error: `Manifest HTTP ${response.status}` }
    }

    const manifest = await response.json() as ReleaseManifest
    if (!manifest?.version || !manifest?.installerUrl) {
      return { manifestUrl, manifest: null, error: 'Manifest is missing version or installerUrl' }
    }

    return { manifestUrl, manifest }
  } catch (error) {
    return {
      manifestUrl,
      manifest: null,
      error: error instanceof Error ? error.message : 'Failed to fetch update manifest',
    }
  }
}

export function readLocalUpdateState(): LocalUpdateState | null {
  try {
    const statePath = resolveUpdateStatePath()
    if (!fs.existsSync(statePath)) return null
    return JSON.parse(fs.readFileSync(statePath, 'utf8')) as LocalUpdateState
  } catch {
    return null
  }
}

export function resolveUpdateScriptPath(): string | null {
  const candidates = [
    path.resolve(process.cwd(), 'tools', 'install-update.ps1'),
    path.resolve(process.cwd(), 'dist-server', 'tools', 'install-update.ps1'),
  ]

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate
  }

  return null
}
