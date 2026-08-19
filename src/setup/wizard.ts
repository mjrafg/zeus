/**
 * The setup wizard.
 *
 * One command installs Zeus; this then walks the user through what the
 * machine already has, what is missing, and what they would like done about
 * it. The governing rule is that **nothing is installed, elevated or
 * authenticated without an explicit yes**, and every command is printed before
 * it runs.
 *
 * The flow is resumable: progress is recorded as it happens, and detection is
 * re-run from scratch every time, so an interrupted sign-in is continued rather
 * than restarted.
 */

import { SystemProbe } from './probe';
import { DependencyStatus, DependencySpec, detectAll, systemInfo, SystemInfo } from './deps';
import {
  detectPackageManager, privileges, installSystemPackages, installNpmGlobal,
  installCommand, PackageManager, PrivilegeContext,
} from './pkg';
import {
  PROVIDERS, ProviderId, ProviderStatus, providerStatus, installProvider, loginProvider,
  loginWithApiKey, RoleAssignment, DEFAULT_ROLES, roleOf, roleWarnings,
} from './providers';

export type FailureCode =
  | 'DEPENDENCY_MISSING'
  | 'DEPENDENCY_VERSION_UNSUPPORTED'
  | 'DEPENDENCY_INSTALL_FAILED'
  | 'AUTHENTICATION_REQUIRED'
  | 'AUTHENTICATION_FAILED'
  | 'PERMISSION_REQUIRED'
  | 'UNSUPPORTED_PLATFORM'
  | 'NO_PACKAGE_MANAGER';

export interface Unmet {
  code: FailureCode;
  component: string;
  /** True when Zeus cannot run at all until this is resolved. */
  blocking: boolean;
  detail: string;
  remedy: string;
}

/** Everything setup asks a human. Tests supply a scripted implementation. */
export interface Consent {
  /** Yes/no. `def` is what pressing enter means. */
  confirm(question: string, def: boolean): boolean;
  /** Multi-select; returns the chosen ids. */
  choose(prompt: string, options: Array<{ id: string; label: string; selected: boolean }>): string[];
  /** Single choice; returns the chosen id. */
  pick(prompt: string, options: Array<{ id: string; label: string }>, def: string): string;
  /** Reads a value that must never be echoed. Absent means "cannot ask". */
  secret?(prompt: string): string;
}

/**
 * Refuses everything, and records what it refused.
 *
 * This is what `--non-interactive` and CI get: no installation, no browser
 * OAuth, no guessed consent — just an accurate report of what a human would
 * have been asked.
 */
export class NonInteractiveConsent implements Consent {
  readonly asked: string[] = [];
  confirm(question: string): boolean { this.asked.push(question); return false; }
  choose(prompt: string): string[] { this.asked.push(prompt); return []; }
  pick(prompt: string, _options: Array<{ id: string; label: string }>, def: string): string {
    this.asked.push(prompt);
    return def;
  }
}

export interface SetupState {
  version: number;
  startedAt: string;
  updatedAt: string;
  /** Steps already completed, so a rerun continues instead of repeating work. */
  completed: string[];
  roles: RoleAssignment;
  /** Components the user said no to; recorded so a rerun can lead with them. */
  declined: string[];
  lastOutcome: string | null;
}

export const SETUP_STATE_VERSION = 1;

export function emptyState(): SetupState {
  const now = new Date().toISOString();
  return {
    version: SETUP_STATE_VERSION, startedAt: now, updatedAt: now,
    completed: [], roles: { ...DEFAULT_ROLES }, declined: [], lastOutcome: null,
  };
}

export interface StateStore {
  load(): SetupState;
  save(s: SetupState): void;
}

