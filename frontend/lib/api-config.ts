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
  backupSync: (filename: string) => `/api/backups/${encodeURIComponent(filename)}/sync`,

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

  // Auth disabled — no 401 redirect needed

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
    const error = await response.text()
    throw new Error(error || `API call failed: ${response.status}`)
  }

  // Check if response has content
  const text = await response.text()
  if (!text) {
    return {} as T
  }

  return JSON.parse(text) as T
}

/**
 * Fetch with retry for read-only GET calls.
 * 3 retries with exponential backoff (1s, 2s, 4s).
 * Only use for idempotent read operations, NOT mutations.
 */
export async function fetchWithRetry(
  endpoint: string,
  options: RequestInit = {},
  maxRetries = 3
): Promise<Response> {
  let lastError: Error | null = null

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await authFetch(endpoint, options)
      if (response.ok || response.status === 401 || response.status === 403) {
        return response
      }
      // Server error - retry
      lastError = new Error(`HTTP ${response.status}`)
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error))
    }

    if (attempt < maxRetries) {
      const delay = 1000 * Math.pow(2, attempt)
      await new Promise(resolve => setTimeout(resolve, delay))
    }
  }

  throw lastError || new Error('fetchWithRetry exhausted all retries')
}
