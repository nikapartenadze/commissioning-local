/**
 * API Configuration
 *
 * Architecture (Node.js-only):
 * Browser -> Next.js API Routes (same origin) -> SQLite/PLC
 *
 * Fully self-contained — no external backend required.
 */

/**
 * Runtime configuration fetched from Next.js API routes.
 */
export interface RuntimeConfig {
  subsystemId: string
  plcIp: string
  cloudConnected: boolean
  isReloading: boolean
  showStateColumn: boolean
  showResultColumn: boolean
  showTimestampColumn: boolean
  showHistoryColumn: boolean
  orderMode: boolean
  signalRHubUrl: string
}

// Cache for runtime config
let cachedRuntimeConfig: RuntimeConfig | null = null
let runtimeConfigFetchPromise: Promise<RuntimeConfig> | null = null

/**
 * Fetches runtime configuration from the API.
 * Caches the result to avoid repeated API calls.
 * Use refreshRuntimeConfig() to force a refresh.
 */
export async function getRuntimeConfig(): Promise<RuntimeConfig> {
  // Return cached config if available
  if (cachedRuntimeConfig) {
    return cachedRuntimeConfig
  }

  // Deduplicate concurrent requests
  if (runtimeConfigFetchPromise) {
    return runtimeConfigFetchPromise
  }

  runtimeConfigFetchPromise = fetchRuntimeConfigInternal()

  try {
    const config = await runtimeConfigFetchPromise
    cachedRuntimeConfig = config
    return config
  } finally {
    runtimeConfigFetchPromise = null
  }
}

/**
 * Forces a refresh of the runtime configuration cache.
 * Call this when you know configuration has changed.
 */
export async function refreshRuntimeConfig(): Promise<RuntimeConfig> {
  cachedRuntimeConfig = null
  return getRuntimeConfig()
}

/**
 * Clears the runtime configuration cache.
 * Next call to getRuntimeConfig() will fetch fresh data.
 */
export function clearRuntimeConfigCache(): void {
  cachedRuntimeConfig = null
}

async function fetchRuntimeConfigInternal(): Promise<RuntimeConfig> {
  try {
    const apiBaseUrl = getApiBaseUrl()
    const response = await fetch(`${apiBaseUrl}/api/configuration/runtime`, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
    })

    if (!response.ok) {
      console.warn('Failed to fetch runtime config, using defaults')
      return getDefaultRuntimeConfig()
    }

    const data = await response.json()
    return {
      subsystemId: data.subsystemId || '',
      plcIp: data.plcIp || '',
      cloudConnected: data.cloudConnected || false,
      isReloading: data.isReloading || false,
      showStateColumn: data.showStateColumn ?? true,
      showResultColumn: data.showResultColumn ?? true,
      showTimestampColumn: data.showTimestampColumn ?? true,
      showHistoryColumn: data.showHistoryColumn ?? true,
      orderMode: data.orderMode || false,
      signalRHubUrl: data.signalRHubUrl || getWebSocketUrl(),
    }
  } catch (error) {
    console.warn('Error fetching runtime config, using defaults:', error)
    return getDefaultRuntimeConfig()
  }
}

function getDefaultRuntimeConfig(): RuntimeConfig {
  return {
    subsystemId: '',
    plcIp: '',
    cloudConnected: false,
    isReloading: false,
    showStateColumn: true,
    showResultColumn: true,
    showTimestampColumn: true,
    showHistoryColumn: true,
    orderMode: false,
    signalRHubUrl: getWebSocketUrl(),
  }
}

/**
 * Get the base URL for API calls from the browser.
 * Returns empty string for relative URLs (same origin).
 */
export function getApiBaseUrl(): string {
  return ''
}

/**
 * Get the WebSocket URL for real-time updates.
 * WebSocket is served on the same port as the app, at the /ws path.
 */
export function getWebSocketUrl(): string {
  if (typeof window !== 'undefined') {
    const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    return `${wsProtocol}//${window.location.host}/ws`
  }
  return `ws://localhost:3000/ws`
}

/**
 * @deprecated Alias for getWebSocketUrl() — kept for backward compatibility.
 */
export function getSignalRHubUrl(): string {
  return getWebSocketUrl()
}

