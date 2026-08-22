#!/usr/bin/env node
/**
 * `zeus` — the user-facing CLI.
 *
 * Zeus is installed once per user and initialised into each project, so
 * this command is deliberately thin: it detects the project, writes/reads
 * `.zeus/config.yaml`, reports capabilities, and talks to the engine.
 * Nothing here writes into the user's source tree except that one directory.
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  ProjectConfig, defaultConfig, findProjectRoot, projectConfigPath, readConfig,
  renderConfig, userConfigDir, userDataDir, userDefaultsPath, validateConfig,
  writeConfig, writeUserDefaults, PROJECT_DIR,
} from './config';
import { detectProject } from './adapters';
import { probe, summarize, Capability } from './doctor';
import { projectReadiness, ReadinessProbe, ReadinessReport } from './readiness';
import { describeDependencyState, cleanDependencyCache, depsCacheRoot } from './engine/dependencies';
import { Engine, TERMINAL } from './engine/orchestrator';
import { ProcessSupervisor } from './engine/exec';
import { defaultPolicy } from './engine/policy';
import { readOnlyGit } from './engine/gitro';
import { MissionRegistry } from './mission/registry';
import { PlanGraph, ScopeMismatchError, scopeOf, localLabel as missionLabel } from './mission/types';
import { reconstructRatchet, ratchetRef, readRatchet } from './mission/ratchet';
import { compileOracle, critiqueOracle, proposeAcceptance } from './mission/compile';
import { evaluateCriteria, acceptedCommands } from './mission/evaluate';
import {
  requireAcceptedOracle, planMission, critiquePlan, planAcceptance,
} from './mission/planner';
import { runMissionLoop } from './mission/loop';
import { missionHost, ledgerFrom } from './mission/host';
import {
  missionUsage, progressFrom, providerSpendOf, negotiateBudget, applyBudgetRevisions,
  mergeMissionBudgets, BudgetNegotiation,
} from './mission/progress';
import { missionStatusView, missionListView, missionReportView } from './views';
import {
  startWebServer, defaultSpawnRun, zeusCliArgv, ProjectTarget,
} from './web/server';
import { defaultProjectsRoot } from './projects';
import {
  compileMissionOracle, planMissionGraph, recompileMissionOracle,
  MAX_ORACLE_RECOMPILES,
} from './mission/operations';
import { selftestLive, SelftestReport } from './mission/selftest';
import {
  Criterion, Oracle, ProjectContext, validateOracle, makeCriterionId,
  CriticFindingRef, findingFamily,
} from './mission/oracle';
import { deriveBudgets } from './engine/budget';
import { report as isolationReport } from './engine/isolation';
import { claudeProvider, codexProvider, mockProvider, Provider } from './engine/providers';
import { RealProbe } from './setup/probe';
import { runSetup, NonInteractiveConsent, SetupReport } from './setup/wizard';
import { TtyConsent, interactivePossible } from './setup/prompt';
import { FileStateStore, applyRoles } from './setup/state';
import { RoleAssignment, DEFAULT_ROLES, ProviderId } from './setup/providers';
import { planMigration, applyMigration, MigrationPlan } from './migrate';
import { taskTelemetry, zeroTouchCleanRate, formatZeroTouch, TaskTelemetry } from './validation/telemetry';
import { revalidateForIntegration, GitAccess } from './validation/revalidate';
import { impactConfidence } from './validation/tier';
import { parseDiff } from './validation/diff';
import { renderEscalation, EscalationPayload } from './validation/escalation';
import { runtimeState, createAuditCheckout } from './selfaudit/checkout';
import { runLane, consolidate } from './selfaudit/runner';
import { renderMarkdown, renderTerminal } from './selfaudit/report';
import { runSelfCheck, renderRefusal } from './selfaudit/commitgate';

/** Single source of truth: the packaged manifest, not a second literal. */
export const VERSION: string = (() => {
  for (const rel of ['../package.json', '../../package.json']) {
    try { return require(rel).version as string; } catch { /* try the next */ }
  }
  return '0.0.0-unknown';
})();

const C = process.stdout.isTTY ? {
  b: '\x1b[1m', dim: '\x1b[2m', g: '\x1b[32m', y: '\x1b[33m', r: '\x1b[31m', x: '\x1b[0m',
} : { b: '', dim: '', g: '', y: '', r: '', x: '' };

const mark = (l: Capability['level']) => (l === 'ok' ? `${C.g}✓${C.x}` : l === 'warn' ? `${C.y}!${C.x}` : `${C.r}✗${C.x}`);

function out(s = ''): void { process.stdout.write(`${s}\n`); }
function err(s: string): void { process.stderr.write(`${s}\n`); }

function usage(): void {
  out(`${C.b}zeus${C.x} ${VERSION} — autonomous development control plane

${C.b}Usage${C.x}
  zeus setup [dependencies|providers]    interactive bootstrap: check, install, sign in
        [--dry-run] [--non-interactive] [--json] [--advanced]
  zeus init [--force] [--adapter <id>]   inspect this repository and create .zeus/config.yaml
  zeus web [--port N] [--host H] [--projects <dir>]
                                         the Control Center; --projects enables the home
  zeus doctor                            report what this machine can actually do
  zeus run "<task>" [--mock]              run a task in this project
  zeus status [<taskId>]
  zeus cancel <taskId> [--reason "..."]
  zeus logs [<taskId>] [--follow]
  zeus config [get <key> | set <key> <value>]  read or edit this project's configuration
  zeus config [get <key> | set <key> <value>]  read or edit this project's configuration
  zeus revalidate <taskId> [--into <ref>]     recheck a verified task against a moved integration target
  zeus self-audit [--lane A-F] [--cycle-id <id>]  audit this checkout adversarially, on a disposable copy
  zeus self-check                             gate for Zeus's own commits: boundary checks + the non-service suite
  zeus clean --deps                           remove this project's prepared dependency caches
  zeus mission create "<goal>"                 record a mission goal (no planning, no model)
  zeus mission status <id> [--json]           reconstructed mission state
  zeus mission list                           missions in this project
  zeus mission cancel <id> [--reason "..."]   cancel a mission and its live tasks
  zeus mission compile <id> [--mock]          compile the goal into criteria, critique, compute mode
        [--review-oracle] [--json]
  zeus mission confirm <id>                   accept an oracle, with any findings on the record
  zeus mission recompile <id> [--mock]        send the critique back to the compiler and retry
  zeus mission evaluate <id> [--full]         prove the criteria; --criteria a,b for a subset
  zeus mission plan <id> [--mock]             plan the accepted contract and critique it
  zeus mission accept-plan <id> [--version N] --yes [--raise-budget]
                                              accept the plan on the log, findings recorded
  zeus mission selftest --live                real provider contact before anything is spent
  zeus mission run <id> [--mock] [--yes]      execute the accepted plan, one node at a time
  zeus mission report <id> [--json]           the full account, derived from the log
        [--criteria a,b] [--mock] [--json]
  zeus version
  zeus help

${C.dim}Zeus is installed per user; it is not vendored into your project.
Runtime:  ${userDataDir()}${C.x}`);
}

/** Reads the configured provider roles, falling back to the recommended pair. */
function rolesFor(cfg: ProjectConfig | null): RoleAssignment {
  const known = (v: unknown): ProviderId | null =>
    v === 'claude' || v === 'claude-code' ? 'claude' : v === 'codex' ? 'codex' : null;
  if (!cfg?.providers) return DEFAULT_ROLES;
  return {
    developer: known(cfg.providers.planner) ?? known(cfg.providers.implementer),
    reviewer: known(cfg.providers.reviewer),
  };
}

function requireProject(): { root: string; cfg: ProjectConfig } | null {
  const root = findProjectRoot();
  if (!root) { err(`${C.r}not inside a git repository or an initialised project${C.x}\nRun zeus init from your project root.`); return null; }
  const cfg = readConfig(root);
  if (!cfg) { err(`${C.r}no ${PROJECT_DIR}/config.yaml in ${root}${C.x}\nRun: zeus init`); return null; }
  const problems = validateConfig(cfg);
  const fatal = problems.filter((p) => p.level === 'error');
  if (fatal.length) {
    err(`${C.r}invalid ${PROJECT_DIR}/config.yaml${C.x}`);
    for (const p of problems) err(`  ${p.level === 'error' ? C.r + '✗' : C.y + '!'}${C.x} ${p.message}`);
    return null;
  }
  return { root, cfg };
}

function cmdInit(args: string[]): number {
  const root = findProjectRoot() ?? process.cwd();
  const force = args.includes('--force');
  if (args.includes('--migrate')) offerMigration(root, { assumeYes: true });
  const adapterFlag = args[args.indexOf('--adapter') + 1];
  const existing = readConfig(root);
  if (existing && !force) {
    out(`${C.y}!${C.x} ${projectConfigPath(root)} already exists. Re-run with --force to overwrite.`);
    return 0;
  }

  const det = detectProject(root);
  out(`${C.b}Inspecting${C.x} ${root}\n`);
  out(`  ${mark(det.isGitRepo ? 'ok' : 'warn')} Git repository ${det.isGitRepo ? 'detected' : `${C.y}not found — Zeus needs version control to work safely${C.x}`}`);
  out(`  ${mark('ok')} Project type detected: ${C.b}${det.primary.name}${C.x}${det.all.length > 1 ? ` ${C.dim}(also: ${det.all.slice(1).map((a) => a.name).join(', ')})${C.x}` : ''}`);
  if (det.markersFound.length) out(`  ${C.dim}   markers: ${det.markersFound.join(', ')}${C.x}`);

  const cfg = defaultConfig(root);
  if (adapterFlag && !adapterFlag.startsWith('--')) {
    const a = require('./adapters').adapterById(adapterFlag);
    if (!a) { err(`${C.r}unknown adapter "${adapterFlag}"${C.x}`); return 2; }
    cfg.project.adapter = a.id;
    cfg.commands = a.commands(root);
    cfg.policy.protectedPaths = a.protectedPaths(root);
  }
  const declared = Object.entries(cfg.commands).filter(([, v]) => v);
  out(`  ${mark(declared.length ? 'ok' : 'warn')} Build/test tooling: ${declared.length ? declared.map(([k]) => k).join(', ') : `${C.y}none detected — Zeus will rely on review only${C.x}`}`);

  const caps = probe(rolesFor(cfg));
  for (const id of ['claude', 'codex', 'graphify']) {
    const c = caps.find((x) => x.id === id)!;
    out(`  ${mark(c.level)} ${c.label}: ${c.detail}`);
  }
  const iso = isolationReport();
  out(`  ${mark(iso.fallbackMode ? 'warn' : 'ok')} Execution isolation: ${iso.selected}${iso.fallbackMode ? ' (FALLBACK — process groups only)' : ''}`);

  const file = writeConfig(root, cfg);
  for (const sub of ['state', 'logs']) fs.mkdirSync(path.join(root, PROJECT_DIR, sub), { recursive: true });
  const ignore = path.join(root, PROJECT_DIR, '.gitignore');
  if (!fs.existsSync(ignore)) {
    // Config is worth committing; runtime state never is.
    fs.writeFileSync(ignore, 'state/\nlogs/\nworktrees/\n');
  }
  out(`\n${C.g}Created${C.x} ${path.relative(root, file)}`);
  out(`${C.dim}         ${PROJECT_DIR}/state/, ${PROJECT_DIR}/logs/ (git-ignored)${C.x}`);
  out(`\n${C.b}Zeus ready.${C.x}  Next: ${C.b}zeus doctor${C.x}, then ${C.b}zeus run "…"${C.x}`);
  return 0;
}

/**
 * `zeus setup` — the interactive bootstrap.
 *
 * Detects the machine, shows what is present and what is missing, and then
 * asks before doing anything at all. Without a terminal it degrades to a
 * report: no installs, no browser OAuth, and no consent inferred from silence.
 */
/**
 * Offers to move a pre-rename layout across.
 *
 * Old development installs used `.autopilot/` and
 * `~/.local/share/ai-autopilot/`. Those hold configuration, task state and
 * hash-chained evidence, so nothing is moved without a yes, and nothing is ever
 * overwritten or deleted. Without a terminal this only reports.
 */
function offerMigration(root: string | null, opts: { assumeYes?: boolean } = {}): void {
  let plan: MigrationPlan;
  try { plan = planMigration(root); } catch { return; }
  if (!plan.needed) return;

  out('');
  out(`${C.y}!${C.x} Legacy Zeus configuration detected.`);
  for (const st of plan.steps) {
    const what = st.contains.length ? st.contains.join(', ') : 'empty';
    out(`    ${st.from}  ${C.dim}(${what})${C.x}`);
    if (st.status === 'conflict') out(`      ${C.y}!${C.x} ${st.reason}`);
  }
  const movable = plan.steps.filter((st) => st.status === 'ready');
  if (!movable.length) {
    out(`  ${C.dim}Nothing can be moved automatically; both copies were left untouched.${C.x}`);
    return;
  }

  let go = !!opts.assumeYes;
  if (!go) {
    if (!interactivePossible()) {
      out(`  ${C.dim}Run ${C.b}zeus init --migrate${C.x}${C.dim} on a terminal to move it to ${PROJECT_DIR}/.${C.x}`);
      return;
    }
    go = new TtyConsent().confirm(`  Migrate to ${PROJECT_DIR}/?`, true);
  }
  if (!go) {
    out(`  ${C.dim}Left as it is. Zeus will keep asking until it is moved or removed.${C.x}`);
    return;
  }
  for (const r of applyMigration(plan)) {
    out(`  ${r.moved ? `${C.g}✓${C.x}` : `${C.y}!${C.x}`} ${r.detail}`);
  }
}

