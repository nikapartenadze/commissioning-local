import { Request, Response } from 'express'
import { configService } from '@/lib/config'

/**
 * POST /api/mcm/pull-all
 *
 * Pull the full cloud IO dataset (IO definitions + current results + safety /
 * network / punchlist state) for EVERY configured station into local SQLite, in
 * one press. It self-calls the existing guarded per-MCM pull (POST
 * /api/mcm/:id/pull) sequentially so all the safety rails apply unchanged: the
 * pre-pull DB backup, the "don't clobber unsynced local results" guard, and the
 * scoped delete+reinsert. Sequential (not parallel) on purpose — a pull is a
 * heavy scoped rewrite and we don't want N of them fighting the same SQLite
 * writer or the cloud rate-limiter at once.
 *
 * Returns a per-station result list; one station failing never aborts the rest.
 */
export async function POST(_req: Request, res: Response) {
  const cfg = await configService.getConfig()
  const mcms = Array.isArray(cfg.mcms) ? cfg.mcms.filter((m) => m.enabled !== false) : []
  const port = process.env.PORT || '3000'

  const results: Array<{ subsystemId: string; name: string; ok: boolean; detail: string }> = []

  for (const m of mcms) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/mcm/${encodeURIComponent(m.subsystemId)}/pull`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
        signal: AbortSignal.timeout(120_000),
      })
      let detail = `HTTP ${r.status}`
      try {
        const data: any = await r.json()
        if (data && typeof data === 'object') {
          detail = data.message || data.error || data.result || detail
        }
      } catch {
        /* non-JSON body — keep the HTTP status */
      }
      results.push({ subsystemId: m.subsystemId, name: m.name, ok: r.ok, detail })
    } catch (e) {
      results.push({
        subsystemId: m.subsystemId,
        name: m.name,
        ok: false,
        detail: e instanceof Error ? e.message : 'pull failed',
      })
    }
  }

  const okCount = results.filter((r) => r.ok).length
  return res.json({
    success: true,
    total: results.length,
    pulled: okCount,
    failed: results.length - okCount,
    results,
  })
}
