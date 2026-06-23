/**
 * SharePoint upload via Microsoft Graph (app-only client-credentials).
 *
 * App registration (Entra) with the `Sites.ReadWrite.All` (or selected-sites)
 * application permission + admin consent is required. This module never logs
 * or returns the client secret in an error string.
 *
 * Node 20: global `fetch` is available. We use `fs`/`Buffer` for file chunks.
 */
import { promises as fs } from 'fs'
import path from 'path'
import type { SharePointConfig } from '@/lib/config/types'

const GRAPH = 'https://graph.microsoft.com/v1.0'
const SIMPLE_UPLOAD_LIMIT = 4 * 1024 * 1024 // < 4 MB → single PUT
const CHUNK_SIZE = 5 * 1024 * 1024 // ~5 MB chunks for the upload session

export interface UploadResult {
  ok: boolean
  webUrl?: string
  error?: string
}

export interface TestResult {
  ok: boolean
  site?: string
  webUrl?: string
  error?: string
}

interface ResolvedSite {
  siteId: string
  webUrl: string
  displayName: string
}

// ── token cache (per tenantId+clientId) ────────────────────────────────────
interface CachedToken {
  token: string
  expiresAt: number // epoch ms
}
const tokenCache = new Map<string, CachedToken>()
const siteCache = new Map<string, ResolvedSite>()

function requireFields(cfg: SharePointConfig): { tenantId: string; clientId: string; clientSecret: string; siteUrl: string } {
  if (!cfg.tenantId || !cfg.clientId || !cfg.clientSecret || !cfg.siteUrl) {
    throw new Error('SharePoint is not fully configured (tenantId, clientId, clientSecret, siteUrl required)')
  }
  return { tenantId: cfg.tenantId, clientId: cfg.clientId, clientSecret: cfg.clientSecret, siteUrl: cfg.siteUrl }
}

/**
 * Acquire (and cache) an app-only access token. Cached until 60s before the
 * reported expiry. The secret is sent only in the form body, never logged.
 */
