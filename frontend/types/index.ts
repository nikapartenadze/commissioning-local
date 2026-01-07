export type Project = {
  id: number
  name: string
  apiKey: string | null
}

export type Subsystem = {
  id: number
  projectId: number
  name: string | null
}

export type Io = {
  id: number
  subsystemId: number
  name: string
  description: string | null
  result: string | null
  timestamp: string | null
  comments: string | null
  order: number | null
  version: bigint
}

export type TestHistory = {
  id: number
  ioId: number
  result: string | null
  state: string | null
  comments: string | null
  testedBy: string | null
  timestamp: string
}

export type IoWithSubsystem = Io & {
  subsystemName: string
}

export type ChartData = {
  passed: number
  failed: number
  notTested: number
  total: number
  passedPercent: number
  failedPercent: number
  notTestedPercent: number
}