export interface SetupOptions {
  probe: SystemProbe;
  consent: Consent;
  store: StateStore;
  out: (line: string) => void;
  /** Detect and report only; change nothing at all. */
  dryRun?: boolean;
  /**
   * False when there is no human to ask. Setup then reports and stops: it does
   * not install, does not sign in, and does not record silence as a refusal.
   */
  interactive?: boolean;
  /** Limits the run to one half of setup. */
  scope?: 'all' | 'dependencies' | 'providers';
  /** Offer API-key sign-in where the vendor supports it. Off by default. */
  advanced?: boolean;
  /** Roles are configuration, so the caller persists them where it wants. */
  onRoles?: (roles: RoleAssignment) => void;
}

export interface SetupReport {
  system: SystemInfo;
  dependencies: DependencyStatus[];
  providers: ProviderStatus[];
  packageManager: string | null;
  privileges: { isRoot: boolean; sudoAvailable: boolean };
  roles: RoleAssignment;
  actions: Array<{ action: string; command: string; result: string }>;
  unmet: Unmet[];
  warnings: string[];
  ready: boolean;
  dryRun: boolean;
  /** Steps carried over from a previous, interrupted run. */
  resumed: string[];
}

const OK = '✓', NO = '✗', WARN = '!';

const TIER_TITLE: Record<string, string> = {
  core: 'Required', provider: 'AI providers', recommended: 'Recommended', optional: 'Optional',
};

function symbolFor(d: DependencyStatus): string {
  if (d.state === 'installed') return OK;
  return d.spec.tier === 'core' ? NO : WARN;
}

/**
 * Runs setup.
 *
 * The shape is always the same: detect everything → show everything → ask →
 * act on exactly what was accepted → re-detect → report. Detection never
 * mutates, so `--dry-run` follows the identical path and simply stops before
 * the asking.
 */
