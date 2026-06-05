/**
 * Minimal error reporter for self-hosted GlitchTip (Sentry-API-compatible,
 * https://glitchtip.lci.ge).
 *
 * Deliberately dependency-free: this tool ships as a portable ZIP / NSIS
 * installer with a bundled Node runtime — the official Sentry SDK adds ~20MB
 * of OpenTelemetry deps and runtime require-hooking we don't want anywhere
 * near ffi-rs/libplctag. A plain fetch to the store endpoint is enough.
 *
 * Offline-first: sends are fire-and-forget with a short timeout and swallow
 * every failure — field machines are frequently offline and reporting must
 * NEVER affect commissioning work.
 *
 * The default DSN is the project's public (browser-safe) key; field installs
 * have no env configuration so it ships embedded. Override with SENTRY_DSN,
 * disable entirely with SENTRY_DISABLED=true.
 */

import { getAppVersion } from '@/lib/app-version';

const DEFAULT_DSN = 'https://3a62c8a0-3cf6-4ad9-a932-2cb46feeacfe@glitchtip.lci.ge/8';

const SEND_TIMEOUT_MS = 1500;

type StackFrame = {
  filename?: string;
  function?: string;
  lineno?: number;
  colno?: number;
};

function parseDsn(): { storeUrl: string; publicKey: string } | null {
  if (process.env.SENTRY_DISABLED === 'true') return null;
  const dsn = process.env.SENTRY_DSN || DEFAULT_DSN;
  try {
    const url = new URL(dsn);
    const projectId = url.pathname.replace(/^\//, '');
    if (!url.username || !projectId) return null;
    return {
      storeUrl: `${url.protocol}//${url.host}/api/${projectId}/store/`,
      publicKey: url.username,
    };
  } catch {
    return null;
  }
}

// Parse a V8 stack trace into Sentry frames (oldest call first, per spec).
function parseStack(stack: string | undefined): StackFrame[] {
  if (!stack) return [];
  const frames: StackFrame[] = [];
  for (const line of stack.split('\n')) {
    const m = /^\s*at\s+(?:(.+?)\s+\()?(?:(.+?):(\d+):(\d+)|([^)]+))\)?\s*$/.exec(line);
    if (!m || (!m[2] && !m[5])) continue;
    frames.push({
      function: m[1] || '<anonymous>',
      filename: m[2] || m[5],
      lineno: m[3] ? Number(m[3]) : undefined,
      colno: m[4] ? Number(m[4]) : undefined,
    });
  }
  return frames.reverse();
}

function buildEvent(error: unknown, context?: Record<string, unknown>) {
  const err = error instanceof Error ? error : new Error(String(error ?? 'unknown'));
  return {
    event_id: crypto.randomUUID().replace(/-/g, ''),
    timestamp: new Date().toISOString(),
    platform: 'node',
    level: 'error',
    environment: process.env.SENTRY_ENVIRONMENT ?? 'field',
    release: getAppVersion(),
    server_name: process.env.COMPUTERNAME || process.env.HOSTNAME,
    exception: {
      values: [
        {
          type: err.name,
          value: err.message,
          stacktrace: { frames: parseStack(err.stack) },
        },
      ],
    },
    extra: context,
  };
}

function send(event: unknown, parsed: { storeUrl: string; publicKey: string }): Promise<unknown> {
  return fetch(parsed.storeUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Sentry-Auth': `Sentry sentry_version=7, sentry_client=commissioning-local/${getAppVersion()}, sentry_key=${parsed.publicKey}`,
    },
    body: JSON.stringify(event),
    signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
  });
}

/**
 * Report an error to GlitchTip. Fire-and-forget; never throws, never blocks.
 */
export function reportError(error: unknown, context?: Record<string, unknown>): void {
  const parsed = parseDsn();
  if (!parsed) return;
  void send(buildEvent(error, context), parsed).catch(() => {
    // Offline or GlitchTip unreachable — silently drop.
  });
}

/**
 * Report a fatal (crash) error. Returns a promise that resolves once the
 * report is sent OR the timeout elapses — callers can `.finally(exit)` so a
 * crash report gets a chance to flush without delaying exit by more than
 * ~1.5 seconds.
 */
export function reportFatal(error: unknown, context?: Record<string, unknown>): Promise<void> {
  const parsed = parseDsn();
  if (!parsed) return Promise.resolve();
  return send(buildEvent(error, context), parsed).then(
    () => undefined,
    () => undefined,
  );
}
