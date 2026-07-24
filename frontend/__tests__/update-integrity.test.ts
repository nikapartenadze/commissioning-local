import { describe, it, expect } from 'vitest'
import { isValidSha256, validateInstallerUrl, envAllowsHttp } from '@/lib/update/integrity'

// Integrity policy for the auto-update channel (lib/update/integrity.ts).
// These helpers gate what install-launcher.ts will pass to
// tools/install-update.ps1 — the last code that runs before an installer
// executes as SYSTEM — so the edge cases here are load-bearing.

describe('isValidSha256', () => {
  it('accepts a 64-char lowercase hex digest', () => {
    expect(isValidSha256('a'.repeat(64))).toBe(true)
    expect(isValidSha256('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')).toBe(true)
  })

  it('accepts uppercase and mixed case (Get-FileHash returns uppercase)', () => {
    expect(isValidSha256('E3B0C44298FC1C149AFBF4C8996FB92427AE41E4649B934CA495991B7852B855')).toBe(true)
    expect(isValidSha256('E3b0C44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')).toBe(true)
  })

  it('rejects wrong lengths', () => {
    expect(isValidSha256('')).toBe(false)
    expect(isValidSha256('a'.repeat(63))).toBe(false)
    expect(isValidSha256('a'.repeat(65))).toBe(false)
    // MD5 / SHA-1 lengths must not slip through
    expect(isValidSha256('d41d8cd98f00b204e9800998ecf8427e')).toBe(false)
    expect(isValidSha256('da39a3ee5e6b4b0d3255bfef95601890afd80709')).toBe(false)
  })

  it('rejects non-hex content and injection-shaped strings', () => {
    expect(isValidSha256('g'.repeat(64))).toBe(false)
    expect(isValidSha256('a'.repeat(63) + ' ')).toBe(false)
    expect(isValidSha256('a'.repeat(62) + '; ')).toBe(false)
  })
})

describe('validateInstallerUrl', () => {
  it('accepts https for any host', () => {
    expect(validateInstallerUrl('https://commissioning.autstand.com/downloads/CommissioningTool-Setup-v2.49.0.exe').ok).toBe(true)
    expect(validateInstallerUrl('https://10.0.0.5/x.exe').ok).toBe(true)
  })

  it('accepts http for loopback hosts without any opt-in', () => {
    expect(validateInstallerUrl('http://localhost:13001/downloads/a.exe').ok).toBe(true)
    expect(validateInstallerUrl('http://127.0.0.1:3000/downloads/a.exe').ok).toBe(true)
    expect(validateInstallerUrl('http://[::1]:3000/a.exe').ok).toBe(true)
  })

  it('rejects http for non-loopback hosts by default', () => {
    const r = validateInstallerUrl('http://commissioning.autstand.com/downloads/a.exe')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/https/i)
    expect(validateInstallerUrl('http://192.168.1.50:3000/a.exe').ok).toBe(false)
    // NOT loopback even though it resolves there on some setups
    expect(validateInstallerUrl('http://localhost.evil.com/a.exe').ok).toBe(false)
  })

  it('allows http for non-loopback hosts when allowHttp is set (battle/soak rigs)', () => {
    expect(validateInstallerUrl('http://cloud:3000/downloads/a.exe', { allowHttp: true }).ok).toBe(true)
    expect(validateInstallerUrl('http://linkshaper:3000/downloads/a.exe', { allowHttp: true }).ok).toBe(true)
  })

  it('rejects non-http(s) schemes and garbage', () => {
    expect(validateInstallerUrl('file:///C:/evil.exe').ok).toBe(false)
    expect(validateInstallerUrl('ftp://host/a.exe').ok).toBe(false)
    expect(validateInstallerUrl('javascript:alert(1)').ok).toBe(false)
    expect(validateInstallerUrl('not a url').ok).toBe(false)
    expect(validateInstallerUrl('').ok).toBe(false)
    // scheme-relative / case tricks
    expect(validateInstallerUrl('HTTPS://host/a.exe').ok).toBe(true)
    expect(validateInstallerUrl('HTTP://192.168.1.50/a.exe').ok).toBe(false)
  })
})

describe('envAllowsHttp', () => {
  it('is off by default and for falsy/unknown values', () => {
    expect(envAllowsHttp(undefined)).toBe(false)
    expect(envAllowsHttp('')).toBe(false)
    expect(envAllowsHttp('0')).toBe(false)
    expect(envAllowsHttp('false')).toBe(false)
    expect(envAllowsHttp('no')).toBe(false)
  })

  it('accepts the documented opt-in spellings', () => {
    expect(envAllowsHttp('1')).toBe(true)
    expect(envAllowsHttp('true')).toBe(true)
    expect(envAllowsHttp('TRUE')).toBe(true)
    expect(envAllowsHttp(' yes ')).toBe(true)
  })
})
