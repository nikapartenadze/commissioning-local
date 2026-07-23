/**
 * fetch-with-timeout — bound any fetch by a hard deadline.
 *
 * WHY THIS EXISTS: a bare `fetch`/`authFetch` on a dead connection can hang
 * indefinitely — no response, no error — so a `try/finally { setLoading(false) }`
 * never runs and the UI spins forever. That is exactly what the cloud Compare
 * tab did. Racing the request against an AbortController timer turns "hangs
 * forever" into a clean, catchable failure the caller can render as a message.
 *
 * `run` receives an AbortSignal it MUST forward to the underlying
 * authFetch/fetch (so the socket is actually torn down on timeout, not just
 * abandoned). If the timer wins, the request is aborted and a FetchTimeoutError
 * is thrown; the caller distinguishes it via isFetchTimeoutError() to show a
 * "couldn't reach the cloud" message instead of a generic error.
 */

export class FetchTimeoutError extends Error {
  readonly timeoutMs: number
  constructor(timeoutMs: number) {
    super(`Request timed out after ${timeoutMs}ms`)
    this.name = 'FetchTimeoutError'
    this.timeoutMs = timeoutMs
  }
}

/** True when a rejection came from fetchWithTimeout's own deadline (not a caller abort or HTTP error). */
export function isFetchTimeoutError(e: unknown): e is FetchTimeoutError {
  return e instanceof FetchTimeoutError || (e instanceof Error && e.name === 'FetchTimeoutError')
}

/**
 * Run a fetch bounded by `timeoutMs`. `run` gets an AbortSignal to pass to
 * authFetch/fetch. Resolves with the Response if it arrives in time; rejects
 * with FetchTimeoutError if the deadline fires first; re-throws any other error
 * (network reject, HTTP-layer throw) unchanged.
 *
 * Uses a local `timedOut` flag rather than sniffing the abort reason's name so
 * it does not depend on whether the runtime supports `AbortController.abort(reason)`
 * (older field browsers may not) — the flag is authoritative about who won.
 */
export async function fetchWithTimeout(
  run: (signal: AbortSignal) => Promise<Response>,
  timeoutMs = 15000,
): Promise<Response> {
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)
  try {
    return await run(controller.signal)
  } catch (e) {
    // If our deadline fired, the abort is the CAUSE of this rejection — surface
    // it as a timeout regardless of the underlying error shape.
    if (timedOut) throw new FetchTimeoutError(timeoutMs)
    throw e
  } finally {
    clearTimeout(timer)
  }
}
