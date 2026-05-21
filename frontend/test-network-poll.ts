#!/usr/bin/env tsx
/**
 * Smoke test for the network device poller. Connects to a real PLC, runs
 * one discovery pass + a few poll cycles, and prints what came back.
 *
 * Usage:
 *   npm run test:plc:network
 *
 * Env:
 *   PLC_IP       PLC ip address    (default 192.168.20.40)
 *   PLC_PATH     PLC path          (default 1,0)
 *   POLL_CYCLES  number of cycles  (default 3)
 *   FALLBACK     comma-separated device names to probe if @tags browse is empty
 */

import { initLibrary } from './lib/plc/libplctag'
import { NetworkPoller } from './lib/plc/network'

const PLC_IP = process.env.PLC_IP ?? '192.168.20.40'
const PLC_PATH = process.env.PLC_PATH ?? '1,0'
const POLL_CYCLES = Number(process.env.POLL_CYCLES ?? '3')
const FALLBACK = (process.env.FALLBACK ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)

async function main() {
  console.log(`[smoke] Connecting to PLC ${PLC_IP} (path ${PLC_PATH})`)
  initLibrary()

  const poller = new NetworkPoller({
    pollIntervalMs: 1_500, // tighter for the smoke test
    fallbackDevices: FALLBACK,
  })
  poller.setConnection(PLC_IP, PLC_PATH)

  let cyclesSeen = 0
  poller.on('discovered', (names) => {
    console.log(`[smoke] discovered: ${names.length} device(s) -> ${names.join(', ') || '(none)'}`)
  })
  poller.on('snapshot', (snap) => {
    cyclesSeen++
    const linked = snap.ports.filter((p) => p.linkUp).map((p) => `p${p.portNumber}@${p.speedMbps}Mbps`)
    console.log(
      `[smoke] ${snap.deviceName} pc=${snap.productCode} fw=${snap.firmwareMajor}.${snap.firmwareMinor} links=[${linked.join(', ')}]`,
    )
  })
  poller.on('deviceError', (deviceName, msg) => {
    console.log(`[smoke] device error ${deviceName}: ${msg}`)
  })
  poller.on('error', (err) => {
    console.error('[smoke] poller error:', err.message)
  })

  await poller.start()

  // Spin until we've seen POLL_CYCLES snapshots PER discovered device, or 20s.
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500))
    if (cyclesSeen >= POLL_CYCLES * Math.max(1, poller.getLatestSnapshots().length)) break
  }

  console.log(`[smoke] stopping after ${cyclesSeen} snapshot event(s)`)
  await poller.stop()
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error('[smoke] fatal:', err)
    process.exit(1)
  },
)
