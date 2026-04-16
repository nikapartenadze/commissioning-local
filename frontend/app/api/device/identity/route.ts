import { Request, Response } from 'express'
import { isLoopbackIp } from '@/lib/device-identity'

/**
 * GET /api/device/identity
 *
 * Classifies the requesting device as the server machine (loopback) or a remote device.
 * Used by the React UserProvider to decide whether to auto-name the session
 * "Server Laptop" or prompt the user.
 *
 * No auth — called before the user is established.
 */
export async function GET(req: Request, res: Response) {
  // Express sets req.ip from socket.remoteAddress (trust proxy is off by default).
  // Fall back to socket.remoteAddress in case req.ip is not populated.
  const ip = (req.ip && req.ip.length > 0 ? req.ip : req.socket?.remoteAddress) || ''
  const isServerDevice = isLoopbackIp(ip)
  return res.json({ isServerDevice })
}
