/**
 * Provider installation and authentication.
 *
 * The single rule here: **the provider owns its own authentication.** Zeus
 * launches the vendor's official flow, waits, and then asks the vendor whether
 * it worked. It never sees a password, never handles an OAuth token, never
 * stores a credential, and never renders a login screen of its own. What we
 * persist is which provider plays which role — configuration, not secrets.
 *
 * Auth *state* is read with the vendors' own read-only status commands, so
 * checking never disturbs an existing session.
 */

import { SystemProbe } from './probe';
import { installNpmGlobal, InstallOutcome } from './pkg';

export type ProviderId = 'claude' | 'codex';

export type AuthState =
  | 'AUTHENTICATED'
  | 'AUTHENTICATION_REQUIRED'
  | 'AUTHENTICATION_FAILED'
  | 'NOT_INSTALLED'
  | 'UNKNOWN';

export interface ProviderSpec {
  id: ProviderId;
  label: string;
  bin: string;
  npmPackage: string;
  /** Read-only status command. Must never mutate a session. */
  statusArgs: string[];
  /** Interactive sign-in, run by the vendor's own CLI. */
  loginArgs: string[];
  /** Advanced, explicit alternative where the vendor supports it. */
  apiKeyLogin?: { args: string[]; note: string };
  docs: string;
}

export const PROVIDERS: Record<ProviderId, ProviderSpec> = {
  claude: {
    id: 'claude', label: 'Claude Code', bin: 'claude',
    npmPackage: '@anthropic-ai/claude-code',
    statusArgs: ['auth', 'status', '--json'],
    loginArgs: ['auth', 'login'],
    docs: 'https://docs.claude.com/en/docs/claude-code',
  },
  codex: {
    id: 'codex', label: 'OpenAI Codex', bin: 'codex',
    npmPackage: '@openai/codex',
    statusArgs: ['login', 'status'],
    loginArgs: ['login'],
    apiKeyLogin: { args: ['login', '--with-api-key'],
      note: 'reads the key from stdin; Zeus never stores or echoes it' },
    docs: 'https://developers.openai.com/codex/cli',
  },
};

export interface ProviderStatus {
  id: ProviderId;
  label: string;
  installed: boolean;
  path: string | null;
  version: string | null;
  auth: AuthState;
  /** e.g. "claude.ai", "chatgpt", "api-key" — never an identity or a token. */
  authMethod: string | null;
  detail: string;
}

/** Extracts a version without keeping anything else the CLI printed. */
function versionOf(probe: SystemProbe, bin: string): string | null {
  const r = probe.run(bin, ['--version'], { timeoutMs: 30_000 });
  const m = /(\d+\.\d+(\.\d+)?)/.exec(`${r.stdout}${r.stderr}`);
  return m ? m[1] : null;
}

/**
 * Reads auth state from the vendor's status command.
 *
 * Deliberately narrow: only a boolean and a method name are lifted out. The
 * status output can contain an email address and organisation id, and none of
 * that is Zeus's business or fit to appear in a log.
 */
export function providerStatus(probe: SystemProbe, id: ProviderId): ProviderStatus {
  const spec = PROVIDERS[id];
  const path = probe.which(spec.bin);
  if (!path) {
    return { id, label: spec.label, installed: false, path: null, version: null,
      auth: 'NOT_INSTALLED', authMethod: null, detail: 'not installed' };
  }
  const version = versionOf(probe, spec.bin);
  const r = probe.run(spec.bin, spec.statusArgs, { timeoutMs: 60_000 });
  const out = `${r.stdout}\n${r.stderr}`;

  let auth: AuthState = 'UNKNOWN';
  let method: string | null = null;

  // Prefer structured output when the vendor provides it.
  try {
    const start = out.indexOf('{');
    const end = out.lastIndexOf('}');
    if (start >= 0 && end > start) {
      const j = JSON.parse(out.slice(start, end + 1));
      if (typeof j.loggedIn === 'boolean') auth = j.loggedIn ? 'AUTHENTICATED' : 'AUTHENTICATION_REQUIRED';
      if (typeof j.authMethod === 'string') method = j.authMethod;
    }
  } catch { /* fall through to text */ }

  if (auth === 'UNKNOWN') {
    if (r.code === 0 && /logged in|signed in|authenticated|account:|using chatgpt|api key/i.test(out)) {
      auth = 'AUTHENTICATED';
      const m = /(chatgpt|claude\.ai|api[ -]?key|console)/i.exec(out);
      method = m ? m[1].toLowerCase() : null;
    } else if (/not logged in|no credentials|please (run )?login|unauthenticated|not authenticated/i.test(out)) {
      auth = 'AUTHENTICATION_REQUIRED';
    } else if (r.code !== 0) {
      auth = 'AUTHENTICATION_REQUIRED';
    } else {
      auth = 'UNKNOWN';
    }
  }

  const detail = auth === 'AUTHENTICATED'
    ? `authenticated${method ? ` via ${method}` : ''}`
    : auth === 'AUTHENTICATION_REQUIRED'
      ? `${spec.label.toUpperCase().replace(/[^A-Z]/g, '_')}_INSTALLED_NOT_AUTHENTICATED`
      : 'authentication state could not be determined';

  return { id, label: spec.label, installed: true, path, version, auth, authMethod: method, detail };
}

