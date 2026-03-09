import { NextRequest, NextResponse } from 'next/server';
import { connectPlc } from '@/lib/plc-client-manager';

interface ConnectRequestBody {
  ip: string;
  path: string;
}

export async function POST(request: NextRequest) {
  try {
    const body: ConnectRequestBody = await request.json();

    // Validate required fields
    if (!body.ip || typeof body.ip !== 'string') {
      return NextResponse.json(
        { success: false, error: 'Missing or invalid "ip" field' },
        { status: 400 }
      );
    }

    if (!body.path || typeof body.path !== 'string') {
      return NextResponse.json(
        { success: false, error: 'Missing or invalid "path" field' },
        { status: 400 }
      );
    }

    console.log(`Connecting to PLC at ${body.ip} with path ${body.path}`);

    const result = await connectPlc({
      ip: body.ip,
      path: body.path,
    });

    if (result.success) {
      return NextResponse.json({
        success: true,
        message: `Connected to PLC at ${body.ip}`,
        status: result.status,
      });
    } else {
      return NextResponse.json(
        {
          success: false,
          error: result.error || 'Failed to connect to PLC',
          status: result.status,
        },
        { status: 500 }
      );
    }
  } catch (error) {
    console.error('PLC connect error:', error);
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : 'Internal server error',
      },
      { status: 500 }
    );
  }
}
