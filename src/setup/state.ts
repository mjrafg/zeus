/**
 * Persistence for setup.
 *
 * Two things are written, both boring on purpose:
 *   * setup progress, under the per-user data directory, so an interrupted run
 *     continues where it stopped instead of reinstalling everything;
 *   * provider ROLE configuration, in the project's own config.
 *
 * No credential, token, API key or account identifier is ever written by this
 * module. Provider credentials stay wherever the provider's own CLI puts them.
 */

import * as fs from 'fs';
import * as path from 'path';
import { SetupState, StateStore, emptyState, SETUP_STATE_VERSION } from './wizard';
import { RoleAssignment } from './providers';

/** Shapes that must never appear in setup state, whatever a future edit adds. */
const FORBIDDEN = /(token|secret|password|api[-_]?key|credential|bearer|sk-[A-Za-z0-9]{8})/i;

export function stateFile(dataDir: string): string {
  return path.join(dataDir, 'setup-state.json');
}

/**
 * Rejects anything that looks like a secret before it reaches disk, so a bug
 * that starts persisting credentials fails loudly instead of leaking quietly.
 */
export function assertNoSecrets(s: SetupState): void {
  const hit = JSON.stringify(s).match(FORBIDDEN);
  if (hit) throw new Error(`refusing to persist setup state containing "${hit[0]}"`);
}

export class FileStateStore implements StateStore {
  constructor(private readonly dataDir: string) {}

  load(): SetupState {
    try {
      const raw = JSON.parse(fs.readFileSync(stateFile(this.dataDir), 'utf8')) as SetupState;
      // State from an unknown version is discarded rather than half-honoured:
      // re-detection is cheap, a wrong resume is not.
      if (raw?.version !== SETUP_STATE_VERSION) return emptyState();
      return {
        ...emptyState(),
        ...raw,
        completed: Array.isArray(raw.completed) ? raw.completed : [],
        declined: Array.isArray(raw.declined) ? raw.declined : [],
      };
    } catch { return emptyState(); }
  }

  save(s: SetupState): void {
    assertNoSecrets(s);
    fs.mkdirSync(this.dataDir, { recursive: true });
    const file = stateFile(this.dataDir);
    const tmp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, `${JSON.stringify(s, null, 1)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, file);
  }

  clear(): void {
    try { fs.unlinkSync(stateFile(this.dataDir)); } catch { /* already gone */ }
  }
}

/** Keeps setup state in memory. Used by tests and by --dry-run. */
export class MemoryStateStore implements StateStore {
  constructor(private state: SetupState = emptyState()) {}
  load(): SetupState { return JSON.parse(JSON.stringify(this.state)); }
  save(s: SetupState): void { assertNoSecrets(s); this.state = JSON.parse(JSON.stringify(s)); }
}

/**
 * Writes the chosen provider roles into a project config object.
 * Roles are configuration; credentials are not, and none are touched here.
 */
export function applyRoles<T extends { providers?: any }>(cfg: T, roles: RoleAssignment): T {
  const developer = roles.developer ?? 'claude';
  const reviewer = roles.reviewer ?? 'codex';
  cfg.providers = {
    ...(cfg.providers ?? {}),
    planner: developer,
    implementer: developer === 'claude' ? 'claude-code' : developer,
    reviewer,
    billing: 'subscription-cli-only',
  };
  return cfg;
}