/** Reads a dotted path out of a parsed config. */
function getPath(obj: any, dotted: string): unknown {
  return dotted.split('.').reduce((acc, k) => (acc == null ? acc : acc[k]), obj);
}

/**
 * Writes a dotted path, coercing the value to the type already stored there.
 *
 * Only keys that already exist are settable. Inventing a key silently is how a
 * typo becomes a setting that looks applied and does nothing.
 */
function setPath(obj: any, dotted: string, raw: string): { ok: true } | { ok: false; why: string } {
  const keys = dotted.split('.');
  let cur = obj;
  for (const k of keys.slice(0, -1)) {
    if (cur == null || typeof cur !== 'object' || !(k in cur)) return { ok: false, why: `no such key "${dotted}"` };
    cur = cur[k];
  }
  const last = keys[keys.length - 1];
  if (cur == null || typeof cur !== 'object' || !(last in cur)) return { ok: false, why: `no such key "${dotted}"` };
  const existing = cur[last];
  if (Array.isArray(existing)) {
    cur[last] = raw.split(',').map((x) => x.trim()).filter(Boolean);
  } else if (typeof existing === 'boolean') {
    if (!/^(true|false)$/i.test(raw)) return { ok: false, why: `${dotted} is a boolean; got "${raw}"` };
    cur[last] = /^true$/i.test(raw);
  } else if (typeof existing === 'number') {
    const n = Number(raw);
    if (!Number.isFinite(n)) return { ok: false, why: `${dotted} is a number; got "${raw}"` };
    cur[last] = n;
  } else {
    cur[last] = raw;
  }
  return { ok: true };
}

/** `zeus config` — read, or carefully edit, this project's configuration. */
function cmdConfig(argv: string[]): number {
  const ctx = requireProject();
  if (!ctx) return 2;
  const file = projectConfigPath(ctx.root);
  const [sub, key, ...rest] = argv.filter((a) => !a.startsWith('--'));
  const json = argv.includes('--json');

  if (!sub || sub === 'show') {
    if (json) { out(JSON.stringify({ path: file, config: ctx.cfg, problems: validateConfig(ctx.cfg) }, null, 1)); return 0; }
    out(`${C.b}${path.relative(ctx.root, file)}${C.x} ${C.dim}${ctx.root}${C.x}\n`);
    out(fs.readFileSync(file, 'utf8').trimEnd());
    for (const p of validateConfig(ctx.cfg)) {
      out(`  ${p.level === 'error' ? `${C.r}✗` : `${C.y}!`}${C.x} ${p.message}`);
    }
    return 0;
  }

  if (sub === 'path') { out(file); return 0; }

  if (sub === 'get') {
    if (!key) { err('usage: zeus config get <key>'); return 2; }
    const v = getPath(ctx.cfg, key);
    if (v === undefined) { err(`no such key "${key}"`); return 2; }
    out(typeof v === 'object' ? JSON.stringify(v, null, json ? 1 : 0) : String(v));
    return 0;
  }

  if (sub === 'set') {
    const value = rest.join(' ');
    if (!key || !rest.length) { err('usage: zeus config set <key> <value>'); return 2; }
    const next = JSON.parse(JSON.stringify(ctx.cfg)) as ProjectConfig;
    const r = setPath(next, key, value);
    if (!r.ok) { err(`${C.r}✗${C.x} ${r.why}`); return 2; }
    // A config the CLI would then refuse to load is not written at all.
    const fatal = validateConfig(next).filter((p) => p.level === 'error');
    if (fatal.length) {
      err(`${C.r}✗${C.x} that change would make the configuration invalid:`);
      for (const f of fatal) err(`    ${f.message}`);
      return 2;
    }
    writeConfig(ctx.root, next);
    out(`${C.g}✓${C.x} ${key} = ${String(getPath(next, key))}`);
    return 0;
  }

  err(`unknown config subcommand "${sub}" (expected: show, get, set, path)`);
  return 2;
}

function cmdSetup(argv: string[]): number {
  const scopeArg = argv.find((a) => !a.startsWith('--'));
  if (scopeArg && !['dependencies', 'providers', 'all'].includes(scopeArg)) {
    err(`unknown setup scope "${scopeArg}" (expected: dependencies, providers)`);
    return 2;
  }
  const json = argv.includes('--json');
  const dryRun = argv.includes('--dry-run');
  // --json implies non-interactive: a machine-readable report must never be
  // interrupted by a question, and must never be mistaken for consent.
  const forcedNonInteractive = argv.includes('--non-interactive') || json;
  const interactive = !forcedNonInteractive && !dryRun && interactivePossible();

  const lines: string[] = [];
  const emit = (l: string) => { lines.push(l); if (!json) out(l); };

  const probe = new RealProbe();
  const store = new FileStateStore(userDataDir());
  const root = findProjectRoot();

  const report: SetupReport = runSetup({
    probe,
    consent: interactive ? new TtyConsent() : new NonInteractiveConsent(),
    store,
    out: emit,
    dryRun,
    interactive,
    scope: (scopeArg as 'dependencies' | 'providers' | undefined) ?? 'all',
    advanced: argv.includes('--advanced'),
    onRoles: (roles) => {
      // Roles are configuration; provider credentials are not written here, or
      // anywhere else by Zeus. They are recorded per user so a second project
      // inherits them, and in the project when there is one.
      if (dryRun) return;
      const developer = roles.developer ?? 'claude';
      writeUserDefaults({ providers: {
        planner: developer,
        implementer: developer === 'claude' ? 'claude-code' : developer,
        reviewer: roles.reviewer ?? 'codex',
      } });
      if (!root) return;
      const cfg = readConfig(root);
      if (!cfg) return;
      writeConfig(root, applyRoles(cfg, roles));
    },
  });

  if (!interactive && !dryRun) {
    const note = 'Non-interactive: nothing was installed and no sign-in was attempted.';
    if (!json) out(`\n${C.dim}${note}${C.x}`);
  }

  if (json) {
    out(JSON.stringify({
      version: VERSION,
      ready: report.ready,
      dryRun: report.dryRun,
      interactive,
      system: report.system,
      packageManager: report.packageManager,
      privileges: report.privileges,
      roles: report.roles,
      dependencies: report.dependencies.map((d) => ({
        id: d.spec.id, label: d.spec.label, tier: d.spec.tier,
        state: d.state, version: d.version, path: d.path, detail: d.detail,
      })),
      providers: report.providers.map((p) => ({
        id: p.id, label: p.label, installed: p.installed, version: p.version,
        auth: p.auth, authMethod: p.authMethod,
      })),
      actions: report.actions,
      unmet: report.unmet,
      warnings: report.warnings,
      resumed: report.resumed,
    }, null, 1));
  }
  return report.ready ? 0 : 1;
}

function cmdDoctor(args: string[]): number {
  const json = args.includes('--json');
  const root = findProjectRoot();
  const cfg = root ? readConfig(root) : null;
  // Provider health is only meaningful against the role each one has been
  // given: an uninstalled reviewer matters, an unused one does not.
  const caps = probe(rolesFor(cfg));
  // Probed in a project context only: readiness is a question about a project,
  // and answering it outside one would be answering about nothing.
  const readiness = root && cfg ? projectReadiness({ root, cfg }) : null;
  if (json) {
    out(JSON.stringify({ version: VERSION, runtime: userDataDir(), project: root, capabilities: caps,
      configProblems: cfg ? validateConfig(cfg) : null, readiness }, null, 1));
    return summarize(caps).ok && (readiness?.ok ?? true) ? 0 : 1;
  }
  out(`${C.b}zeus doctor${C.x} ${C.dim}(${VERSION})${C.x}\n`);
  for (const c of caps) {
    out(`  ${mark(c.level)} ${c.label.padEnd(28)} ${c.detail}`);
    if (c.remedy && c.level !== 'ok') out(`      ${C.dim}→ ${c.remedy}${C.x}`);
  }
  if (root) {
    out(`\n${C.b}Project${C.x} ${root}`);
    if (!cfg) out(`  ${mark('warn')} not initialised — run zeus init`);
    else {
      const problems = validateConfig(cfg);
      out(`  ${mark(problems.some((p) => p.level === 'error') ? 'missing' : 'ok')} ${PROJECT_DIR}/config.yaml (adapter: ${cfg.project?.adapter})`);
      for (const p of problems) out(`      ${p.level === 'error' ? C.r + '✗' : C.y + '!'}${C.x} ${p.message}`);
    }
  } else {
    out(`\n${C.dim}Not inside a project; run from a repository for project checks.${C.x}`);
  }
  // Isolation is reported as what is actually enforced, never as a claim.
  const iso = isolationReport();
  const budgets = deriveBudgets();
  out(`\n${C.b}Paths${C.x}`);
  out(`  runtime  ${userDataDir()}`);
  out(`  config   ${userConfigDir()}${fs.existsSync(userDefaultsPath()) ? '' : `  ${C.dim}(no defaults yet)${C.x}`}`);

  out(`\n${C.b}Execution isolation${C.x}`);
  for (const b of iso.backends) out(`  ${mark(b.available ? 'ok' : 'warn')} ${b.id.padEnd(16)} ${b.detail}`);
  out(`  ${C.b}selected backend:${C.x} ${iso.selected}`);
  out(`  ${C.b}fallback mode:${C.x} ${iso.fallbackMode}`);
  // What is enforced here, not what the configuration asks for.
  const kernelBacked = iso.resourceEnforcement === 'cgroup';
  out(`  ${C.b}resource ceilings:${C.x} ${kernelBacked ? `${C.g}cgroup${C.x}` : `${C.y}rlimit only${C.x}`}`);
  out(`  ${C.dim}${iso.resourceDetail}${C.x}`);
  out(`  ${C.dim}enforces: ${iso.enforces.join(', ')}${C.x}`);
  if (!kernelBacked) {
    // The limitation, in the words that matter to someone deciding whether to
    // trust this machine with an autonomous task.
    out(`  ${C.y}!${C.x} many processes can still exhaust memory TOGETHER: the ceiling here`);
    out(`     bounds one address space, not the process tree.`);
    out(`     ${C.dim}→ a systemd user manager gives tree-wide cgroup ceilings:${C.x}`);
    out(`     ${C.dim}  loginctl enable-linger "$USER"   (then re-run zeus doctor)${C.x}`);
  }
  out(`\n${C.b}Derived budgets${C.x} ${C.dim}(from ${budgets.derivedFrom.cpus} cpus / ${budgets.derivedFrom.totalMemMb} MB)${C.x}`);
  out(`  reserved for control plane : ${budgets.reservedCpus} cpu, ${budgets.reservedMemMb} MB`);
  out(`  per execution              : ${budgets.cpuQuotaPercent}% cpu, ${budgets.memoryMaxMb} MB, ${budgets.maxProcesses} procs`);
  out(`  test workers               : ${budgets.maxTestWorkers} (playwright ${budgets.maxPlaywrightWorkers})`);
  out(`  concurrency                : heavy ${budgets.globalHeavyConcurrency}, light ${budgets.globalLightConcurrency}`);

  // Dependency preparation, reported as state rather than intent: a cache
  // that was never built and a cache that was deleted must not look alike, and
  // "would use" is a different fact from "has".
  if (root) {
    const dep = describeDependencyState(root,
      adapterFor(root, cfg)?.commands(root).install ?? null, depsCacheRoot(root, cfg?.paths?.deps));
    out(`\n${C.b}Dependency preparation${C.x}`);
    out(`  ecosystem        ${dep.ecosystem}${dep.packageManager ? ` (${dep.packageManager})` : ''}`);
    out(`  lockfile         ${dep.lockfile ?? `${C.dim}none${C.x}`}`);
    out(`  lockfile hash    ${dep.lockfileHash ? dep.lockfileHash.slice(0, 16) : `${C.dim}n/a${C.x}`}`);
    out(`  prepared cache   ${dep.cached ? `${C.g}present${C.x} (${(dep.cacheBytes / 1e6).toFixed(1)} MB)` : `${C.y}none${C.x}`}`);
    out(`  cache directory  ${dep.cacheDir ? path.relative(root, dep.cacheDir) : `${C.dim}n/a${C.x}`}`);
    out(`  caches for this project  ${dep.caches}`);
    out(`  next task would use      ${dep.wouldUse}  ${C.dim}${dep.detail}${C.x}`);
  }

  if (readiness) renderReadiness(readiness);

  const capsOk = summarize(caps).ok;
  const blocking = summarize(caps).blocking;
  // The verdict cannot be softer than the probes. A required project probe
  // that failed is the whole finding this section exists for, and letting the
  // overall line stay green while it fails would reproduce the defect.
  const ok = capsOk && (readiness?.ok ?? true);
  const providerGaps = caps.filter((c) => c.provider && c.level === 'missing');
  const notReady = [...blocking.map((b) => b.label),
    ...(readiness && !readiness.ok
      ? readiness.probes.filter((p) => p.required && p.status === 'FAIL').map((p) => p.label) : [])];
  out(`\n${ok ? `${C.g}Ready.${C.x}` : `${C.r}Not ready:${C.x} ${notReady.join(', ')}`}`);
  if (providerGaps.length) {
    out(`${C.y}!${C.x} ${providerGaps.map((c) => c.label).join(' and ')} ${providerGaps.length > 1 ? 'are' : 'is'} not ready — run ${C.b}zeus setup providers${C.x}`);
  }
  return ok && !providerGaps.length ? 0 : 1;
}

