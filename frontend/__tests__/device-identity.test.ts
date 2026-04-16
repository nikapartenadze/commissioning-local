import { describe, it, expect } from 'vitest'
import { isLoopbackIp } from '@/lib/device-identity'

describe('isLoopbackIp', () => {
  it('returns true for IPv4 loopback', () => {
    expect(isLoopbackIp('127.0.0.1')).toBe(true)
  })

  it('returns true for IPv6 loopback', () => {
    expect(isLoopbackIp('::1')).toBe(true)
  })

  it('returns true for IPv4-mapped IPv6 loopback', () => {
    expect(isLoopbackIp('::ffff:127.0.0.1')).toBe(true)
  })

  it('returns false for LAN IPv4', () => {
    expect(isLoopbackIp('192.168.1.45')).toBe(false)
  })

  it('returns false for public IPv4', () => {
    expect(isLoopbackIp('8.8.8.8')).toBe(false)
  })

  it('returns false for arbitrary IPv6', () => {
    expect(isLoopbackIp('fe80::1')).toBe(false)
  })

  it('returns false for empty string', () => {
    expect(isLoopbackIp('')).toBe(false)
  })

  it('returns false for undefined', () => {
    expect(isLoopbackIp(undefined)).toBe(false)
  })

  it('returns false for null-like string "null"', () => {
    expect(isLoopbackIp('null')).toBe(false)
  })
})
