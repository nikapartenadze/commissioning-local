import { Request, Response } from 'express'
import { isAuthRequired } from '@/lib/auth/middleware'

/**
 * Public endpoint (no auth) — tells the client whether login is enforced.
 *
 * The client fetches this on boot. When `required` is true it shows the
 * login screen and attaches Bearer tokens; when false it keeps the existing
 * open / single-laptop flow.
 */
export async function GET(_req: Request, res: Response) {
  return res.json({ required: isAuthRequired() })
}
