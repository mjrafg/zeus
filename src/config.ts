/**
 * Project configuration: `.zeus/config.yaml`.
 *
 * Zeus is installed once per user and initialised into each project. The
 * program itself never lives inside the user's source tree; only this small
 * config and the project's own state do.
 */

import * as fs from 'fs';
import { RoutingTable } from './routing';
import * as path from 'path';
import * as os from 'os';
import { parse, stringify, Yaml } from './yaml';
import { detectProject, adapterById, Commands } from './adapters';

export const CONFIG_VERSION = 1;
export const PROJECT_DIR = '.zeus';

export interface ProjectConfig {
  version: number;
  project: { name: string; adapter: string; root: string; packageManager?: string };
  commands: Commands;
  policy: {
    protectedPaths: string[];
    maxFilesChanged: number;
    requireHumanForProtectedPaths: boolean;
    autoMerge: boolean;
    autoDeploy: boolean;
    /** Accept changes in a project that has no executable verification. */
    allowUnverifiedAcceptance: boolean;
  };
  resources: {
    globalHeavyTestConcurrency: number;
    heavyTestTimeoutSeconds: number;
    maxTestWorkers: number;
    maxPlaywrightWorkers: number;
  };
  providers: { planner: string; implementer: string; reviewer: string; billing: string };
  /**
   * Which model answers for which pipeline stage, and how hard it thinks.
   *
   * Optional and sparse BY DESIGN: an absent stage, or an absent field within
   * a stage, falls through to the global setting and then to the Zeus default.
   * Writing the whole table into every project would freeze today's answer
   * into every config file on disk.
   */
  routing?: RoutingTable;
  validation: {
    /** Only 'fastest-safe' exists today; the field makes future strategies explicit. */
    strategy: string;
    hardening: {
      /** §1. Non-disableable in v1: recorded, and always enforced. */
      mixedDiffMaxTier: boolean;
      /** §2. Non-disableable in v1. */
      testSurfaceRisk: boolean;
      unknownPlusRiskDirectDeep: boolean;
      /** Minimum tier the generic adapter may claim for non-documentation. */
      genericAdapterFloor: string;
      /** Reviewer-requested validation expansions allowed per task. */
      reviewerExpansionBudget: number;
    };
  };
  integrations: { graphify: 'auto' | 'on' | 'off' };
  paths: { state: string; logs: string; worktrees: string; deps: string };
}

/** Where per-user runtime state lives, XDG-respecting. */
export function userDataDir(): string {
  return process.env.ZEUS_HOME
    ?? path.join(process.env.XDG_DATA_HOME ?? path.join(os.homedir(), '.local', 'share'), 'zeus');
}

/**
 * Per-user configuration, XDG-respecting.
 *
 * Distinct from the data directory on purpose: this holds choices a person made
 * and might want to keep or copy between machines, while the data directory
 * holds runtime state that is safe to throw away.
 */
export function userConfigDir(): string {
  return process.env.ZEUS_CONFIG_HOME
    ?? path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config'), 'zeus');
}

export function userDefaultsPath(): string {
  return path.join(userConfigDir(), 'defaults.yaml');
}

/** Defaults a new project inherits. Never holds a credential. */
export interface UserDefaults {
  providers?: { planner?: string; implementer?: string; reviewer?: string };
  /** The global tier of the routing table. Projects override it field by field. */
  routing?: RoutingTable;
}

export function readUserDefaults(): UserDefaults | null {
  try { return parse(fs.readFileSync(userDefaultsPath(), 'utf8')) as unknown as UserDefaults; }
  catch { return null; }
}

/**
 * Records which provider plays which role, so a second project does not have to
 * be told again. Roles are configuration; credentials stay with the provider.
 */