/** Builds an engine bound to the current project. */
function engineFor(root: string, cfg: ProjectConfig, opts: { mock?: boolean } = {}): Engine {
  const budgets = deriveBudgets({
    maxTestWorkers: cfg.resources?.maxTestWorkers,
    maxPlaywrightWorkers: cfg.resources?.maxPlaywrightWorkers,
    heavyTimeoutSeconds: cfg.resources?.heavyTestTimeoutSeconds,
    globalHeavyConcurrency: cfg.resources?.globalHeavyTestConcurrency,
  });
  // The supervisor records running process groups under the project's state
  // root so a `cancel` typed in another terminal can actually reach them.
  const stateRoot = path.resolve(root, cfg.paths?.state ?? '.zeus/state');
  const supervisor = new ProcessSupervisor(budgets, undefined, stateRoot);
  // --mock keeps the whole pipeline real (processes, policy, governor, events)
  // while replacing the models, so a lifecycle can be proven without spend.
  const providers: { planner: Provider; implementer: Provider; reviewer: Provider } = opts.mock
    ? { planner: mockProvider(), implementer: mockProvider(), reviewer: mockProvider() }
    : { planner: claudeProvider(), implementer: claudeProvider(), reviewer: codexProvider() };
  return new Engine({ projectRoot: root, config: cfg, supervisor, providers });
}

/** `zeus run` — the operator watches the lifecycle happen. */
async function cmdRun(argv: string[]): Promise<number> {
  const ctx = requireProject();
  if (!ctx) return 2;
  const description = argv.find((a) => !a.startsWith('--'));
  if (!description) { err('usage: zeus run "<task description>"'); return 2; }
  const engine = engineFor(ctx.root, ctx.cfg, { mock: argv.includes('--mock') });
  const owned = engine.acquire();
  if (!owned.ok) { err(`${C.r}✗${C.x} ${owned.reason}`); return 4; }
  try {
    const rec = engine.createTask(description);
    out(`${C.b}${rec.taskId}${C.x} ${description}`);
    out(`${C.dim}project ${ctx.cfg.project.name} · base ${rec.baseSha.slice(0, 12)} · worktree ${path.relative(ctx.root, rec.worktree)}${C.x}\n`);
    // Print transitions as they are recorded, so the CLI is not a black box.
    let seen = 0;
    const drain = () => {
      const evs = engine.events.read(rec.taskId);
      for (const e of evs.slice(seen)) {
        const p = e.payload as any;
        if (e.type === 'STATE_CHANGED' && !p.substateOnly) out(`  ${C.dim}→${C.x} ${p.to}`);
        if (e.type === 'CHECK_RESULT') {
          out(`  ${p.outcome === 'PASSED' ? `${C.g}✓` : `${C.y}!`}${C.x} ${p.name}: ${p.outcome}`);
        }
        if (e.type === 'FINDINGS' && p.count) out(`  ${C.y}!${C.x} review findings: ${p.count}`);
      }
      seen = evs.length;
    };
    const tick = setInterval(drain, 400);
    let final: string;
    try { final = await engine.run(rec.taskId); }
    finally { clearInterval(tick); drain(); }
    out(`\n${final === 'COMPLETED' ? C.g : C.y}${final}${C.x}  ${C.dim}(${rec.taskId})${C.x}`);
    return final === 'COMPLETED' ? 0 : 1;
  } finally {
    engine.release();
  }
}

function cmdStatus(argv: string[]): number {
  const ctx = requireProject();
  if (!ctx) return 2;
  const engine = engineFor(ctx.root, ctx.cfg);
  const raw = argv.find((a) => !a.startsWith('--'));
  // Humans type the short label. Resolve it against the project before asking
  // what KIND of id it is, or every scope question is answered about a string
  // that is missing the half that carries the answer.
  const wanted = raw && !raw.includes('/') ? `${engine.projectId}/${raw}` : raw;
  // A mission id arriving here is a scope error, and `Engine.task` refuses it
  // loudly — which is correct, and used to surface as a stack trace from the
  // primary status command on any project that had ever created a mission.
  // The discriminant was doing its job; this caller had not learned to ask it.
  if (wanted && scopeOf(wanted) === 'MISSION') {
    err(`${C.r}✗${C.x} ${wanted} is a mission, not a task`);
    err(`  ${C.dim}zeus mission status ${missionLabel(wanted)}${C.x}`);
    return 2;
  }
  if (wanted && scopeOf(wanted) === null) {
    err(`${C.r}✗${C.x} "${raw}" is not a task id`);
    return 2;
  }
  const known = engine.events.listTasks();
  const missionCount = known.filter((id) => scopeOf(id) === 'MISSION').length;
  const ids = wanted ? [wanted] : known.filter((id) => scopeOf(id) === 'TASK');
  if (!ids.length) {
    out(missionCount
      ? `no tasks yet in this project  ${C.dim}(${missionCount} mission(s) — zeus mission list)${C.x}`
      : 'no tasks yet in this project');
    return 0;
  }
  out(`${C.b}${ctx.cfg.project.name}${C.x} ${C.dim}${ctx.root}${C.x}`);
  const lease = engine.lock.current();
  if (lease) out(`${C.dim}owned by ${lease.instanceId} (heartbeat ${lease.heartbeatAt})${C.x}`);
  const telemetry: TaskTelemetry[] = [];
  for (const id of ids) {
    const t = engine.task(id);
    if (!t) { err(`unknown task ${id}`); continue; }
    const terminal = TERMINAL.includes(t.state);
    const tel = taskTelemetry(id, engine.events.read(id));
    telemetry.push(tel);
    const touch = tel.humanInterventionCount === 0 ? `${C.g}0 touch${C.x}` : `${C.y}${tel.humanInterventionCount} touch${C.x}`;
    out(`  ${terminal ? C.dim : C.b}${id}${C.x}  ${t.state.padEnd(22)} ${touch}  ${t.description.slice(0, 50)}`);
    // A task waiting on a person should say what it wants, right here.
    if (['AWAITING_HUMAN', 'BLOCKED', 'NEEDS_RECONCILIATION'].includes(t.state)) {
      const esc = [...engine.events.read(id)].reverse().find((e) => e.type === 'ESCALATION');
      if (esc) {
        const p = esc.payload as unknown as EscalationPayload;
        for (const line of renderEscalation(p).split('\n').slice(1)) out(`${C.dim}    ${line.trim()}${C.x}`);
      }
    }
  }

  if (missionCount) out(`  ${C.dim}${missionCount} mission(s) — zeus mission list${C.x}`);

  // The product metric. Everything above is detail; this is the number.
  const metric = zeroTouchCleanRate(telemetry);
  out('');
  out(`  ${metric.rate === null || metric.rate >= 0.8 ? C.g : C.y}${formatZeroTouch(metric)}${C.x}`);
  if (metric.completed && metric.rate !== null && metric.rate < 1) {
    if (metric.withIntervention) out(`${C.dim}    ${metric.withIntervention} needed a person; ${metric.withRegression} caused a regression attributed later${C.x}`);
    for (const r of metric.topInterventionReasons) out(`${C.dim}    ${String(r.count).padStart(3)} × ${r.reason}${C.x}`);
  }
  return 0;
}

/**
 * `zeus revalidate` — the integration primitive.
 *
 * A task verified against one commit and integrated onto another was never
 * verified against what it lands on. This rebases, recomputes impact on the
 * REBASED diff, and says what must rerun. It deliberately stops there: merging
 * is a separate, explicitly enabled operation.
 */
/**
 * `zeus self-audit` — Zeus auditing Zeus.
 *
 * The first rule is that the running process is never the thing under audit.
 * A candidate is checked out into a disposable worktree, the permanent harness
 * in audits/ runs against THAT, and the verdict is reported. Nothing is
 * installed, nothing is restarted, and the live runtime is not touched — a
 * defect in the candidate must not be able to disable the checks looking for it.
 */
async function cmdSelfAudit(argv: string[]): Promise<number> {
  const root = findProjectRoot() ?? process.cwd();
  const laneIdx = argv.indexOf('--lane');
  const wanted = laneIdx >= 0 ? (argv[laneIdx + 1] ?? '').toUpperCase() : null;
  const cycleIdx = argv.indexOf('--cycle-id');
  const json = argv.includes('--json');
  const keep = argv.includes('--keep');

  const state = runtimeState(root);
  const cycleId = cycleIdx >= 0 && argv[cycleIdx + 1] && !argv[cycleIdx + 1].startsWith('--')
    ? argv[cycleIdx + 1]
    : `c-${state.head.slice(0, 7)}`;

  if (!fs.existsSync(path.join(root, 'audits', 'harness', 'index.ts'))) {
    err(`${C.r}✗${C.x} no audits/harness in ${root}`);
    err('  zeus self-audit runs the permanent harness from a source checkout; an installed runtime does not carry it.');
    return 2;
  }

  if (!json) {
    out(`${C.b}Zeus self-audit${C.x}`);
    out('');
    out(`  repository   ${state.repoRoot}`);
    out(`  branch       ${state.branch}${state.dirty ? `  ${C.y}(uncommitted changes present)${C.x}` : ''}`);
    out(`  HEAD         ${state.head}`);
    out(`  version      ${state.version}`);
    out(`  live runtime ${state.runtimeRoot}  ${C.dim}(pid ${state.pid}, never modified by this command)${C.x}`);
    out('');
  }
  if (state.dirty && !json) {
    out(`  ${C.y}!${C.x} HEAD is audited, not the working tree. Uncommitted changes are NOT in the candidate.`);
    out('');
  }

  const checkout = createAuditCheckout(root, cycleId);
  if (!json) out(`  ${C.g}✓${C.x} disposable candidate at ${checkout.root}`);

  const startedAt = new Date().toISOString();
  try {
    // The harness is loaded FROM the candidate, so an audit exercises the
    // candidate's own probes rather than the runtime's copy of them.
    const harnessEntry = path.join(checkout.root, 'audits', 'harness', 'index.ts');
    if (!fs.existsSync(harnessEntry)) {
      err(`${C.r}✗${C.x} the candidate at ${state.head.slice(0, 12)} does not contain audits/harness`);
      err('  The audit runs the harness as it exists in the COMMIT under audit, not in your working tree.');
      err('  Commit the harness first, then re-run. This is deliberate: a harness that only exists');
      err('  uncommitted would audit a candidate nobody can reproduce.');
      return 2;
    }
    // eslint-disable-next-line
    const harness = require(harnessEntry);
    const lanes = (harness.LANES as any[]).filter((l) => !wanted || l.lane.toUpperCase() === wanted);
    if (!lanes.length) { err(`unknown lane "${wanted}" (available: ${(harness.LANES as any[]).map((l) => l.lane).join(', ')})`); return 2; }

    const results: Awaited<ReturnType<typeof runLane>>[] = [];
    for (const spec of lanes) {
      if (!json) out(`  ${C.dim}running lane ${spec.lane} — ${spec.title}${C.x}`);
      results.push(await runLane(spec, { auditRoot: checkout.root, cycleId }));
    }

    const cycle = consolidate(cycleId, checkout.head, results, startedAt);
    const dir = path.join(root, 'audits', 'cycles', cycleId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'findings.json'), `${JSON.stringify(cycle, null, 1)}\n`);
    fs.writeFileSync(path.join(dir, 'report.md'), `${renderMarkdown(cycle)}\n`);

    if (json) { out(JSON.stringify(cycle, null, 1)); }
    else {
      out('');
      out(renderTerminal(cycle, process.stdout.isTTY));
      out('');
      out(`  report  ${path.relative(root, path.join(dir, 'report.md'))}`);
      out(`  data    ${path.relative(root, path.join(dir, 'findings.json'))}`);
    }
    return cycle.verdict === 'CANDIDATE_SAFE_TO_INSTALL' ? 0 : 1;
  } finally {
    if (keep) { if (!json) out(`  ${C.dim}candidate kept at ${checkout.root}${C.x}`); }
    else checkout.dispose();
  }
}


/**
 * `zeus self-check` — the gate on Zeus's own commits.
 *
 * Used by `.githooks/pre-commit`. Exits non-zero and names the failing checks,
 * so a refusal says what is wrong rather than that something is.
 */
/**
 * `zeus clean --deps` — remove prepared dependency caches for THIS project.
 *
 * Nothing evicts on its own: a content-addressed cache is either the right one
 * or unreachable, so there is no age at which deleting it is automatically
 * correct. Removal is therefore something a person asks for, and this is where
 * they ask.
 */
/** The findings from the most recent critique on this mission. */
function latestFindings(missions: MissionRegistry, missionId: string): CriticFindingRef[] {
  const evs = [...missions.events.read(missionId)].reverse();
  const q = evs.find((e) => e.type === 'ORACLE_CRITIQUED');
  const raw = (q?.payload as any)?.findings;
  return Array.isArray(raw) ? raw.filter((f: any) => f && typeof f.code === 'string') : [];
}

/** Accepts an oracle with the standing findings recorded against it. */
function acceptDespite(missions: MissionRegistry, missionId: string, proposal: any,
  findings: CriticFindingRef[], json: boolean): number {
  missions.acceptOracle(missionId, {
    acceptanceMode: proposal.mode, acceptedBy: 'user-confirmed',
    modeInputs: proposal.computed.inputs,
    modeReasons: [...proposal.computed.reasons,
      `a human accepted this with ${findings.length} finding(s) standing`],
    escalatedByCritic: proposal.escalatedByCritic,
    escalatedByFindings: proposal.escalatedByFindings,
    acceptedDespite: findings.map((f) => ({ code: f.code, criterionId: f.criterionId })),
    findingsFloor: proposal.floor,
  });
  if (json) { out(JSON.stringify({ accepted: 'user-confirmed', acceptedDespite: findings.length }, null, 1)); return 0; }
  out(`  ${C.g}✓${C.x} accepted by you, ${C.y}despite ${findings.length} finding(s)${C.x} — on the record`);
  return 0;
}

