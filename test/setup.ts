/**
 * Setup-wizard tests.
 *
 * Every scenario runs against a fake machine, so the cases that matter most —
 * a missing package manager, an unauthenticated provider, a refused sudo, an
 * interrupted sign-in — are exercised without touching this host and without
 * ever invoking a real, paid provider login.
 *
 * Two invariants are asserted throughout, because they are the point of the
 * whole wizard: nothing is installed without a recorded yes, and no credential
 * is ever echoed, logged or persisted.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { check, section } from './harness';
import { RunResult, SystemProbe } from '../src/setup/probe';
import { detect, detectAll, systemInfo, DEPENDENCIES } from '../src/setup/deps';
import { detectPackageManager, installCommand, privileges, installNpmGlobal } from '../src/setup/pkg';
import { providerStatus, loginProvider, loginWithApiKey, roleWarnings, DEFAULT_ROLES } from '../src/setup/providers';
import { runSetup, Consent, NonInteractiveConsent, SetupState, emptyState } from '../src/setup/wizard';
import { FileStateStore, MemoryStateStore, applyRoles, assertNoSecrets, stateFile } from '../src/setup/state';

// ---------------------------------------------------------------------------
// A fake machine.
// ---------------------------------------------------------------------------

interface Machine {
  platform?: string;
  arch?: string;
  user?: string;
  tty?: boolean;
  /** bin name -> resolved path. Absent means "not on PATH". */
  bins?: Record<string, string>;
  /** Handlers consulted in order; the first match answers. */
  handle?: Array<{ when: RegExp; reply: (argv: string[], input?: string) => RunResult }>;
}

const ok = (stdout = ''): RunResult => ({ code: 0, stdout, stderr: '' });
const fail = (stderr = '', code = 1): RunResult => ({ code, stdout: '', stderr });

class FakeProbe implements SystemProbe {
  /** Every command line this probe was asked to run, in order. */
  readonly ran: string[] = [];
  /** Commands run with a terminal attached (provider sign-in flows). */
  readonly interactive: string[] = [];
  /** Anything handed to a command on stdin, so tests can prove key handling. */
  readonly stdin: string[] = [];

  constructor(private m: Machine) {}

  platform(): string { return this.m.platform ?? 'linux'; }
  arch(): string { return this.m.arch ?? 'x64'; }
  distro() { return { id: 'ubuntu', name: 'Ubuntu', version: '24.04' }; }
  shell(): string { return 'bash'; }
  user(): string { return this.m.user ?? 'dev'; }
  homedir(): string { return '/home/dev'; }
  pathEntries(): string[] { return ['/usr/bin', '/home/dev/.local/bin']; }
  which(bin: string): string | null { return this.m.bins?.[bin] ?? null; }
  exists(): boolean { return false; }
  isTTY(): boolean { return this.m.tty ?? true; }

  run(cmd: string, args: string[], opts: { input?: string } = {}): RunResult {
    const line = [cmd, ...args].join(' ');
    this.ran.push(line);
    if (opts.input !== undefined) this.stdin.push(opts.input);
    for (const h of this.m.handle ?? []) if (h.when.test(line)) return h.reply([cmd, ...args], opts.input);
    return fail(`fake: no handler for "${line}"`, 127);
  }

  runInteractive(cmd: string, args: string[]): RunResult {
    const line = [cmd, ...args].join(' ');
    this.interactive.push(line);
    this.ran.push(line);
    for (const h of this.m.handle ?? []) if (h.when.test(line)) return h.reply([cmd, ...args]);
    return ok();
  }
}

