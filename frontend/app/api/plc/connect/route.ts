import { Request, Response } from 'express'
import { connectPlc } from '@/lib/plc-client-manager';

interface ConnectRequestBody {
  ip: string;
  path: string;
}

export async function POST(req: Request, res: Response) {
  try {
    const body: ConnectRequestBody = req.body;

    if (!body.ip || typeof body.ip !== 'string') {
      return res.status(400).json({ success: false, error: 'Missing or invalid "ip" field' });
    }

    if (!body.path || typeof body.path !== 'string') {
      return res.status(400).json({ success: false, error: 'Missing or invalid "path" field' });
    }

    console.log(`Connecting to PLC at ${body.ip} with path ${body.path}`);

    const result = await connectPlc({ ip: body.ip, path: body.path });

    if (result.success) {
      return res.json({
        success: true,
        message: `Connected to PLC at ${body.ip}`,
        status: result.status,
      });
    } else {
      return res.status(500).json({
        success: false,
        error: result.error || 'Failed to connect to PLC',
        status: result.status,
      });
    }
  } catch (error) {
    console.error('PLC connect error:', error);
    return res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Internal server error',
    });
  }
}