/** How many times a mission may send a critique back to the compiler. */

/**
 * The fix loop: show the compiler what the critic said, compile again.
 *
 * The round-2 CRITIC is a fresh critique that never sees the round-1 verdict —
 * the compiler seeing findings is the fix, the critic seeing its past self is
 * contamination. `critiqueOracle` builds a payload under the same policy every
 * time, so this is a property of the machinery rather than of this function
 * remembering.
 */
async function recompileOracle(ctx: { root: string; cfg: ProjectConfig }, missions: MissionRegistry,
  eng: Engine, missionId: string, json: boolean): Promise<number> {
  // The OPERATION, not a second copy of it. This function used to carry its
  // own compile-critique-record sequence, which is how the console ended up
  // with no recompile at all: the capability was locked inside the CLI.
  const before = missions.mission(missionId);
  const res = await recompileMissionOracle({
    missions, engine: eng, projectRoot: ctx.root,
    context: projectContextFor(ctx.root, ctx.cfg),
    policy: defaultPolicy(ctx.root, ctx.root),
  }, missionId);

  if (!res.ok) {
    if (res.kind === 'RECOMPILE_LIMIT') {
      const [first, ...rest] = res.detail.split('. ');
      err(`${C.r}✗${C.x} ${first}`);
      if (rest.length) err(`  ${C.dim}${rest.join('. ')}${C.x}`);
      return 1;
    }
    if (res.kind === 'INFRASTRUCTURE') {
      err(`${C.r}✗${C.x} compiler unavailable: ${res.detail}`);
      return 3;
    }
    if (res.kind === 'REJECTED') {
      out(`${C.r}✗${C.x} the recompiled criteria are not a contract:`);
      for (const f of res.findings) out(`  ${C.r}${f.code}${C.x} ${C.dim}${f.detail}${C.x}`);
      return 1;
    }
    err(`${C.r}✗${C.x} ${res.detail}`);
    return 1;
  }

  const { oracle, proposal } = res;
  const nextFindings = res.critique.findings;
  const forwarded = res.recompiledFrom?.findingsForwarded ?? 0;
  if (json) {
    out(JSON.stringify({ oracle, findingsForwarded: forwarded,
      critique: { findings: nextFindings }, mode: proposal }, null, 1));
    return 0;
  }
  out(`${C.b}${missionId}${C.x} oracle v${oracle.version} ${C.dim}(recompiled with ${forwarded} finding(s) forwarded)${C.x}`);
  for (const c of oracle.criteria) {
    const ev = c.evaluator as any;
    out(`  ${missionLabel(c.criterionId).padEnd(8)} ${c.type.padEnd(14)} ${c.statement.slice(0, 60)}`);
    out(`           ${C.dim}${ev.kind === 'rubric' ? `rubric: ${String(ev.rubric).slice(0, 55)}` : ev.command}${ev.repeat ? ` ×${ev.repeat}` : ''}${C.x}`);
  }
  // The FRESH critique's round number. `before` was read before the recompile
  // was recorded, so its count is the one BEFORE this attempt: the critique
  // that follows attempt N is round N+1.
  const priorRounds = before?.recompiles ?? 0;
  out(`  ${C.b}round ${priorRounds + 2}${C.x} critique (a fresh one — it has not seen round ${priorRounds + 1}):`);
  renderFindings(nextFindings);
  out(`  ${C.b}acceptance mode${C.x} ${proposal.mode}`);
  out(nextFindings.length
    ? `  ${C.y}!${C.x} still not accepted — ${C.b}zeus mission confirm ${missionLabel(missionId)}${C.x} or recompile again`
    : `  ${C.g}✓${C.x} the critique is now clean — ${C.b}zeus mission confirm ${missionLabel(missionId)}${C.x} to accept`);
  return 0;
}

/**
 * Renders a critique's findings so a human decides from evidence, not a count.
 *
 * A real run printed "accepted (consent-flag)" over seven findings, one of
 * which said an evaluator did not measure what it claimed. Nobody saw them.
 * Every path that can accept an oracle now prints this first.
 */
function renderFindings(findings: CriticFindingRef[]): void {
  if (!findings.length) { out(`  ${C.dim}the independent critique raised nothing${C.x}`); return; }
  out(`  ${C.b}${findings.length} finding(s) from the independent critique${C.x}`);
  for (const f of findings) {
    const family = findingFamily(f.code);
    const colour = family === 'evaluator-integrity' ? C.r : C.y;
    const where = f.criterionId ? missionLabel(f.criterionId) : '—';
    out(`    ${colour}${f.code}${C.x} ${C.dim}${where}${C.x}`);
    const first = String(f.detail ?? '').split(/(?<=\.)\s|\n/)[0] ?? '';
    if (first) out(`       ${first.slice(0, 100)}`);
  }
}

/**
 * The evidence a compiler is allowed to derive criteria from.
 *
 * Declared commands are the resolvable universe for an EXECUTABLE evaluator;
 * failing checks and recorded findings are the observed facts. A criterion
 * derived from nothing here is a target nobody has seen, which is what keeps
 * a mission out of AUTO.
 */
function projectContextFor(root: string, cfg: ProjectConfig): ProjectContext {
  const commands: Record<string, string> = {};
  for (const [k, v] of Object.entries((cfg.commands ?? {}) as unknown as Record<string, unknown>)) {
    if (typeof v === 'string' && v.trim()) commands[k] = v;
  }
  return { commands, failingChecks: [], findings: [] };
}

/** `C-0002` → `proj/M-0001/C-0002`, so an operator can type the short form. */
function resolveCriterion(missionId: string): (raw: string) => string {
  return (rawId: string) => (rawId.includes('/') ? rawId : `${missionId}/${rawId}`);
}

/** The adapter this project is configured to use, or the detected one. */
function adapterFor(root: string, cfg: ProjectConfig | null) {
  const { adapterById, detectProject } = require('./adapters');
  return (cfg?.project?.adapter ? adapterById(cfg.project.adapter) : null)
    ?? detectProject(root).primary;
}

function cmdClean(argv: string[]): number {
  const root = findProjectRoot();
  if (!root) { err(`${C.r}not inside a project${C.x}`); return 2; }
  if (!argv.includes('--deps')) {
    err('usage: zeus clean --deps');
    err('  --deps  remove prepared dependency caches for this project');
    return 2;
  }
  const cfg = readConfig(root);
  const cacheRoot = depsCacheRoot(root, cfg?.paths?.deps);
  const before = describeDependencyState(root, adapterFor(root, cfg)?.commands(root).install ?? null, cacheRoot);
  const r = cleanDependencyCache(cacheRoot);
  if (argv.includes('--json')) {
    out(JSON.stringify({ cacheRoot, removed: r.removed, bytes: r.bytes, cachesBefore: before.caches }, null, 1));
    return 0;
  }
  if (!r.removed.length) { out(`${C.dim}nothing to clean in ${path.relative(root, cacheRoot)}${C.x}`); return 0; }
  out(`${C.g}✓${C.x} removed ${r.removed.length} dependency artifact(s), ${(r.bytes / 1e6).toFixed(1)} MB`);
  for (const n of r.removed) out(`  ${C.dim}${n}${C.x}`);
  out(`${C.dim}the next task in this project prepares dependencies again${C.x}`);
  return 0;
}

/**
 * `zeus mission` — stage 1 of Mission Mode.
 *
 * Deterministic throughout. `create` records a goal and nothing else: it does
 * not plan, and it does not call a model. A mission at this stage is an
 * identity with a log, which is exactly as much as the foundation needs to be
 * worth building on.
 */
