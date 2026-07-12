import fs from 'fs';
import path from 'path';

/**
 * Resolve the running app's version (package.json `version`) at runtime.
 *
 * Why a runtime read instead of a build-time constant: the server is compiled
 * to dist-server/ but package.json stays at the frontend root, so a relative
 * `import './package.json'` from the compiled file resolves to the wrong place.
 * The candidate list below covers running from source (tsx), from dist-server/,
 * and from the packaged layout. Mirrors the probe already used by the
 * server→cloud heartbeat (lib/heartbeat/heartbeat-service.ts) so the version
 * the browser sees over the WS ack and the version the cloud fleet sees always
 * agree.
 *
 * Cached after first successful read — the version can't change without the
 * process restarting, and a restart re-evaluates this module fresh.
 */
let cached: string | null = null;

export function getAppVersion(): string {
  if (cached) return cached;
  // Packaged builds may not have package.json where the probes expect it, but
  // the build scripts stamp APP_VERSION into the runtime .env — trust it first.
  const envVersion = process.env.APP_VERSION?.trim();
  if (envVersion) {
    cached = envVersion;
    return cached;
  }
  const candidates = [
    path.join(process.cwd(), 'package.json'),
    path.join(__dirname, '..', 'package.json'),
    path.join(__dirname, '..', '..', 'package.json'),
  ];
  for (const p of candidates) {
    try {
      const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (parsed && typeof parsed.version === 'string' && parsed.version.length > 0) {
        cached = parsed.version;
        return cached;
      }
    } catch {
      /* try next candidate */
    }
  }
  return 'unknown';
}
