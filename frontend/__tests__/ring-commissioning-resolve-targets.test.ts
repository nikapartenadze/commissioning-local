import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import { resolveSwitchTargets } from '@/lib/plc/network/ring-commissioning/resolve-targets'

function db() {
  const d = new Database(':memory:')
  d.exec(`CREATE TABLE NetworkRings(id INTEGER PRIMARY KEY, SubsystemId INT, Name TEXT, McmName TEXT, McmIp TEXT, McmTag TEXT);
          CREATE TABLE NetworkNodes(id INTEGER PRIMARY KEY, RingId INT, Name TEXT, Position INT, IpAddress TEXT, StatusTag TEXT, TotalPorts INT);
          CREATE TABLE NetworkPorts(id INTEGER PRIMARY KEY, NodeId INT, PortNumber INT, DeviceName TEXT, DeviceIp TEXT, DeviceType TEXT, StatusTag TEXT, ParentPortId INT);`)
  d.prepare('INSERT INTO NetworkRings VALUES (1,40,?,?,?,?)').run('CDW5 Ring', 'MCM01', '11.0.0.1', 'MCM01_NN')
  d.prepare('INSERT INTO NetworkNodes VALUES (1,1,?,1,?,?,28)').run('UL17_8_DPM1', '11.0.0.10', 'DPM1_NN')
  d.prepare('INSERT INTO NetworkNodes VALUES (2,1,?,2,?,?,28)').run('UL17_8_DPM2', '11.0.0.11', 'DPM2_NN')
  return d
}

describe('resolveSwitchTargets', () => {
  it('builds one ring with its switch IPs from NetworkNodes', () => {
    const rings = resolveSwitchTargets(db(), 40)
    expect(rings.length).toBe(1)
    expect(rings[0].ringName).toBe('CDW5 Ring')
    expect(rings[0].switches.map(s => s.ip).sort()).toEqual(['11.0.0.10', '11.0.0.11'])
  })

  it('resolveChassis maps an id embedding a node name back to that node', () => {
    const rings = resolveSwitchTargets(db(), 40)
    expect(rings[0].resolveChassis('chassis-UL17_8_DPM2-x')).toBe('UL17_8_DPM2')
    expect(rings[0].resolveChassis('unknown')).toBe('unknown')
  })
})