async function cmdMission(argv: string[]): Promise<number> {
  const ctx = requireProject();
  if (!ctx) return 2;
  const [sub, ...rest] = argv;
  const json = rest.includes('--json') || argv.includes('--json');
  const engine = engineFor(ctx.root, ctx.cfg);
  const missions = new MissionRegistry({
    events: engine.events, projectId: engine.projectId, stateRoot: engine.stateRoot,
  });

  const resolve = (raw: string): string => (raw.includes('/') ? raw : `${engine.projectId}/${raw}`);
  const guard = <T>(fn: () => T): T | null => {
    try { return fn(); } catch (e: any) {
      if (e instanceof ScopeMismatchError) { err(`${C.r}✗${C.x} ${e.message}`); return null; }
      throw e;
    }
  };

  switch (sub) {
    case 'create': {
      const goal = rest.find((a) => !a.startsWith('--'));
      if (!goal) { err('usage: zeus mission create "<goal>"'); return 2; }
      const head = (() => {
        try { return readOnlyGit(ctx.root, { timeoutMs: 15_000 })(['rev-parse', 'HEAD']); }
        catch { return 'unknown'; }
      })();
      const rec = missions.create(goal, head);
      if (json) { out(JSON.stringify(rec, null, 1)); return 0; }
      out(`${C.g}✓${C.x} ${C.b}${rec.missionId}${C.x}`);
      out(`  goal      ${rec.goal}`);
      out(`  base      ${rec.baseSha.slice(0, 12)}`);
      out(`  ${C.dim}no plan yet — mission create records a goal; planning arrives with the execution loop${C.x}`);
      return 0;
    }

    case 'list': {
      const ids = missions.list();
      const recs = missionListView(missions);
      if (json) { out(JSON.stringify(recs, null, 1)); return 0; }
      if (!recs.length) { out(`${C.dim}no missions in this project${C.x}`); return 0; }
      for (const r of recs) {
        const state = r.terminated ? `${r.terminationReason} / ${r.achievement}` : 'ACTIVE';
        out(`  ${C.b}${missionLabel(r.missionId).padEnd(8)}${C.x} ${state.padEnd(28)} ${r.goal.slice(0, 60)}`);
      }
      return 0;
    }

    case 'status': {
      const raw = rest.find((a) => !a.startsWith('--'));
      if (!raw) { err('usage: zeus mission status <id> [--json]'); return 2; }
      const id = resolve(raw);
      const rec = guard(() => missions.mission(id));
      if (rec === null) return 2;
      if (!rec) { err(`unknown mission ${id}`); return 2; }
      const ratchet = readRatchet(ctx.root, id);
      if (json) { out(JSON.stringify(missionStatusView(missions, ctx.root, id), null, 1)); return 0; }
      out(`${C.b}${rec.missionId}${C.x} ${rec.terminated ? `${C.dim}(terminated)${C.x}` : ''}`);
      out(`  goal            ${rec.goal}`);
      out(`  created         ${rec.createdAt}  ${C.dim}base ${rec.baseSha.slice(0, 12)}${C.x}`);
      out(`  events          ${rec.events}`);
      out(`  plan            ${rec.planVersion === null ? `${C.dim}none${C.x}` : `v${rec.planVersion} (${rec.plan?.nodes.length ?? 0} node(s))`}`);
      if (rec.planInvalidations.length) out(`  invalidations   ${rec.planInvalidations.length}`);
      out(`  spawned tasks   ${rec.spawned.length}`);
      for (const t of rec.spawned) {
        out(`    ${missionLabel(t.taskId).padEnd(8)} ${(t.outcome ?? 'RUNNING').padEnd(22)} ${C.dim}node ${t.nodeId || '-'}${C.x}`);
      }
      out(`  checkpoints     ${rec.checkpoints.length}`);
      out(`  ratchet         ${rec.ratchetSha ? rec.ratchetSha.slice(0, 12) : `${C.dim}not advanced${C.x}`}`
        + `  ${C.dim}${ratchetRef(id)}${C.x}`);
      if (rec.ratchetSha && ratchet !== rec.ratchetSha) {
        // The log is the truth; the ref is a pointer that can be lost.
        out(`  ${C.y}!${C.x} the ref does not match the log (${ratchet ?? 'absent'}); `
          + 'it can be rebuilt from the events');
      }
      const o = rec.oracle as Oracle | null;
      out(`  oracle          ${o ? `v${o.version} (${o.criteria.length} criteria)` : `${C.dim}not compiled${C.x}`}`);
      if (o) {
        out(`  acceptance      ${rec.acceptanceMode ?? '—'}`
          + `  ${rec.oracleAccepted ? `${C.g}accepted${C.x} (${rec.acceptedBy})` : `${C.y}not accepted${C.x}`}`);
        const required = o.criteria.filter((c) => c.required).length;
        const proven = o.criteria.filter((c) => c.required
          && rec.criterionOutcomes[c.criterionId] === 'PROVEN').length;
        out(`  criteria proven ${proven}/${required} required${rec.evaluations ? '' : `  ${C.dim}(never evaluated)${C.x}`}`);
        for (const c of o.criteria) {
          const outcome = rec.criterionOutcomes[c.criterionId] ?? 'UNEVALUATED';
          const colour = outcome === 'PROVEN' ? C.g : outcome === 'FAILED' ? C.r : C.y;
          out(`    ${missionLabel(c.criterionId).padEnd(8)} ${colour}${outcome.padEnd(12)}${C.x} ${C.dim}${c.statement.slice(0, 54)}${C.x}`);
        }
        if (rec.evaluatorRevisions) out(`  evaluator revisions ${rec.evaluatorRevisions}`);
        out(`  derived         ${rec.derivedAchievement}  ${C.dim}from the criteria${C.x}`);
      }
      out(`  achievement     ${rec.achievement}`);
      out(`  termination     ${rec.terminationReason ?? `${C.dim}—${C.x}`}`);
      if (rec.escalations) out(`  escalations     ${rec.escalations}`);
      return 0;
    }

    case 'compile': {
      const raw = rest.find((a) => !a.startsWith('--'));
      if (!raw) { err('usage: zeus mission compile <id> [--mock]'); return 2; }
      const id = resolve(raw);
      const mock = rest.includes('--mock');
      const eng = mock ? engineFor(ctx.root, ctx.cfg, { mock: true }) : engine;

      // THE SAME OPERATION THE WEB CALLS. The CLI renders it; it does not
      // decide it. Two callers with two copies of this sequence would be two
      // engines with two opinions about when a contract is accepted.
      const result = await compileMissionOracle({
        missions, engine: eng, projectRoot: ctx.root,
        context: projectContextFor(ctx.root, ctx.cfg),
        policy: defaultPolicy(ctx.root, ctx.root),
      }, id, { wantsReview: rest.includes('--review-oracle') });

      if (!result.ok && result.kind !== 'REJECTED') {
        if (result.kind === 'INFRASTRUCTURE') {
          err(`${C.r}✗${C.x} compiler unavailable: ${result.detail}`);
          err(`  ${C.dim}the mission is unchanged; retry when the provider is back${C.x}`);
          return 3;
        }
        err(result.kind === 'TERMINATED' ? `${id} is terminated` : `unknown mission ${id}`);
        return result.kind === 'TERMINATED' ? 1 : 2;
      }
      if (!result.ok) {
        out(`${C.r}✗${C.x} the compiled criteria are not a contract:`);
        for (const f of result.findings) {
          out(`  ${C.r}${f.code}${C.x} ${(f as any).criterionId ?? ''} ${C.dim}${f.detail}${C.x}`);
        }
        out(`  ${C.dim}recorded as ORACLE_COMPILE_REJECTED; the mission is unchanged and can be recompiled${C.x}`);
        return 1;
      }

      const { oracle, proposal, critique, acceptedBy } = result;
      if (json) {
        out(JSON.stringify({ oracle, validation: result.validation,
          critique: { valid: critique.valid, findings: critique.findings,
            modeOpinion: critique.modeOpinion },
          mode: proposal, accepted: acceptedBy }, null, 1));
        return acceptedBy ? 0 : 4;
      }

      out(`${C.b}${id}${C.x} oracle v${oracle.version} ${C.dim}(${oracle.criteria.length} criteria)${C.x}`);
      for (const c of oracle.criteria) {
        const ev = c.evaluator as any;
        out(`  ${missionLabel(c.criterionId).padEnd(8)} ${c.type.padEnd(14)} ${c.required ? 'required' : 'informs '} ${c.statement.slice(0, 58)}`);
        out(`           ${C.dim}${ev.kind === 'rubric' ? `rubric: ${String(ev.rubric).slice(0, 60)}` : ev.command}`
          + `${ev.repeat ? ` ×${ev.repeat}` : ''}${C.x}`);
      }
      if (!critique.valid) {
        out(`  ${C.r}critique INVALID${C.x} — the payload was refused, so there is no second opinion`);
      }
      // Findings BEFORE the verdict, always.
      renderFindings(critique.findings);
      out(`  ${C.b}acceptance mode${C.x} ${proposal.mode}`
        + `${proposal.escalatedByCritic ? ` ${C.y}(critic escalated)${C.x}` : ''}`
        + `${proposal.escalatedByFindings ? ` ${C.y}(findings escalated)${C.x}` : ''}`);
      for (const r of [...proposal.computed.reasons, ...proposal.floor.reasons]) out(`    ${C.dim}${r}${C.x}`);

      if (acceptedBy) {
        out(`  ${C.g}✓${C.x} accepted (${acceptedBy}: no findings, mode ${proposal.mode})`
          + ` — run ${C.b}zeus mission evaluate ${missionLabel(id)}${C.x}`);
        return 0;
      }

      // THE STOP. Nothing is accepted here, in any context.
      out('');
      out(`  ${C.y}!${C.x} ${C.b}this oracle is not accepted${C.x}`);
      out(`    ${proposal.floor.findingCount} finding(s) stand against it`
        + `${proposal.floor.families['evaluator-integrity'] ? `, ${proposal.floor.families['evaluator-integrity']} contesting an evaluator's validity` : ''}.`);
      const label = missionLabel(id);
      if (interactivePossible() && !rest.includes('--no-prompt')) {
        const choice = new TtyConsent().pick('What should happen to this oracle?', [
          { id: 'abort', label: 'leave it unaccepted — decide later (default)' },
          { id: 'recompile', label: 'send the findings back to the compiler and try again' },
          { id: 'accept', label: 'accept it anyway, with the findings on the record' },
        ], 'abort');
        if (choice === 'accept') return acceptDespite(missions, id, proposal, critique.findings, json);
        if (choice === 'recompile') {
          return recompileOracle(ctx, missions, engineFor(ctx.root, ctx.cfg, { mock }), id, json);
        }
        out(`  ${C.dim}left unaccepted; the mission is unchanged${C.x}`);
        return 4;
      }
      // No terminal on the other end: refuse, and say what a person can do.
      out(`    ${C.dim}nobody can be asked here, so nothing was accepted.${C.x}`);
      out(`    ${C.b}zeus mission confirm ${label}${C.x}    accept it, with the findings on the record`);
      out(`    ${C.b}zeus mission recompile ${label}${C.x}  send the findings back to the compiler`);
      out(`    ${C.dim}or do nothing — the mission stays pre-oracle${C.x}`);
      return 4;
    }

    case 'confirm': {
      const raw = rest.find((a) => !a.startsWith('--'));
      if (!raw) { err('usage: zeus mission confirm <id>'); return 2; }
      const id = resolve(raw);
      const rec = guard(() => missions.mission(id));
      if (rec === null) return 2;
      if (!rec) { err(`unknown mission ${id}`); return 2; }
      if (!rec.oracle) { err(`${id} has no compiled oracle to confirm`); return 1; }
      if (rec.oracleAccepted) { err(`${C.y}!${C.x} ${id} is already accepted`); return 1; }
      const o = rec.oracle as Oracle;
      const standing = latestFindings(missions, id);
      if (!json) {
        out(`${C.b}${id}${C.x} oracle v${o.version} — ${o.acceptanceMode}`);
        renderFindings(standing);
        out('');
      }
      missions.acceptOracle(id, {
        acceptanceMode: o.acceptanceMode, acceptedBy: 'user-confirmed',
        modeInputs: { confirmedFromCli: true },
        modeReasons: [`a human confirmed this oracle with ${standing.length} finding(s) standing`],
        escalatedByCritic: false,
        acceptedDespite: standing.map((f) => ({ code: f.code, criterionId: f.criterionId })),
      });
      if (json) {
        out(JSON.stringify({ missionId: id, acceptedBy: 'user-confirmed', mode: o.acceptanceMode,
          acceptedDespite: standing.length }, null, 1));
        return 0;
      }
      out(`${C.g}✓${C.x} ${id} accepted by you`
        + (standing.length ? ` ${C.y}despite ${standing.length} finding(s)${C.x}` : ' (no findings stood against it)'));
      return 0;
    }

    case 'evaluate': {
      const raw = rest.find((a) => !a.startsWith('--'));
      if (!raw) { err('usage: zeus mission evaluate <id> [--full | --criteria a,b]'); return 2; }
      const id = resolve(raw);
      const rec = guard(() => missions.mission(id));
      if (rec === null) return 2;
      if (!rec) { err(`unknown mission ${id}`); return 2; }
      if (!rec.oracle || !rec.oracleAccepted) {
        err(`${C.r}✗${C.x} ${id} has no ACCEPTED oracle; nothing authorises an evaluation`);
        return 1;
      }
      const mock = rest.includes('--mock');
      const eng = mock ? engineFor(ctx.root, ctx.cfg, { mock: true }) : engine;
      const idx = rest.indexOf('--criteria');
      const subset = idx >= 0 ? (rest[idx + 1] ?? '').split(',').filter(Boolean).map(resolveCriterion(id)) : [];
      const run = await evaluateCriteria({
        oracle: rec.oracle as Oracle, projectId: eng.projectId,
        // The ledger comes from what the LOG says was accepted, not from the
        // object being evaluated.
        ledger: acceptedCommands(rec.oracle as Oracle),
        // M2 evaluates against the project itself: a mission has no worktree
        // until the execution loop creates one, which is stage 3.
        worktree: ctx.root, supervisor: eng.opts.supervisor,
        policy: defaultPolicy(ctx.root, ctx.root),
        judge: eng.opts.providers.reviewer,
        scope: subset.length ? 'incremental' : 'full',
        criterionIds: subset, baseSha: rec.baseSha,
      });
      missions.recordEvaluation(id, {
        oracleVersion: run.oracleVersion, scope: run.scope,
        results: run.results.map((r) => ({ criterionId: r.criterionId, outcome: r.outcome,
          evidence: r.evidence, detail: r.detail })),
        provenRequired: run.provenRequired, totalRequired: run.totalRequired,
      });
      if (json) { out(JSON.stringify(run, null, 1)); return 0; }
      out(`${C.b}${id}${C.x} evaluation (${run.scope}) ${C.dim}oracle v${run.oracleVersion}${C.x}`);
      for (const r of run.results) {
        const colour = r.outcome === 'PROVEN' ? C.g : r.outcome === 'FAILED' ? C.r : C.y;
        out(`  ${missionLabel(r.criterionId).padEnd(8)} ${colour}${r.outcome.padEnd(12)}${C.x} ${C.dim}${r.detail.slice(0, 70)}${C.x}`);
        if (r.refusal) out(`           ${C.y}${r.refusal}${C.x}`);
      }
      out(`  ${C.b}required proven${C.x} ${run.provenRequired}/${run.totalRequired}`);
      return run.results.some((r) => r.outcome === 'FAILED') ? 1 : 0;
    }

    case 'recompile': {
      const raw = rest.find((a) => !a.startsWith('--'));
      if (!raw) { err('usage: zeus mission recompile <id> [--mock]'); return 2; }
      const id = resolve(raw);
      const rec = guard(() => missions.mission(id));
      if (rec === null) return 2;
      if (!rec) { err(`unknown mission ${id}`); return 2; }
      return recompileOracle(ctx, missions, engineFor(ctx.root, ctx.cfg,
        { mock: rest.includes('--mock') }), id, json);
    }

    case 'reconstruct-ratchet': {
      const raw = rest.find((a) => !a.startsWith('--'));
      if (!raw) { err('usage: zeus mission reconstruct-ratchet <id>'); return 2; }
      const id = resolve(raw);
      const rec = guard(() => missions.mission(id));
      if (rec === null) return 2;
      if (!rec) { err(`unknown mission ${id}`); return 2; }
      const r = reconstructRatchet(ctx.root, rec);
      if (json) { out(JSON.stringify(r, null, 1)); return 0; }
      out(`${C.g}✓${C.x} ${r.ref} ${r.action}${r.after ? ` → ${r.after.slice(0, 12)}` : ''}`);
      return 0;
    }

    case 'cancel': {
      const raw = rest.find((a) => !a.startsWith('--'));
      if (!raw) { err('usage: zeus mission cancel <id> [--reason "..."]'); return 2; }
      const id = resolve(raw);
      const reasonIdx = rest.indexOf('--reason');
      const reason = reasonIdx >= 0 ? (rest[reasonIdx + 1] ?? 'cancelled') : 'cancelled by operator';
      const r = guard(() => missions.cancel(id, reason));
      if (r === null) return 2;
      if (json) { out(JSON.stringify(r, null, 1)); return r.cancelled ? 0 : 1; }
      if (!r.cancelled) { err(`${C.y}!${C.x} ${id} is unknown or already terminated`); return 1; }
      out(`${C.g}✓${C.x} ${id} CANCELLED — ${r.tasks.length} task(s) affected, ${r.killed} process tree(s) killed`);
      return 0;
    }

    case 'plan': {
      const raw = rest.find((a) => !a.startsWith('--'));
      if (!raw) { err('usage: zeus mission plan <id> [--mock] [--yes]'); return 2; }
      const id = resolve(raw);
      const rec = guard(() => missions.mission(id));
      if (rec === null) return 2;
      if (!rec) { err(`unknown mission ${id}`); return 2; }
      if (rec.terminated) { err(`${id} is terminated`); return 1; }

      // The contract has to be ACCEPTED, and the gate reads the log.
      const gate = requireAcceptedOracle(missions, id);
      if (!gate.ok) { err(`${C.r}✗${C.x} ${gate.message}`); return 1; }

      const mock = rest.includes('--mock');
      const eng = mock ? engineFor(ctx.root, ctx.cfg, { mock: true }) : engine;
      const context = projectContextFor(ctx.root, ctx.cfg);
      const policy = defaultPolicy(ctx.root, ctx.root);
      const version = (rec.planVersion ?? 0) + 1;

      const planned = await planMission({
        missionId: id, projectId: eng.projectId, goal: rec.goal, criteria: gate.criteria,
        context, provider: eng.opts.providers.planner, supervisor: eng.opts.supervisor,
        policy, baseSha: rec.ratchetSha ?? rec.baseSha,
      });
      if (planned.infrastructureFailure) {
        err(`${C.r}✗${C.x} planner unavailable: ${planned.infrastructureFailure}`);
        return 1;
      }
      const graph: PlanGraph = { version, nodes: planned.graph.nodes };
      if (!planned.validation.valid) {
        missions.recordPlanRejected(id, {
          version, nodes: graph.nodes, findings: planned.validation.findings, retryable: true,
          note: 'the deterministic validator refused the plan; the mission is unchanged',
        });
        err(`${C.r}✗${C.x} the plan did not validate — nothing was accepted`);
        for (const f of planned.validation.findings) {
          err(`  ${C.y}${f.code}${C.x} ${f.nodeId ?? ''} ${f.detail}`);
        }
        return 1;
      }
      missions.recordPlan(id, graph, planned.validation.findings
        .filter((f) => f.code === 'CRITERION_SCOPE_MISMATCH'), planned.providerUsage);

      const critique = await critiquePlan({
        missionId: id, projectId: eng.projectId, goal: rec.goal, criteria: gate.criteria,
        graph, validation: planned.validation, context,
        provider: eng.opts.providers.reviewer, supervisor: eng.opts.supervisor,
        policy, baseSha: rec.ratchetSha ?? rec.baseSha,
      });
      const acceptance = planAcceptance(critique);
      missions.recordPlanCritique(id, {
        version, findings: critique.findings, acceptance: acceptance.decision,
        contaminated: !critique.valid,
        contaminationDetail: critique.valid ? null : 'the critique payload was contaminated',
        providerUsage: critique.providerUsage,
      });

      if (json) {
        out(JSON.stringify({ version, graph, findings: critique.findings, acceptance }, null, 1));
        if (acceptance.decision === 'FLOW') missions.acceptPlan(id, graph, { acceptedBy: 'auto' });
        return acceptance.decision === 'REJECT' ? 1 : 0;
      }

      out(`${C.b}${id}${C.x} plan v${version} ${C.dim}(${graph.nodes.length} node(s))${C.x}`);
      for (const n of graph.nodes) {
        out(`  ${missionLabel(n.nodeId).padEnd(8)} ${(n.slug ?? '').padEnd(20).slice(0, 20)} `
          + `${C.dim}${n.description.slice(0, 50)}${C.x}`);
        if (n.dependsOn.length) out(`           ${C.dim}after ${n.dependsOn.map(missionLabel).join(', ')}${C.x}`);
      }
      renderPlanFindings(critique.findings);
      renderScopeGaps(planned.validation.findings);
      const negotiation = negotiationFor(missions, id, graph);
      renderNegotiation(negotiation);

      if (acceptance.decision === 'REJECT') {
        err(`${C.r}✗${C.x} ${acceptance.reasons.join('; ')}`);
        err(`  ${C.dim}plan v${version} is recorded but NOT accepted; nothing may be spawned against it${C.x}`);
        return 1;
      }
      if (acceptance.decision === 'STOP') {
        // A findings-bearing plan needs a person. A --yes supplied before the
        // findings existed cannot answer them, so it is refused here rather
        // than honoured as consent.
        // NOT `--yes` on this command. Re-running would call the planner
        // again and accept a DIFFERENT plan from the one just reviewed, which
        // is consent to something nobody read. `accept-plan` accepts the plan
        // that is on the log, by version.
        missions.recordPlanStopDecision(id, {
          version,
          rendered: [...acceptance.reasons, negotiation.rendered,
            ...planned.validation.findings.filter((f) => f.code === 'CRITERION_SCOPE_MISMATCH')
              .map((f) => f.detail)],
          decision: 'STOPPED_FINDINGS', decidedBy: 'nobody yet',
          deferred: !process.stdin.isTTY,
        });
        err(`${C.y}!${C.x} ${acceptance.reasons.join('; ')}`);
        err(`  ${C.dim}zeus mission accept-plan ${missionLabel(id)} --version ${version} --yes${C.x}`
          + `  ${C.dim}accepts THIS plan with those findings recorded${C.x}`);
        return 1;
        missions.acceptPlan(id, graph, {
          acceptedBy: 'user-confirmed',
          acceptedDespite: acceptance.advisory.map((f) => `${f.code}: ${f.detail}`),
        });
        out(`${C.g}✓${C.x} plan v${version} accepted with ${acceptance.advisory.length} finding(s) on the record`);
        return 0;
      }
      if (!negotiation.fits) {
        // A plan that cannot be paid for is a conversation, not a failure, and
        // it is one nobody can have automatically: the budget may be the wrong
        // size or the plan may be, and only a person can say which.
        missions.recordPlanStopDecision(id, {
          version, rendered: [negotiation.rendered], decision: 'STOPPED_BUDGET',
          decidedBy: 'nobody yet', deferred: !process.stdin.isTTY,
        });
        err(`${C.y}!${C.x} this plan does not fit the mission budget`);
        err(`  ${C.dim}zeus mission accept-plan ${missionLabel(id)} --version ${version} `
          + `--raise-budget --yes${C.x}  ${C.dim}raises it, on the record${C.x}`);
        return 1;
      }
      missions.acceptPlan(id, graph, { acceptedBy: 'auto' });
      missions.recordPlanStopDecision(id, {
        version, rendered: [negotiation.rendered], decision: 'FLOW',
        decidedBy: 'auto', deferred: false,
      });
      out(`${C.g}✓${C.x} plan v${version} accepted ${C.dim}(the critique raised nothing)${C.x}`);
      return 0;
    }

    case 'accept-plan': {
      const raw = rest.find((a) => !a.startsWith('--'));
      if (!raw) { err('usage: zeus mission accept-plan <id> [--version N]'); return 2; }
      const id = resolve(raw);
      const rec = guard(() => missions.mission(id));
      if (rec === null) return 2;
      if (!rec) { err(`unknown mission ${id}`); return 2; }
      if (rec.terminated) { err(`${id} is terminated`); return 1; }

      const vIdx = rest.indexOf('--version');
      const wantVersion = vIdx >= 0 ? Number(rest[vIdx + 1]) : null;
      const log = missions.events.read(id);
      const recorded = [...log].reverse().find((e) => e.type === 'PLAN_RECORDED'
        && (wantVersion === null || (e.payload as any).version === wantVersion));
      if (!recorded) {
        err(`${C.r}✗${C.x} ${id} has no recorded plan${wantVersion === null ? '' : ` at v${wantVersion}`}`);
        err(`  ${C.dim}zeus mission plan ${missionLabel(id)} first${C.x}`);
        return 1;
      }
      const version = (recorded.payload as any).version as number;
      const graph = (recorded.payload as any).plan as PlanGraph;

      // A plan with no independent critique on the log has no second opinion,
      // and consent to it would be consent to nothing having been checked.
      const critique = [...log].reverse().find((e) => e.type === 'PLAN_CRITIQUED'
        && (e.payload as any).version === version);
      if (!critique) {
        err(`${C.r}✗${C.x} plan v${version} has no critique on the log; there is no second opinion to consent over`);
        return 1;
      }
      const cp = critique.payload as any;
      if (cp.contaminated) {
        err(`${C.r}✗${C.x} the critique of plan v${version} was contaminated, so it is not a second opinion`);
        return 1;
      }
      if (cp.acceptance === 'REJECT') {
        err(`${C.r}✗${C.x} the critique REJECTED plan v${version}; it cannot be accepted by consent`);
        return 1;
      }
      const findings = (cp.findings ?? []) as Array<{ code: string; severity: string; nodeId?: string; detail: string }>;

      out(`${C.b}${id}${C.x} plan v${version} ${C.dim}(${graph.nodes.length} node(s), critiqued ${critique.ts})${C.x}`);
      for (const n of graph.nodes) {
        out(`  ${missionLabel(n.nodeId).padEnd(8)} ${(n.slug ?? '').padEnd(20).slice(0, 20)} `
          + `${C.dim}${n.description.slice(0, 46)}${C.x}`);
        if (n.writes.length) out(`           ${C.dim}writes ${n.writes.join(', ').slice(0, 60)}${C.x}`);
      }
      renderPlanFindings(findings);

      // Scope mismatches were recorded by the deterministic validator when the
      // plan was produced. They are re-rendered here because this is the
      // moment someone is deciding, and a finding nobody re-reads at the point
      // of decision is a finding that was not part of the decision.
      const scopeGaps = ((recorded.payload as any).scopeFindings ?? []) as Array<any>;
      renderScopeGaps(scopeGaps);

      const negotiation = negotiateBudget(graph.nodes, budgetsFor(missions, id));
      renderNegotiation(negotiation);

      const rendered = [
        ...findings.map((f) => `${f.severity} ${f.code}: ${f.detail}`),
        ...scopeGaps.map((f: any) => `CRITERION_SCOPE_MISMATCH: ${f.detail}`),
        negotiation.rendered,
      ];

      if (!rest.includes('--yes')) {
        missions.recordPlanStopDecision(id, {
          version, rendered, decision: 'REFUSED_NO_CONSENT', decidedBy: 'nobody yet',
          deferred: !process.stdin.isTTY,
        });
        err(`${C.y}!${C.x} ${findings.length + scopeGaps.length} finding(s) stand against plan v${version}`);
        err(`  ${C.dim}re-run with --yes to accept THIS plan with those findings on the record${C.x}`);
        return 1;
      }
      if (!negotiation.fits && !rest.includes('--raise-budget')) {
        // --yes answers the findings. It does not answer the budget: those are
        // two different questions and one flag must not silently answer both.
        missions.recordPlanStopDecision(id, {
          version, rendered, decision: 'REFUSED_BUDGET', decidedBy: 'nobody yet',
          deferred: !process.stdin.isTTY,
        });
        err(`${C.r}✗${C.x} ${negotiation.rendered}`);
        err(`  ${C.dim}--yes accepts the findings; --raise-budget is a separate decision${C.x}`);
        return 1;
      }
      if (!negotiation.fits) {
        const before = budgetsFor(missions, id);
        if (negotiation.tasksNeeded > before.maxTasks) {
          missions.reviseBudget(id, { limit: 'maxTasks', from: before.maxTasks,
            to: negotiation.tasksNeeded, decidedBy: 'user-confirmed',
            reason: `plan v${version} needs ${negotiation.nodeCount} node(s) plus one repair` });
        }
        if (negotiation.estimatedCostUsd !== null
          && negotiation.estimatedCostUsd > before.costCeilingUsd) {
          missions.reviseBudget(id, { limit: 'costCeilingUsd', from: before.costCeilingUsd,
            to: negotiation.estimatedCostUsd, decidedBy: 'user-confirmed',
            reason: `the planner ESTIMATES ~$${negotiation.estimatedCostUsd.toFixed(2)} for plan v${version}` });
        }
        out(`  ${C.y}budget raised${C.x} ${C.dim}on the record — MISSION_BUDGET_REVISED${C.x}`);
      }

      missions.acceptPlan(id, graph, {
        acceptedBy: 'user-confirmed',
        acceptedDespite: [...findings.map((f) => `${f.severity} ${f.code}${f.nodeId ? ` ${missionLabel(f.nodeId)}` : ''}: ${f.detail}`),
          ...scopeGaps.map((f: any) => `CRITERION_SCOPE_MISMATCH: ${f.detail}`)],
      });
      missions.recordPlanStopDecision(id, {
        version, rendered, decision: 'ACCEPTED', decidedBy: 'user-confirmed', deferred: false,
      });
      out(`${C.g}✓${C.x} plan v${version} accepted by you`
        + (rendered.length ? ` ${C.y}despite ${findings.length + scopeGaps.length} finding(s)${C.x}` : ''));
      return 0;
    }

    case 'selftest': {
      const raw = rest.find((a) => !a.startsWith('--'));
      const live = rest.includes('--live');
      if (!live) { err('usage: zeus mission selftest --live'); return 2; }
      const report = await runLiveSelftest(ctx, engine, rest.includes('--mock'));
      if (json) { out(JSON.stringify(report, null, 1)); return report.refused ? 1 : 0; }
      renderSelftest(report);
      if (raw) {
        const id = resolve(raw);
        if (missions.mission(id)) {
          missions.events.append({ taskId: id, type: 'SELFTEST_LIVE', payload: { ...report } as any });
        }
      }
      return report.refused ? 1 : 0;
    }

    case 'run': {
      const raw = rest.find((a) => !a.startsWith('--'));
      if (!raw) { err('usage: zeus mission run <id> [--mock] [--yes]'); return 2; }
      const id = resolve(raw);
      const rec = guard(() => missions.mission(id));
      if (rec === null) return 2;
      if (!rec) { err(`unknown mission ${id}`); return 2; }
      if (rec.terminated) { err(`${id} is terminated (${rec.terminationReason})`); return 1; }

      const gate = requireAcceptedOracle(missions, id);
      if (!gate.ok) { err(`${C.r}✗${C.x} ${gate.message}`); return 1; }
      if (!rec.acceptedPlan) {
        err(`${C.r}✗${C.x} ${id} has no ACCEPTED plan in its log`);
        err(`  ${C.dim}zeus mission plan ${missionLabel(id)} first — a recorded plan is a proposal, not a mandate${C.x}`);
        return 1;
      }

      const mock = rest.includes('--mock');
      const eng = mock ? engineFor(ctx.root, ctx.cfg, { mock: true }) : engine;

      // Project readiness comes FIRST, before the selftest, because it is free
      // and the selftest costs money. The same probes doctor runs, from the
      // same implementation: two health paths that decide separately will
      // eventually disagree, and the one that disagrees quietly is the one
      // that lets a mission start on a host that cannot run it.
      const ready = projectReadiness({ root: ctx.root, cfg: ctx.cfg });
      if (!ready.ok) {
        const failed = ready.probes.filter((p) => p.required && p.status === 'FAIL');
        err(`${C.r}✗${C.x} ${id} will not start: this project is not ready on this host`);
        for (const p of failed) {
          err(`  ${C.r}✗${C.x} ${p.label}: ${p.detail}`);
          if (p.remedy) err(`      ${C.dim}→ ${p.remedy}${C.x}`);
        }
        err(`  ${C.dim}${ready.summary}${C.x}`);
        err(`  ${C.dim}nothing was spent — zeus doctor shows the full readiness report${C.x}`);
        return 1;
      }
      if (!json) out(`  ${C.dim}${ready.summary}${C.x}`);

      // The preflight runs BEFORE anything is spent. --mock skips it, and says
      // so: a mocked run has nothing to preflight, and silently passing a lane
      // that never ran would be the worst of both.
      if (mock) {
        out(`${C.dim}--mock: the live preflight was skipped, and no real provider will be called${C.x}`);
      } else {
        const pre = await runLiveSelftest(ctx, eng, false);
        missions.events.append({ taskId: id, type: 'SELFTEST_LIVE', payload: { ...pre } as any });
        renderSelftest(pre);
        if (pre.refused) { err(`${C.r}✗${C.x} the mission will not start: ${pre.detail}`); return 1; }
        if (pre.needsConfirmation) {
          if (!process.stdin.isTTY) {
            err(`${C.r}✗${C.x} ${pre.detail}, and this is not a terminal`);
            return 1;
          }
          if (!rest.includes('--yes')) {
            err(`${C.y}!${C.x} ${pre.detail}`);
            err(`  ${C.dim}re-run with --yes to proceed with that on the record${C.x}`);
            return 1;
          }
        }
      }

      const oracle = gate.oracle;
      const host = missionHost({
        engine: eng, missionId: id, projectRoot: ctx.root, oracle,
        ledger: ledgerFrom(oracle), supervisor: eng.opts.supervisor,
        judge: eng.opts.providers.reviewer,
        onEvent: (line) => { if (!json) out(`  ${C.dim}${line}${C.x}`); },
      });

      const result = await runMissionLoop(missions, host, { missionId: id, oracle });
      if (json) { out(JSON.stringify(result, null, 1)); return result.achievement === 'ACHIEVED' ? 0 : 1; }
      out('');
      out(`${C.b}${id}${C.x} ${result.achievement} / ${result.terminationReason}`);
      out(`  ${result.detail}`);
      out(`  ${C.dim}${result.cycles} cycle(s)${C.x}`);
      for (const r of result.refusals) out(`  ${C.y}${r.code}${C.x} ${r.detail}`);
      out(`  ${C.dim}zeus mission report ${missionLabel(id)} for the full account${C.x}`);
      return result.achievement === 'ACHIEVED' ? 0 : 1;
    }

    case 'report': {
      const raw = rest.find((a) => !a.startsWith('--'));
      if (!raw) { err('usage: zeus mission report <id> [--json]'); return 2; }
      const id = resolve(raw);
      const rec = guard(() => missions.mission(id));
      if (rec === null) return 2;
      if (!rec) { err(`unknown mission ${id}`); return 2; }

      const log = missions.events.read(id);
      const usage = missionUsage(log, Date.now(), (taskId) => {
        try { return providerSpendOf(missions.events.read(taskId)); }
        catch { return { costUsd: 0, unmetered: 0 }; }
      });
      const score = progressFrom(log);
      const integrations = log.filter((e) => e.type === 'INTEGRATION_RESULT').map((e) => e.payload as any);
      const mismatches = log.filter((e) => e.type === 'EFFECT_MISMATCH').map((e) => e.payload as any);
      const flips = log.filter((e) => e.type === 'OSCILLATION_DETECTED').map((e) => e.payload as any);
      const replans = log.filter((e) => e.type === 'MISSION_REPLAN').map((e) => e.payload as any);
      const escalations = log.filter((e) => e.type === 'MISSION_ESCALATED').map((e) => e.payload as any);
      const o = rec.oracle as Oracle | null;

      if (json) {
        out(JSON.stringify(missionReportView(missions, id), null, 1));
        return 0;
      }

      out(`${C.b}${rec.missionId}${C.x} ${rec.terminated
        ? `${rec.achievement} / ${rec.terminationReason}` : `${C.y}ACTIVE${C.x}`}`);
      out(`  goal            ${rec.goal}`);
      // An invalidated plan keeps its version — that is history — but loses
      // its mandate. Printing "v1 accepted (0 nodes)" would read as an empty
      // plan rather than a revoked one.
      const planLine = rec.acceptedPlanVersion === null ? `${C.dim}none accepted${C.x}`
        : rec.acceptedPlan
          ? `v${rec.acceptedPlanVersion} accepted (${rec.acceptedPlan.nodes.length} node(s))`
          : `${C.y}v${rec.acceptedPlanVersion} invalidated${C.x} ${C.dim}— nothing may be spawned${C.x}`;
      out(`  plan            ${planLine}`
        + `  ${C.dim}${rec.planRejections} rejected, ${rec.planCritiques} critiqued${C.x}`);

      if (o) {
        const required = o.criteria.filter((c) => c.required);
        const proven = required.filter((c) => rec.criterionOutcomes[c.criterionId] === 'PROVEN');
        out(`  criteria        ${proven.length}/${required.length} required proven`);
        for (const c of o.criteria) {
          const outcome = rec.criterionOutcomes[c.criterionId] ?? 'UNEVALUATED';
          const colour = outcome === 'PROVEN' ? C.g : outcome === 'FAILED' ? C.r : C.y;
          out(`    ${missionLabel(c.criterionId).padEnd(8)} ${colour}${outcome.padEnd(12)}${C.x} `
            + `${C.dim}${c.statement.slice(0, 52)}${C.x}`);
        }
      }

      out(`  integrations    ${integrations.length}`);
      for (const i of integrations) {
        const mark = i.integrated && !i.invariantsBroken.length ? `${C.g}✓${C.x}` : `${C.r}✗${C.x}`;
        out(`    ${mark} ${missionLabel(i.nodeId).padEnd(8)} ${String(i.reason).slice(0, 58)}`);
      }
      out(`  progress        ${score.provenRequired} proven, `
        + `${score.enablingCredits.length} enabling credit(s), `
        + `${score.consecutiveNoProgress} cycle(s) of nothing`);
      if (mismatches.length) {
        out(`  effect misses   ${mismatches.length}  ${C.dim}predicted vs observed${C.x}`);
        for (const m of mismatches) {
          for (const x of m.mismatches ?? []) {
            out(`    ${C.y}${missionLabel(m.nodeId)}${C.x} predicted ${JSON.stringify(x.predicted)}, `
              + `observed ${x.observed}`);
          }
        }
      }
      if (flips.length) {
        out(`  oscillation     ${flips.length}`);
        for (const f of flips) out(`    ${missionLabel(f.criterionId)} ${f.attribution}`);
      }
      if (replans.length) {
        out(`  replans         ${replans.length}`);
        for (const r of replans) out(`    ${C.y}${r.reason}${C.x} ${String(r.detail).slice(0, 60)}`);
      }
      if (escalations.length) {
        out(`  escalations     ${escalations.length}`);
        for (const e of escalations) out(`    ${C.y}${e.kind ?? 'escalated'}${C.x} ${String(e.detail ?? '').slice(0, 58)}`);
      }
      out(`  budget          ${usage.tasksSpawned} task(s) (${usage.repairs} repair), `
        + `${usage.replans} replan(s), ${Math.round(usage.elapsedSeconds / 60)} min`);
      out(`  cost            ${usage.costUsd > 0 ? `$${usage.costUsd.toFixed(4)} provider-reported` : `${C.dim}nothing reported${C.x}`}`
        + (usage.unmeteredCalls ? `  ${C.y}${usage.unmeteredCalls} call(s) reported no cost${C.x}` : ''));
      out(`  ratchet         ${rec.ratchetSha ? rec.ratchetSha.slice(0, 12) : `${C.dim}never advanced${C.x}`}`);
      return 0;
    }

    default:
      err('usage: zeus mission <create|status|list|compile|confirm|plan|run|report|'
        + 'accept-plan|recompile|evaluate|selftest|cancel|reconstruct-ratchet>');
      return 2;
  }
}



/** The budget a mission is actually operating under, revisions included. */
function budgetsFor(missions: MissionRegistry, missionId: string) {
  return applyBudgetRevisions(mergeMissionBudgets(), missions.events.read(missionId));
}

function negotiationFor(missions: MissionRegistry, missionId: string, graph: PlanGraph): BudgetNegotiation {
  return negotiateBudget(graph.nodes, budgetsFor(missions, missionId));
}

/**
 * The BC-2 signal, rendered where a person will see it before paying.
 *
 * Non-blocking, and printed anyway: a plan may legitimately intend partial
 * progress, and the only thing that must not happen is paying for partial
 * progress while believing it was the whole job.
 */
function renderScopeGaps(findings: Array<{ code: string; detail: string }>): void {
  const gaps = findings.filter((f) => f.code === 'CRITERION_SCOPE_MISMATCH');
  if (!gaps.length) return;
  out(`  ${C.y}${gaps.length} scope mismatch(es)${C.x} ${C.dim}between what the criteria read `
    + `and what this plan writes${C.x}`);
  for (const g of gaps) out(`    ${C.y}CRITERION_SCOPE_MISMATCH${C.x} ${C.dim}${g.detail}${C.x}`);
}

function renderNegotiation(n: BudgetNegotiation): void {
  if (n.fits) { out(`  ${C.dim}budget: ${n.rendered}${C.x}`); return; }
  out(`  ${C.y}budget:${C.x} ${n.rendered}`);
}

/** Renders plan-critic findings the way the oracle's are rendered. */
function renderPlanFindings(findings: Array<{ code: string; severity: string; nodeId?: string; detail: string }>): void {
  if (!findings.length) { out(`  ${C.dim}the independent critique raised nothing${C.x}`); return; }
  out(`  ${C.y}${findings.length} finding(s)${C.x} ${C.dim}from the plan critic${C.x}`);
  for (const f of findings) {
    const colour = f.severity === 'BLOCKING' ? C.r : C.y;
    out(`    ${colour}${f.severity.padEnd(9)}${C.x} ${(f.nodeId ? missionLabel(f.nodeId) : '—').padEnd(8)} `
      + `${f.code} ${C.dim}${f.detail.slice(0, 50)}${C.x}`);
  }
}

function renderSelftest(r: SelftestReport): void {
  out(`${C.b}zeus selftest --live${C.x}`);
  for (const l of r.lanes) {
    const colour = l.status === 'PASS' ? C.g : l.status === 'FAIL' ? C.r
      : l.status === 'DRIFT' ? C.y : C.dim;
    out(`  ${colour}${l.status.padEnd(8)}${C.x} ${l.lane.padEnd(20)} ${C.dim}${l.detail.slice(0, 56)}${C.x}`);
  }
  const spend = r.costUsd === null ? 'nothing reported' : `$${r.costUsd.toFixed(4)}`;
  out(`  ${C.dim}cost ${spend}${r.costIsLowerBound ? ' (a lower bound)' : ''}`
    + ` of a $${r.costCapUsd.toFixed(2)} cap for ${r.contacts} contact(s)`
    + `${r.unmeteredCalls ? `; ${r.unmeteredCalls} reported no price` : ''}${C.x}`);
}

/**
 * The live preflight, with this project's providers.
 *
 * `--mock` is honoured but says so loudly at the call site: a preflight whose
 * providers are fakes proves that Zeus can talk to fakes.
 */
async function runLiveSelftest(ctx: { root: string; cfg: ProjectConfig }, engine: Engine,
  mock: boolean): Promise<SelftestReport> {
  const providers = mock
    ? [engine.opts.providers.reviewer]
    : [...new Map([engine.opts.providers.planner, engine.opts.providers.implementer,
      engine.opts.providers.reviewer].map((p) => [p.id, p])).values()];
  return selftestLive({
    providers, supervisor: engine.opts.supervisor,
    policy: defaultPolicy(ctx.root, ctx.root), projectId: engine.projectId,
    isolation: isolationReport(),
    // The baseline lives in durable project state beside the event log. The
    // old code read a config key that nothing in the codebase ever wrote, so
    // the lane was permanently SKIPPED on every project.
    stateRoot: engine.stateRoot,
    versionOf: (id) => providerCliVersion(id),
  });
}

/** Reads a provider CLI's version, or null when it cannot be asked. */
function providerCliVersion(providerId: string): string | null {
  const bin = providerId === 'claude' ? 'claude' : providerId === 'codex' ? 'codex' : providerId;
  try {
    return require('child_process')
      .execFileSync(bin, ['--version'], { encoding: 'utf8', timeout: 20_000,
        stdio: ['ignore', 'pipe', 'pipe'] }).trim().split('\n')[0];
  } catch { return null; }
}

/** One line per probe, plus the contract line. Never softer than the probes. */
function renderReadiness(r: ReadinessReport): void {
  const glyph = (p: ReadinessProbe) => (p.status === 'PASS' ? `${C.g}✓${C.x}`
    : p.status === 'FAIL' ? `${C.r}✗${C.x}`
      : p.status === 'WARN' ? `${C.y}!${C.x}` : `${C.dim}-${C.x}`);
  out(`\n${C.b}Project readiness${C.x} ${C.dim}(what a mission on this project needs)${C.x}`);
  for (const p of r.probes) {
    const status = p.status === 'SKIPPED' ? `SKIPPED (${p.reason ?? 'no reason given'})` : p.status;
    out(`  ${glyph(p)} ${p.label.padEnd(24)} ${status.padEnd(9)} ${C.dim}${p.detail}${C.x}`);
    if (p.remedy && (p.status === 'FAIL' || p.status === 'WARN')) out(`      ${C.dim}→ ${p.remedy}${C.x}`);
  }
  out(`  ${r.ok ? C.g : C.r}${r.summary}${C.x}`);
}

/**
 * The Control Center.
 *
 * Loopback by default, and `--host` prints what it is exposing rather than
 * quietly doing it: a console that can spend money and run agents against a
 * repository is not something to bind outward by accident.
 */
async function cmdWeb(argv: string[]): Promise<number> {
  const ctx = requireProject();
  if (!ctx) return 2;
  const portIdx = argv.indexOf('--port');
  const hostIdx = argv.indexOf('--host');
  const rootIdx = argv.indexOf('--projects');
  const projectsRoot = rootIdx >= 0 ? path.resolve(argv[rootIdx + 1] ?? '')
    : (process.env.ZEUS_PROJECTS_ROOT ? defaultProjectsRoot() : null);
  const port = portIdx >= 0 ? Number(argv[portIdx + 1]) : 4317;
  const host = hostIdx >= 0 ? argv[hostIdx + 1] : '127.0.0.1';
  if (!Number.isFinite(port) || port < 0 || port > 65535) {
    err(`${C.r}✗${C.x} --port must be a port number`); return 2;
  }
  const engine = engineFor(ctx.root, ctx.cfg);

  // The SAME operations the CLI's own subcommands call. Handed in rather than
  // constructed inside the server, so the server cannot acquire its own copy.
  //
  // Built PER TARGET, not once. The first version closed over the directory
  // `zeus web` was started in, so compiling a mission in any other project
  // asked the wrong registry and got NO_SUCH_MISSION — and would have compiled
  // the wrong mission entirely had the ids not been project-qualified.
  const opCtx = (t: ProjectTarget) => {
    const cfg = t.root === ctx.root ? ctx.cfg
      : (readConfig(t.root) ?? defaultConfig(t.root));
    const eng = t.root === ctx.root ? engine : engineFor(t.root, cfg);
    return {
      missions: new MissionRegistry({
        events: eng.events, projectId: eng.projectId, stateRoot: eng.stateRoot,
      }),
      engine: eng, projectRoot: t.root,
      context: projectContextFor(t.root, cfg),
      policy: defaultPolicy(t.root, t.root),
    };
  };

  const server = await startWebServer({
    projectRoot: ctx.root, stateRoot: engine.stateRoot, projectId: engine.projectId,
    port, host,
    spawnRun: (missionId, target) => defaultSpawnRun(target.root, missionId),
    ...(projectsRoot ? { projectsRoot } : {}),
    // Creation steps run through the supervisor: bounded, killable, and in the
    // run registry like every other execution Zeus causes.
    createRunner: async (spec) => {
      const res = await engine.opts.supervisor.run({
        id: `create-${spec.kind}-${Date.now()}`,
        projectId: engine.projectId, taskId: null, cls: 'heavy',
        // `zeus init` is THIS CLI, invoked the way this CLI can actually be
        // invoked. Spawning bare node on a .ts entry point failed on the first
        // import, so every created project was left without a .zeus/.
        command: spec.kind === 'init' ? process.execPath : 'git',
        args: spec.kind === 'init'
          ? [...zeusCliArgv(), 'init']
          : spec.args,
        cwd: spec.cwd, inspectArgs: false, timeoutSeconds: 600,
        policy: defaultPolicy(spec.cwd, spec.cwd),
      } as any);
      return { ok: res.outcome === 'COMPLETED',
        detail: `${spec.kind} ${res.outcome}${res.exitCode === null ? '' : ` (exit ${res.exitCode})`}` };
    },
    operations: {
      compile: (missionId, target) => compileMissionOracle(opCtx(target), missionId),
      plan: (missionId, target) => planMissionGraph(opCtx(target), missionId),
      evaluate: async (missionId) => ({
        error: 'NOT_WIRED',
        detail: 'evaluate over HTTP arrives with the CLI evaluate rewire; use zeus mission evaluate',
        missionId,
      }),
    },
  });

  out(`${C.b}zeus web${C.x} ${C.dim}${engine.projectId}${C.x}`);
  out(`  ${server.url}`);
  if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') {
    out(`  ${C.y}!${C.x} bound to ${C.b}${host}${C.x}, not loopback — this exposes a console that can`);
    out(`     spend money and run agents against ${ctx.root} to everything that can reach it.`);
  }
  if (server.tokenCreated) {
    // Once. A secret reprinted on every start is a secret in every scrollback.
    out('');
    out(`  ${C.b}token${C.x} ${server.token}`);
    out(`  ${C.dim}shown once — stored at ${engine.stateRoot}/web-token (owner-only)${C.x}`);
  } else {
    out(`  ${C.dim}token already generated; read it from ${engine.stateRoot}/web-token${C.x}`);
  }
  out(projectsRoot
    ? `  ${C.dim}projects root ${projectsRoot}; ctrl-c to stop${C.x}`
    : `  ${C.dim}single project (pass --projects <dir> for the Projects home); ctrl-c to stop${C.x}`);

  await new Promise<void>((resolve) => {
    const stop = () => { void server.close().then(resolve); };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  });
  return 0;
}

