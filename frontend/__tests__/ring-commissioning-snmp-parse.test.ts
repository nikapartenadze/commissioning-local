import { describe, it, expect } from 'vitest'
import { parseLldpNeighbors, parseFdb, type SnmpRow } from '@/lib/plc/network/ring-commissioning/snmp/parse'
import { OID } from '@/lib/plc/network/ring-commissioning/snmp/mibs'

describe('parseLldpNeighbors', () => {
  it('turns lldpRem rows into SwitchLinks, resolving chassis-id to a device name', () => {
    // index scheme: <timemark>.<localPort>.<remoteIndex>
    const rows: SnmpRow[] = [
      { oid: `${OID.lldpRemChassisId}.0.3.1`, value: 'aa:bb:cc:00:00:02' },
      { oid: `${OID.lldpRemPortId}.0.3.1`, value: '1' },
    ]
    const links = parseLldpNeighbors(rows, 'DPM1', (chassis) => chassis === 'aa:bb:cc:00:00:02' ? 'DPM2' : chassis)
    expect(links).toEqual([{ localDevice: 'DPM1', localPort: 3, remoteDevice: 'DPM2', remotePort: 1 }])
  })
})

describe('parseFdb', () => {
  it('maps a learned MAC on a bridge port to a leaf device on the physical port', () => {
    const rows: SnmpRow[] = [
      // dot1dTpFdbPort indexed by decimal MAC; value = bridge port number
      { oid: `${OID.dot1dTpFdbPort}.0.26.187.0.0.9`, value: '7' },
    ]
    const portIfIndex = new Map<number, number>([[7, 7]]) // bridge port 7 -> phys port 7
    const leaves = parseFdb(rows, 'DPM1', portIfIndex, (mac) => mac === '00:1a:bb:00:00:09' ? 'UL17_8_FIOM1' : null)
    expect(leaves).toEqual([{ device: 'UL17_8_FIOM1', switchName: 'DPM1', port: 7 }])
  })

  it('drops MACs that resolve to no known device', () => {
    const rows: SnmpRow[] = [{ oid: `${OID.dot1dTpFdbPort}.0.0.0.0.0.1`, value: '5' }]
    expect(parseFdb(rows, 'DPM1', new Map([[5, 5]]), () => null)).toEqual([])
  })
})
