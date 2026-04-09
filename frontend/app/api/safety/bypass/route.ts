import { Request, Response } from 'express'
import { getPlcClient } from '@/lib/plc-client-manager'

const activeBypass = (globalThis as any).__activeBypass ??= new Map<string, NodeJS.Timeout>()

export async function POST(req: Request, res: Response) {
  try {
    const { bssTag, action } = req.body

    if (!bssTag || typeof bssTag !== 'string') {
      return res.status(400).json({ success: false, error: 'bssTag is required' })
    }

    const client = getPlcClient()
    if (!client.isConnected) {
      return res.status(503).json({ success: false, error: 'PLC not connected' })
    }

    if (action === 'start') {
      if (activeBypass.has(bssTag)) clearInterval(activeBypass.get(bssTag)!)
      const result = client.writeOutputBit({ id: -1, name: bssTag }, 1)
      if (!result.success) return res.status(500).json({ success: false, error: result.error })

      const interval = setInterval(() => {
        try {
          if (client.isConnected) { client.writeOutputBit({ id: -1, name: bssTag }, 1) }
          else { clearInterval(interval); activeBypass.delete(bssTag) }
        } catch { clearInterval(interval); activeBypass.delete(bssTag) }
      }, 500)
      activeBypass.set(bssTag, interval)
      console.log(`[SafetyBypass] STARTED bypass on ${bssTag}`)
      return res.json({ success: true, bssTag, active: true })
    }

    if (action === 'stop') {
      if (activeBypass.has(bssTag)) { clearInterval(activeBypass.get(bssTag)!); activeBypass.delete(bssTag) }
      try { client.writeOutputBit({ id: -1, name: bssTag }, 0) } catch {}
      console.log(`[SafetyBypass] STOPPED bypass on ${bssTag}`)
      return res.json({ success: true, bssTag, active: false })
    }

    return res.status(400).json({ success: false, error: 'action must be start or stop' })
  } catch (error) {
    return res.status(500).json({ success: false, error: 'Failed to control bypass' })
  }
}

export async function GET(req: Request, res: Response) {
  const active = Array.from(activeBypass.keys())
  return res.json({ success: true, active })
}
