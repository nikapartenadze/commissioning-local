/**
 * API Configuration
 *
 * This module provides centralized API URL configuration.
 * All API calls should go through the Next.js API routes (proxy pattern)
 * to avoid CORS issues when accessing from different machines.
 *
 * Architecture:
 * Browser → Next.js Frontend (same origin) → Next.js API Routes → Backend
 *
 * This eliminates CORS issues because:
 * 1. Browser only talks to Next.js (same origin)
 * 2. Next.js server talks to backend (server-to-server, no CORS)
 *
 * Hot-Reload Support:
 * The frontend can now fetch runtime configuration dynamically from the backend
 * via the /api/configuration/runtime endpoint. This eliminates the need for
 * environment variables that are fixed at startup.
 */

/**
 * Runtime configuration fetched from backend.
 * Allows frontend to dynamically adapt to backend configuration changes.
 */
export interface RuntimeConfig {
  backendPort: number
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
 * Fetches runtime configuration from the backend.
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
    // Use the proxy path to avoid CORS issues
    const apiBaseUrl = getApiBaseUrl()
    const response = await fetch(`${apiBaseUrl}/api/backend/configuration/runtime`, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
    })

    if (!response.ok) {
      console.warn('Failed to fetch runtime config, using defaults')
      return getDefaultRuntimeConfig()
    }

    const data = await response.json()
    return {
      backendPort: data.backendPort || 5000,
      subsystemId: data.subsystemId || '',
      plcIp: data.plcIp || '',
      cloudConnected: data.cloudConnected || false,
      isReloading: data.isReloading || false,
      showStateColumn: data.showStateColumn ?? true,
      showResultColumn: data.showResultColumn ?? true,
      showTimestampColumn: data.showTimestampColumn ?? true,
      showHistoryColumn: data.showHistoryColumn ?? true,
      orderMode: data.orderMode || false,
      signalRHubUrl: data.signalRHubUrl || getSignalRHubUrl(),
    }
  } catch (error) {
    console.warn('Error fetching runtime config, using defaults:', error)
    return getDefaultRuntimeConfig()
  }
}

function getDefaultRuntimeConfig(): RuntimeConfig {
  return {
    backendPort: 5000,
    subsystemId: '',
    plcIp: '',
    cloudConnected: false,
    isReloading: false,
    showStateColumn: true,
    showResultColumn: true,
    showTimestampColumn: true,
    showHistoryColumn: true,
    orderMode: false,
    signalRHubUrl: getSignalRHubUrl(),
  }
}

// ===========================================
// HARDCODED PORTS - No .env configuration needed
// ===========================================
const BACKEND_PORT = 5000
const FRONTEND_PORT = 3002
// ===========================================

/**
 * Get the base URL for API calls from the browser.
 * Returns empty string for relative URLs (same origin).
 */
export function getApiBaseUrl(): string {
  // In the browser, use relative URLs (same origin as the page)
  if (typeof window !== 'undefined') {
    return '' // Relative to current origin
  }
  // Server-side, use the full URL
  return ''
}

/**
 * Get the backend URL for server-side API routes.
 * This is the actual C# backend URL, only used in Next.js API routes.
 * Configurable via BACKEND_URL env var for Docker deployment.
 */
export function getBackendUrl(): string {
  if (typeof process !== 'undefined' && process.env?.BACKEND_URL) {
    return process.env.BACKEND_URL
  }
  return `http://localhost:${BACKEND_PORT}`
}

/**
 * Get the SignalR hub URL.
 * SignalR is proxied through the Next.js server at /hub to avoid exposing backend port.
 * This allows phone access with only port 3000 open.
 */
export function getSignalRHubUrl(): string {
  if (typeof window !== 'undefined') {
    // Use same origin - SignalR is proxied through Next.js custom server
    return `${window.location.origin}/hub`
  }
  return `http://localhost:${FRONTEND_PORT}/hub`
}

/**
 * Get the WebSocket URL for SignalR.
 * Uses same origin - proxied through Next.js custom server.
 */
export function getSignalRWsUrl(): string {
  if (typeof window !== 'undefined') {
    const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    return `${wsProtocol}//${window.location.host}/hub`
  }
  return `ws://localhost:${FRONTEND_PORT}/hub`
}

/**
 * Get the configured ports for reference.
 */
export function getPorts() {
  return { backend: BACKEND_PORT, frontend: FRONTEND_PORT }
}

// API endpoint paths (relative to API base)
export const API_ENDPOINTS = {
  // Status & Connection
  status: '/api/backend/status',
  tagStatus: '/api/backend/tag-status',
  plcTestConnection: '/api/backend/plc/test-connection',
  plcDisconnect: '/api/backend/plc/disconnect',

  // IOs
  ios: '/api/backend/ios',
  ioById: (id: number) => `/api/backend/ios/${id}`,
  ioHistory: (id: number) => `/api/backend/ios/${id}/history`,
  ioPass: (id: number) => `/api/backend/ios/${id}/pass`,
  ioFail: (id: number) => `/api/backend/ios/${id}/fail`,
  ioClear: (id: number) => `/api/backend/ios/${id}/clear`,
  ioFireOutput: (id: number) => `/api/backend/ios/${id}/fire-output`,
  ioComment: (id: number) => `/api/backend/ios/${id}/comment`,

  // Testing
  testingToggle: '/api/backend/testing/toggle',

  // Users & Auth
  users: '/api/backend/users',
  usersActive: '/api/backend/users/active',
  userById: (id: number) => `/api/backend/users/${id}`,
  userResetPin: (id: number) => `/api/backend/users/${id}/reset-pin`,
  userToggleActive: (id: number) => `/api/backend/users/${id}/toggle-active`,
  authLogin: '/api/backend/auth/login',

  // Configuration
  configuration: '/api/backend/configuration',
  configurationUpdate: '/api/backend/configuration/update-config-json',
  configurationRuntime: '/api/backend/configuration/runtime',

  // Cloud Sync
  cloudSync: '/api/backend/cloud/sync',
  cloudPull: '/api/backend/cloud/pull',

  // Simulator
  simulatorStatus: '/api/backend/simulator/status',
  simulatorEnable: '/api/backend/simulator/enable',
  simulatorDisable: '/api/backend/simulator/disable',

  // Diagnostics
  diagnosticSteps: '/api/backend/diagnostics/steps',
  diagnosticFailureModes: '/api/backend/diagnostics/failure-modes',

  // Network Status
  networkChainStatus: '/api/backend/network/chain-status',
  networkModules: '/api/backend/network/modules',
  networkDevices: '/api/backend/network/devices',

  // History
  history: '/api/backend/history',
  historyExport: '/api/backend/history/export',
  historySyncToCloud: '/api/backend/history/sync-to-cloud',
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

  if (response.status === 401) {
    // Token expired or invalid — clear and redirect to login
    if (typeof window !== 'undefined') {
      localStorage.removeItem('authToken')
      localStorage.removeItem('currentUser')
      localStorage.removeItem('loginTime')
      window.location.href = '/'
    }
  }

  return response
}

/**
 * Helper function to make API calls through the proxy.
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
      // Server error — retry
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
