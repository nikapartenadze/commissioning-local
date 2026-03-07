/**
 * Dynamic API configuration for multi-device access
 * When accessed from phones/tablets on the network, uses the current hostname
 * instead of hardcoded localhost
 */

export function getApiBaseUrl(): string {
  if (typeof window !== 'undefined') {
    return `http://${window.location.hostname}:5000`
  }
  return 'http://localhost:5000'
}

export function getHubUrl(): string {
  if (typeof window !== 'undefined') {
    return `http://${window.location.hostname}:5000/hub`
  }
  return 'http://localhost:5000/hub'
}

export function getWsHubUrl(): string {
  if (typeof window !== 'undefined') {
    return `ws://${window.location.hostname}:5000/hub`
  }
  return 'ws://localhost:5000/hub'
}

/**
 * Helper to make API calls with dynamic base URL
 */
export async function apiCall(endpoint: string, options?: RequestInit): Promise<Response> {
  const baseUrl = getApiBaseUrl()
  const url = endpoint.startsWith('/') ? `${baseUrl}${endpoint}` : `${baseUrl}/${endpoint}`
  return fetch(url, options)
}
