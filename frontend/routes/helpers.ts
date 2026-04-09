import { Request, Response } from 'express'

/** Parse dynamic route params (mirrors Next.js params) */
export function getParam(req: Request, name: string): string {
  const val = req.params[name]
  return typeof val === 'string' ? val : ''
}

/** Parse query string params (mirrors request.nextUrl.searchParams) */
export function getQuery(req: Request, name: string): string | null {
  const val = req.query[name]
  if (typeof val === 'string') return val
  if (Array.isArray(val)) return val[0] as string
  return null
}

/** Send JSON response with optional status (mirrors NextResponse.json) */
export function jsonResponse(res: Response, data: any, status = 200): void {
  res.status(status).json(data)
}
