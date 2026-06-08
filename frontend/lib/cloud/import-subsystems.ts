/**
 * Import the project's subsystems from the cloud into the local MCM list.
 *
 * The cloud is authoritative for {subsystemId, name} per project (the project
 * is identified by the configured apiPassword / X-API-Key). PLC IP + path are
 * site-local, so imported MCMs land with a blank IP for the operator to fill —
 * then it's just "Connect". Existing MCMs keep their IP (see
 * configService.upsertMcmsFromCloud).
 *
 * Cloud endpoint: GET {remoteUrl}/api/sync/subsystems  (header X-API-Key)
 *   -> { projectId, projectName, subsystems: [{ id, name }] }
 */

import { configService } from '@/lib/config';

export interface ImportSubsystemsResult {
  success: boolean;
  error?: string;
  projectId?: number;
  projectName?: string;
  total?: number;
  added?: string[];
  updated?: string[];
}

export interface CloudProjectInfo {
  ok: boolean;
  error?: string;
  projectId?: number;
  projectName?: string;
  subsystemCount?: number;
  subsystems?: Array<{ id: number; name: string }>;
}

/**
 * Read-only probe: which cloud project does the configured API key resolve to?
 * Hits GET {remoteUrl}/api/sync/subsystems with the X-API-Key and reports the
 * project + station count WITHOUT mutating the local MCM list. Used by the
 * cloud-config settings UI so the operator can confirm the key is valid and
 * see exactly which project (and how many stations) it unlocks before importing.
 */
export async function fetchCloudProjectInfo(): Promise<CloudProjectInfo> {
  const cfg = await configService.getConfig();
  const remoteUrl = (cfg.remoteUrl || '').replace(/\/+$/, '');
  const apiPassword = cfg.apiPassword || '';

  if (!remoteUrl) return { ok: false, error: 'Cloud URL not configured' };
  if (!apiPassword) return { ok: false, error: 'API key not set' };

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    let res: Response;
    try {
      res = await fetch(`${remoteUrl}/api/sync/subsystems`, {
        method: 'GET',
        headers: { 'X-API-Key': apiPassword },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    if (res.status === 401 || res.status === 403) {
      return { ok: false, error: 'Cloud rejected the API key (wrong project key?)' };
    }
    if (!res.ok) return { ok: false, error: `Cloud returned ${res.status}` };
    const data = await res.json();
    const subs = Array.isArray(data?.subsystems) ? data.subsystems : [];
    return {
      ok: true,
      projectId: data.projectId,
      projectName: data.projectName,
      subsystemCount: subs.length,
      subsystems: subs,
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Cloud request failed' };
  }
}

export async function importSubsystemsFromCloud(): Promise<ImportSubsystemsResult> {
  const cfg = await configService.getConfig();
  const remoteUrl = (cfg.remoteUrl || '').replace(/\/+$/, '');
  const apiPassword = cfg.apiPassword || '';

  if (!remoteUrl) return { success: false, error: 'Cloud URL not configured' };
  if (!apiPassword) return { success: false, error: 'API key not configured — set the cloud API password first' };

  let data: { projectId?: number; projectName?: string; subsystems?: Array<{ id: number; name: string }> };
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    let res: Response;
    try {
      res = await fetch(`${remoteUrl}/api/sync/subsystems`, {
        method: 'GET',
        headers: { 'X-API-Key': apiPassword },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    if (res.status === 401 || res.status === 403) {
      return { success: false, error: 'Cloud rejected the API key (check the cloud API password)' };
    }
    if (!res.ok) {
      return { success: false, error: `Cloud returned ${res.status}` };
    }
    data = await res.json();
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : 'Cloud request failed' };
  }

  const subs = Array.isArray(data?.subsystems) ? data.subsystems : [];
  const incoming = subs
    .filter((s) => s && s.id !== undefined && s.id !== null)
    .map((s) => ({ subsystemId: String(s.id), name: String(s.name ?? `MCM ${s.id}`) }));

  const { mcms, added, updated } = await configService.upsertMcmsFromCloud(incoming);

  return {
    success: true,
    projectId: data.projectId,
    projectName: data.projectName,
    total: mcms.length,
    added,
    updated,
  };
}