/** A machine with the core tools present and both providers signed in. */
function healthyMachine(over: Partial<Machine> = {}): Machine {
  const bins: Record<string, string> = {
    git: '/usr/bin/git', node: '/usr/bin/node', npm: '/usr/bin/npm',
    claude: '/home/dev/.local/bin/claude', codex: '/usr/bin/codex',
    bwrap: '/usr/bin/bwrap', rg: '/usr/bin/rg', jq: '/usr/bin/jq',
    'apt-get': '/usr/bin/apt-get', sudo: '/usr/bin/sudo',
  };
  return {
    bins: { ...bins, ...(over.bins ?? {}) },
    // Scenario handlers come first: a test that says "signed out" outranks the
    // healthy default that says otherwise.
    handle: [
      ...(over.handle ?? []),
      { when: /^git --version/, reply: () => ok('git version 2.43.0') },
      { when: /^node --version/, reply: () => ok('v18.16.1') },
      { when: /^npm --version/, reply: () => ok('9.5.1') },
      { when: /^claude --version/, reply: () => ok('2.1.233 (Claude Code)') },
      { when: /^codex --version/, reply: () => ok('codex-cli 0.147.0') },
      { when: /^bwrap --version/, reply: () => ok('bubblewrap 0.9.0') },
      { when: /^rg --version/, reply: () => ok('ripgrep 14.1.0') },
      { when: /^jq --version/, reply: () => ok('jq-1.7') },
      { when: /^claude auth status/, reply: () => ok('{"loggedIn":true,"authMethod":"claude.ai","email":"someone@example.com","orgId":"org_123"}') },
      { when: /^codex login status/, reply: () => ok('Logged in using ChatGPT') },
      { when: /^sudo -n true/, reply: () => ok() },
    ],
    ...(over.platform ? { platform: over.platform } : {}),
    ...(over.user ? { user: over.user } : {}),
    ...(over.tty !== undefined ? { tty: over.tty } : {}),
  };
}

/** Consent scripted by a test: answers by substring, defaults to refusing. */
class ScriptedConsent implements Consent {
  readonly questions: string[] = [];
  readonly secretsRequested: string[] = [];
  constructor(private readonly script: {
    yes?: RegExp[];
    select?: Record<string, string[]>;   // prompt substring -> chosen ids
    picks?: Record<string, string>;      // prompt substring -> chosen id
    secret?: string;
  }) {}

  confirm(question: string, def: boolean): boolean {
    this.questions.push(question);
    if (this.script.yes?.some((r) => r.test(question))) return true;
    return def && false;   // silence is never a yes in these tests
  }

  choose(prompt: string, options: Array<{ id: string; label: string; selected: boolean }>): string[] {
    this.questions.push(prompt);
    for (const [needle, ids] of Object.entries(this.script.select ?? {})) {
      if (prompt.includes(needle)) return ids;
    }
    void options;
    return [];
  }

  pick(prompt: string, _o: Array<{ id: string; label: string }>, def: string): string {
    this.questions.push(prompt);
    for (const [needle, id] of Object.entries(this.script.picks ?? {})) {
      if (prompt.includes(needle)) return id;
    }
    return def;
  }

  secret(prompt: string): string {
    this.secretsRequested.push(prompt);
    return this.script.secret ?? '';
  }
}

interface Run {
  report: ReturnType<typeof runSetup>;
  transcript: string;
  probe: FakeProbe;
  state: SetupState;
}

function runOn(machine: Machine, consent: Consent, extra: Partial<Parameters<typeof runSetup>[0]> = {},
  store = new MemoryStateStore()): Run {
  const probe = new FakeProbe(machine);
  const lines: string[] = [];
  const report = runSetup({ probe, consent, store, out: (l) => lines.push(l), ...extra });
  return { report, transcript: lines.join('\n'), probe, state: store.load() };
}

const codes = (r: Run): string[] => r.report.unmet.map((u) => u.code);
const installCommands = (p: FakeProbe): string[] =>
  p.ran.filter((c) => /install|apt-get|dnf|pacman|apk|zypper|brew/.test(c));

// ---------------------------------------------------------------------------

