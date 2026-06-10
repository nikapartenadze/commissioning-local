import { describe, it, expect } from 'vitest'
import { getPartyResponsible } from '@/lib/party-responsible'

/**
 * Mirrors commissioning-cloud/tests/party-responsible.test.ts. The two
 * getPartyResponsible() implementations are hand-synced across repos because
 * both derive the cloud "Party Responsible" column from ios.failure_mode.
 */
describe('getPartyResponsible', () => {
  it('maps the canonical descriptive vocabulary to the right party', () => {
    expect(getPartyResponsible('Not installed')).toBe('Electrical')
    expect(getPartyResponsible('Wrong wiring')).toBe('Electrical')
    expect(getPartyResponsible('Not programmed')).toBe('Controls')
    expect(getPartyResponsible('Vendor blocked')).toBe('3rd Party')
    expect(getPartyResponsible('Guard rail missing')).toBe('Mechanical')
  })

  it('tolerates casing and whitespace drift (the field-data bug)', () => {
    // 'Not Installed' (capital I), stray spaces, lower/upper — all must map,
    // not fall through to null (which left Party Responsible blank).
    expect(getPartyResponsible('Not Installed')).toBe('Electrical')
    expect(getPartyResponsible('  not installed  ')).toBe('Electrical')
    expect(getPartyResponsible('NOT PROGRAMMED')).toBe('Controls')
    expect(getPartyResponsible('vendor blocked')).toBe('3rd Party')
  })

  it('returns null for Other, empty, and unknown reasons', () => {
    expect(getPartyResponsible('Other')).toBeNull()
    expect(getPartyResponsible('')).toBeNull()
    expect(getPartyResponsible('   ')).toBeNull()
    expect(getPartyResponsible(null)).toBeNull()
    expect(getPartyResponsible(undefined)).toBeNull()
    // Functional-check outcomes are not party-mappable (see the guided-mode note).
    expect(getPartyResponsible('No Response')).toBeNull()
    expect(getPartyResponsible('No Drop')).toBeNull()
  })

  it('still honors the legacy party-name vocabulary', () => {
    expect(getPartyResponsible('Mech')).toBe('Mechanical')
    expect(getPartyResponsible('Mechanical')).toBe('Mechanical')
    expect(getPartyResponsible('3rd Party')).toBe('3rd Party')
  })
})