export function runSetup(opts: SetupOptions): SetupReport {
  const { probe, consent, store, out } = opts;
  const scope = opts.scope ?? 'all';
  const dryRun = !!opts.dryRun;
  const interactive = opts.interactive !== false;
  const state = store.load();
  const resumed = [...state.completed];
  const actions: SetupReport['actions'] = [];
  const unmet: Unmet[] = [];
  const warnings: string[] = [];

  const sys = systemInfo(probe);
  let deps = detectAll(probe);
  let provs = (Object.keys(PROVIDERS) as ProviderId[]).map((id) => providerStatus(probe, id));
  const pm = detectPackageManager(probe);
  const priv = privileges(probe);

  // ---- report what is here -------------------------------------------------
  out('');
  out('Zeus setup');
  out('');
  out(`  system    ${sys.distro} · ${sys.arch}`);
  out(`  user      ${sys.user}${priv.isRoot ? ' (root)' : ''} · shell ${sys.shell}`);
  out(`  packages  ${pm ? pm.id : 'no supported package manager'}${!priv.isRoot && priv.sudoAvailable ? ' · sudo available' : ''}`);
  if (sys.note) out(`  note      ${sys.note}`);

  if (!sys.supported) {
    unmet.push({
      code: 'UNSUPPORTED_PLATFORM', component: sys.platform, blocking: true,
      detail: `${sys.platform} is not supported`, remedy: 'Zeus targets Linux; macOS is usable but untuned',
    });
  }

  showInventory();

  if (resumed.length) {
    out('');
    out(`Resuming a previous setup (${resumed.length} step${resumed.length === 1 ? '' : 's'} already done: ${resumed.join(', ')}).`);
  }

  if (dryRun) {
    out('');
    out('Dry run: nothing was installed, changed, or authenticated.');
    collectOutstanding();
    return finish();
  }

  if (!interactive) {
    // No human to ask, so nothing is done and nothing is inferred. Silence is
    // not a refusal either: the outstanding list below is simply the truth.
    out('');
    out('No terminal available: reporting only. Nothing was installed and no sign-in was attempted.');
    collectOutstanding();
    return finish();
  }

  // ---- dependencies --------------------------------------------------------
  if (scope === 'all' || scope === 'dependencies') doDependencies();

  // ---- providers -----------------------------------------------------------
  if (scope === 'all' || scope === 'providers') doProviders();

  // ---- verify --------------------------------------------------------------
  deps = detectAll(probe);
  provs = (Object.keys(PROVIDERS) as ProviderId[]).map((id) => providerStatus(probe, id));
  collectOutstanding();

  out('');
  out('Final check');
  for (const d of deps.filter((x) => x.spec.tier === 'core')) {
    out(`  ${symbolFor(d)} ${d.spec.label.padEnd(14)} ${d.state === 'installed' ? d.detail : d.detail}`);
  }
  for (const p of provs) {
    const role = roleOf(state.roles, p.id);
    if (role === 'none') { out(`  · ${p.label.padEnd(14)} not used`); continue; }
    const good = p.installed && p.auth === 'AUTHENTICATED';
    out(`  ${good ? OK : NO} ${p.label.padEnd(14)} ${good ? `ready · ${role}` : p.detail}`);
  }

  return finish();

  // ==== steps ===============================================================

  function showInventory(): void {
    for (const tier of ['core', 'provider', 'recommended', 'optional'] as const) {
      const rows = deps.filter((d) => d.spec.tier === tier);
      if (!rows.length) continue;
      out('');
      out(`${TIER_TITLE[tier]}`);
      for (const d of rows) {
        const right = d.state === 'installed'
          ? (d.version ? d.version : (d.path ?? 'present'))
          : `${d.state === 'missing' ? 'not installed' : d.detail} — ${d.spec.purpose}`;
        out(`  ${symbolFor(d)} ${d.spec.label.padEnd(14)} ${right}`);
        if (tier === 'provider') {
          const p = provs.find((x) => x.id === d.spec.id);
          if (p?.installed) {
            out(`      ${p.auth === 'AUTHENTICATED' ? OK : NO} ${p.auth === 'AUTHENTICATED' ? p.detail : 'not authenticated'}`);
          }
        }
      }
    }
  }

  function doDependencies(): void {
    const candidates = deps.filter((d) =>
      d.spec.tier !== 'provider' &&
      (d.state === 'missing' || d.state === 'unsupported-version'));
    if (!candidates.length) return;

    out('');
    const chosen = consent.choose('Install missing dependencies — select what you want:',
      candidates.map((d) => ({
        id: d.spec.id,
        label: `${d.spec.label} (${d.spec.tier}) — ${d.spec.purpose}`,
        // Required and recommended come pre-ticked; optional never does.
        selected: d.spec.tier === 'core' || d.spec.tier === 'recommended',
      })));

    for (const d of candidates) {
      if (!chosen.includes(d.spec.id)) { decline(d.spec.id); continue; }
      installDependency(d);
    }
  }

  function installDependency(d: DependencyStatus): void {
    const spec = d.spec;

    if (spec.npmPackage) {
      const display = `npm install -g ${spec.npmPackage}`;
      out(`  running: ${display}`);
      const r = installNpmGlobal(probe, spec.npmPackage);
      actions.push({ action: `install ${spec.label}`, command: r.command, result: r.code });
      if (r.code === 'INSTALLED') { markDone(`install:${spec.id}`); if (r.prefixChanged) warnings.push(`npm global prefix set to ${r.prefixChanged}; make sure ${r.prefixChanged}/bin is on your PATH`); }
      return;
    }

    if (!spec.systemPackage) {
      // Node is the notable case: choosing a Node distribution for someone is
      // a decision with consequences, so we describe it instead.
      out(`  ${WARN} ${spec.label} is not something Zeus will install for you.`);
      out(`      ${spec.hint ?? manualHint(spec, pm, priv)}`);
      return;
    }

    if (!pm) {
      out(`  ${WARN} no supported package manager; ${spec.label} must be installed by hand`);
      return;
    }

    const cmd = installCommand(pm, [spec.systemPackage], priv);
    out('');
    out(`${spec.label} would be installed with:`);
    out(`  ${cmd.display}`);
    if (cmd.requiresSudo) out('  (this needs administrator privileges)');
    // Privilege is never assumed: the exact command is shown and consented to.
    if (!consent.confirm('Run this command?', false)) { decline(spec.id); return; }

    const r = installSystemPackages(probe, [spec.systemPackage]);
    actions.push({ action: `install ${spec.label}`, command: r.command, result: r.code });
    if (r.code === 'INSTALLED') markDone(`install:${spec.id}`);
    else out(`  ${WARN} ${r.detail}`);
  }

  function doProviders(): void {
    chooseRoles();
    for (const id of Object.keys(PROVIDERS) as ProviderId[]) {
      if (roleOf(state.roles, id) === 'none') continue;
      const spec = PROVIDERS[id];
      let st = provs.find((p) => p.id === id)!;

      if (!st.installed) {
        out('');
        out(`${spec.label} is not installed. It would be installed with:`);
        out(`  npm install -g ${spec.npmPackage}`);
        if (!consent.confirm(`Install ${spec.label}?`, true)) { decline(id); continue; }
        const r = installProvider(probe, id);
        actions.push({ action: `install ${spec.label}`, command: r.command, result: r.code });
        if (r.code !== 'INSTALLED') { out(`  ${NO} ${r.detail}`); continue; }
        markDone(`install:${id}`);
        if (r.prefixChanged) warnings.push(`npm global prefix set to ${r.prefixChanged}; make sure ${r.prefixChanged}/bin is on your PATH`);
        st = providerStatus(probe, id);
        provs = provs.map((p) => (p.id === id ? st : p));
      }

      if (st.auth === 'AUTHENTICATED') { markDone(`auth:${id}`); continue; }

      out('');
      out(`${spec.label} is installed but not signed in.`);
      out(`Sign-in is handled entirely by ${spec.label} itself — Zeus never sees your`);
      out('password, your OAuth tokens, or your account details.');

      if (!probe.isTTY()) {
        out(`  ${WARN} sign-in needs a terminal; run: ${spec.bin} ${spec.loginArgs.join(' ')}`);
        continue;
      }
      if (!consent.confirm(`Sign in to ${spec.label} now?`, true)) { decline(`auth:${id}`); continue; }

      const useKey = opts.advanced && spec.apiKeyLogin && consent.secret
        && consent.confirm(`Use an API key instead of the normal ${spec.label} sign-in? (advanced)`, false);

      let r;
      if (useKey) {
        // The key goes to the vendor CLI on stdin and nowhere else.
        const key = consent.secret!(`${spec.label} API key (not echoed, not stored by Zeus):`);
        if (!key) { out(`  ${WARN} no key entered`); continue; }
        r = loginWithApiKey(probe, id, key);
        actions.push({ action: `authenticate ${spec.label}`, command: `${spec.bin} ${spec.apiKeyLogin!.args.join(' ')}`, result: r.state });
      } else {
        out(`  launching: ${spec.bin} ${spec.loginArgs.join(' ')}`);
        out(`  ${spec.label} will print its own sign-in URL below; open it in any browser.`);
        r = loginProvider(probe, id);
        actions.push({ action: `authenticate ${spec.label}`, command: `${spec.bin} ${spec.loginArgs.join(' ')}`, result: r.state });
      }
      if (r.state === 'AUTHENTICATED') markDone(`auth:${id}`);
      else out(`  ${NO} ${r.detail}`);
    }
  }

  function chooseRoles(): void {
    const base = [
      { id: 'claude', label: `${PROVIDERS.claude.label} — plans and writes code` },
      { id: 'codex', label: `${PROVIDERS.codex.label} — independent review` },
      { id: 'none', label: 'Decide later' },
    ];
    const dev = consent.pick('Which provider should implement changes?', base, state.roles.developer ?? 'claude');
    const rev = consent.pick('Which provider should review them independently?', base, state.roles.reviewer ?? 'codex');
    state.roles = {
      developer: dev === 'none' ? null : (dev as ProviderId),
      reviewer: rev === 'none' ? null : (rev as ProviderId),
    };
    markDone('roles');
    for (const w of roleWarnings(state.roles)) warnings.push(w);
    // Roles are configuration, never credentials; the caller decides where.
    opts.onRoles?.(state.roles);
  }

  // ==== helpers =============================================================

  function markDone(step: string): void {
    if (!state.completed.includes(step)) state.completed.push(step);
  }

  function decline(id: string): void {
    if (!state.declined.includes(id)) state.declined.push(id);
  }

  function manualHint(spec: DependencySpec, mgr: PackageManager | null, p: PrivilegeContext): string {
    if (spec.npmPackage) return `npm install -g ${spec.npmPackage}`;
    if (spec.systemPackage && mgr) return installCommand(mgr, [spec.systemPackage], p).display;
    if (spec.hint) return spec.hint;
    if (spec.systemPackage) return `install the "${spec.systemPackage}" package using your platform's package manager`;
    return `install ${spec.label}`;
  }

  /** Rebuilds the outstanding list from current facts, not from what we tried. */
  function collectOutstanding(): void {
    for (let i = unmet.length - 1; i >= 0; i -= 1) {
      if (unmet[i].code !== 'UNSUPPORTED_PLATFORM') unmet.splice(i, 1);
    }
    for (const d of deps) {
      if (d.state === 'installed') continue;
      if (d.spec.tier === 'provider') continue;   // handled below, by role
      // A missing package manager is a distinct, more useful diagnosis than a
      // missing package: no amount of consent would have installed it.
      const noWayToInstall = !!d.spec.systemPackage && !d.spec.npmPackage && !pm;
      unmet.push({
        code: noWayToInstall ? 'NO_PACKAGE_MANAGER'
          : d.state === 'missing' ? 'DEPENDENCY_MISSING' : 'DEPENDENCY_VERSION_UNSUPPORTED',
        component: d.spec.label,
        blocking: d.spec.tier === 'core',
        detail: noWayToInstall ? `${d.detail}; no supported package manager on this host` : d.detail,
        remedy: manualHint(d.spec, pm, priv),
      });
    }
    for (const p of provs) {
      const role = roleOf(state.roles, p.id);
      if (role === 'none') continue;             // not selected: not required
      const spec = PROVIDERS[p.id];
      if (!p.installed) {
        unmet.push({ code: 'DEPENDENCY_MISSING', component: spec.label, blocking: true,
          detail: `required as ${role} but not installed`, remedy: `npm install -g ${spec.npmPackage}` });
      } else if (p.auth !== 'AUTHENTICATED') {
        unmet.push({
          code: p.auth === 'AUTHENTICATION_FAILED' ? 'AUTHENTICATION_FAILED' : 'AUTHENTICATION_REQUIRED',
          component: spec.label, blocking: true,
          detail: `required as ${role} but not signed in`,
          remedy: `${spec.bin} ${spec.loginArgs.join(' ')}`,
        });
      }
    }
  }

  function finish(): SetupReport {
    const blocking = unmet.filter((u) => u.blocking);
    const ready = blocking.length === 0;

    state.updatedAt = new Date().toISOString();
    state.lastOutcome = ready ? 'READY' : blocking.map((u) => u.code).join(',');
    if (!dryRun) store.save(state);

    out('');
    if (ready) {
      out('Zeus is ready.');
      out('  next: cd <your project> && zeus init');
    } else {
      out('Setup is not complete. Outstanding:');
      for (const u of blocking) out(`  ${NO} ${u.code}  ${u.component}: ${u.detail}`);
      out('');
      out('  fix with:');
      for (const u of blocking) out(`    ${u.remedy}`);
      out('');
      out('  then run: zeus setup');
    }
    const optional = unmet.filter((u) => !u.blocking);
    if (optional.length) {
      out('');
      out('Optional, not installed:');
      for (const u of optional) out(`  ${WARN} ${u.component} — ${u.remedy}`);
    }
    for (const w of warnings) out(`  ${WARN} ${w}`);

    return {
      system: sys, dependencies: deps, providers: provs,
      packageManager: pm ? pm.id : null,
      privileges: { isRoot: priv.isRoot, sudoAvailable: priv.sudoAvailable },
      roles: state.roles, actions, unmet, warnings, ready, dryRun, resumed,
    };
  }
}
