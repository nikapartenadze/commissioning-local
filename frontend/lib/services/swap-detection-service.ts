/**
 * Swap Detection Service
 *
 * Detects wiring swaps during guided IO testing. When the tech activates
 * the expected IO but a different IO triggers, this service analyzes the
 * relationship between the expected and triggered IOs to determine if it's
 * a swap (same device/adjacent port), mis-wire (different device), or
 * cross-talk (multiple simultaneous triggers).
 */

import type { GuidedSequenceItem } from './guided-sequence-service'

// ── Types ──────────────────────────────────────────────────────────

export type SwapConfidence = 'high' | 'medium' | 'low'

export type SwapType =
  | 'swap'         // Same device or adjacent port — high confidence
  | 'miswire'      // Different device entirely
  | 'crosstalk'    // Multiple IOs triggered simultaneously
  | 'unknown'

export interface SwapDetectionResult {
  detected: boolean
  type: SwapType
  confidence: SwapConfidence
  expectedIo: GuidedSequenceItem
  triggeredIo: GuidedSequenceItem
  suggestedFailureMode: string
  suggestedComment: string
  suggestedTrade: string
}

export interface AutoFailureMode {
  failureMode: string
  comment: string
  trade: string
}

// ── Swap Detection Logic ───────────────────────────────────────────

/**
 * Analyze a trigger event where the wrong IO fired.
 * Returns a SwapDetectionResult with diagnosis and suggested failure info.
 */
export function analyzeSwap(
  expectedIo: GuidedSequenceItem,
  triggeredIo: GuidedSequenceItem
): SwapDetectionResult {
  // Same device?
  const sameDevice = expectedIo.deviceName !== null &&
    triggeredIo.deviceName !== null &&
    expectedIo.deviceName.toUpperCase() === triggeredIo.deviceName.toUpperCase()

  // Same DPM node?
  const sameNode = expectedIo.nodeId === triggeredIo.nodeId && expectedIo.nodeId !== 0

  // Adjacent ports? (within 2 port numbers)
  const expectedPort = parseInt(expectedIo.portNumber || '0')
  const triggeredPort = parseInt(triggeredIo.portNumber || '0')
  const portDistance = Math.abs(expectedPort - triggeredPort)
  const adjacentPorts = sameNode && portDistance <= 2

  // Determine swap type and confidence
  let type: SwapType
  let confidence: SwapConfidence

  if (sameDevice) {
    type = 'swap'
    confidence = 'high'
  } else if (adjacentPorts) {
    type = 'swap'
    confidence = 'high'
  } else if (sameNode) {
    type = 'swap'
    confidence = 'medium'
  } else {
    type = 'miswire'
    confidence = 'low'
  }

  // Generate failure suggestions
  const expectedDesc = expectedIo.ioDescription || expectedIo.ioName
  const triggeredDesc = triggeredIo.ioDescription || triggeredIo.ioName

  let suggestedFailureMode: string
  let suggestedComment: string
  let suggestedTrade: string

  if (type === 'swap') {
    suggestedFailureMode = 'Wrong wiring'
    suggestedComment = `Swap detected: Expected "${expectedDesc}" but "${triggeredDesc}" triggered instead. ` +
      `Location: ${triggeredIo.nodeName || 'unknown'} Port ${triggeredIo.portNumber || '?'}`
    suggestedTrade = 'ELEC'
  } else {
    suggestedFailureMode = 'Wrong wiring'
    suggestedComment = `Possible mis-wire: Expected "${expectedDesc}" on ${expectedIo.nodeName || 'unknown'} ` +
      `but "${triggeredDesc}" on ${triggeredIo.nodeName || 'unknown'} triggered`
    suggestedTrade = 'ELEC'
  }

  return {
    detected: true,
    type,
    confidence,
    expectedIo,
    triggeredIo,
    suggestedFailureMode,
    suggestedComment,
    suggestedTrade,
  }
}

/**
 * Detect cross-talk: multiple IOs triggered within a short time window.
 */
