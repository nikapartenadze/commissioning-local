/**
 * Per-MCM log tag helper.
 *
 * On a central box that runs many MCMs in ONE process, every per-MCM operation
 * shares a single `app.log` stream. Prefixing a log line with a consistent tag
 * makes that stream filterable per station:
 *
 *   grep "\[MCM07\]" app-YYYY-MM-DD.log     # everything for MCM07
 *   grep "\[sub:38\]" app-YYYY-MM-DD.log    # when the display name is unknown
 *
 * ONE helper, ONE format, applied at every per-MCM call site, so the grep is
 * stable everywhere:
 *   - `[MCM07] ` when the MCM's display name is resolvable (or already given)
 *   - `[sub:38] ` otherwise (numeric/opaque subsystem id, name not yet known)
 *
 * Returns '' for a missing/blank id so callers can prepend unconditionally
 * (`${mcmTag(id)}...`). Never throws — logging must never break the caller.
 */
export function mcmTag(subsystemIdOrName: string | number | null | undefined): string {
  if (subsystemIdOrName === null || subsystemIdOrName === undefined) return '';
  const raw = String(subsystemIdOrName).trim();
  if (raw === '') return '';

  // Already an MCM display name (e.g. "MCM07") — use it verbatim.
  if (/^MCM/i.test(raw)) return `[${raw}] `;

  // Numeric / opaque subsystem id: try to resolve the MCM's display name from
  // the registry (cheap, in-memory). Fall back to [sub:<id>] when unknown.
  const name = resolveMcmName(raw);
  if (name && name.trim() && name.trim() !== raw) return `[${name.trim()}] `;
  return `[sub:${raw}] `;
}

function resolveMcmName(subsystemId: string): string | null {
  try {
    // Lazy require — mcm-registry pulls in the whole PLC layer; a static import
    // here would risk a module-init cycle (the logging modules are imported very
    // early). The `@/` runtime alias is already used the same way inside
    // mcm-registry itself (require('@/lib/db-sqlite')), so it resolves in both
    // the compiled server and the test runner.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const reg = require('@/lib/mcm-registry') as typeof import('@/lib/mcm-registry');
    return reg.getMcmStatus(subsystemId)?.name ?? null;
  } catch {
    return null;
  }
}
