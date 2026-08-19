/**
 * Dependency registry and detection.
 *
 * Each dependency states what it is for and how important it is, because
 * "missing" means very different things for git and for Docker. Nothing here
 * installs anything: detection and action are deliberately separate, so the
 * wizard can show a complete picture before asking for consent.
 */

import { SystemProbe } from './probe';

export type Tier = 'core' | 'provider' | 'recommended' | 'optional';
export type DepState = 'installed' | 'missing' | 'unsupported-version';

export interface DependencySpec {
  id: string;
  label: string;
  tier: Tier;
  bin: string;
  /** Why a user should care. Shown when it is missing. */
  purpose: string;
  versionArgs?: string[];
  /** Minimum major version, when one is genuinely required. */
  minMajor?: number;
  /** npm package for user-level installs; system packages come from pkg.ts. */
  npmPackage?: string;
  systemPackage?: string;
  /** Linux-only tools are not reported as missing elsewhere. */
  linuxOnly?: boolean;
  /** What to tell the user when we deliberately will not install it for them. */
  hint?: string;
}

export const DEPENDENCIES: DependencySpec[] = [
  { id: 'git', label: 'Git', tier: 'core', bin: 'git', versionArgs: ['--version'],
    purpose: 'worktrees, diffs and commit history — Zeus cannot operate without it',
    systemPackage: 'git' },
  { id: 'node', label: 'Node.js', tier: 'core', bin: 'node', versionArgs: ['--version'], minMajor: 18,
    purpose: 'the runtime Zeus and both provider CLIs execute on',
    // Deliberately not automated: replacing someone's Node is their decision,
    // and a distribution package is rarely the one they want.
    hint: 'install Node.js 18 or newer with nvm (https://github.com/nvm-sh/nvm), fnm, or your distribution' },
  { id: 'npm', label: 'npm', tier: 'core', bin: 'npm', versionArgs: ['--version'],
    purpose: 'installs the provider CLIs into your user prefix' },

  { id: 'claude', label: 'Claude Code', tier: 'provider', bin: 'claude', versionArgs: ['--version'],
    purpose: 'plans and implements changes', npmPackage: '@anthropic-ai/claude-code' },
  { id: 'codex', label: 'OpenAI Codex', tier: 'provider', bin: 'codex', versionArgs: ['--version'],
    purpose: 'reviews changes independently', npmPackage: '@openai/codex' },

  { id: 'bubblewrap', label: 'bubblewrap', tier: 'recommended', bin: 'bwrap', versionArgs: ['--version'],
    purpose: 'filesystem and network confinement for project commands', systemPackage: 'bubblewrap', linuxOnly: true },
  { id: 'ripgrep', label: 'ripgrep', tier: 'recommended', bin: 'rg', versionArgs: ['--version'],
    purpose: 'fast source search for the agents', systemPackage: 'ripgrep' },
  { id: 'jq', label: 'jq', tier: 'recommended', bin: 'jq', versionArgs: ['--version'],
    purpose: 'inspecting Zeus event logs from the shell', systemPackage: 'jq' },

  { id: 'graphify', label: 'Graphify', tier: 'optional', bin: 'graphify', versionArgs: ['--version'],
    purpose: 'structural code navigation; review works without it',
    hint: 'pip install graphifyy into a virtualenv and put it on PATH' },
  { id: 'docker', label: 'Docker', tier: 'optional', bin: 'docker', versionArgs: ['--version'],
    purpose: 'only if your project’s own tests need containers',
    hint: 'follow your platform\'s Docker installation guide (https://docs.docker.com/engine/install/)' },
  { id: 'gh', label: 'GitHub CLI', tier: 'optional', bin: 'gh', versionArgs: ['--version'],
    purpose: 'only if you want Zeus to interact with GitHub',
    systemPackage: 'gh', hint: 'https://github.com/cli/cli#installation' },
];

export interface DependencyStatus {
  spec: DependencySpec;
  state: DepState;
  path: string | null;
  version: string | null;
  major: number | null;
  detail: string;
}

function parseVersion(text: string): { version: string | null; major: number | null } {
  const m = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(text);
  if (!m) return { version: null, major: null };
  return { version: m[0], major: Number(m[1]) };
}

export function detect(probe: SystemProbe, spec: DependencySpec): DependencyStatus {
  if (spec.linuxOnly && probe.platform() !== 'linux') {
    return { spec, state: 'installed', path: null, version: null, major: null,
      detail: 'not applicable on this platform' };
  }
  const path = probe.which(spec.bin);
  if (!path) {
    return { spec, state: 'missing', path: null, version: null, major: null, detail: 'not found on PATH' };
  }
  if (!spec.versionArgs) {
    return { spec, state: 'installed', path, version: null, major: null, detail: path };
  }
  const r = probe.run(spec.bin, spec.versionArgs, { timeoutMs: 20_000 });
  const { version, major } = parseVersion(`${r.stdout}${r.stderr}`);
  if (spec.minMajor && major !== null && major < spec.minMajor) {
    return { spec, state: 'unsupported-version', path, version, major,
      detail: `${version} found, ${spec.minMajor}+ required` };
  }
  return { spec, state: 'installed', path, version, major, detail: version ?? path };
}

export function detectAll(probe: SystemProbe): DependencyStatus[] {
  return DEPENDENCIES.map((s) => detect(probe, s));
}

export interface SystemInfo {
  platform: string; arch: string; distro: string; shell: string; user: string;
  home: string; pathEntries: number; tty: boolean; supported: boolean; note: string;
}

export function systemInfo(probe: SystemProbe): SystemInfo {
  const d = probe.distro();
  const platform = probe.platform();
  // Linux is the supported target; macOS works but is not what this is tuned
  // for, and anything else is refused rather than half-supported.
  const supported = platform === 'linux' || platform === 'darwin';
  return {
    platform, arch: probe.arch(),
    distro: d ? `${d.name} ${d.version}`.trim() : platform,
    shell: probe.shell(), user: probe.user(), home: probe.homedir(),
    pathEntries: probe.pathEntries().length, tty: probe.isTTY(),
    supported,
    note: supported
      ? (platform === 'darwin' ? 'macOS is usable; Linux is the primary target' : '')
      : `UNSUPPORTED_PLATFORM: ${platform}`,
  };
}
