/**
 * Configuration Log Buffer
 *
 * In-memory log buffer for configuration operations.
 * Used by API routes to store and retrieve logs.
 */

export interface LogEntry {
  id: number
  timestamp: string
  level: 'info' | 'warn' | 'error'
  message: string
}

// Simple circular buffer for logs
const MAX_LOGS = 100
let logBuffer: LogEntry[] = []
let logIdCounter = 0

/**
 * Add a log entry to the buffer.
 * Called internally by other services.
 */
export function addConfigLog(level: LogEntry['level'], message: string): void {
  logIdCounter++
  const entry: LogEntry = {
    id: logIdCounter,
    timestamp: new Date().toISOString(),
    level,
    message,
  }
  logBuffer.push(entry)

  // Keep only last MAX_LOGS entries
  if (logBuffer.length > MAX_LOGS) {
    logBuffer = logBuffer.slice(-MAX_LOGS)
  }
}

/**
 * Get all log entries after the specified ID.
 */
export function getConfigLogs(afterId: number = 0): { entries: LogEntry[]; latestId: number } {
  const entries = logBuffer.filter(entry => entry.id > afterId)
  return {
    entries,
    latestId: logBuffer.length > 0 ? logBuffer[logBuffer.length - 1].id : 0,
  }
}

/**
 * Clear all logs from the buffer.
 */
export function clearConfigLogs(): void {
  logBuffer = []
}