// API endpoint paths (relative to API base)
export const API_ENDPOINTS = {
  // Status & Connection
  status: '/api/plc/status',
  tagStatus: '/api/plc/tags',
  plcTestConnection: '/api/plc/test-connection',
  plcDisconnect: '/api/plc/disconnect',
  plcConnect: '/api/plc/connect',

  // IOs
  ios: '/api/ios',
  ioById: (id: number) => `/api/ios/${id}`,
  ioHistory: (id: number) => `/api/history/${id}`,
  ioTest: (id: number) => `/api/ios/${id}/test`,
  ioPass: (id: number) => `/api/ios/${id}/test`,
  ioFail: (id: number) => `/api/ios/${id}/test`,
  ioClear: (id: number) => `/api/ios/${id}/reset`,
  ioFireOutput: (id: number) => `/api/ios/${id}/fire-output`,
  ioComment: (id: number) => `/api/ios/${id}`,
  ioDependencies: (id: number) => `/api/ios/${id}/dependencies`,
  ioStats: '/api/ios/stats',

  // Testing
  testingToggle: '/api/plc/toggle-testing',

  // Users & Auth
  users: '/api/users',
  usersActive: '/api/users/active',
  userById: (id: number) => `/api/users/${id}`,
  userResetPin: (id: number) => `/api/users/${id}/reset-pin`,
  userToggleActive: (id: number) => `/api/users/${id}/toggle-active`,
  authLogin: '/api/auth/login',
  authVerify: '/api/auth/verify',

  // Configuration
  configuration: '/api/configuration',
  configurationUpdate: '/api/configuration',
  configurationConnectPlc: '/api/configuration/connect',
  configurationRuntime: '/api/configuration/runtime',
  configurationLogs: '/api/configuration/logs',

  // Cloud Sync
  cloudSync: '/api/cloud/sync',
  cloudSyncL2: '/api/cloud/sync-l2',
  cloudSyncL2Items: '/api/cloud/sync-l2/items',
  cloudPull: '/api/cloud/pull',
  cloudStatus: '/api/cloud/status',
  updateStatus: '/api/update/status',
  updateInstall: '/api/update/install',

  // Diagnostics
  diagnosticSteps: '/api/diagnostics/steps',
  diagnosticFailureModes: '/api/diagnostics/failure-modes',

  // Network Status
  networkChainStatus: '/api/network/chain-status',
  networkModules: '/api/network/modules',
  networkDevices: '/api/network/devices',

  // History
  history: '/api/history',
  historyExport: '/api/history/export',
  historySyncToCloud: '/api/history/sync-to-cloud',

  // Health
  health: '/api/health',

  // Backups
  backups: '/api/backups',
  backupByFilename: (filename: string) => `/api/backups/${encodeURIComponent(filename)}`,
  // backupSync REMOVED (2026-07-08): the /api/backups/:filename/sync route was
  // dead code (queried nonexistent table names) and has been deleted.

  // Change Requests
  changeRequests: '/api/change-requests',
  changeRequestById: (id: number) => `/api/change-requests/${id}`,

  // Network Topology
  networkTopology: '/api/network/topology',

  // EStop Check
  estopStatus: '/api/estop/status',
} as const

/**
 * Authenticated fetch wrapper.
 * Reads JWT from localStorage and adds Authorization header.
 * On 401 response, clears token and redirects to login page.
 */
export async function authFetch(
  endpoint: string,
  options: RequestInit = {}
): Promise<Response> {
  const baseUrl = getApiBaseUrl()
  const url = `${baseUrl}${endpoint}`
  const token = typeof window !== 'undefined' ? localStorage.getItem('authToken') : null

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string> || {}),
  }

  if (token) {
    headers['Authorization'] = `Bearer ${token}`
  }

  const response = await fetch(url, {
    ...options,
    headers,
  })

  // When auth is enforced and the token is missing/expired/invalid, the server
  // replies 401. Clear the stored token and signal the app shell to return to
  // the login screen. We only act when a token was actually present so the
  // open-mode (AUTH_REQUIRED off) flow — which never sets a token and never
  // gets 401s on gated reads — is completely untouched.
  if (response.status === 401 && token && typeof window !== 'undefined') {
    localStorage.removeItem('authToken')
    // The UserProvider listens for this to drop back to the login screen
    // without a hard reload (avoids losing in-flight component state elsewhere).
    window.dispatchEvent(new CustomEvent('auth:unauthorized'))
  }

  return response
}

/**
 * Helper function to make API calls.
 * Automatically handles the base URL and error handling.
 */
export async function apiCall<T = unknown>(
  endpoint: string,
  options: RequestInit = {}
): Promise<T> {
  const response = await authFetch(endpoint, options)

  if (!response.ok) {
    const raw = await response.text()
    let msg = raw
    try { const j = JSON.parse(raw); if (j?.error) msg = j.error } catch { /* not JSON */ }
    throw new Error(msg || `API call failed: ${response.status}`)
  }

  // Check if response has content
  const text = await response.text()
  if (!text) {
    return {} as T
  }

  return JSON.parse(text) as T
}

/**
 * Tells a genuine caller cancellation apart from an expired timeout budget.
 *
 * Callers pass `signal: AbortSignal.timeout(15000)`, which is a per-request
 * BUDGET, not a cancellation — and that is exactly what killed the retry loop
 * (see fetchWithRetry). A spec-compliant AbortSignal.timeout aborts with a
 * reason whose name is 'TimeoutError', whereas an AbortController aborted for
 * unmount/navigation gives 'AbortError' (or a caller-chosen reason). So:
 *   - reason.name === 'TimeoutError'  -> the attempt's budget ran out (retryable)
 *   - anything else                   -> the caller really wants us to stop
 * Anything without a reason is treated as a real cancellation, which is the
 * safe default: we stop rather than keep hammering the PLC/server.
 */
