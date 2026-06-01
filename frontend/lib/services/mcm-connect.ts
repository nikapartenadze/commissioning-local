/**
 * Connect a single configured MCM by subsystemId — the shared core behind the
 * bulk "Connect All" action (POST /api/mcm/connect-all).
 *
 * Mirrors the per-MCM connect route (app/api/mcm/[subsystemId]/plc/connect):
 * load the subsystem's IO tag set from SQLite, then connect the libplctag
 * client (or RPC the gateway in split mode) with a hard timeout. Returns a
 * compact per-MCM result so the caller can show "X connected, Y failed" with
 * reasons. Never throws — a failure is reported in the result.
 */

import { configService } from '@/lib/config';
import { connectMcm, loadMcmTags } from '@/lib/mcm-registry';
import { db } from '@/lib/db-sqlite';

const CONNECT_TIMEOUT_MS = 30_000;

interface IoRow {
  id: number;
  Name: string | null;
  Description: string | null;
  TagType: string | null;
}

export interface ConnectMcmResult {
  subsystemId: string;
  name: string;
  success: boolean;
  /** True when nothing was attempted (e.g. no IP configured yet). */
  skipped?: boolean;
  status?: string;
  plcReachable?: boolean;
  totalTags?: number;
  tagsSuccessful?: number;
  tagsFailed?: number;
  error?: string;
}

export async function connectConfiguredMcm(
  subsystemId: string,
  overrides?: { ip?: string; path?: string }
): Promise<ConnectMcmResult> {
  const cfg = await configService.getMcm(subsystemId);
  if (!cfg) {
    return { subsystemId, name: subsystemId, success: false, error: 'MCM not configured' };
  }
  const name = cfg.name;
  const ip = String(overrides?.ip ?? cfg.ip ?? '').trim();
  const path = String(overrides?.path ?? cfg.path ?? '1,0').trim();

  if (!ip) {
    return { subsystemId, name, success: false, skipped: true, error: 'No IP configured' };
  }

  const subsystemIdNum = parseInt(subsystemId, 10);
  if (!Number.isFinite(subsystemIdNum)) {
    return { subsystemId, name, success: false, error: 'subsystemId must be numeric' };
  }

  const ios = db
    .prepare('SELECT id, Name, Description, TagType FROM Ios WHERE SubsystemId = ?')
    .all(subsystemIdNum) as IoRow[];
  if (ios.length === 0) {
    return {
      subsystemId,
      name,
      success: false,
      error: `No IOs for subsystem ${subsystemId} — pull IOs from cloud first`,
    };
  }

  const tags = ios.map((io) => ({
    id: io.id,
    name: io.Name || '',
    description: io.Description || undefined,
    tagType: io.TagType || undefined,
  }));
  loadMcmTags(subsystemId, tags);

  let result: Awaited<ReturnType<typeof connectMcm>>;
  try {
    result = await Promise.race([
      connectMcm(subsystemId, name, { ip, path }),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error(`Timed out after ${CONNECT_TIMEOUT_MS / 1000}s`)),
          CONNECT_TIMEOUT_MS
        )
      ),
    ]);
  } catch (timeoutError) {
    return {
      subsystemId,
      name,
      success: false,
      error: timeoutError instanceof Error ? timeoutError.message : 'Connection timed out',
    };
  }

  // Persist a changed ip/path so the next session reconnects with these values.
  if (ip !== cfg.ip || path !== cfg.path) {
    try {
      await configService.updateMcm(subsystemId, { ip, path });
    } catch {
      // best-effort
    }
  }

  const failedTags = result.failedTags || [];
  return {
    subsystemId,
    name,
    success: result.success,
    status: result.status,
    plcReachable: result.plcReachable ?? false,
    totalTags: ios.length,
    tagsSuccessful: result.tagsSuccessful || 0,
    tagsFailed: failedTags.length,
    error: result.success ? undefined : result.error || 'Failed to connect to PLC',
  };
}
