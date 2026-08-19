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
import { Engine, TERMINAL } from './engine/orchestrator';
import { ProcessSupervisor } from './engine/exec';
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
  zeus doctor                            report what this machine can actually do
  zeus run "<task>" [--mock]              run a task in this project
  zeus status [<taskId>]
  zeus cancel <taskId> [--reason "..."]
  zeus logs [<taskId>] [--follow]
  zeus config [get <key> | set <key> <value>]  read or edit this project's configuration
  zeus config [get <key> | set <key> <value>]  read or edit this project's configuration
  zeus revalidate <taskId> [--into <ref>]     recheck a verified task against a moved integration target
  zeus self-audit [--lane A-F] [--cycle-id <id>]  audit this checkout adversarially, on a disposable copy
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
  if (json) {
    out(JSON.stringify({ version: VERSION, runtime: userDataDir(), project: root, capabilities: caps,
      configProblems: cfg ? validateConfig(cfg) : null }, null, 1));
    return summarize(caps).ok ? 0 : 1;
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
  out(`  ${C.b}fallback mode:${C.x} ${iso.fallbackMode}${iso.fallbackMode ? `  ${C.y}(resource limits are NOT enforced by the kernel)${C.x}` : ''}`);
  out(`  ${C.dim}enforces: ${iso.enforces.join(', ')}${C.x}`);
  out(`\n${C.b}Derived budgets${C.x} ${C.dim}(from ${budgets.derivedFrom.cpus} cpus / ${budgets.derivedFrom.totalMemMb} MB)${C.x}`);
  out(`  reserved for control plane : ${budgets.reservedCpus} cpu, ${budgets.reservedMemMb} MB`);
  out(`  per execution              : ${budgets.cpuQuotaPercent}% cpu, ${budgets.memoryMaxMb} MB, ${budgets.maxProcesses} procs`);
  out(`  test workers               : ${budgets.maxTestWorkers} (playwright ${budgets.maxPlaywrightWorkers})`);
  out(`  concurrency                : heavy ${budgets.globalHeavyConcurrency}, light ${budgets.globalLightConcurrency}`);

  const { ok, blocking } = summarize(caps);
  const providerGaps = caps.filter((c) => c.provider && c.level === 'missing');
  out(`\n${ok ? `${C.g}Ready.${C.x}` : `${C.r}Not ready:${C.x} ${blocking.map((b) => b.label).join(', ')}`}`);
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
  const wanted = argv.find((a) => !a.startsWith('--'));
  const ids = wanted ? [wanted] : engine.events.listTasks();
  if (!ids.length) { out('no tasks yet in this project'); return 0; }
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
  const inProject = git(ctx.root);
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
    default: err(`unknown command "${cmd}"`); usage(); return 2;
  }
}

if (require.main === module) {
  main(process.argv.slice(2))
    .then((code) => { if (!process.argv.includes('--follow')) process.exit(code); })
    .catch((e) => { err(`zeus: ${e?.stack ?? e}`); process.exit(1); });
}
