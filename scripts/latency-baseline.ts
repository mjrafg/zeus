#!/usr/bin/env ts-node
/**
 * Latency baseline harness — measurement only.
 *
 * Runs a fixed set of task shapes against one pinned repository and records
 * where the wall clock went. It changes nothing about how Zeus behaves: the
 * only difference from a normal run is that a SpanRecorder is passed in, and
 * the null recorder is what every other caller gets.
 *
 * Each task gets a fresh clone so that SETUP is measured honestly rather than
 * amortised — except T5, which deliberately reuses T1's clone to expose warm
 * effects.
 *
 *   ts-node scripts/latency-baseline.ts [--only T1,T2] [--out audits/latency]
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';

import { Engine } from '../src/engine/orchestrator';
import { ProcessSupervisor } from '../src/engine/exec';
import { deriveBudgets } from '../src/engine/budget';
import { claudeProvider, codexProvider, mockProvider, Provider } from '../src/engine/providers';
import { ProcessSupervisor as Sup } from '../src/engine/exec';
import { defaultConfig, readConfig, writeConfig } from '../src/config';
import { SpanRecorder, LatencyReport } from '../src/telemetry/spans';
import { createSubject } from './latency-subject';

const REPO = path.resolve(__dirname, '..');

interface TaskSpec {
  id: string;
  description: string;
  expectedTier: string;
  note?: string;
  /** Reuse the clone from this task instead of making a fresh one. */
  reuseCloneOf?: string;
}

const TASKS: TaskSpec[] = [
  {
    id: 'T1', expectedTier: 'FAST',
    description: 'In README.md, change the word "small" to "compact" in the first paragraph. Change nothing else in any file.',
  },
  {
    id: 'T2', expectedTier: 'FAST',
    description: 'In src/components/styles.css, change the padding of .ledger-row from "4px 8px" to "6px 10px". Change nothing else in any file.',
  },
  {
    id: 'T3', expectedTier: 'NORMAL',
    description: 'In src/app/money.ts, add and export a function sumCents(values: number[]): number that returns the sum of the array. Do not change any existing function.',
  },
  {
    id: 'T4', expectedTier: 'DEEP',
    description: 'In src/lib/session.ts, add and export a function willExpireWithin(s: Session, nowMs: number, withinSeconds: number): boolean that reports whether the session expires within the given window. Do not change any existing function.',
  },
  {
    id: 'T5', expectedTier: 'FAST', reuseCloneOf: 'T1',
    description: 'In README.md, change the word "sample" to "example" in the first paragraph. Change nothing else in any file.',
  },
];

/** T1 is run three times so variance is visible rather than assumed away. */
const REPEATS: Record<string, number> = { T1: 3 };

interface RunResult {
  taskId: string;
  runIndex: number;
  spec: TaskSpec;
  finalState: string;
  latency: LatencyReport;
  tier: string | null;
  confidence: string | null;
  checksRun: string[];
  checksAvailable: string[];
  providerInvocations: number;
  filesChanged: number;
  wallClockMs: number;
  cloneReused: boolean;
  error?: string;
}

