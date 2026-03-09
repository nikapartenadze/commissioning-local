/**
 * End-to-End Test Script for Node.js Migration
 *
 * This script tests all major API endpoints to verify the full system works.
 * Run with: npm run test:e2e
 *
 * Prerequisites:
 * - Backend running on port 5000
 * - Frontend running on port 3020 (optional, tests go directly to backend)
 */

const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:5000'
const DEFAULT_PIN = '852963' // Default admin PIN from CLAUDE.md

interface TestResult {
  name: string
  passed: boolean
  error?: string
  duration: number
}

const results: TestResult[] = []

// Colors for terminal output
const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  dim: '\x1b[2m',
}

function log(message: string, color: string = colors.reset): void {
  console.log(`${color}${message}${colors.reset}`)
}

async function runTest(
  name: string,
  testFn: () => Promise<void>
): Promise<void> {
  const start = Date.now()
  try {
    await testFn()
    const duration = Date.now() - start
    results.push({ name, passed: true, duration })
    log(`  [PASS] ${name} (${duration}ms)`, colors.green)
  } catch (error) {
    const duration = Date.now() - start
    const errorMessage = error instanceof Error ? error.message : String(error)
    results.push({ name, passed: false, error: errorMessage, duration })
    log(`  [FAIL] ${name} (${duration}ms)`, colors.red)
    log(`         ${errorMessage}`, colors.dim)
  }
}

