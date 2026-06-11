import { Request, Response } from 'express'
import { getJob } from '@/lib/logix-sdk-bridge'

/** GET /api/controller-management/job?id=<jobId> - poll a download/upload job. */
export async function GET(req: Request, res: Response) {
  const id = String(req.query.id || '')
  if (!id) return res.status(400).json({ error: 'id required' })
  const job = getJob(id)
  if (!job) return res.status(404).json({ error: 'job not found' })
  return res.json({
    id: job.id,
    op: job.op,
    status: job.status,
    percent: job.percent,
    statusText: job.statusText,
    error: job.error,
    result: job.result,
    logs: job.logs.slice(-40),
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
  })
}
