/**
 * Mode-aware live tag-state access for server-side route logic (Phase 1.1).
 *
 * The guided engine, test/clear state capture and similar flows used the
 * legacy singleton's getPlcTags() — empty on the central server (registry
 * connections) and empty in PLC_MODE=remote (no in-process PLC at all).
 * This helper unions across every registered MCM via the mcm-registry, which
 * is already mode-aware (embedded: in-process clients; remote: the polled
 * gateway-state cache + :3102 event patches), and falls back to the legacy
 * singleton on single-MCM field tablets.
 */
import { getAllTags, hasAnyMcm } from '@/lib/mcm-registry';

export interface LiveTagState {
  id?: number;
  name?: string;
  state?: string;
}

/** Union of live tag states across all MCMs (or the legacy singleton). */
export function getLiveTagsUnion(): LiveTagState[] {
  if (hasAnyMcm()) {
    return getAllTags().tags as LiveTagState[];
  }
  try {
    // Lazy require: must not force libplctag init in remote mode.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mgr = require('@/lib/plc-client-manager') as typeof import('@/lib/plc-client-manager');
    return mgr.getPlcTags().tags as LiveTagState[];
  } catch {
    return [];
  }
}
