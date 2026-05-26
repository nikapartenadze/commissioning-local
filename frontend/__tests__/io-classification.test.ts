import { describe, expect, it } from 'vitest'
import { isOutputIo, isSafetyOutput } from '@/lib/io-classification'

describe('isOutputIo — name-driven conventions', () => {
  it('matches standard output tokens', () => {
    expect(isOutputIo('Local:1:O.Data.0')).toBe(true)
    expect(isOutputIo('FIOM_01_DO.5')).toBe(true)
    expect(isOutputIo('Conveyor_DO')).toBe(true)
    expect(isOutputIo('Rack:2:O:Data')).toBe(true)
    expect(isOutputIo('Cell.Outputs.Lamp')).toBe(true)
    expect(isOutputIo('STD_BSD_Reset')).toBe(true)
  })

  it('matches analog outputs', () => {
    expect(isOutputIo('Drive:1:AO.Data.0')).toBe(true)
    expect(isOutputIo('SpeedRef_AO')).toBe(true)
  })

  it('treats safety outputs as outputs', () => {
    expect(isOutputIo('Safety:1:SO.Data.0')).toBe(true)
    expect(isSafetyOutput('Safety:1:SO.Data.0')).toBe(true)
    expect(isSafetyOutput('Local:1:O.Data.0')).toBe(false)
  })

  it('does not match inputs', () => {
    expect(isOutputIo('Local:1:I.Data.0')).toBe(false)
    expect(isOutputIo('Sensor_DI')).toBe(false)
    expect(isOutputIo('Drive:1:AI.Data.0')).toBe(false)
    expect(isOutputIo('PB_Start_DI.3')).toBe(false)
  })
})

describe('isOutputIo — beacon animation members are outputs', () => {
  it('matches PlantPAx beacon segment animation tags', () => {
    expect(
      isOutputIo('PS10_5_CH1_BCN1_PD.Advanced_PD.Segment_1.Animation_Type.0'),
    ).toBe(true)
    expect(
      isOutputIo('PS10_5_CH1_BCN1_PD.Advanced_PD.Segment_2.Animation_Type.0'),
    ).toBe(true)
  })

  it('is case-insensitive on the beacon pattern', () => {
    expect(
      isOutputIo('x_pd.advanced_pd.segment_12.animation_type.0'),
    ).toBe(true)
  })
})

describe('isOutputIo — description-driven (SOLENOID)', () => {
  it('treats any SOLENOID description as an output regardless of name', () => {
    expect(isOutputIo('Some_Tag_With_No_Output_Token', 'AIR SOLENOID VALVE')).toBe(true)
    expect(isOutputIo('Local:1:I.Data.0', 'solenoid')).toBe(true)
  })

  it('does not over-match a normal input with an unrelated description', () => {
    expect(isOutputIo('Local:1:I.Data.0', 'PROXIMITY SENSOR')).toBe(false)
  })
})

describe('isOutputIo — null/undefined safety', () => {
  it('handles missing name and description', () => {
    expect(isOutputIo(null, null)).toBe(false)
    expect(isOutputIo(undefined, undefined)).toBe(false)
    expect(isSafetyOutput(null)).toBe(false)
  })
})
