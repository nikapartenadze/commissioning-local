/**
 * SNMP OID constants for ring-commissioning reads.
 *
 * Standard MIBs (LLDP, BRIDGE) are exact and vendor-neutral. Vendor ring-state
 * OIDs: MRP is confirmed (Hirschmann HMRING MIB); the Moxa Turbo Ring OID is a
 * documented PLACEHOLDER — fill it from the Moxa Industrial Protocols manual
 * (moxa.com/.../moxa-industrial-protocol-users-guide-manual-v6.6.pdf) against
 * real MTN6 hardware. Until it is set, the Moxa adapter reports ring source
 * 'moxa' with closed:false and a clear reason — it never false-greens.
 */
export const OID = {
  // LLDP-MIB (IEEE 802.1AB) — remote systems table
  lldpRemChassisId: '1.0.8802.1.1.2.1.4.1.1.5',
  lldpRemPortId: '1.0.8802.1.1.2.1.4.1.1.7',
  lldpLocPortDesc: '1.0.8802.1.1.2.1.3.7.1.4',
  // BRIDGE-MIB — forwarding database + bridge-port -> ifIndex mapping
  dot1dTpFdbPort: '1.3.6.1.2.1.17.4.3.1.2',
  dot1dBasePortIfIndex: '1.3.6.1.2.1.17.1.4.1.2',
  // Vendor ring state
  hmMrpMRMRealRingState: '1.3.6.1.4.1.248.14.5.3.1.25', // open(1)/closed(2)/undefined(3)
  moxaTurboRingState: '', // PLACEHOLDER — see file header; empty => Moxa adapter self-reports unconfigured
} as const