export async function getToken(cfg: SharePointConfig): Promise<string> {
  const { tenantId, clientId, clientSecret } = requireFields(cfg)
  const key = `${tenantId}:${clientId}`
  const cached = tokenCache.get(key)
  if (cached && cached.expiresAt > Date.now()) return cached.token

  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    scope: 'https://graph.microsoft.com/.default',
    grant_type: 'client_credentials',
  })

  const resp = await fetch(`https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  })

  if (!resp.ok) {
    // Surface the AAD error description (it never contains the secret) but
    // strip anything that could echo a credential back.
    let detail = ''
    try {
      const j = (await resp.json()) as { error?: string; error_description?: string }
      detail = j.error_description || j.error || ''
    } catch { /* non-JSON */ }
    throw new Error(`token request failed (HTTP ${resp.status})${detail ? `: ${sanitize(detail)}` : ''}`)
  }

  const json = (await resp.json()) as { access_token?: string; expires_in?: number }
  if (!json.access_token) throw new Error('token request returned no access_token')
  const ttlMs = Math.max(0, (json.expires_in ?? 3600) - 60) * 1000
  tokenCache.set(key, { token: json.access_token, expiresAt: Date.now() + ttlMs })
  return json.access_token
}

/** Remove any accidental occurrence of secret-like query params from a message. */
function sanitize(msg: string): string {
  return msg.replace(/client_secret=[^&\s]+/gi, 'client_secret=***')
}

/**
 * Resolve the SharePoint site id from a site URL. Cached per siteUrl.
 * siteUrl shape: https://{host}/sites/{path...}
 */
export async function resolveSite(cfg: SharePointConfig, token: string): Promise<ResolvedSite> {
  const { siteUrl } = requireFields(cfg)
  const cached = siteCache.get(siteUrl)
  if (cached) return cached

  let url: URL
  try {
    url = new URL(siteUrl)
  } catch {
    throw new Error('siteUrl is not a valid URL')
  }
  const host = url.host
  // Strip leading/trailing slashes; the server-relative path after the host.
  const relPath = url.pathname.replace(/^\/+|\/+$/g, '')
  // Graph site address: /sites/{host}:/{server-relative-path}
  const graphUrl = relPath
    ? `${GRAPH}/sites/${encodeURIComponent(host)}:/${relPath.split('/').map(encodeURIComponent).join('/')}`
    : `${GRAPH}/sites/${encodeURIComponent(host)}`

  const resp = await fetch(graphUrl, { headers: { Authorization: `Bearer ${token}` } })
  if (!resp.ok) {
    throw new Error(`resolve site failed (HTTP ${resp.status})${await graphErr(resp)}`)
  }
  const body = (await resp.json()) as { id?: string; webUrl?: string; displayName?: string }
  if (!body.id) throw new Error('resolve site returned no id')
  const resolved: ResolvedSite = {
    siteId: body.id,
    webUrl: body.webUrl || siteUrl,
    displayName: body.displayName || host,
  }
  siteCache.set(siteUrl, resolved)
  return resolved
}

/** Pull a Graph error message out of a failed response without leaking secrets. */
async function graphErr(resp: Response): Promise<string> {
  try {
    const j = (await resp.json()) as { error?: { message?: string; code?: string } }
    const m = j.error?.message || j.error?.code
    return m ? `: ${sanitize(m)}` : ''
  } catch {
    return ''
  }
}

/** Build the encoded `root:/path:` target segment, preserving slashes. */
function buildTarget(folderPath: string | undefined, remoteName: string): string {
  const strip = (s: string) => s.replace(/^\/+|\/+$/g, '')
  const folder = folderPath ? strip(folderPath) : ''
  const name = strip(remoteName)
  const full = folder ? `${folder}/${name}` : name
  return full.split('/').filter(Boolean).map(encodeURIComponent).join('/')
}

/**
 * Upload a local file to the site's default document library.
 * < 4 MB → single PUT; >= 4 MB → resumable upload session in ~5 MB chunks.
 * A failure returns { ok:false, error } rather than throwing.
 */
export async function uploadFile(cfg: SharePointConfig, localPath: string, remoteName: string): Promise<UploadResult> {
  try {
    requireFields(cfg)
    const token = await getToken(cfg)
    const site = await resolveSite(cfg, token)
    const target = buildTarget(cfg.folderPath, remoteName || path.basename(localPath))

    const stat = await fs.stat(localPath)
    if (stat.size < SIMPLE_UPLOAD_LIMIT) {
      return await simpleUpload(site.siteId, target, localPath, token)
    }
    return await sessionUpload(cfg, site.siteId, target, localPath, token, stat.size)
  } catch (e) {
    return { ok: false, error: cleanError(e) }
  }
}

async function simpleUpload(siteId: string, target: string, localPath: string, token: string): Promise<UploadResult> {
  const bytes = await fs.readFile(localPath)
  const url = `${GRAPH}/sites/${encodeURIComponent(siteId)}/drive/root:/${target}:/content`
  const resp = await fetch(url, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/octet-stream' },
    // Pass a plain ArrayBuffer slice — a portable BodyInit across the Node
    // fetch typings (a Node Buffer / typed-array view trips the lib types).
    body: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
  })
  if (!resp.ok) return { ok: false, error: `upload failed (HTTP ${resp.status})${await graphErr(resp)}` }
  const item = (await resp.json()) as { webUrl?: string }
  return { ok: true, webUrl: item.webUrl }
}

async function sessionUpload(
  cfg: SharePointConfig,
  siteId: string,
  target: string,
  localPath: string,
  token: string,
  total: number,
): Promise<UploadResult> {
  const createUrl = `${GRAPH}/sites/${encodeURIComponent(siteId)}/drive/root:/${target}:/createUploadSession`
  const createResp = await fetch(createUrl, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ item: { '@microsoft.graph.conflictBehavior': 'rename' } }),
  })
  if (!createResp.ok) return { ok: false, error: `create upload session failed (HTTP ${createResp.status})${await graphErr(createResp)}` }
  const session = (await createResp.json()) as { uploadUrl?: string }
  if (!session.uploadUrl) return { ok: false, error: 'create upload session returned no uploadUrl' }

  const fh = await fs.open(localPath, 'r')
  try {
    let start = 0
    let lastItem: { webUrl?: string } | null = null
    while (start < total) {
      const end = Math.min(start + CHUNK_SIZE, total) - 1
      const len = end - start + 1
      const chunk = Buffer.alloc(len)
      await fh.read(chunk, 0, len, start)
      // NO Authorization header on the session URL — the uploadUrl is pre-authed.
      const resp = await fetch(session.uploadUrl, {
        method: 'PUT',
        headers: {
          'Content-Length': String(len),
          'Content-Range': `bytes ${start}-${end}/${total}`,
        },
        body: chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength) as ArrayBuffer,
      })
      if (resp.status === 200 || resp.status === 201) {
        lastItem = (await resp.json()) as { webUrl?: string }
      } else if (resp.status === 202) {
        // Accepted — more chunks expected; ignore the body.
      } else {
        return { ok: false, error: `chunk upload failed (HTTP ${resp.status})${await graphErr(resp)}` }
      }
      start = end + 1
    }
    return { ok: true, webUrl: lastItem?.webUrl }
  } finally {
    await fh.close().catch(() => { /* ignore */ })
  }
}

/**
 * Validate config by acquiring a token + resolving the site (no upload).
 * Lets the user confirm the app registration + permissions once they land.
 */
export async function testConnection(cfg: SharePointConfig): Promise<TestResult> {
  try {
    requireFields(cfg)
    const token = await getToken(cfg)
    const site = await resolveSite(cfg, token)
    return { ok: true, site: site.displayName, webUrl: site.webUrl }
  } catch (e) {
    return { ok: false, error: cleanError(e) }
  }
}

/** Stringify an error and strip any secret-shaped substrings. */
function cleanError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e)
  return sanitize(msg)
}