export function writeUserDefaults(d: UserDefaults): string {
  const file = userDefaultsPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const header = [
    '# Zeus user defaults.',
    '# Applied to new projects by `zeus init`. Roles only — never credentials.',
    '',
  ].join('\n');
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${header}${stringify(d as unknown as Yaml)}\n`);
  fs.renameSync(tmp, file);
  return file;
}

export function projectConfigPath(root: string): string {
  return path.join(root, PROJECT_DIR, 'config.yaml');
}

/** The pre-rename project directory, recognised so it can be migrated. */
export const LEGACY_PROJECT_DIR = '.autopilot';

/** Walks up to the git root so `zeus` works from any subdirectory. */
export function findProjectRoot(start = process.cwd()): string | null {
  let dir = path.resolve(start);
  for (;;) {
    // The legacy directory counts as a project root purely so that a project
    // on the old layout is found at all, and can therefore be offered a
    // migration instead of looking like an uninitialised repository.
    if (fs.existsSync(path.join(dir, '.git'))
      || fs.existsSync(path.join(dir, PROJECT_DIR))
      || fs.existsSync(path.join(dir, LEGACY_PROJECT_DIR))) return dir;
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

export function defaultConfig(root: string): ProjectConfig {
  const det = detectProject(root);
  return {
    version: CONFIG_VERSION,
    project: {
      name: path.basename(root),
      adapter: det.primary.id,
      root: '.',
      ...(det.packageManager ? { packageManager: det.packageManager } : {}),
    },
    commands: det.primary.commands(root),
    policy: {
      protectedPaths: det.primary.protectedPaths(root),
      maxFilesChanged: 25,
      requireHumanForProtectedPaths: true,
      // Both default OFF. A tool that can merge and deploy on its own should
      // never acquire that power silently on first init.
      autoMerge: false,
      autoDeploy: false,
      // A project with no tests can still be worked on, but saying so must be
      // a decision someone made, not a silence the engine interprets.
      allowUnverifiedAcceptance: false,
    },
    resources: {
      globalHeavyTestConcurrency: 1,
      heavyTestTimeoutSeconds: 180,
      maxTestWorkers: 2,
      maxPlaywrightWorkers: 1,
    },
    providers: {
      planner: 'claude', implementer: 'claude-code', reviewer: 'codex',
      // Whatever the user chose during setup wins over the recommended pair.
      ...(readUserDefaults()?.providers ?? {}),
      billing: 'subscription-cli-only',
    },
    validation: {
      strategy: 'fastest-safe',
      hardening: {
        // The first two are trust infrastructure rather than preference: they
        // are written here for visibility, and enforced whatever they say.
        mixedDiffMaxTier: true,
        testSurfaceRisk: true,
        unknownPlusRiskDirectDeep: true,
        genericAdapterFloor: 'normal',
        reviewerExpansionBudget: 2,
      },
    },
    integrations: { graphify: 'auto' },
    paths: { state: '.zeus/state', logs: '.zeus/logs', worktrees: '.zeus/worktrees', deps: '.zeus/deps' },
  };
}

export function renderConfig(cfg: ProjectConfig): string {
  const header = [
    '# Zeus project configuration.',
    '# Written by `zeus init`; safe to edit and to commit.',
    '# Zeus itself is installed per-user and is NOT vendored into this repo.',
    '',
  ].join('\n');
  return `${header}${stringify(cfg as unknown as Yaml)}\n`;
}

export function writeConfig(root: string, cfg: ProjectConfig): string {
  const file = projectConfigPath(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, renderConfig(cfg));
  fs.renameSync(tmp, file);
  return file;
}

export function readConfig(root: string): ProjectConfig | null {
  try {
    const raw = fs.readFileSync(projectConfigPath(root), 'utf8');
    return parse(raw) as unknown as ProjectConfig;
  } catch { return null; }
}

export interface ConfigProblem { level: 'error' | 'warning'; message: string }

/** Validates a config the user may have edited by hand. */
export function validateConfig(cfg: any): ConfigProblem[] {
  const p: ConfigProblem[] = [];
  if (!cfg || typeof cfg !== 'object') return [{ level: 'error', message: 'config is empty or not a map' }];
  if (cfg.version !== CONFIG_VERSION) {
    p.push({ level: 'warning', message: `config version ${cfg.version} != ${CONFIG_VERSION}; run "zeus init --migrate"` });
  }
  if (!cfg.project?.adapter || !adapterById(String(cfg.project.adapter))) {
    p.push({ level: 'error', message: `unknown project.adapter "${cfg.project?.adapter}"` });
  }
  const r = cfg.resources ?? {};
  if (Number(r.globalHeavyTestConcurrency) > 1) {
    p.push({ level: 'warning', message: 'globalHeavyTestConcurrency > 1: concurrent heavy suites can starve the host' });
  }
  if (!Number(r.heavyTestTimeoutSeconds)) {
    p.push({ level: 'error', message: 'resources.heavyTestTimeoutSeconds must be a positive number' });
  }
  if (cfg.providers?.billing && cfg.providers.billing !== 'subscription-cli-only') {
    p.push({ level: 'error', message: 'providers.billing must be subscription-cli-only; paid API fallback is not supported' });
  }
  const h = cfg.validation?.hardening ?? {};
  // Saying "off" and being ignored is worse than being told. A config that
  // tries to disable an anti-gaming rule is an error, not a silent no-op.
  for (const key of ['mixedDiffMaxTier', 'testSurfaceRisk'] as const) {
    if (h[key] === false) {
      p.push({ level: 'error', message: `validation.hardening.${key} cannot be disabled: it is what makes unattended validation trustworthy` });
    }
  }
  if (cfg.validation?.strategy && cfg.validation.strategy !== 'fastest-safe') {
    p.push({ level: 'error', message: `unknown validation.strategy "${cfg.validation.strategy}" (supported: fastest-safe)` });
  }
  if (h.genericAdapterFloor && !['normal', 'deep'].includes(String(h.genericAdapterFloor).toLowerCase())) {
    p.push({ level: 'error', message: 'validation.hardening.genericAdapterFloor must be normal or deep; the generic adapter cannot justify fast' });
  }
  if (h.reviewerExpansionBudget !== undefined) {
    const n = Number(h.reviewerExpansionBudget);
    if (!Number.isInteger(n) || n < 0) {
      p.push({ level: 'error', message: 'validation.hardening.reviewerExpansionBudget must be a non-negative integer' });
    } else if (n > 5) {
      p.push({ level: 'warning', message: `reviewerExpansionBudget ${n} is high: repeated expansion without findings is usually uncertainty, not diligence` });
    }
  }

  for (const key of ['state', 'logs', 'worktrees', 'deps'] as const) {
    const v = String(cfg.paths?.[key] ?? '');
    if (path.isAbsolute(v) || v.split(/[\\/]/).includes('..')) {
      p.push({ level: 'error', message: `paths.${key} must stay inside the project (got "${v}")` });
    }
  }
  return p;
}
