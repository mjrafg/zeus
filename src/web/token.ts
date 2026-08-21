/**
 * The bearer token every web request carries.
 *
 * From day one, not "once it leaves localhost". A loopback bind is a
 * deployment detail and deployment details change: an SSH tunnel, a container
 * port map, a well-meaning `--host` to show a colleague. Every one of those
 * turns "it's just localhost" into an unauthenticated control plane that can
 * spend money and run agents against a repository. The token costs one line in
 * the client and removes that entire class of accident.
 *
 * Generated once per project, stored beside the event log with owner-only
 * permissions, and printed ONCE at startup — printing it on every request or
 * into every log is how a secret stops being one.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

export function tokenPath(stateRoot: string): string {
  return path.join(stateRoot, 'web-token');
}

export interface WebToken {
  token: string;
  /** True when this call created it — the caller prints it only then. */
  created: boolean;
  path: string;
}

/** Reads the project's token, creating it on first use. */
export function ensureToken(stateRoot: string): WebToken {
  const file = tokenPath(stateRoot);
  try {
    const existing = fs.readFileSync(file, 'utf8').trim();
    if (existing.length >= 32) return { token: existing, created: false, path: file };
  } catch { /* not created yet */ }

  const token = crypto.randomBytes(32).toString('base64url');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // Written owner-only, and written before it is returned: a token the caller
  // has printed but nothing can verify is worse than no token.
  fs.writeFileSync(file, `${token}\n`, { encoding: 'utf8', mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch { /* best effort on exotic filesystems */ }
  return { token, created: true, path: file };
}

/**
 * Constant-time comparison.
 *
 * A length-varying or short-circuiting compare leaks the token one byte at a
 * time to anything that can time requests, and a control plane that can spend
 * money is worth that effort to an attacker.
 */
export function tokenMatches(expected: string, offered: string | null): boolean {
  if (!offered) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(offered);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/** Pulls a bearer token from a request's headers or query string. */
export function offeredToken(headers: Record<string, unknown>, url: URL): string | null {
  const auth = headers.authorization;
  if (typeof auth === 'string' && /^Bearer\s+/i.test(auth)) {
    return auth.replace(/^Bearer\s+/i, '').trim() || null;
  }
  // EventSource cannot set headers, so the stream accepts the token in the
  // query string. Same secret, same check; the difference is only that a URL
  // is likelier to be logged, which is why this is the only route that uses it.
  const q = url.searchParams.get('token');
  return q && q.trim() ? q.trim() : null;
}
