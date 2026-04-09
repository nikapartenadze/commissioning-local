import { Request, Response } from 'express'
import { verifyAuth } from '@/lib/auth/middleware';

export async function GET(req: Request, res: Response) {
  const result = verifyAuth(req as any);

  if (!result.success) {
    return res.status(result.status || 401).json({ message: result.error });
  }

  const user = result.user!;

  return res.json({
    id: user.sub,
    fullName: user.fullName,
    isAdmin: user.isAdmin,
    exp: user.exp,
    iat: user.iat,
  });
}
