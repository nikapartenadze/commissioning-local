/**
 * A safety BSS-bypass control (start/stop) is CONFIRMED only when the server
 * returned a 2xx AND the body says success:true.
 *
 * authFetch does NOT throw on a non-2xx response — POST /api/safety/bypass
 * returns 503 (PLC not connected) or 500 (bit write failed) with
 * { success:false }, and a 200 { success:true } on a real write. A handler that
 * doesn't check this would show the full-screen "SAFETY BYPASSED" overlay for a
 * bit that was never asserted (start), or clear the overlay while the bypass may
 * still be held (stop) — the dangerous direction. Fail-safe: anything not
 * explicitly confirmed is treated as NOT done.
 */
export function bypassConfirmed(
  ok: boolean,
  body: { success?: unknown } | null | undefined,
): boolean {
  return ok === true && !!body && body.success === true
}
