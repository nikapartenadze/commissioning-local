import { Request, Response } from 'express';
import { importSubsystemsFromCloud } from '@/lib/cloud/import-subsystems';

/**
 * POST /api/mcm/import-from-cloud
 *
 * Pull every subsystem for the configured project from the cloud and merge it
 * into the local MCM list (config.mcms). New subsystems land with a blank IP
 * for the operator to fill; existing MCMs keep their IP. Idempotent.
 */
export async function POST(_req: Request, res: Response) {
  const result = await importSubsystemsFromCloud();
  if (!result.success) {
    return res.status(400).json(result);
  }
  return res.json(result);
}
