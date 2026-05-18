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
  // Escape hatch: operators in the field have reported 403s on a real Client
  // Laptop, which means Express saw `req.ip` as loopback for a remote
  // connection (multi-NIC, VPN, IPv6 quirks). Set TRUST_TESTING_FROM_ANY_IP=1
  // to disable the gate without code changes if it misfires.
  if (process.env.TRUST_TESTING_FROM_ANY_IP === '1') {
    next()
    return
  }
  const ip = (req.ip && req.ip.length > 0 ? req.ip : req.socket?.remoteAddress) || ''
  if (isLoopbackIp(ip)) {
    // Keep a breadcrumb so the next field 403 has context. Don't gate on a
    // DEBUG flag — these are rare and we want the trail by default.
    console.warn(
      `[noTestingOnServerLaptop] BLOCKED ${req.method} ${req.path} `
      + `req.ip=${req.ip} socket.remoteAddress=${req.socket?.remoteAddress} `
      + `xff=${req.headers['x-forwarded-for'] || '-'} host=${req.headers.host || '-'}`
    )
    res.status(403).json({
      error: 'Server Laptop cannot author test results. Mark IOs from a Client Laptop browser instead.',
      reason: 'server-laptop-no-testing',
      // Surface the IP Express saw so techs can tell support exactly what the
      // server thinks of their connection. If this shows their real LAN IP,
      // there's a config bug; if it shows 127.0.0.1, they are actually
      // looped back somehow.
      sourceIp: ip,
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