export function setupSuite(): void {
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'zeus-setup-'));

  section('setup: system and dependency discovery');
  {
    const p = new FakeProbe(healthyMachine());
    const sys = systemInfo(p);
    check('SET-S1: the operating system, distribution and architecture are identified',
      sys.platform === 'linux' && sys.distro === 'Ubuntu 24.04' && sys.arch === 'x64' && sys.supported);

    const all = detectAll(p);
    check('SET-S2: every declared dependency is probed, including the ones that are absent',
      all.length === DEPENDENCIES.length &&
      all.filter((d) => d.spec.tier !== 'optional').every((d) => d.state === 'installed') &&
      all.filter((d) => ['graphify', 'docker', 'gh'].includes(d.spec.id)).every((d) => d.state === 'missing'));
    check('SET-S3: versions are captured, not just presence',
      all.find((d) => d.spec.id === 'node')?.version === '18.16.1' &&
      all.find((d) => d.spec.id === 'git')?.version === '2.43.0');

    const bare = new FakeProbe({ bins: {} });
    const missing = detectAll(bare);
    check('SET-S4: absent tools are reported missing rather than assumed',
      missing.every((d) => d.state === 'missing'));

    const old = new FakeProbe(healthyMachine({
      handle: [{ when: /^node --version/, reply: () => ok('v16.20.2') }],
    }));
    const node = detect(old, DEPENDENCIES.find((d) => d.id === 'node')!);
    check('SET-S5: an unsupported Node version is distinguished from an absent one',
      node.state === 'unsupported-version' && node.major === 16);

    const mac = new FakeProbe({ platform: 'darwin', bins: {} });
    check('SET-S6: Linux-only tools are not reported missing on other platforms',
      detect(mac, DEPENDENCIES.find((d) => d.id === 'bubblewrap')!).state === 'installed');
    const win = new FakeProbe({ platform: 'win32', bins: {} });
    check('SET-S7: an unsupported platform is named as such',
      !systemInfo(win).supported && /UNSUPPORTED_PLATFORM/.test(systemInfo(win).note));
  }

  section('setup: package managers and privilege');
  {
    const apt = new FakeProbe(healthyMachine());
    check('SET-S8: the platform package manager is detected', detectPackageManager(apt)?.id === 'apt');
    const none = new FakeProbe({ bins: { git: '/usr/bin/git' } });
    check('SET-S9: no package manager is a reportable state, not a crash', detectPackageManager(none) === null);

    const cmd = installCommand(detectPackageManager(apt)!, ['jq'], privileges(apt));
    check('SET-S10: the exact privileged command is available to show the user',
      cmd.display === 'sudo apt-get install -y jq' && cmd.requiresSudo);
    const asRoot = new FakeProbe(healthyMachine({ user: 'root' }));
    check('S11: running as root does not add a pointless sudo',
      installCommand(detectPackageManager(asRoot)!, ['jq'], privileges(asRoot)).display
        === 'apt-get install -y jq');
  }

  section('setup: nothing is installed without consent');
  {
    // A machine missing the recommended tools, where the user says no.
    const m = healthyMachine({ bins: { jq: '', rg: '' } });
    delete m.bins!.jq; delete m.bins!.rg;
    const consent = new ScriptedConsent({});   // refuses everything
    const r = runOn(m, consent);
    check('S12: the user is asked before any dependency is installed',
      consent.questions.some((q) => /Install missing dependencies/.test(q)));
    check('S13: refusing means no install command is executed',
      installCommands(r.probe).length === 0, r.probe.ran.join(' | ') || 'no commands');
    check('S14: refusals are recorded so a rerun can lead with them',
      r.state.declined.includes('jq') && r.state.declined.includes('ripgrep'));
    check('S15: declined optional tools do not block readiness',
      r.report.ready === true && codes(r).includes('DEPENDENCY_MISSING'));

    // The same machine, where the user says yes to jq only.
    const yes = new ScriptedConsent({
      select: { 'Install missing dependencies': ['jq'] },
      yes: [/Run this command\?/],
    });
    const r2 = runOn(m, yes, {});
    check('S16: accepting installs exactly what was selected, and nothing else',
      r2.probe.ran.includes('sudo apt-get install -y jq') &&
      !r2.probe.ran.some((c) => /install -y ripgrep/.test(c)));
    check('S17: the privileged command is shown in full before it runs',
      r2.transcript.includes('sudo apt-get install -y jq') &&
      r2.transcript.includes('this needs administrator privileges'));
  }

  section('setup: sudo is never silent');
  {
    const m = healthyMachine({ bins: {} });
    m.bins = { ...healthyMachine().bins }; delete m.bins.jq;
    const selectOnly = new ScriptedConsent({ select: { 'Install missing dependencies': ['jq'] } });
    const r = runOn(m, selectOnly);
    check('S18: selecting a package is not consent to run sudo — that is asked separately',
      r.probe.ran.every((c) => !c.startsWith('sudo apt-get')) &&
      selectOnly.questions.some((q) => /Run this command\?/.test(q)));

    // No sudo binary at all: the wizard explains rather than failing the run.
    const noSudo = healthyMachine();
    delete noSudo.bins!.sudo; delete noSudo.bins!.jq;
    const r2 = runOn(noSudo, new ScriptedConsent({
      select: { 'Install missing dependencies': ['jq'] }, yes: [/Run this command\?/],
    }));
    check('S19: without sudo the exact manual command is reported, not a silent failure',
      r2.report.actions.some((a) => a.result === 'PERMISSION_REQUIRED') &&
      r2.report.unmet.some((u) => u.remedy.includes('apt-get install -y jq')));
  }

  section('setup: npm global installs never escalate');
  {
    let attempts = 0;
    const m = healthyMachine();
    delete m.bins!.codex;
    m.handle!.unshift(
      { when: /^npm install -g @openai\/codex/, reply: () => {
        attempts += 1;
        // First attempt fails the way a root-owned prefix does.
        return attempts === 1 ? fail('npm ERR! code EACCES\nnpm ERR! permission denied') : ok('added 1 package');
      } },
      { when: /^npm config set prefix/, reply: () => ok() },
    );
    const p = new FakeProbe(m);
    const r = installNpmGlobal(p, '@openai/codex');
    check('S20: an unwritable global prefix is redirected to the user, never sudo-ed',
      r.code === 'INSTALLED' && r.prefixChanged === '/home/dev/.local' &&
      p.ran.some((c) => c === 'npm config set prefix /home/dev/.local'));
    check('S21: "sudo npm install -g" is never executed',
      p.ran.every((c) => !/^sudo npm/.test(c)));
  }

  section('setup: provider authentication is the provider’s own');
  {
    const p = new FakeProbe(healthyMachine());
    const st = providerStatus(p, 'claude');
    check('S22: authentication state comes from the vendor’s own status command',
      st.auth === 'AUTHENTICATED' && st.authMethod === 'claude.ai' &&
      p.ran.includes('claude auth status --json'));
    check('S23: identity details the vendor returns are not lifted into Zeus',
      !JSON.stringify(st).includes('example.com') && !JSON.stringify(st).includes('org_123'));

    const notLoggedIn = healthyMachine({
      handle: [
        { when: /^claude auth status/, reply: () => ok('{"loggedIn":false}') },
        { when: /^claude auth login/, reply: () => ok() },
      ],
    });
    const q = new FakeProbe(notLoggedIn);
    check('S24: a signed-out provider is reported as needing authentication',
      providerStatus(q, 'claude').auth === 'AUTHENTICATION_REQUIRED');

    // Sign-in that does not complete must not be reported as success.
    const stubborn = new FakeProbe(healthyMachine({
      handle: [{ when: /^claude auth status/, reply: () => ok('{"loggedIn":false}') }],
    }));
    const outcome = loginProvider(stubborn, 'claude');
    check('S25: the vendor, not the exit code, decides whether sign-in worked',
      outcome.state === 'AUTHENTICATION_REQUIRED' &&
      stubborn.interactive.includes('claude auth login'));
    check('S26: the sign-in flow is handed the terminal, not proxied',
      stubborn.interactive.length === 1);

    // Headless: no browser, no guessing.
    const headless = new FakeProbe(healthyMachine({ tty: false, handle: [
      { when: /^claude auth status/, reply: () => ok('{"loggedIn":false}') },
    ] }));
    const h = loginProvider(headless, 'claude');
    check('S27: without a terminal no sign-in is attempted and instructions are given',
      h.state === 'AUTHENTICATION_REQUIRED' && headless.interactive.length === 0 &&
      h.manual.includes('claude auth login'));
  }

  section('setup: API keys are handled by the vendor, never by us');
  {
    const m = healthyMachine({ handle: [
      { when: /^codex login status/, reply: () => ok('Logged in using an API key') },
      { when: /^codex login --with-api-key/, reply: () => ok() },
    ] });
    const p = new FakeProbe(m);
    const secret = 'sk-test-DO-NOT-LOG-abcdef123456';
    const r = loginWithApiKey(p, 'codex', secret);
    check('S28: the key is passed on stdin and never as a command-line argument',
      r.state === 'AUTHENTICATED' && p.stdin.includes(secret) &&
      p.ran.every((c) => !c.includes(secret)));

    const state = emptyState();
    let threw = false;
    try { assertNoSecrets({ ...state, lastOutcome: `token=${secret}` }); } catch { threw = true; }
    check('S29: state that looks like it contains a credential is refused before it reaches disk', threw);
  }

  section('setup: roles are configuration, credentials are not');
  {
    const r = runOn(healthyMachine(), new ScriptedConsent({
      picks: { 'implement changes': 'claude', 'review them independently': 'codex' },
    }));
    check('S30: the chosen roles are persisted',
      r.state.roles.developer === 'claude' && r.state.roles.reviewer === 'codex' &&
      r.state.completed.includes('roles'));
    check('S31: no credential, token or account detail is written to setup state',
      !/token|password|api[-_]?key|credential|example\.com|org_/i.test(JSON.stringify(r.state)));

    const cfg = applyRoles({ providers: { billing: 'subscription-cli-only' } }, r.state.roles);
    check('S32: roles land in project configuration as roles, not secrets',
      cfg.providers.planner === 'claude' && cfg.providers.reviewer === 'codex' &&
      cfg.providers.billing === 'subscription-cli-only' &&
      !('apiKey' in cfg.providers) && !('token' in cfg.providers));

    const same = runOn(healthyMachine(), new ScriptedConsent({
      picks: { 'implement changes': 'claude', 'review them independently': 'claude' },
    }));
    check('S33: putting one provider in both seats is allowed but flagged as not independent',
      same.report.warnings.some((w) => /no longer independent/.test(w)));
    check('S34: the recommended default is two different vendors',
      DEFAULT_ROLES.developer !== DEFAULT_ROLES.reviewer && roleWarnings(DEFAULT_ROLES).length === 0);
  }

  section('setup: non-interactive mode reports, it does not act');
  {
    const m = healthyMachine({ tty: false });
    delete m.bins!.jq;
    delete m.bins!.codex;
    const consent = new NonInteractiveConsent();
    const r = runOn(m, consent, { interactive: false });
    check('S35: nothing is installed and no sign-in is attempted',
      installCommands(r.probe).length === 0 && r.probe.interactive.length === 0);
    check('S35b: no question is even posed, and silence is not recorded as a refusal',
      consent.asked.length === 0 && r.state.declined.length === 0);
    check('S36: the missing reviewer is reported with a machine-readable code',
      r.report.unmet.some((u) => u.component === 'OpenAI Codex' && u.code === 'DEPENDENCY_MISSING' && u.blocking));
    check('S37: an optional tool is reported without blocking readiness',
      r.report.unmet.some((u) => u.component === 'jq' && !u.blocking));
    check('S38: the run is not declared ready while a selected provider is missing',
      r.report.ready === false);
    check('S39: every unmet item carries the command that would fix it',
      r.report.unmet.every((u) => u.remedy.length > 0));

    const authNeeded = healthyMachine({ tty: false, handle: [
      { when: /^codex login status/, reply: () => fail('Not logged in', 1) },
    ] });
    const r2 = runOn(authNeeded, new NonInteractiveConsent(), { interactive: false });
    check('S40: an installed but signed-out provider yields AUTHENTICATION_REQUIRED',
      r2.report.unmet.some((u) => u.code === 'AUTHENTICATION_REQUIRED' && u.component === 'OpenAI Codex'));
  }

  section('setup: dry run changes nothing');
  {
    const m = healthyMachine();
    delete m.bins!.jq;
    const store = new MemoryStateStore();
    const before = JSON.stringify(store.load());
    const consent = new ScriptedConsent({ select: { 'Install missing dependencies': ['jq'] }, yes: [/.*/] });
    const r = runOn(m, consent, { dryRun: true }, store);
    check('S41: a dry run executes no install and asks no question',
      installCommands(r.probe).length === 0 && consent.questions.length === 0);
    check('S42: a dry run does not write setup state',
      JSON.stringify(store.load()) === before && r.report.dryRun);
    check('S43: a dry run still produces the full picture',
      r.report.dependencies.length === DEPENDENCIES.length && r.report.unmet.length > 0 &&
      /Dry run: nothing was installed/.test(r.transcript));
  }

  section('setup: resumability');
  {
    const dir = path.join(TMP, 'resume');
    const store = new FileStateStore(dir);

    // First run: Claude is installed, then the Codex sign-in is interrupted.
    const m1 = healthyMachine({ handle: [
      { when: /^codex login status/, reply: () => fail('Not logged in', 1) },
      { when: /^codex login$/, reply: () => ok() },   // user abandons the browser
    ] });
    const r1 = runOn(m1, new ScriptedConsent({ yes: [/Sign in to/] }), {}, store);
    check('S44: a completed step is recorded',
      r1.state.completed.includes('auth:claude') && !r1.state.completed.includes('auth:codex'));
    check('S45: state is persisted to disk', fs.existsSync(stateFile(dir)));

    // Second run: Claude is untouched, only the outstanding sign-in is retried.
    const m2 = healthyMachine({ handle: [
      { when: /^codex login status/, reply: () => ok('Logged in using ChatGPT') },
    ] });
    const r2 = runOn(m2, new ScriptedConsent({}), {}, store);
    check('S46: a rerun resumes rather than reinstalling what is already there',
      r2.report.resumed.includes('auth:claude') && installCommands(r2.probe).length === 0);
    check('S47: the finished sign-in is picked up and the run is ready',
      r2.report.ready && r2.state.completed.includes('auth:codex'));

    const corrupt = path.join(TMP, 'corrupt');
    fs.mkdirSync(corrupt, { recursive: true });
    fs.writeFileSync(stateFile(corrupt), '{ this is not json');
    check('S48: unreadable state is discarded, not half-honoured',
      new FileStateStore(corrupt).load().completed.length === 0);
    fs.writeFileSync(stateFile(corrupt), JSON.stringify({ version: 99, completed: ['install:claude'] }));
    check('S49: state from an unknown version is ignored',
      new FileStateStore(corrupt).load().completed.length === 0);
  }

  section('setup: readiness and honest reporting');
  {
    const healthy = runOn(healthyMachine(), new ScriptedConsent({}));
    check('S50: a fully provisioned machine is ready and nothing was changed to get there',
      healthy.report.ready && healthy.report.actions.length === 0 &&
      installCommands(healthy.probe).length === 0);
    check('S51: readiness is stated plainly', /Zeus is ready\./.test(healthy.transcript));

    const bare = runOn({ bins: {}, tty: false }, new NonInteractiveConsent(), { interactive: false });
    check('S52: a machine with nothing installed is not ready and says why',
      !bare.report.ready &&
      bare.report.unmet.some((u) => u.component === 'Git' && u.blocking) &&
      bare.report.unmet.some((u) => u.component === 'Node.js' && u.blocking));
    check('S53: with no package manager that is diagnosed specifically',
      bare.report.unmet.some((u) => u.code === 'NO_PACKAGE_MANAGER'));

    const win = runOn({ platform: 'win32', bins: {}, tty: false }, new NonInteractiveConsent(), { interactive: false });
    check('S54: an unsupported platform blocks with UNSUPPORTED_PLATFORM',
      !win.report.ready && win.report.unmet.some((u) => u.code === 'UNSUPPORTED_PLATFORM'));

    const oldNode = healthyMachine({ handle: [{ when: /^node --version/, reply: () => ok('v16.20.2') }] });
    const r = runOn(oldNode, new NonInteractiveConsent(), { interactive: false });
    check('S55: an unsupported Node version blocks with its own code, not "missing"',
      r.report.unmet.some((u) => u.code === 'DEPENDENCY_VERSION_UNSUPPORTED' && u.component === 'Node.js'));
    check('S56: Node is never installed automatically on the user’s behalf',
      !r.probe.ran.some((c) => /install.*node/i.test(c)));
  }

  section('setup: the transcript never leaks a secret');
  {
    const secret = 'sk-live-shouldNeverAppear-999';
    const m = healthyMachine({ handle: [
      { when: /^codex login status/, reply: () => fail('Not logged in', 1) },
      { when: /^codex login --with-api-key/, reply: () => ok() },
    ] });
    const consent = new ScriptedConsent({
      yes: [/Sign in to OpenAI Codex/, /Use an API key/], secret,
    });
    const r = runOn(m, consent, { advanced: true });
    check('S57: an API key is requested through the non-echoing reader',
      consent.secretsRequested.length === 1 && r.probe.stdin.includes(secret));
    check('S58: the key appears in no transcript line, command or persisted state',
      !r.transcript.includes(secret) &&
      r.probe.ran.every((c) => !c.includes(secret)) &&
      !JSON.stringify(r.state).includes(secret) &&
      !JSON.stringify(r.report).includes(secret));
    check('S59: API-key sign-in is an explicit advanced choice, not the default',
      consent.questions.some((q) => /advanced/.test(q)));

    const normal = runOn(m, new ScriptedConsent({ yes: [/Sign in to OpenAI Codex/] }));
    check('S60: without the advanced flag the ordinary vendor flow is used',
      normal.probe.interactive.includes('codex login') &&
      !normal.probe.ran.some((c) => c.includes('--with-api-key')));
  }

  section('setup: scoped runs');
  {
    const m = healthyMachine({ handle: [{ when: /^codex login status/, reply: () => fail('Not logged in', 1) }] });
    delete m.bins!.jq;
    const depsOnly = new ScriptedConsent({});
    const r = runOn(m, depsOnly, { scope: 'dependencies' });
    check('S61: "setup dependencies" does not touch providers',
      r.probe.interactive.length === 0 &&
      !depsOnly.questions.some((q) => /Sign in to/.test(q)));

    const provOnly = new ScriptedConsent({});
    const r2 = runOn(m, provOnly, { scope: 'providers' });
    check('S62: "setup providers" does not offer dependency installation',
      !provOnly.questions.some((q) => /Install missing dependencies/.test(q)) &&
      installCommands(r2.probe).length === 0);
    check('S63: a scoped run still reports the whole machine honestly',
      r2.report.dependencies.length === DEPENDENCIES.length);
  }

  fs.rmSync(TMP, { recursive: true, force: true });
}