export function analyzeCrosstalk(
  expectedIo: GuidedSequenceItem,
  triggeredIos: GuidedSequenceItem[]
): SwapDetectionResult {
  const names = triggeredIos.map(io => io.ioDescription || io.ioName).join(', ')

  return {
    detected: true,
    type: 'crosstalk',
    confidence: 'medium',
    expectedIo,
    triggeredIo: triggeredIos[0], // Primary triggered IO
    suggestedFailureMode: 'Cross-talk',
    suggestedComment: `Cross-talk or short detected: Expected "${expectedIo.ioDescription || expectedIo.ioName}" ` +
      `but multiple IOs triggered: ${names}`,
    suggestedTrade: 'ELEC',
  }
}

// ── Auto Failure Mode Inference ────────────────────────────────────

export type FailureSituation =
  | 'swap'
  | 'no_response'
  | 'intermittent'
  | 'device_faulted'
  | 'not_installed'
  | 'out_of_range'
  | 'crosstalk'
  | 'manual'

/**
 * Get auto-suggested failure mode, comment, and trade for a failure situation.
 */
export function inferFailureMode(
  situation: FailureSituation,
  context?: {
    expectedIo?: GuidedSequenceItem
    triggeredIo?: GuidedSequenceItem
    deviceName?: string
    readValue?: number
    expectedValue?: number
    tolerance?: number
  }
): AutoFailureMode {
  switch (situation) {
    case 'swap': {
      const expected = context?.expectedIo?.ioDescription || context?.expectedIo?.ioName || 'unknown'
      const triggered = context?.triggeredIo?.ioDescription || context?.triggeredIo?.ioName || 'unknown'
      return {
        failureMode: 'Wrong wiring',
        comment: `Swap with ${triggered} (expected: ${expected})`,
        trade: 'ELEC',
      }
    }

    case 'no_response':
      return {
        failureMode: 'No response',
        comment: 'No state change detected during guided test',
        trade: 'ELEC',
      }

    case 'intermittent':
      return {
        failureMode: 'Intermittent',
        comment: 'Signal dropped during test — possible loose connection',
        trade: 'ELEC',
      }

    case 'device_faulted':
      return {
        failureMode: 'Configuration error',
        comment: `Network device ${context?.deviceName || 'unknown'} has connection fault`,
        trade: 'CONTROLS',
      }

    case 'not_installed':
      return {
        failureMode: 'Not installed',
        comment: 'Device not installed per installation tracker',
        trade: 'MECH',
      }

    case 'out_of_range': {
      const read = context?.readValue ?? '?'
      const expected = context?.expectedValue ?? '?'
      const tol = context?.tolerance ?? '?'
      return {
        failureMode: 'Configuration error',
        comment: `Read ${read}, expected ${expected} (tolerance: ±${tol})`,
        trade: 'CONTROLS',
      }
    }

    case 'crosstalk':
      return {
        failureMode: 'Cross-talk',
        comment: 'Multiple IOs triggered simultaneously — possible short or wiring error',
        trade: 'ELEC',
      }

    case 'manual':
    default:
      return {
        failureMode: '',
        comment: '',
        trade: 'ELEC',
      }
  }
}

/**
 * Auto-assign priority based on IO characteristics and urgency.
 */
export function computePriority(
  ioDescription: string | null,
  _daysToTurnover?: number
): number {
  const desc = (ioDescription || '').toUpperCase()

  // Device importance
  let importance = 50 // default
  if (desc.includes('ESTOP') || desc.includes('E-STOP') || desc.includes('EMERGENCY')) {
    importance = 100
  } else if (desc.includes('SAFETY') || desc.includes('GUARD') || desc.includes('GATE')) {
    importance = 90
  } else if (desc.includes('MOTOR') || desc.includes('VFD') || desc.includes('DRIVE')) {
    importance = 80
  } else if (desc.includes('PHOTO') || desc.includes('PROX') || desc.includes('SENSOR')) {
    importance = 60
  } else if (desc.includes('BEACON') || desc.includes('LIGHT') || desc.includes('HORN')) {
    importance = 40
  } else if (desc.includes('INDICATOR') || desc.includes('LAMP')) {
    importance = 30
  }

  // Urgency multiplier based on days to turnover
  let multiplier = 1.0
  if (_daysToTurnover !== undefined) {
    if (_daysToTurnover <= 1) multiplier = 3.0
    else if (_daysToTurnover <= 7) multiplier = 2.0
    else if (_daysToTurnover <= 14) multiplier = 1.5
  }

  return Math.round(importance * multiplier)
}
