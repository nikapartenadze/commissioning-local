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
  /** Number of IOs auto-pulled from the cloud before connecting (0 if none). */
  pulledIos?: number;
  error?: string;
}

export interface ConnectMcmOptions {
  /**
   * When the subsystem has no IOs in SQLite yet, pull them from the cloud first
   * (reusing POST /api/mcm/:id/pull) instead of failing. Used by Connect All so
   * a freshly-imported station connects without a manual pull step.
   */
  ensureIos?: boolean;
}

/**
 * Pull a subsystem's IOs by calling this server's own pull endpoint. Returns the
 * pull's own reason (e.g. a 403 "API key not authorized for this subsystem") so
 * the caller can give an accurate error instead of a generic "cloud returned
 * none" when the real cause is a wrong project / API-key mismatch.
 */
async function pullIosViaSelf(subsystemId: string): Promise<{ ok: boolean; reason?: string }> {
  const port = process.env.PORT || '3000';
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/mcm/${encodeURIComponent(subsystemId)}/pull`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
      signal: AbortSignal.timeout(90_000),
    });
    let reason: string | undefined;
    try {
      const data: any = await r.json();
      reason = data?.error || data?.message;
    } catch {
      /* non-JSON body */
    }
    return { ok: r.ok, reason };
  } catch (e) {
    // Best-effort — the IO re-count below surfaces a still-empty result.
    return { ok: false, reason: e instanceof Error ? e.message : 'pull request failed' };
  }
}

export async function connectConfiguredMcm(
  subsystemId: string,
  overrides?: { ip?: string; path?: string },
  opts?: ConnectMcmOptions
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

  const ioQuery = db.prepare(
    'SELECT id, Name, Description, TagType FROM Ios WHERE SubsystemId = ?'
  );
  let ios = ioQuery.all(subsystemIdNum) as IoRow[];
  let pulledIos = 0;
  let pullReason: string | undefined;

  // Auto-pull on first connect: a just-imported station has an IP but no IOs.
  if (ios.length === 0 && opts?.ensureIos) {
    const pull = await pullIosViaSelf(subsystemId);
    pullReason = pull.reason;
    ios = ioQuery.all(subsystemIdNum) as IoRow[];
    pulledIos = ios.length;
  }

  if (ios.length === 0) {
    // Prefer the pull's own reason (e.g. 403 wrong-project/API-key) over a
    // generic message — that's the difference between "no data" and "this key
    // can't see this subsystem".
    return {
      subsystemId,
      name,
      success: false,
      error: pullReason
        ? `Could not load IOs for subsystem ${subsystemId}: ${pullReason}`
        : opts?.ensureIos
          ? `No IOs for subsystem ${subsystemId} after cloud pull (cloud returned none for this subsystem)`
          : `No IOs for subsystem ${subsystemId} — pull IOs from cloud first`,
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
    pulledIos: pulledIos || undefined,
    error: result.success ? undefined : result.error || 'Failed to connect to PLC',
  };
}
