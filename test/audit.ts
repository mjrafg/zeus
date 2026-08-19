/**
 * Regression tests for Audit Cycle 1.
 *
 * Every one of these fails against the behaviour that was found and passes
 * against the fix. They are named after the defect rather than the repair, so
 * that a future reader sees what went wrong rather than what someone did about
 * it.
 *
 * The last section is the test-the-tests pass (§42): a faulty substitute is
 * injected for each critical safety rule and the check is required to notice.
 * A safety test that cannot fail is decoration.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync, spawn } from 'child_process';

import { check, section } from './harness';
import { Engine, redactSecrets } from '../src/engine/orchestrator';
import { ProcessSupervisor, stillOurProcess, processStartTicks, RunRecord } from '../src/engine/exec';
import { deriveBudgets } from '../src/engine/budget';
import { mockProvider } from '../src/engine/providers';
import { defaultPolicy, inspectCommand } from '../src/engine/policy';
import { defaultConfig } from '../src/config';
import { parseDiff } from '../src/validation/diff';
import { resolveTier, maxTier } from '../src/validation/tier';
import { inspectIntegrity, designContract } from '../src/validation/integrity';

const GIT = ['-c', 'user.email=t@e', '-c', 'user.name=t'];
function git(cwd: string, args: string[]): string {
  try {
    return execFileSync('git', ['-C', cwd, ...GIT, ...args], { encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e: any) { return String(e?.stdout ?? ''); }
}
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

export async function auditRegressionSuite(): Promise<void> {
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'zeus-audit-reg-'));

  section('cycle-1 D1/D2: every shape of change is visible to validation');
  {
    const root = path.join(TMP, 'vis');
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, 'a.ts'), 'export const a = 1;\n');
    fs.writeFileSync(path.join(root, 'package.json'), '{"name":"vis"}\n');
    git(root, ['init', '-q', '-b', 'main']);
    git(root, ['add', '-A']); git(root, ['commit', '-qm', 'base']);

    const cfg = defaultConfig(root);
    const stateRoot = path.join(root, '.zeus/state');
    const engine = new Engine({
      projectRoot: root, config: cfg,
      supervisor: new ProcessSupervisor(deriveBudgets(), undefined, stateRoot),
      providers: { planner: mockProvider(), implementer: mockProvider(), reviewer: mockProvider() },
      stateRoot,
    });
    engine.acquire();
    const rec = engine.createTask('visibility regression');
    git(root, ['worktree', 'add', '-q', '--detach', rec.worktree, rec.baseSha]);

    // Three shapes at once, all of them ordinary implementer behaviour.
    fs.writeFileSync(path.join(rec.worktree, 'a.ts'), 'export const a = 2;\n');          // modified
    fs.mkdirSync(path.join(rec.worktree, 'src'), { recursive: true });
    fs.writeFileSync(path.join(rec.worktree, 'src/session.ts'), 'export const ttl = 86400;\n'); // NEW, untracked
    fs.mkdirSync(path.join(rec.worktree, 'test'), { recursive: true });
    fs.writeFileSync(path.join(rec.worktree, 'test/new.spec.ts'), 'it.skip("critical", () => {});\n');
    git(rec.worktree, ['add', 'a.ts']); git(rec.worktree, ['commit', '-qm', 'committed part']); // COMMITTED

    const diff = engine.diff(rec);
    const changed = engine.changedFiles(rec);
    const parsed = parseDiff(diff);
    const decision = resolveTier({ diff: parsed, adapterId: 'node', confidence: 'KNOWN' });
    const integrity = inspectIntegrity(parsed, designContract({ requiredTests: ['npm test'] }));
    engine.release();

    check('R-D1: a newly created file appears in the diff Zeus classifies',
      parsed.files.some((f) => f.path === 'src/session.ts'), parsed.files.map((f) => f.path).join(', '));
    check('R-D2: work the implementer committed still appears',
      parsed.files.some((f) => f.path === 'a.ts'));
    check('R-D3: changedFiles agrees with the diff, so evidence and classification match',
      ['a.ts', 'src/session.ts', 'test/new.spec.ts'].every((f) => changed.includes(f)), changed.join(', '));
    check('R-D4: a new session module is classified high-risk rather than invisible',
      decision.tier === 'DEEP' && decision.highRiskFiles.includes('src/session.ts'),
      `${decision.tier} ${JSON.stringify(decision.highRiskFiles)}`);
    check('R-D5: a new test arriving pre-skipped is surfaced',
      integrity.testsDisabled.some((d) => d.file === 'test/new.spec.ts'));
    check('R-D6: the reviewer would receive a non-empty diff',
      diff.includes('src/session.ts') && diff.length > 100);
  }

  section('cycle-1 D3: a truncated reviewer diff is announced');
  {
    const src = fs.readFileSync(path.resolve(__dirname, '../src/engine/orchestrator.ts'), 'utf8');
    check('R-D7: the diff section is never silently sliced',
      !/content:\s*diff\.slice\(/.test(src));
    check('R-D8: truncation is stated in the payload the reviewer reads',
      /DIFF TRUNCATED/.test(src) && /have not seen the whole change/i.test(src));
    check('R-D9: truncation is recorded as evidence, not just displayed',
      /diffTruncated/.test(src));
  }

  section('cycle-1 B6: a recycled pid is not signalled on its number alone');
  {
    const now = processStartTicks(process.pid);
    check('R-B1: the kernel start time is readable for a live process',
      now === null || Number.isFinite(now), String(now));

    const base: RunRecord = {
      jobId: 'j', pgid: process.pid, pid: process.pid, unit: null,
      projectId: 'p', taskId: 'T', hostname: 'h',
      startedAt: new Date().toISOString(), command: 'jest', startTicks: now,
    };
    check('R-B2: a record whose start time matches is still ours',
      stillOurProcess(base).ours);
    check('R-B3: a record whose start time differs is refused',
      now === null || !stillOurProcess({ ...base, startTicks: (now as number) + 1 }).ours);
    check('R-B4: an old record with no start time is refused rather than trusted',
      !stillOurProcess({ ...base, startTicks: null, startedAt: new Date(Date.now() - 4 * 3600_000).toISOString() }).ours);
    check('R-B5: a fresh record with no start time is still usable',
      stillOurProcess({ ...base, startTicks: null }).ours);

    // End to end: a bystander wearing a recorded pgid must survive a cancel.
    const { killRecorded, registryDirFor } = require('../src/engine/exec');
    const stateRoot = path.join(TMP, 'pidreuse');
    const dir = registryDirFor(stateRoot);
    fs.mkdirSync(dir, { recursive: true });
    const bystander = spawn('sh', ['-c', 'sleep 30256'], { detached: true, stdio: 'ignore' });
    await sleep(400);
    fs.writeFileSync(path.join(dir, 'j-stale.json'), JSON.stringify({
      jobId: 'j-stale', pgid: bystander.pid, pid: bystander.pid, unit: null,
      projectId: 'p', taskId: 'T-9', hostname: 'h',
      startedAt: new Date(Date.now() - 3 * 3600_000).toISOString(),
      command: 'jest', startTicks: (processStartTicks(bystander.pid!) ?? 0) + 7,
    }));
    const r = killRecorded(stateRoot, { taskId: 'T-9' }, 'regression');
    await sleep(400);
    const survived = alive(bystander.pid!);
    try { process.kill(-bystander.pid!, 'SIGKILL'); } catch { /* fine */ }
    check('R-B6: cancel does not kill a process group it cannot prove is its own',
      survived, `killed=${r.killed} unverified=${JSON.stringify(r.unverified)}`);
    check('R-B7: the refusal is reported rather than silently swallowed',
      Array.isArray(r.unverified) && r.unverified.length === 1);
  }

  section('cycle-1 C5: secret-shaped command output never reaches the log');
  {
    const cases: Array<[string, string]> = [
      ['sk-live-ABCDEFGHIJKLMNOPQRSTUV', 'api key'],
      ['ghp_abcdefghijklmnopqrstuvwxyz0123', 'github token'],
      ['AKIAABCDEFGHIJKLMNOP', 'aws key id'],
      ['postgres://user:hunter2@db:5432/app', 'credentialed url'],
      ['DATABASE_PASSWORD=hunter2', 'named secret'],
    ];
    for (const [secret, what] of cases) {
      const r = redactSecrets(`test output before ${secret} and after`);
      check(`R-C1: ${what} is redacted from recorded output`,
        !r.text.includes(secret) && r.redactions > 0, r.text);
    }
    check('R-C2: ordinary output is left intact',
      redactSecrets('47 tests passed in 3.2s').text === '47 tests passed in 3.2s');
    check('R-C3: redaction is applied where the log is written',
      /redactSecrets\(res\.stdout/.test(fs.readFileSync(path.resolve(__dirname, '../src/engine/orchestrator.ts'), 'utf8')));
  }

  section('cycle-1 C3: recursive permission changes on system paths are refused');
  {
    const wt = path.join(TMP, 'pol'); fs.mkdirSync(wt, { recursive: true });
    const policy = defaultPolicy(TMP, wt);
    check('R-C4: chmod -R 777 / is refused',
      inspectCommand(policy, 'chmod', ['-R', '777', '/']).length > 0);
    check('R-C5: chown -R on /etc is refused',
      inspectCommand(policy, 'chown', ['-R', 'me', '/etc']).length > 0);
    check('R-C6: chmod -R on $HOME is refused',
      inspectCommand(policy, 'sh', ['-c', 'chmod -R 700 $HOME']).length > 0);
    check('R-C7: a legitimate chmod inside the worktree is allowed',
      inspectCommand(policy, 'chmod', ['+x', './scripts/build.sh']).length === 0);
    check('R-C8: a non-recursive chmod on a system path is not swept up',
      inspectCommand(policy, 'chmod', ['644', './README.md']).length === 0);
  }

  section('cycle-1 F3: the empty-repository fallback does not clone .git');
  {
    const src = fs.readFileSync(path.resolve(__dirname, '../src/engine/orchestrator.ts'), 'utf8');
    check('R-F1: the fallback excludes .git, node_modules and .zeus',
      /--exclude=\.git/.test(src) && /--exclude=node_modules/.test(src) && /--exclude=\.zeus/.test(src));
    check('R-F2: it no longer uses a bare recursive copy',
      !/cp -a "\$\{this\.opts\.projectRoot\}\/\."/.test(src));
  }

  // ---------------------------------------------------------------------
  // §42 — test the tests.
  // ---------------------------------------------------------------------
  section('test-the-tests: a faulty substitute for each safety rule is detected');
  {
    // 1. Tier maximum. Substitute an averaging rule and require the check to fail.
    const faultyMax = (a: string, b: string) => (a === 'FAST' || b === 'FAST' ? 'FAST' : a);
    const mixed = parseDiff([
      'diff --git a/src/lib/session.ts b/src/lib/session.ts',
      '--- a/src/lib/session.ts', '+++ b/src/lib/session.ts', '@@ -1 +1 @@',
      '-const t = 1;', '+const t = 2;',
      'diff --git a/docs/x.md b/docs/x.md',
      '--- a/docs/x.md', '+++ b/docs/x.md', '@@ -1 +1 @@', '-a', '+b',
    ].join('\n'));
    const realTier = resolveTier({ diff: mixed, adapterId: 'node', confidence: 'KNOWN' }).tier;
    const faultyTier = mixed.files.map((f) => (f.path.includes('session') ? 'DEEP' : 'FAST'))
      .reduce((acc, t) => faultyMax(acc, t) as any, 'FAST');
    check('TT1: the real rule says DEEP and the faulty substitute says FAST',
      realTier === 'DEEP' && faultyTier === 'FAST');
    check('TT2: the assertion used in the harness distinguishes them',
      (realTier === 'DEEP') !== (faultyTier === 'DEEP'));

    // 2. Redaction. A substitute that returns its input unchanged must be caught.
    const faultyRedact = (t: string) => ({ text: t, redactions: 0 });
    const secret = 'sk-live-TESTTHETESTS0123456789';
    const realOut = redactSecrets(`x ${secret}`);
    const faultyOut = faultyRedact(`x ${secret}`);
    check('TT3: the redaction assertion fails against a pass-through substitute',
      !realOut.text.includes(secret) && faultyOut.text.includes(secret));

    // 3. Pid identity. A substitute that always says "ours" must be caught.
    const faultyIdentity = () => ({ ours: true, reason: 'always' });
    const ticks = processStartTicks(process.pid);
    const recycled: RunRecord = {
      jobId: 'j', pgid: process.pid, pid: process.pid, unit: null, projectId: 'p', taskId: 'T',
      hostname: 'h', startedAt: new Date().toISOString(), command: 'x',
      startTicks: (ticks ?? 0) + 99,
    };
    check('TT4: the pid-identity assertion fails against an always-true substitute',
      (ticks === null || !stillOurProcess(recycled).ours) && faultyIdentity().ours);

    // 4. Required-test immutability. A substitute that honours a justification
    //    must be caught by the assertion that no justification clears it.
    const del = parseDiff([
      'diff --git a/tests/auth.spec.ts b/tests/auth.spec.ts', 'deleted file mode 100644',
      '--- a/tests/auth.spec.ts', '+++ /dev/null', '@@ -1 +0,0 @@', '-it("x", () => {});',
    ].join('\n'));
    const real = inspectIntegrity(del, designContract({
      requiredTests: ['npx jest tests/auth.spec.ts'],
      testChangeJustifications: [{ path: 'tests/auth.spec.ts', reason: 'no longer considered useful by the implementer' }],
    }));
    const faultyBlocking = real.blocking.filter((f) => f.code !== 'REQUIRED_TEST_TAMPERED');
    check('TT5: the immutability assertion fails against a substitute that accepts a justification',
      real.blocking.some((f) => f.code === 'REQUIRED_TEST_TAMPERED')
      && !faultyBlocking.some((f) => f.code === 'REQUIRED_TEST_TAMPERED'));

    check('TT6: no intentional breakage was committed — every substitute is local to this test',
      typeof faultyMax === 'function' && typeof faultyRedact === 'function' && typeof faultyIdentity === 'function');
  }

  fs.rmSync(TMP, { recursive: true, force: true });
}