export function installProvider(probe: SystemProbe, id: ProviderId): InstallOutcome & { prefixChanged?: string } {
  return installNpmGlobal(probe, PROVIDERS[id].npmPackage);
}

export interface LoginOutcome {
  state: AuthState;
  detail: string;
  /** Instructions for finishing by hand, when the flow could not complete. */
  manual: string;
}

/**
 * Runs the vendor's own sign-in flow with the terminal attached.
 *
 * On a headless server the vendor CLI prints a URL and a code; because stdio is
 * inherited, the user sees exactly what the vendor intended and can finish in a
 * browser anywhere. Zeus does not proxy, parse or re-render that flow — it
 * waits, then re-checks status.
 */
export function loginProvider(probe: SystemProbe, id: ProviderId): LoginOutcome {
  const spec = PROVIDERS[id];
  const manual = `run: ${spec.bin} ${spec.loginArgs.join(' ')}   (docs: ${spec.docs})`;
  if (!probe.which(spec.bin)) {
    return { state: 'NOT_INSTALLED', detail: `${spec.label} is not installed`, manual };
  }
  if (!probe.isTTY()) {
    // A browser sign-in needs a human. Guessing consent here would hang CI.
    return { state: 'AUTHENTICATION_REQUIRED',
      detail: 'interactive sign-in needs a terminal; skipped in non-interactive mode', manual };
  }
  probe.runInteractive(spec.bin, spec.loginArgs);
  // The vendor is the authority on whether it worked, not the exit code.
  const after = providerStatus(probe, id);
  if (after.auth === 'AUTHENTICATED') {
    return { state: 'AUTHENTICATED', detail: after.detail, manual };
  }
  return {
    state: after.auth === 'UNKNOWN' ? 'AUTHENTICATION_FAILED' : 'AUTHENTICATION_REQUIRED',
    detail: `sign-in did not complete; ${spec.label} still reports it is not authenticated`,
    manual,
  };
}

/**
 * API-key sign-in, where the vendor supports it.
 *
 * The key is passed straight to the vendor CLI on stdin and never held, echoed,
 * logged or written to project configuration.
 */
export function loginWithApiKey(probe: SystemProbe, id: ProviderId, key: string): LoginOutcome {
  const spec = PROVIDERS[id];
  const manual = `run: ${spec.bin} ${(spec.apiKeyLogin?.args ?? []).join(' ')}`;
  if (!spec.apiKeyLogin) {
    return { state: 'AUTHENTICATION_FAILED',
      detail: `${spec.label} does not support API-key sign-in through this CLI`, manual };
  }
  const r = probe.run(spec.bin, spec.apiKeyLogin.args, { input: key, timeoutMs: 120_000 });
  const after = providerStatus(probe, id);
  if (after.auth === 'AUTHENTICATED') return { state: 'AUTHENTICATED', detail: after.detail, manual };
  return { state: 'AUTHENTICATION_FAILED',
    detail: `key was rejected or the session did not persist (exit ${r.code})`, manual };
}

export type Role = 'developer' | 'reviewer' | 'none';

export interface RoleAssignment {
  developer: ProviderId | null;
  reviewer: ProviderId | null;
}

/** Recommended default: separate vendors, so the review is genuinely independent. */
export const DEFAULT_ROLES: RoleAssignment = { developer: 'claude', reviewer: 'codex' };

export function roleOf(roles: RoleAssignment, id: ProviderId): Role {
  if (roles.developer === id) return 'developer';
  if (roles.reviewer === id) return 'reviewer';
  return 'none';
}

/** Same vendor in both seats is allowed, but it is not independent review. */
export function roleWarnings(roles: RoleAssignment): string[] {
  const w: string[] = [];
  if (roles.developer && roles.developer === roles.reviewer) {
    w.push('the same provider is implementing and reviewing: the review is no longer independent');
  }
  if (!roles.developer) w.push('no developer provider selected: zeus run cannot implement changes');
  if (!roles.reviewer) w.push('no reviewer selected: changes will not be independently reviewed');
  return w;
}