function cmdSelfCheck(argv: string[]): number {
  const root = findProjectRoot() ?? process.cwd();
  const json = argv.includes('--json');
  if (!json) out(`${C.b}zeus self-check${C.x} ${C.dim}${root}${C.x}`);
  const g = runSelfCheck(root);
  if (json) { out(JSON.stringify(g, null, 1)); return g.ok ? 0 : 1; }
  if (g.ok) {
    out(`  ${C.g}✓${C.x} ${g.passed} passed, 0 failed in ${Math.round(g.durationMs / 1000)}s`);
    return 0;
  }
  err(renderRefusal(g));
  return 1;
}

function cmdRevalidate(argv: string[]): number {
  const ctx = requireProject();
  if (!ctx) return 2;
  const taskId = argv.find((a) => !a.startsWith('--'));
  if (!taskId) { err('usage: zeus revalidate <taskId> [--into <ref>]'); return 2; }
  const intoIdx = argv.indexOf('--into');
  const into = intoIdx >= 0 ? argv[intoIdx + 1] : 'HEAD';
  const json = argv.includes('--json');

  const engine = engineFor(ctx.root, ctx.cfg);
  const rec = engine.task(taskId);
  if (!rec) { err(`unknown task ${taskId}`); return 2; }

  const { execFileSync } = require('child_process');
  // git's own progress and conflict hints are captured rather than inherited:
  // Zeus reports the outcome in its own words, and a wall of rebase hints in
  // the middle of that is noise the reader has to parse past.
  const git = (cwd: string) => (args: string[]): string => {
    try {
      return execFileSync('git', ['-C', cwd, ...args], {
        encoding: 'utf8', timeout: 120_000, maxBuffer: 32 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e: any) { return `${String(e?.stdout ?? '')}${String(e?.stderr ?? '')}`; }
  };
  // The project repository is being asked a question here, not changed: the
  // integration target is inspected, and only the TASK's own worktree is
  // rebased. Finding G-U2 was a read-only phase that mutated a repository, so
  // the two are now different callables rather than the same one used
  // carefully.
  const readOnly = readOnlyGit(ctx.root, {
    onRefusal: (r) => err(`${C.r}✗${C.x} ${r.message}`),
  });
  const inProject = (args: string[]): string => {
    try { return readOnly(args); } catch (e: any) { return `${e?.message ?? e}`; }
  };
  const inWorktree = git(rec.worktree);

  const access: GitAccess = {
    headOf: (ref) => inProject(['rev-parse', ref]).trim() || rec.baseSha,
    filesChangedBetween: (from, to) => inProject(['diff', '--name-only', `${from}..${to}`]).split('\n').filter(Boolean),
    rebase: (onto) => {
      const before = inWorktree(['status', '--porcelain']);
      const out2 = inWorktree(['rebase', onto]);
      const conflicts = inWorktree(['diff', '--name-only', '--diff-filter=U']).split('\n').filter(Boolean);
      if (conflicts.length) { inWorktree(['rebase', '--abort']); return { ok: false, conflicts, detail: 'rebase aborted; the worktree is unchanged' }; }
      void out2;
      return { ok: true, conflicts: [], detail: `rebased onto ${onto.slice(0, 12)} (worktree was ${before.trim() ? 'dirty' : 'clean'})` };
    },
    diffAgainst: (base) => inWorktree(['diff', base, '--']),
  };

  const parsedNow = parseDiff(inWorktree(['diff', rec.baseSha, '--']));
  const decision = revalidateForIntegration({
    git: access, integrationRef: into, verifiedAgainst: rec.baseSha,
    originalTier: 'NORMAL',
    adapterId: ctx.cfg.project?.adapter ?? 'generic',
    confidence: impactConfidence(parsedNow, ctx.cfg.project?.adapter ?? 'generic'),
    commands: (ctx.cfg.commands ?? {}) as unknown as Record<string, string | null | undefined>,
    hardening: (ctx.cfg as any)?.validation?.hardening,
  });

  engine.events.append({ taskId, type: 'INTEGRATION_REVALIDATION', payload: {
    code: decision.code, verifiedAgainst: decision.verifiedAgainst, integrationHead: decision.integrationHead,
    intervening: decision.intervening, overlap: decision.overlap,
    tier: decision.tier, escalated: decision.escalated, plan: decision.plan, detail: decision.detail,
  } });

  if (json) { out(JSON.stringify(decision, null, 1)); return decision.code === 'REVALIDATION_CONFLICT' ? 1 : 0; }

  out(`${C.b}${taskId}${C.x} verified against ${C.dim}${decision.verifiedAgainst.slice(0, 12)}${C.x}`);
  out(`  integration target ${into} is at ${decision.integrationHead.slice(0, 12)}`);
  if (decision.code === 'REVALIDATION_NOT_NEEDED') { out(`  ${C.g}✓${C.x} ${decision.detail}`); return 0; }
  if (decision.code === 'REVALIDATION_CONFLICT') {
    err(`  ${C.r}✗${C.x} ${decision.detail}`);
    for (const f of decision.conflicts.slice(0, 10)) err(`      ${f}`);
    return 1;
  }
  out(`  ${decision.intervening.length} file(s) changed on the target since verification`);
  out(`  ${decision.overlap.length ? `${C.y}!${C.x}` : `${C.g}✓${C.x}`} overlap: ${decision.overlap.join(', ') || 'none'}`);
  out(`  tier ${decision.originalTier} → ${C.b}${decision.tier}${C.x}${decision.escalated ? ' (escalated by overlap)' : ''}`);
  out(`  rerun before integrating: ${[...(decision.plan?.floor ?? []), ...(decision.plan?.additional ?? [])].join(', ') || '(nothing configured)'}`);
  // This command is not read-only, and an operator running it as "should I
  // integrate?" deserves to be told that the answer changed the worktree.
  out(`  ${C.y}!${C.x} the task worktree is now rebased onto ${decision.integrationHead.slice(0, 12)}; `
    + 'its evidence was recorded against the previous base');
  out(`${C.dim}  ${decision.detail}${C.x}`);
  return 0;
}

function cmdCancel(argv: string[]): number {
  const ctx = requireProject();
  if (!ctx) return 2;
  const id = argv.find((a) => !a.startsWith('--'));
  if (!id) { err('usage: zeus cancel <taskId>'); return 2; }
  const reasonIdx = argv.indexOf('--reason');
  const reason = reasonIdx >= 0 ? argv[reasonIdx + 1] ?? 'cancelled by operator' : 'cancelled by operator';
  const engine = engineFor(ctx.root, ctx.cfg);
  if (!engine.task(id)) { err(`unknown task ${id}`); return 2; }
  const r = engine.cancel(id, reason);
  out(`${C.g}✓${C.x} ${id} cancelled (${r.killed} process tree(s) terminated); evidence preserved`);
  return 0;
}

function cmdLogs(argv: string[]): number {
  const ctx = requireProject();
  if (!ctx) return 2;
  const engine = engineFor(ctx.root, ctx.cfg);
  const id = argv.find((a) => !a.startsWith('--')) ?? engine.events.listTasks().pop();
  if (!id) { out('no tasks yet in this project'); return 0; }
  const show = (from: number) => {
    const evs = engine.events.read(id);
    for (const e of evs.slice(from)) {
      const p = JSON.stringify(e.payload);
      out(`${C.dim}${e.ts.slice(11, 19)}${C.x} ${String(e.seq).padStart(3)} ${e.type.padEnd(16)} ${p.slice(0, 120)}`);
    }
    return evs.length;
  };
  let n = show(0);
  if (!argv.includes('--follow')) return 0;
  setInterval(() => { n = show(n); }, 500);
  return 0;
}

export async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  // Ask about a pre-rename layout before any command reads or writes state, so
  // a task is never recorded into one directory while its history sits in the
  // other. `init --migrate` does it itself; version/help touch nothing.
  if (!['version', '--version', '-v', 'help', '--help', '-h', undefined].includes(cmd)
      && !(cmd === 'init' && rest.includes('--migrate'))) {
    offerMigration(findProjectRoot());
  }
  switch (cmd) {
    case 'setup': return cmdSetup(rest);
    case 'init': return cmdInit(rest);
    case 'web': return cmdWeb(rest);
    case 'doctor': return cmdDoctor(rest);
    case 'version': case '--version': case '-v': out(VERSION); return 0;
    case 'help': case '--help': case '-h': case undefined: usage(); return 0;
    case 'run': return cmdRun(rest);
    case 'status': return cmdStatus(rest);
    case 'cancel': return cmdCancel(rest);
    case 'logs': return cmdLogs(rest);
    case 'config': return cmdConfig(rest);
    case 'revalidate': return cmdRevalidate(rest);
    case 'self-audit': return cmdSelfAudit(rest);
    case 'self-check': return cmdSelfCheck(rest);
    case 'clean': return cmdClean(rest);
    case 'mission': return cmdMission(rest);
    default: err(`unknown command "${cmd}"`); usage(); return 2;
  }
}

if (require.main === module) {
  main(process.argv.slice(2))
    .then((code) => { if (!process.argv.includes('--follow')) process.exit(code); })
    .catch((e) => { err(`zeus: ${e?.stack ?? e}`); process.exit(1); });
}