function git(cwd: string, args: string[]): string {
  try {
    return execFileSync('git', ['-C', cwd, '-c', 'user.email=lat@zeus', '-c', 'user.name=lat', ...args],
      { encoding: 'utf8', timeout: 300_000, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e: any) { return String(e?.stdout ?? ''); }
}

/**
 * A write-capable Codex, for the implementer seat only.
 *
 * The product's codexProvider hardcodes `--sandbox read-only`, which is right:
 * Codex is the independent REVIEWER and a reviewer that can edit the code is
 * not a reviewer. But it means Codex cannot stand in for the implementer, and
 * a measurement run where the implementer physically cannot write measures an
 * empty task — which is what the first attempt at this baseline did.
 *
 * This lives in the harness rather than in src/ precisely so that the product's
 * provider definitions are unchanged by a measurement exercise.
 */
function codexImplementer(): Provider {
  const bin = process.env.ZEUS_CODEX_BIN ?? 'codex';
  return {
    id: 'codex-write',
    async available() { return { ok: true, detail: bin }; },
    async invoke(req: any, sup: Sup) {
      const res = await sup.run({
        id: `${req.taskId}-${req.role}-${Date.now()}`,
        projectId: req.projectId, taskId: req.taskId, cls: 'agent',
        command: bin,
        args: ['exec', '--json', '--sandbox', 'workspace-write', '--skip-git-repo-check', req.prompt],
        cwd: req.policy.worktreeRoot, policy: req.policy,
        confineFilesystem: false, inspectArgs: false, timeoutSeconds: 1200,
      } as any);
      let structured: any = null;
      for (const line of res.stdout.split('\n')) {
        const t = line.trim();
        if (!t.startsWith('{')) continue;
        try {
          const j = JSON.parse(t);
          const text = j?.msg?.message ?? j?.message ?? j?.result;
          if (typeof text === 'string' && text.includes('{')) {
            const a = text.indexOf('{'); const b = text.lastIndexOf('}');
            try { structured = JSON.parse(text.slice(a, b + 1)); } catch { /* prose */ }
          }
        } catch { /* not a json line */ }
      }
      return {
        ok: res.outcome === 'COMPLETED', role: req.role, structured,
        text: res.stdout.slice(-4000), raw: res.stdout, exitCode: res.exitCode,
        durationMs: res.durationMs, outcome: res.outcome,
        infrastructureFailure: res.outcome === 'COMPLETED' ? null : String(res.outcome),
        timing: (res as any).timing,
      } as any;
    },
  };
}

function providersFor(mode: string): { planner: Provider; implementer: Provider; reviewer: Provider } {
  if (mode === 'mock') return { planner: mockProvider(), implementer: mockProvider(), reviewer: mockProvider() };
  // Default pairing. Requires a Claude CLI with a live token.
  if (mode === 'real') return { planner: claudeProvider(), implementer: claudeProvider(), reviewer: codexProvider() };
  // Codex in every seat, with a write-capable implementer. Used when the Claude
  // token is unavailable; the report must say so, because PROVIDER numbers then
  // describe Codex rather than the default developer model.
  return { planner: codexProvider(), implementer: codexImplementer(), reviewer: codexProvider() };
}

async function runOne(spec: TaskSpec, runIndex: number, sha: string, mode: string,
  clones: Map<string, string>, subjectRepo: string): Promise<RunResult> {
  const reuse = spec.reuseCloneOf ? clones.get(spec.reuseCloneOf) : undefined;
  const root = reuse ?? fs.mkdtempSync(path.join(os.tmpdir(), `zeus-lat-${spec.id}-${runIndex}-`));

  // A recorder started BEFORE anything happens, so clone and init are inside
  // the measured window rather than free.
  const spans = new SpanRecorder(`${spec.id}#${runIndex}`);

  if (!reuse) {
    spans.sync('setup.clone', 'SETUP', () => {
      execFileSync('git', ['clone', '-q', subjectRepo, root], { timeout: 600_000, stdio: ['ignore', 'pipe', 'pipe'] });
      git(root, ['-c', 'advice.detachedHead=false', 'checkout', '-q', sha]);
    });
    spans.sync('setup.link-toolchain', 'SETUP', () => {
      // The subject has no third-party dependencies; it needs only a compiler.
      // Linking one is cheaper and more honest than measuring an npm install
      // against a registry the confinement cannot reach anyway.
      try { fs.symlinkSync(path.join(REPO, 'node_modules'), path.join(root, 'node_modules'), 'dir'); }
      catch { /* already linked on a reused clone */ }
    });
  }

  const cfg = spans.sync('setup.config', 'SETUP', () => {
    const existing = readConfig(root);
    if (existing) return existing;
    const made = defaultConfig(root);
    writeConfig(root, made);
    for (const sub of ['state', 'logs']) fs.mkdirSync(path.join(root, '.zeus', sub), { recursive: true });
    return made;
  });

  const stateRoot = path.join(root, '.zeus/state');
  const engine = new Engine({
    projectRoot: root, config: cfg,
    supervisor: new ProcessSupervisor(deriveBudgets(), undefined, stateRoot),
    providers: providersFor(mode),
    stateRoot, spans,
  });

  const owned = spans.sync('lease.acquire', 'PERSISTENCE', () => engine.acquire());
  if (!owned.ok) throw new Error(`lease: ${owned.reason}`);

  let finalState = 'UNKNOWN';
  let error: string | undefined;
  let taskId = '';
  try {
    const rec = engine.createTask(spec.description);
    taskId = rec.taskId;

    // Zeus creates a per-task git worktree and never installs dependencies
    // into it — `commands.install` is detected by the adapter but the
    // lifecycle does not run it. On any real Node project that means every
    // check fails with "Cannot find module 'fs'" until something puts
    // node_modules there. Doing it here, inside SETUP, is what a real
    // environment-preparation step would cost, and measuring it is the point
    // of Q2 rather than a workaround hidden from the numbers.
    spans.sync('setup.worktree-deps', 'SETUP', () => {
      fs.mkdirSync(path.dirname(rec.worktree), { recursive: true });
      if (!fs.existsSync(rec.worktree)) {
        git(root, ['worktree', 'add', '-q', '--detach', rec.worktree, rec.baseSha]);
      }
      const nm = path.join(rec.worktree, 'node_modules');
      if (!fs.existsSync(nm)) fs.symlinkSync(path.join(REPO, 'node_modules'), nm, 'dir');
    });

    finalState = await engine.run(rec.taskId);
  } catch (e: any) {
    error = String(e?.stack ?? e);
    finalState = 'HARNESS_ERROR';
  } finally {
    spans.sync('lease.release', 'PERSISTENCE', () => engine.release());
    spans.finish();
  }

  const events = taskId ? engine.events.read(taskId) : [];
  const payloadOf = (type: string) => (events.filter((e) => e.type === type).pop()?.payload ?? {}) as any;
  const plan = payloadOf('VALIDATION_PLAN');
  const scope = payloadOf('VALIDATION_SCOPE');
  const change = payloadOf('CODE_CHANGE');
  const checks = events.filter((e) => e.type === 'CHECK_RESULT').map((e) => String((e.payload as any).name));
  const available = Object.entries(cfg.commands ?? {}).filter(([, v]) => v).map(([k]) => k);

  const latency = spans.report();

  // The spans go into the existing event store, as one append, after the
  // measured window has closed so the write cannot perturb what it describes.
  if (taskId) {
    engine.events.append({
      taskId, type: 'LATENCY_SPANS',
      payload: { report: latency as any, spans: spans.raw() as any, harness: `${spec.id}#${runIndex}` },
    });
  }

  clones.set(spec.id, root);
  return {
    taskId: spec.id, runIndex, spec, finalState, latency,
    tier: plan.tier ?? null, confidence: plan.confidence ?? null,
    checksRun: checks, checksAvailable: available,
    providerInvocations: events.filter((e) => e.type === 'AGENT_STARTED').length,
    filesChanged: Array.isArray(change.filesChanged) ? change.filesChanged.length : 0,
    wallClockMs: latency.totalMs,
    cloneReused: !!reuse,
    error,
  };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const onlyIdx = argv.indexOf('--only');
  const only = onlyIdx >= 0 ? (argv[onlyIdx + 1] ?? '').split(',').filter(Boolean) : null;
  const modeIdx = argv.indexOf('--providers');
  const mode = modeIdx >= 0 ? argv[modeIdx + 1] : 'codex';
  const outIdx = argv.indexOf('--out');
  const out = path.resolve(outIdx >= 0 ? argv[outIdx + 1] : path.join(REPO, 'audits/latency'));
  fs.mkdirSync(out, { recursive: true });

  const zeusSha = git(REPO, ['rev-parse', 'HEAD']).trim();
  const subjectRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'zeus-lat-subject-'));
  const sha = createSubject(subjectRepo);
  const clones = new Map<string, string>();
  const results: RunResult[] = [];

  process.stdout.write(`latency baseline\n`
    + `  zeus      ${REPO} @ ${zeusSha.slice(0, 12)}\n`
    + `  subject   ${subjectRepo} @ ${sha.slice(0, 12)}\n`
    + `  providers ${mode}\n\n`);

  for (const spec of TASKS) {
    if (only && !only.includes(spec.id)) continue;
    const repeats = REPEATS[spec.id] ?? 1;
    for (let i = 1; i <= repeats; i += 1) {
      const label = repeats > 1 ? `${spec.id} run ${i}/${repeats}` : spec.id;
      process.stdout.write(`  ${label} … `);
      const started = Date.now();
      try {
        const r = await runOne(spec, i, sha, mode, clones, subjectRepo);
        results.push(r);
        process.stdout.write(`${r.finalState} tier=${r.tier} ${Math.round(r.latency.totalMs)}ms `
          + `(recon ${r.latency.reconciliationDeltaMs.toFixed(3)}ms, overhead ${r.latency.overheadMs.toFixed(1)}ms)\n`);
      } catch (e: any) {
        process.stdout.write(`HARNESS_ERROR after ${Date.now() - started}ms: ${e?.message}\n`);
      }
      // Machine-specific absolute paths are redacted before this is written:
      // the file is committed as evidence, and Zeus's own boundary check
      // refuses a repository that hard-codes one.
      const redactPaths = (text: string): string => text
        .split(REPO).join('<zeus-repo>')
        .split(subjectRepo).join('<subject-repo>')
        .replace(/"\/tmp\/[^"]*"/g, '"<tmp>"')
        .replace(/"\/home\/[^"]*"/g, '"<home>"');
      fs.writeFileSync(path.join(out, 'raw.json'), `${redactPaths(JSON.stringify(
        { zeusSha, subjectSha: sha, mode, host: { cpus: os.cpus().length, totalMemMb: Math.round(os.totalmem() / 2 ** 20) }, results },
        null, 1))}\n`);
    }
  }

  process.stdout.write(`\nwrote ${path.join(out, 'raw.json')} (${results.length} run(s))\n`);
}

if (require.main === module) {
  main().catch((e) => { process.stderr.write(`${e?.stack ?? e}\n`); process.exit(1); });
}
