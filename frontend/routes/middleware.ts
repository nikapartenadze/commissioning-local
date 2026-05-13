import { Request, Response, NextFunction, RequestHandler } from 'express'
import { verifyAuth } from '@/lib/auth/middleware'
import type { DecodedToken } from '@/lib/auth/jwt'
import { isLoopbackIp } from '@/lib/device-identity'

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

/**
 * Express middleware: refuse test/fire/reset actions when the request originates
 * from the Server Laptop itself (loopback IP). The Server Laptop is the sync
 * and PLC-broker host; operators on it shouldn't author test results. History
 * was getting entries like "Server Laptop failed IO" because the browser on
 * the server machine was being used as a testing terminal — block that path
 * authoritatively. Remote (Client Laptop) browsers are untouched.
 *
 * Apply to: pass/fail, reset, fire-output, mark-passed/failed, safety/fire.
 */
export const noTestingOnServerLaptop: RequestHandler = (req, res, next) => {
  const ip = (req.ip && req.ip.length > 0 ? req.ip : req.socket?.remoteAddress) || ''
  if (isLoopbackIp(ip)) {
    res.status(403).json({
      error: 'Server Laptop cannot author test results. Mark IOs from a Client Laptop browser instead.',
      reason: 'server-laptop-no-testing',
    })
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
