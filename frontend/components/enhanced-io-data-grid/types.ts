// Shared types for the enhanced IO data grid. Extracted verbatim from
// enhanced-io-data-grid.tsx so the pure helpers / presentational sub-components
// in sibling files can reference them without importing the god component.

export type IoItem = {
  id: number
  name: string
  description: string | null
  result: string | null
  timestamp: string | null
  comments: string | null
  state: string | null
  subsystemName: string
  tagType?: string | null
  failureMode?: string | null
  assignedTo?: string | null
  networkDeviceName?: string | null
  hasNetworkDevice?: boolean
  installationStatus?: string | null
  installationPercent?: number | null
  poweredUp?: boolean | null
  hasDependencies?: boolean | null
  // Punchlist resolver state, owned by the cloud and pulled down here. A Failed
  // IO an electrician/admin marked ADDRESSED (fixed, ready to re-check) or
  // CLARIFICATION (parked, awaiting engineer input). result stays Pass/Fail.
  punchlistStatus?: string | null
  clarificationNote?: string | null
  trade?: string | null
}

export type TestHistory = {
  id: number
  result: string | null
  state: string | null
  comments: string | null
  testedBy: string | null
  timestamp: string
}

// Columns the user can click to sort by. Live PLC values (State, Net) are
// intentionally excluded — they change continuously and would reshuffle rows
// under the operator's fingers. Default is "ioPoint" ascending, which matches
// the grid's historical always-natural-sort-by-name behaviour.
export type SortColumn = 'ioPoint' | 'description' | 'result' | 'timestamp' | 'comments' | 'installStatus' | 'reason'
export type SortDir = 'asc' | 'desc'
