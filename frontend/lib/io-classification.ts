/**
 * Centralized IO output / safety-output classification.
 *
 * This logic used to be duplicated (with subtle differences) across the grid,
 * the commissioning page, the value-change dialog, the dashboard CSV export,
 * the guided device-test panel, and the IO API routes. This module is now the
 * single source of truth so the "Fire" button, the Inputs/Outputs filters, and
 * the exported `isOutput` flag all agree.
 *
 * An IO is an "output" (a point we drive / can fire) when its tag name matches
 * a known output naming convention, OR when its engineering description marks
 * it as an actuator. Two field-reported rules live here:
 *   - PlantPAx beacon animation members
 *     (e.g. `..._PD.Advanced_PD.Segment_1.Animation_Type.0`) are outputs even
 *     though the name carries no `:O.` token.
 *   - Anything whose description contains SOLENOID is an actuator -> output.
 */

// Beacon segment animation control member, e.g.
//   PS10_5_CH1_BCN1_PD.Advanced_PD.Segment_1.Animation_Type.0
const BEACON_ANIMATION = /Advanced_PD\.Segment_\d+\.Animation_Type/i

/**
 * True when the IO is an output. Pass the description when available so
 * description-driven rules (e.g. SOLENOID) can apply.
 */
export function isOutputIo(name?: string | null, description?: string | null): boolean {
  const n = name ?? ''
  const d = description ?? ''

  // Description-driven: solenoids are actuators (outputs).
  if (/solenoid/i.test(d)) return true

  // Name-driven output naming conventions (union of all historical patterns).
  return (
    n.includes(':O.') ||
    n.includes(':SO.') || // safety output — an output, but not directly fireable
    n.includes(':AO.') ||
    n.includes(':O:') ||
    n.includes('.O.') ||
    n.includes('.Outputs.') ||
    n.includes('_DO.') ||
    n.includes('_AO.') ||
    n.endsWith('.DO') ||
    n.endsWith('_DO') ||
    n.endsWith('.AO') ||
    n.endsWith('_AO') ||
    n.startsWith('STD_') || // safety intermediary tags (STO/BSD control)
    BEACON_ANIMATION.test(n)
  )
}

/**
 * Safety outputs (`:SO.`) are controlled by the safety PLC and cannot be fired
 * directly. They are still outputs; the UI shows a "SAFETY" marker instead of a
 * Fire button, and the server rejects writes to them.
 */
export function isSafetyOutput(name?: string | null): boolean {
  return /:SO\./i.test(name ?? '')
}
