import { Request, Response } from 'express';
import { getMcmStatus, getMcmTags } from '@/lib/mcm-registry';

/**
 * GET /api/mcm/:subsystemId/plc/tags
 *
 * The current cached tag list + values for one MCM. Mirrors the legacy
 * /api/plc/tags shape but scoped to a specific subsystem.
 */
export async function GET(req: Request, res: Response) {
  const subsystemId = String(req.params.subsystemId);
  try {
    const status = getMcmStatus(subsystemId);
    const { tags, count } = getMcmTags(subsystemId);

    let successfulTags = 0;
    let failedTags = 0;
    for (const tag of tags) {
      if (tag.state !== undefined && tag.state !== null) {
        successfulTags += 1;
      } else {
        failedTags += 1;
      }
    }

    return res.json({
      success: true,
      subsystemId,
      connected: status?.connected ?? false,
      tags,
      count,
      totalTags: count,
      successfulTags,
      failedTags,
      successRate: count > 0 ? Math.round((successfulTags / count) * 100) : 0,
      hasErrors: failedTags > 0,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Internal server error',
      tags: [],
      count: 0,
    });
  }
}
