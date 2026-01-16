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
 */

/**
 * Get the base URL for API calls from the browser.
 * This should always return the Next.js server URL (same origin).
 * The actual backend URL is only used server-side in API routes.
 */
export function getApiBaseUrl(): string {
  // In the browser, use relative URLs (same origin as the page)
  if (typeof window !== 'undefined') {
    return '' // Relative to current origin
  }
  // Server-side, use the full URL
  return process.env.NEXT_PUBLIC_APP_URL || ''
}

/**
 * Get the backend URL for server-side API routes.
 * This is the actual C# backend URL, only used in Next.js API routes.
 */
export function getBackendUrl(): string {
  return process.env.BACKEND_URL || process.env.NEXT_PUBLIC_CSHARP_API_URL || 'http://localhost:5000'
}

/**
 * Get the SignalR hub URL.
 * SignalR must connect directly to the backend, but we use the current hostname.
 */
export function getSignalRHubUrl(): string {
  if (typeof window !== 'undefined') {
    // Use the same hostname as the page, but with backend port
    const backendPort = process.env.NEXT_PUBLIC_BACKEND_PORT || '5000'
    return `${window.location.protocol}//${window.location.hostname}:${backendPort}/hub`
  }
  return 'http://localhost:5000/hub'
}

/**
 * Get the WebSocket URL for SignalR.
 */
export function getSignalRWsUrl(): string {
  if (typeof window !== 'undefined') {
    const backendPort = process.env.NEXT_PUBLIC_BACKEND_PORT || '5000'
    const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    return `${wsProtocol}//${window.location.hostname}:${backendPort}/hub`
  }
  return 'ws://localhost:5000/hub'
}

// API endpoint paths (relative to API base)
export const API_ENDPOINTS = {
  // Status & Connection
  status: '/api/backend/status',
  plcTestConnection: '/api/backend/plc/test-connection',

  // IOs
  ios: '/api/backend/ios',
  ioById: (id: number) => `/api/backend/ios/${id}`,
  ioHistory: (id: number) => `/api/backend/ios/${id}/history`,
  ioPass: (id: number) => `/api/backend/ios/${id}/pass`,
  ioFail: (id: number) => `/api/backend/ios/${id}/fail`,
  ioClear: (id: number) => `/api/backend/ios/${id}/clear`,
  ioFireOutput: (id: number) => `/api/backend/ios/${id}/fire-output`,

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

  // Cloud Sync
  cloudSync: '/api/backend/cloud/sync',

  // Simulator
  simulatorStatus: '/api/backend/simulator/status',
  simulatorEnable: '/api/backend/simulator/enable',
  simulatorDisable: '/api/backend/simulator/disable',

  // Diagnostics
  diagnosticSteps: '/api/backend/diagnostics/steps',
  diagnosticFailureModes: '/api/backend/diagnostics/failure-modes',

  // Network Status
  networkChainStatus: '/api/backend/network/chain-status',

  // History
  history: '/api/backend/history',
} as const

/**
 * Helper function to make API calls through the proxy.
 * Automatically handles the base URL and error handling.
 */
export async function apiCall<T = unknown>(
  endpoint: string,
  options: RequestInit = {}
): Promise<T> {
  const baseUrl = getApiBaseUrl()
  const url = `${baseUrl}${endpoint}`

  const response = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...options.headers,
    },
  })

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