async function fetchJson<T>(
  url: string,
  options: RequestInit = {}
): Promise<{ status: number; data: T | null; error?: string }> {
  try {
    const response = await fetch(url, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...options.headers,
      },
    })

    const text = await response.text()
    let data: T | null = null

    if (text) {
      try {
        data = JSON.parse(text) as T
      } catch {
        // Response is not JSON
      }
    }

    return { status: response.status, data }
  } catch (error) {
    return {
      status: 0,
      data: null,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

// ============================================
// Test Groups
// ============================================

async function testConfiguration(): Promise<void> {
  log('\n[Configuration Tests]', colors.cyan)

  await runTest('GET /api/configuration - returns config', async () => {
    const result = await fetchJson<Record<string, unknown>>(
      `${BACKEND_URL}/api/configuration`
    )
    if (result.error) throw new Error(result.error)
    if (result.status !== 200) throw new Error(`Status ${result.status}`)
    if (!result.data) throw new Error('No data returned')
    // Config should have some expected fields
    if (typeof result.data !== 'object') throw new Error('Config is not an object')
  })

  await runTest('GET /api/configuration/runtime - returns runtime config', async () => {
    const result = await fetchJson<Record<string, unknown>>(
      `${BACKEND_URL}/api/configuration/runtime`
    )
    if (result.error) throw new Error(result.error)
    if (result.status !== 200) throw new Error(`Status ${result.status}`)
    if (!result.data) throw new Error('No data returned')
  })
}

async function testIOs(): Promise<void> {
  log('\n[IO Tests]', colors.cyan)

  await runTest('GET /api/ios - returns IO list', async () => {
    const result = await fetchJson<unknown[]>(`${BACKEND_URL}/api/ios`)
    if (result.error) throw new Error(result.error)
    if (result.status !== 200) throw new Error(`Status ${result.status}`)
    if (!Array.isArray(result.data)) throw new Error('Response is not an array')
  })
}

async function testPLCStatus(): Promise<void> {
  log('\n[PLC Status Tests]', colors.cyan)

  await runTest('GET /api/plc/status - returns PLC status', async () => {
    const result = await fetchJson<Record<string, unknown>>(
      `${BACKEND_URL}/api/plc/status`
    )
    if (result.error) throw new Error(result.error)
    // PLC status endpoint might return various status codes
    if (result.status >= 500) throw new Error(`Server error: ${result.status}`)
  })
}

async function testSimulator(): Promise<void> {
  log('\n[Simulator Tests]', colors.cyan)

  await runTest('GET /api/simulator/status - returns simulator status', async () => {
    const result = await fetchJson<{ enabled?: boolean }>(
      `${BACKEND_URL}/api/simulator/status`
    )
    if (result.error) throw new Error(result.error)
    if (result.status !== 200) throw new Error(`Status ${result.status}`)
    if (result.data === null) throw new Error('No data returned')
  })

  let initialState: boolean | undefined

  await runTest('POST /api/simulator/enable - enable simulator', async () => {
    // First get current state
    const statusResult = await fetchJson<{ enabled?: boolean }>(
      `${BACKEND_URL}/api/simulator/status`
    )
    initialState = statusResult.data?.enabled

    const result = await fetchJson<unknown>(`${BACKEND_URL}/api/simulator/enable`, {
      method: 'POST',
    })
    if (result.error) throw new Error(result.error)
    if (result.status >= 400) throw new Error(`Status ${result.status}`)
  })

  await runTest('GET /api/simulator/status - verify enabled', async () => {
    const result = await fetchJson<{ enabled?: boolean }>(
      `${BACKEND_URL}/api/simulator/status`
    )
    if (result.error) throw new Error(result.error)
    if (result.status !== 200) throw new Error(`Status ${result.status}`)
    if (result.data?.enabled !== true) {
      throw new Error(`Simulator not enabled, got: ${JSON.stringify(result.data)}`)
    }
  })

  await runTest('POST /api/simulator/disable - disable simulator', async () => {
    const result = await fetchJson<unknown>(`${BACKEND_URL}/api/simulator/disable`, {
      method: 'POST',
    })
    if (result.error) throw new Error(result.error)
    if (result.status >= 400) throw new Error(`Status ${result.status}`)
  })

  await runTest('GET /api/simulator/status - verify disabled', async () => {
    const result = await fetchJson<{ enabled?: boolean }>(
      `${BACKEND_URL}/api/simulator/status`
    )
    if (result.error) throw new Error(result.error)
    if (result.status !== 200) throw new Error(`Status ${result.status}`)
    if (result.data?.enabled !== false) {
      throw new Error(`Simulator not disabled, got: ${JSON.stringify(result.data)}`)
    }
  })

  // Restore initial state if it was enabled
  if (initialState === true) {
    await fetchJson<unknown>(`${BACKEND_URL}/api/simulator/enable`, {
      method: 'POST',
    })
    log('  (Restored simulator to initial enabled state)', colors.dim)
  }
}

async function testPLCConnection(): Promise<void> {
  log('\n[PLC Connection Tests]', colors.cyan)

  await runTest('POST /api/plc/test-connection - test PLC connection', async () => {
    // This tests the connection endpoint, which may fail if no PLC is available
    // We just verify the endpoint responds correctly
    const result = await fetchJson<Record<string, unknown>>(
      `${BACKEND_URL}/api/plc/test-connection`,
      {
        method: 'POST',
        body: JSON.stringify({
          ip: '192.168.1.100',
          path: '1,0',
        }),
      }
    )
    if (result.error) throw new Error(result.error)
    // Connection test might fail (no PLC), but endpoint should respond
    // Accept 200 (success), 400 (bad request), or specific error responses
    if (result.status >= 500) throw new Error(`Server error: ${result.status}`)
  })

  await runTest('GET /api/plc/status - verify PLC status after test', async () => {
    const result = await fetchJson<Record<string, unknown>>(
      `${BACKEND_URL}/api/plc/status`
    )
    if (result.error) throw new Error(result.error)
    if (result.status >= 500) throw new Error(`Server error: ${result.status}`)
  })
}

async function testAuthentication(): Promise<void> {
  log('\n[Authentication Tests]', colors.cyan)

  let authToken: string | undefined

  await runTest('POST /api/auth/login - login with valid PIN', async () => {
    const result = await fetchJson<{ token?: string; user?: unknown }>(
      `${BACKEND_URL}/api/auth/login`,
      {
        method: 'POST',
        body: JSON.stringify({ pin: DEFAULT_PIN }),
      }
    )
    if (result.error) throw new Error(result.error)
    if (result.status === 401) {
      throw new Error('Login failed - PIN may not be set up')
    }
    if (result.status !== 200) throw new Error(`Status ${result.status}`)
    if (!result.data?.token) {
      throw new Error('No token returned')
    }
    authToken = result.data.token
  })

  await runTest('GET /api/auth/verify - verify token', async () => {
    if (!authToken) {
      throw new Error('No auth token from previous test')
    }
    const result = await fetchJson<Record<string, unknown>>(
      `${BACKEND_URL}/api/auth/verify`,
      {
        headers: {
          Authorization: `Bearer ${authToken}`,
        },
      }
    )
    if (result.error) throw new Error(result.error)
    if (result.status !== 200) throw new Error(`Status ${result.status}`)
  })

  await runTest('POST /api/auth/login - reject invalid PIN', async () => {
    const result = await fetchJson<unknown>(`${BACKEND_URL}/api/auth/login`, {
      method: 'POST',
      body: JSON.stringify({ pin: '000000' }),
    })
    if (result.error) throw new Error(result.error)
    // Should return 401 for invalid PIN
    if (result.status === 200) {
      throw new Error('Should have rejected invalid PIN')
    }
    if (result.status !== 401 && result.status !== 400) {
      throw new Error(`Unexpected status ${result.status}`)
    }
  })
}

async function testUsers(): Promise<void> {
  log('\n[User Management Tests]', colors.cyan)

  await runTest('GET /api/users - returns user list', async () => {
    const result = await fetchJson<unknown[]>(`${BACKEND_URL}/api/users`)
    if (result.error) throw new Error(result.error)
    if (result.status !== 200) throw new Error(`Status ${result.status}`)
    if (!Array.isArray(result.data)) throw new Error('Response is not an array')
  })

  await runTest('GET /api/users/active - returns active users', async () => {
    const result = await fetchJson<unknown[]>(`${BACKEND_URL}/api/users/active`)
    if (result.error) throw new Error(result.error)
    if (result.status !== 200) throw new Error(`Status ${result.status}`)
    if (!Array.isArray(result.data)) throw new Error('Response is not an array')
  })
}

async function testHistory(): Promise<void> {
  log('\n[History Tests]', colors.cyan)

  await runTest('GET /api/history - returns test history', async () => {
    const result = await fetchJson<unknown[]>(`${BACKEND_URL}/api/history`)
    if (result.error) throw new Error(result.error)
    if (result.status !== 200) throw new Error(`Status ${result.status}`)
    if (!Array.isArray(result.data)) throw new Error('Response is not an array')
  })
}

async function testDiagnostics(): Promise<void> {
  log('\n[Diagnostics Tests]', colors.cyan)

  await runTest('GET /api/diagnostics/steps - returns diagnostic steps', async () => {
    const result = await fetchJson<unknown>(`${BACKEND_URL}/api/diagnostics/steps`)
    if (result.error) throw new Error(result.error)
    // This endpoint might return 404 if no tag type is specified
    if (result.status >= 500) throw new Error(`Server error: ${result.status}`)
  })
}

async function testNetworkStatus(): Promise<void> {
  log('\n[Network Status Tests]', colors.cyan)

  await runTest('GET /api/network/chain-status - returns network chain status', async () => {
    const result = await fetchJson<unknown>(`${BACKEND_URL}/api/network/chain-status`)
    if (result.error) throw new Error(result.error)
    // Network status might not be available
    if (result.status >= 500) throw new Error(`Server error: ${result.status}`)
  })
}

// ============================================
// Main
// ============================================

async function checkBackendAvailability(): Promise<boolean> {
  log(`\nChecking backend availability at ${BACKEND_URL}...`, colors.yellow)
  try {
    const response = await fetch(`${BACKEND_URL}/api/configuration`, {
      method: 'GET',
      signal: AbortSignal.timeout(5000),
    })
    if (response.ok) {
      log('Backend is available!', colors.green)
      return true
    }
    log(`Backend responded with status ${response.status}`, colors.yellow)
    return false
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    log(`Backend not available: ${message}`, colors.red)
    return false
  }
}

function printSummary(): void {
  log('\n' + '='.repeat(60), colors.cyan)
  log('TEST SUMMARY', colors.cyan)
  log('='.repeat(60), colors.cyan)

  const passed = results.filter((r) => r.passed).length
  const failed = results.filter((r) => !r.passed).length
  const total = results.length
  const totalDuration = results.reduce((sum, r) => sum + r.duration, 0)

  log(`\nTotal: ${total} tests`, colors.reset)
  log(`Passed: ${passed}`, colors.green)
  log(`Failed: ${failed}`, failed > 0 ? colors.red : colors.green)
  log(`Duration: ${totalDuration}ms`, colors.dim)

  if (failed > 0) {
    log('\nFailed Tests:', colors.red)
    results
      .filter((r) => !r.passed)
      .forEach((r) => {
        log(`  - ${r.name}`, colors.red)
        if (r.error) {
          log(`    Error: ${r.error}`, colors.dim)
        }
      })
  }

  log('\n' + '='.repeat(60), colors.cyan)
}

async function main(): Promise<void> {
  log('='.repeat(60), colors.cyan)
  log('IO Checkout Tool - End-to-End Tests', colors.cyan)
  log('='.repeat(60), colors.cyan)

  const backendAvailable = await checkBackendAvailability()
  if (!backendAvailable) {
    log(
      '\nBackend is not running. Please start the backend first:',
      colors.yellow
    )
    log('  cd docker && docker compose up -d backend', colors.dim)
    log('  OR', colors.dim)
    log('  cd backend && dotnet run', colors.dim)
    process.exit(1)
  }

  // Run all test groups
  await testConfiguration()
  await testIOs()
  await testPLCStatus()
  await testSimulator()
  await testPLCConnection()
  await testAuthentication()
  await testUsers()
  await testHistory()
  await testDiagnostics()
  await testNetworkStatus()

  printSummary()

  // Exit with error code if any tests failed
  const failed = results.filter((r) => !r.passed).length
  process.exit(failed > 0 ? 1 : 0)
}

main().catch((error) => {
  log(`\nFatal error: ${error}`, colors.red)
  process.exit(1)
})