function isCallerCancelled(signal: AbortSignal | null): boolean {
  if (!signal?.aborted) return false
  const reason = signal.reason as { name?: string } | undefined
  return reason?.name !== 'TimeoutError'
}

function callerCancelReason(signal: AbortSignal | null): Error {
  const reason = signal?.reason
  if (reason instanceof Error) return reason
  return new DOMException('fetchWithRetry cancelled by caller', 'AbortError')
}

/**
 * Backoff sleep that wakes early only on a REAL caller cancellation, so an
 * unmounted page does not sit in a 4s timer before noticing. A TimeoutError on
 * the caller's signal deliberately does NOT shorten the backoff — the whole
 * point of the backoff is to wait out whatever made the attempt time out.
 */
function sleepUnlessCancelled(ms: number, signal: AbortSignal | null): Promise<void> {
  return new Promise(resolve => {
    if (isCallerCancelled(signal)) {
      resolve()
      return
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    const finish = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }
    const onAbort = () => { if (isCallerCancelled(signal)) finish() }
    timer = setTimeout(finish, ms)
    signal?.addEventListener('abort', onAbort)
  })
}

/**
 * Fetch with retry for read-only GET calls.
 * 3 retries with exponential backoff (1s, 2s, 4s).
 * Only use for idempotent read operations, NOT mutations.
 *
 * Timeouts are PER ATTEMPT. Previously every attempt reused the one signal the
 * caller passed in `options.signal`; once `AbortSignal.timeout(15000)` fired,
 * attempts 2..N rejected instantly with AbortError, so on a slow/flapping
 * on-site link the retries were dead code and this degraded to a single try.
 * Each attempt now gets a freshly minted timer, while a caller-supplied signal
 * is still honoured for real cancellation and ends the loop immediately.
 *
 * perAttemptTimeoutMs defaults to 15s to match what every caller was already
 * asking for, so their existing `AbortSignal.timeout(15000)` stays accurate.
 */
export async function fetchWithRetry(
  endpoint: string,
  options: RequestInit = {},
  maxRetries = 3,
  perAttemptTimeoutMs = 15000
): Promise<Response> {
  const callerSignal = options.signal ?? null
  let lastError: Error | null = null

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    // Don't burn an attempt if the caller already walked away.
    if (isCallerCancelled(callerSignal)) {
      throw callerCancelReason(callerSignal)
    }

    const attemptController = new AbortController()
    const timer = setTimeout(() => {
      attemptController.abort(
        new DOMException(`fetchWithRetry attempt timed out after ${perAttemptTimeoutMs}ms`, 'TimeoutError')
      )
    }, perAttemptTimeoutMs)

    // Manual linkage instead of AbortSignal.any(): `any` needs Chrome 116+ /
    // Node 20.3+, and the field tablets are not pinned to a browser version.
    // addEventListener/removeEventListener works anywhere AbortController does.
    // Note this forwards ONLY real cancellations — an already-fired caller
    // timeout is ignored, which is what lets attempt 2 actually run.
    const forwardCancel = () => {
      if (isCallerCancelled(callerSignal)) {
        attemptController.abort(callerCancelReason(callerSignal))
      }
    }
    if (callerSignal) {
      forwardCancel() // an already-aborted signal never fires the event
      callerSignal.addEventListener('abort', forwardCancel)
    }

    try {
      const response = await authFetch(endpoint, { ...options, signal: attemptController.signal })
      if (response.ok || response.status === 401 || response.status === 403) {
        return response
      }
      // Server error - retry
      lastError = new Error(`HTTP ${response.status}`)
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error))
      // A real cancellation is terminal: never keep retrying after an unmount
      // or navigation, and never bury it under a generic retry error.
      if (isCallerCancelled(callerSignal)) {
        throw callerCancelReason(callerSignal)
      }
      // Everything else — including this attempt's own TimeoutError — is a
      // retryable failure and falls through to the backoff below.
    } finally {
      // Always drop the timer and the listener, otherwise a long-lived caller
      // signal accumulates one listener per attempt.
      clearTimeout(timer)
      callerSignal?.removeEventListener('abort', forwardCancel)
    }

    if (attempt < maxRetries) {
      const delay = 1000 * Math.pow(2, attempt)
      await sleepUnlessCancelled(delay, callerSignal)
      if (isCallerCancelled(callerSignal)) {
        throw callerCancelReason(callerSignal)
      }
    }
  }

  throw lastError || new Error('fetchWithRetry exhausted all retries')
}
