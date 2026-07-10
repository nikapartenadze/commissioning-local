// Pure helpers + shared types for the commissioning page. Extracted verbatim
// from page.tsx. None of these close over component state — they only take
// their arguments.

export interface IoItem {
  id: number
  name: string
  description: string | null
  result: string | null
  timestamp: string | null
  comments: string | null
  state: string | null
  subsystemName: string
  assignedTo?: string | null
  networkDeviceName?: string | null
  hasNetworkDevice?: boolean
  installationStatus?: string | null
  installationPercent?: number | null
  poweredUp?: boolean | null
  hasDependencies?: boolean | null
  failureMode?: string | null
  // Cloud punchlist resolver state pulled down with the IO. ADDRESSED = fixed,
  // ready to re-check; CLARIFICATION = parked for engineering (reason held in
  // clarificationNote). result stays Pass/Fail.
  punchlistStatus?: string | null
  clarificationNote?: string | null
  trade?: string | null
}

export interface ChartData {
  passed: number
  failed: number
  notTested: number
  total: number
  passedPercent: number
  failedPercent: number
  notTestedPercent: number
}

/** Extract parent device name from IO tag name */
export function getDeviceName(tagName: string | null | undefined): string | null {
  if (!tagName) return null
  const colonIdx = tagName.indexOf(':')
  if (colonIdx > 0) return tagName.substring(0, colonIdx)
  const fiomMatch = tagName.match(/^(.+?)_X\d/)
  if (fiomMatch) return fiomMatch[1]
  const dotIdx = tagName.indexOf('.')
  if (dotIdx > 0) return tagName.substring(0, dotIdx)
  return tagName
}

export function normalizeIoState(state: unknown): 'TRUE' | 'FALSE' | null {
  if (state === true || state === 'TRUE') return 'TRUE'
  if (state === false || state === 'FALSE') return 'FALSE'
  return null
}

export function calculateTestResults(ios: IoItem[]): ChartData {
  const nonSpare = ios.filter(io => !io.description?.toUpperCase().includes('SPARE'))
  const total = nonSpare.length
  const passed = nonSpare.filter(io => io.result === 'Passed').length
  const failed = nonSpare.filter(io => io.result === 'Failed').length
  const notTested = total - passed - failed

  return {
    passed,
    failed,
    notTested,
    total,
    passedPercent: total > 0 ? (passed / total) * 100 : 0,
    failedPercent: total > 0 ? (failed / total) * 100 : 0,
    notTestedPercent: total > 0 ? (notTested / total) * 100 : 0
  }
}
