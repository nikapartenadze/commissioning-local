import { describe, it, expect } from 'vitest'
import { mapToVfdRows, type RawVfdJoinRow } from '@/lib/belt-tracking/mappers'
import { BELT_TRACKED_INVALIDATED, BELT_TRACKED_VALUE } from '@/lib/belt-tracking/types'

const baseRow: RawVfdJoinRow = {
  deviceId: 1,
  deviceName: 'UL17_20_VFD',
  mcm: 'MCM09',
  subsystem: 'Non-Conveyable 5 to 1 PH1',
  trackedValue: null,
  trackedBy: null,
  trackedAt: null,
  trackedVersion: 0,
  verifyValue: null, verifyAt: null, verifyBy: null,
  motorHpValue: null, motorHpAt: null, motorHpBy: null,
  vfdHpValue: null, vfdHpAt: null, vfdHpBy: null,
  directionValue: null, directionAt: null, directionBy: null,
}

const fullyVerified: Partial<RawVfdJoinRow> = {
  verifyValue: 'pass', verifyAt: '2026-04-22T12:29:01.714Z', verifyBy: 'Jonathan Pickett',
  motorHpValue: '2', motorHpAt: '2026-04-22T12:28:31.850Z', motorHpBy: 'Jonathan Pickett',
  vfdHpValue: '3', vfdHpAt: '2026-04-22T12:28:32.115Z', vfdHpBy: 'Jonathan Pickett',
  directionValue: 'pass', directionAt: '2026-04-21T18:01:10.745Z', directionBy: 'Arman',
}

describe('mapToVfdRows', () => {
  describe('Ready derivation', () => {
    it('marks ready=true when all 4 controls cells are filled and pass', () => {
      const [row] = mapToVfdRows([{ ...baseRow, ...fullyVerified }])
      expect(row.ready).toBe(true)
    })

    it('uses the latest UpdatedAt across the 4 cells for readyAt', () => {
      const [row] = mapToVfdRows([{ ...baseRow, ...fullyVerified }])
      // The latest among the four sample timestamps is verifyAt
      expect(row.readyAt).toBe('2026-04-22T12:29:01.714Z')
      expect(row.readyBy).toBe('Jonathan Pickett')
    })

    it('marks ready=false when any of the 4 controls cells is missing', () => {
      const [row] = mapToVfdRows([{ ...baseRow, ...fullyVerified, motorHpValue: null }])
      expect(row.ready).toBe(false)
      expect(row.readyAt).toBeNull()
    })

    it('marks ready=false when Verify Identity is "fail"', () => {
      const [row] = mapToVfdRows([{ ...baseRow, ...fullyVerified, verifyValue: 'fail' }])
      expect(row.ready).toBe(false)
    })

    it('marks ready=false when Check Direction is "fail"', () => {
      const [row] = mapToVfdRows([{ ...baseRow, ...fullyVerified, directionValue: 'fail' }])
      expect(row.ready).toBe(false)
    })

    it('marks ready=false when Motor HP is empty string', () => {
      const [row] = mapToVfdRows([{ ...baseRow, ...fullyVerified, motorHpValue: '' }])
      expect(row.ready).toBe(false)
    })

    it('treats "FAIL" (uppercase) as fail too', () => {
      const [row] = mapToVfdRows([{ ...baseRow, ...fullyVerified, verifyValue: 'FAIL' }])
      expect(row.ready).toBe(false)
    })
  })

  describe('Tracked derivation', () => {
    it('marks tracked=true on a non-empty cell value', () => {
      const [row] = mapToVfdRows([{
        ...baseRow,
        trackedValue: BELT_TRACKED_VALUE,
        trackedBy: 'mech-jack',
        trackedAt: '2026-04-29T11:00:00Z',
        trackedVersion: 1,
      }])
      expect(row.tracked).toBe(true)
      expect(row.trackedBy).toBe('mech-jack')
      expect(row.trackedAt).toBe('2026-04-29T11:00:00Z')
    })

    it('marks tracked=false when cell value is null', () => {
      const [row] = mapToVfdRows([baseRow])
      expect(row.tracked).toBe(false)
    })

    it('marks tracked=false on empty string', () => {
      const [row] = mapToVfdRows([{ ...baseRow, trackedValue: '' }])
      expect(row.tracked).toBe(false)
    })

    it('treats v2.20 invalidation sentinel as not-tracked and clears its metadata', () => {
      const [row] = mapToVfdRows([{
        ...baseRow,
        trackedValue: BELT_TRACKED_INVALIDATED,
        trackedBy: 'auto-migration',
        trackedAt: '2026-04-21T15:21:49Z',
        trackedVersion: 1,
      }])
      expect(row.tracked).toBe(false)
      expect(row.trackedBy).toBeNull()
      expect(row.trackedAt).toBeNull()
    })

    it('treats whitespace-only cell value as not-tracked', () => {
      const [row] = mapToVfdRows([{ ...baseRow, trackedValue: '   ' }])
      expect(row.tracked).toBe(false)
    })

    it('defaults version to 0 when null (no L2CellValues row yet)', () => {
      const [row] = mapToVfdRows([{ ...baseRow, trackedVersion: null }])
      expect(row.version).toBe(0)
    })
  })

  describe('Combined states', () => {
    it('a fully-verified VFD that is also tracked shows both flags', () => {
      const [row] = mapToVfdRows([{
        ...baseRow,
        ...fullyVerified,
        trackedValue: BELT_TRACKED_VALUE,
        trackedBy: 'mech',
        trackedAt: '2026-04-29T11:00:00Z',
      }])
      expect(row.ready).toBe(true)
      expect(row.tracked).toBe(true)
    })

    it('preserves input order (caller controls sort)', () => {
      const rows = mapToVfdRows([
        { ...baseRow, deviceId: 3, deviceName: 'V3' },
        { ...baseRow, deviceId: 1, deviceName: 'V1' },
        { ...baseRow, deviceId: 2, deviceName: 'V2' },
      ])
      expect(rows.map(r => r.deviceName)).toEqual(['V3', 'V1', 'V2'])
    })

    it('returns [] for empty input', () => {
      expect(mapToVfdRows([])).toEqual([])
    })
  })
})
