export type L2InputType = 'pass_fail' | 'number' | 'text' | 'readonly'

export function normalizeL2InputType(columnType?: string | null, inputType?: string | null): L2InputType {
  const value = (inputType || columnType || '').trim().toLowerCase()
  if (value === 'pass_fail' || value === 'check') return 'pass_fail'
  if (value === 'number' || value === 'numeric') return 'number'
  if (value === 'readonly') return 'readonly'
  return 'text'
}

export function doesL2ColumnCountForProgress(column: {
  IncludeInProgress?: number | boolean | null
  includeInProgress?: boolean | null
  ColumnType?: string | null
  columnType?: string | null
  InputType?: string | null
  inputType?: string | null
}): boolean {
  const explicit = typeof column.includeInProgress === 'boolean'
    ? column.includeInProgress
    : typeof column.IncludeInProgress === 'number'
      ? column.IncludeInProgress === 1
      : null

  if (explicit !== null) return explicit
  return normalizeL2InputType(column.ColumnType || column.columnType, column.InputType || column.inputType) === 'pass_fail'
}

export function isL2ValueComplete(value: string | null | undefined): boolean {
  return value != null && String(value).trim() !== ''
}

export function getL2OverviewGroup(device: {
  DeviceName?: string | null
  deviceName?: string | null
  Mcm?: string | null
  mcm?: string | null
}, sheetName?: string | null): string | null {
  const mcm = (device.Mcm ?? device.mcm ?? '').trim()
  if (mcm) return mcm
  const normalizedSheet = (sheetName || '').trim().toLowerCase()
  if (normalizedSheet === 'mcm') {
    const deviceName = (device.DeviceName ?? device.deviceName ?? '').trim()
    return deviceName || null
  }
  return null
}
