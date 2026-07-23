import { Request, Response } from 'express'
import {
  getConnectionHealth,
  probeCloudNow,
  type ConnectionHealth,
} from '@/lib/cloud/connection-health'

/**
 * GET /api/cloud/connection-status
 *
 * Returns the MEASURED cloud-connection-health object that backs the Sync
 * Center banner (see lib/cloud/connection-health.ts). Cheap and passive: it
 * reads the recorded last-contact + live SSE state + queue counts; it does NOT
 * touch the network.
 *
 * GET /api/cloud/connection-status?probe=1   (or POST)
 *   Runs ONE live authenticated round-trip to the cloud NOW and classifies the
 *   real HTTP result, then returns the refreshed health object. Backs the
 *   "Test connection" button. Hard-capped by an AbortController (~8s) inside
 *   probeCloudNow() so it can NEVER hang.
 *
 * Failures degrade to `unknown` (never a 500, never "connected") so the banner
 * stays honest even if reading status itself hiccups.
 */

function wantsProbe(req: Request): boolean {
  const p = req.query?.probe
  const v = Array.isArray(p) ? p[0] : p
  return v === '1' || v === 'true' || v === 'yes'
}

async function respond(res: Response, probe: boolean): Promise<Response> {
  try {
    if (probe) await probeCloudNow()
    const health = await getConnectionHealth()
    return res.json({ ...health, probed: probe })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    console.warn('[ConnectionStatus] Failed to read connection health:', message)
    // Absence of a reliable read is NOT health — report unknown, not connected.
    const fallback: ConnectionHealth & { probed: boolean } = {
      state: 'unknown',
      lastSuccessAt: null,
      lastError: { message },
      cloudUrl: '',
      waitingCount: 0,
      probed: probe,
    }
    return res.json(fallback)
  }
}

export async function GET(req: Request, res: Response): Promise<Response> {
  return respond(res, wantsProbe(req))
}

// POST is always a live probe — the "Test connection" button may POST.
export async function POST(_req: Request, res: Response): Promise<Response> {
  return respond(res, true)
}
