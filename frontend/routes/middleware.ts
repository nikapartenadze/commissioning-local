import { Request, Response, NextFunction, RequestHandler } from 'express'
import { verifyAuth } from '@/lib/auth/middleware'
import type { DecodedToken } from '@/lib/auth/jwt'

// Extend Express Request to carry auth user and fix param types
declare global {
  namespace Express {
    interface Request {
      user?: DecodedToken
      // Override params to always be Record<string, string> (Router guarantees this)
      params: Record<string, string>
    }
  }
}

/** The only endpoint a must-change-PIN session may reach. */
function isChangePinPath(req: Request): boolean {
  const p = (req.path || req.originalUrl || '').replace(/\/+$/, '')
  return p.endsWith('/auth/change-pin')
}

/** Express middleware: verify auth token, attach user to req */
export const authMiddleware: RequestHandler = (req, res, next) => {
  const result = verifyAuth(req as any)
  if (!result.success) {
    res.status(401).json({ error: result.error || 'Unauthorized' })
    return
  }
  req.user = result.user!
  // First-run hardening: a session still flagged must-change-PIN (the seeded
  // default admin) may ONLY call the change-PIN endpoint. Every other route is
  // refused so a client that ignores the mustChangePin login response can't
  // operate on the default PIN. Open mode never sets the claim, so this is a
  // no-op there.
  if (req.user?.mustChangePin === true && !isChangePinPath(req)) {
    res.status(403).json({ error: 'PIN change required', code: 'must-change-pin' })
    return
  }
  next()
}

/** Express middleware: verify admin role */
export const adminMiddleware: RequestHandler = (req, res, next) => {
  authMiddleware(req, res, () => {
    if (!req.user?.isAdmin) {
      res.status(403).json({ error: 'Forbidden' })
      return
    }
    next()
  })
}

/** Wrapper: creates Express handler from a function that receives (req, user) */
export function withAuth(
  handler: (req: Request, user: DecodedToken, res: Response) => Promise<void>
): RequestHandler[] {
  return [
    authMiddleware,
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        await handler(req, req.user!, res)
      } catch (e) {
        next(e)
      }
    },
  ]
}

export function withAdmin(
  handler: (req: Request, user: DecodedToken, res: Response) => Promise<void>
): RequestHandler[] {
  return [
    adminMiddleware,
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        await handler(req, req.user!, res)
      } catch (e) {
        next(e)
      }
    },
  ]
}
