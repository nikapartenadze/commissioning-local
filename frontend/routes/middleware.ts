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

/** Express middleware: verify auth token, attach user to req */
export const authMiddleware: RequestHandler = (req, res, next) => {
  const result = verifyAuth(req as any)
  if (!result.success) {
    res.status(401).json({ error: result.error || 'Unauthorized' })
    return
  }
  req.user = result.user!
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
