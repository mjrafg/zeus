/**
 * The real `LoopHost`: git, the engine, the oracle and the ratchet.
 *
 * Kept out of `loop.ts` on purpose. The loop's subject is sequencing and
 * refusal; this file's subject is the machinery those decisions are made
 * about. Mixed together they would produce a file in which neither could be
 * read, and the refusals are the part that has to stay readable.
 */

import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { Engine, TaskRecord, ZEUS_PATHSPEC_EXCLUDES } from '../engine/orchestrator';
import { ProcessSupervisor } from '../engine/exec';
import { Provider } from '../engine/providers';
import { GitAccess, revalidateForIntegration } from '../validation/revalidate';
import { Tier } from '../validation/tier';
import { Oracle } from './oracle';
import { PlanGraph, TaskNode } from './types';
import { advanceRatchet, readRatchet } from './ratchet';
import { acceptedCommands, evaluateCriteria } from './evaluate';
import { PreconditionProbe } from './schedule';
import { LoopHost, NodeExecution } from './loop';
import { ObservedEvidence } from './progress';

const GIT_ID = ['-c', 'user.email=zeus@localhost', '-c', 'user.name=zeus'];

function git(cwd: string, args: string[], timeoutMs = 120_000): string {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8', timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function gitSoft(cwd: string, args: string[]): { ok: boolean; out: string } {
  try { return { ok: true, out: git(cwd, args) }; }
  catch (e: any) { return { ok: false, out: `${String(e?.stdout ?? '')}${String(e?.stderr ?? '')}`.trim() }; }
}

/** Git access scoped to one task's worktree, for the revalidation decision. */
function worktreeGit(worktree: string, projectRoot: string): GitAccess {
  return {
    headOf: (ref) => {
      const r = gitSoft(projectRoot, ['rev-parse', ref]);
      return r.ok ? r.out : ref;
    },
    filesChangedBetween: (from, to) => {
      const r = gitSoft(projectRoot, ['diff', '--name-only', `${from}..${to}`, '--']);
      return r.ok ? r.out.split('\n').filter(Boolean) : [];
    },
    rebase: (onto) => {
      const r = gitSoft(worktree, [...GIT_ID, 'rebase', onto]);
      if (r.ok) return { ok: true, conflicts: [], detail: 'rebased cleanly' };
      const conflicts = gitSoft(worktree, ['diff', '--name-only', '--diff-filter=U']);
      // A failed rebase leaves the worktree mid-operation. Abort it: the
      // decision is "do not integrate", and leaving a half-rebased worktree
      // behind turns one refusal into a broken tree for everything after.
      gitSoft(worktree, ['rebase', '--abort']);
      return { ok: false, conflicts: conflicts.ok ? conflicts.out.split('\n').filter(Boolean) : [],
        detail: r.out.split('\n').slice(0, 3).join(' ') || 'rebase failed' };
    },
    diffAgainst: (base) => {
      const r = gitSoft(worktree, ['diff', '--stat', '-p', base, '--']);
      return r.ok ? r.out : '';
    },
  };
}

export interface MissionHostInput {
  engine: Engine;
  missionId: string;
  projectRoot: string;
  oracle: Oracle;
  /** The commands the ACCEPTED oracle authorises. Passed, never re-derived. */
  ledger: Set<string>;
  supervisor: ProcessSupervisor;
  judge?: Provider;
  /** Produces a fresh accepted plan. Wired by the CLI, absent in `--no-replan`. */
  replan?: (reason: string, detail: string) => Promise<PlanGraph | null>;
  onEvent?: (line: string) => void;
}

/**
 * Builds the host the loop runs against.
 *
 * Every method here answers by OBSERVING. None of them asks the implementer
 * what it did: the whole reason integration re-runs checks and re-reads the
 * filesystem is that a report of one's own work cannot be independent of it.
 */
export function missionHost(input: MissionHostInput): LoopHost {
  const { engine, missionId, projectRoot, oracle } = input;
  const say = input.onEvent ?? (() => {});
  const tasks = new Map<string, TaskRecord>();

  const greenOf = (): string => readRatchet(projectRoot, missionId)
    ?? (engine.task([...tasks.keys()][0] ?? '')?.baseSha ?? 'HEAD');

  /** The check outcomes a task actually recorded, newest wins. */
  const checksOf = (taskId: string): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const e of engine.logs(taskId, 1000)) {
      if (e.type !== 'CHECK_RESULT') continue;
      const p = e.payload as any;
      if (typeof p?.name === 'string' && typeof p?.outcome === 'string') out[p.name] = p.outcome;
    }
    return out;
  };

  let lastTaskId: string | null = null;

  return {
    createTask(node: TaskNode): string {
      const rec = engine.createTask(node.description, { missionId });
      tasks.set(rec.taskId, rec);
      return rec.taskId;
    },

    async runNode(taskId: string, node: TaskNode): Promise<NodeExecution> {
      say(`${node.nodeId} → ${taskId}`);
      let state: string;
      try { state = await engine.run(taskId); }
      catch (e: any) { state = 'FAILED'; say(`${taskId} threw: ${e?.message ?? e}`); }
      const rec = engine.task(taskId);
      if (rec) tasks.set(taskId, rec);
      lastTaskId = taskId;
      return {
        taskId, state,
        evidence: Object.entries(checksOf(taskId)).map(([n, o]) => `check:${n}:${o}`),
        detail: `task ${taskId} finished ${state}`,
      };
    },

    async integrate(exec, ctx) {
      const rec = engine.task(exec.taskId);
      if (!rec) return { integrated: false, sha: null, touched: [], detail: `task ${exec.taskId} is unknown` };
      const green = greenOf();

      // Commit whatever the node produced. An uncommitted worktree cannot be
      // rebased, and a node that produced nothing has not earned a commit.
      //
      // With the excludes, like every other place that asks what a task
      // changed. The info/exclude file is belt; this is braces, and it is the
      // one that matters: a bare `git add -A` here committed Zeus's own npm
      // cache as the node's work, and the following node's rebase conflicted
      // on it. Nothing under .zeus-cache/ or .zeus/ is ever the project's.
      gitSoft(rec.worktree, ['add', '-A', '--', ...ZEUS_PATHSPEC_EXCLUDES]);
      const staged = gitSoft(rec.worktree, ['diff', '--cached', '--name-only']);
      const committed = gitSoft(rec.worktree, ['log', '--format=%H', `${rec.baseSha}..HEAD`]);
      if (!(staged.ok && staged.out) && !(committed.ok && committed.out)) {
        return { integrated: false, sha: null, touched: [], detail: 'the node changed nothing' };
      }
      if (staged.ok && staged.out) {
        const c = gitSoft(rec.worktree, [...GIT_ID, 'commit', '-m',
          `${ctx.node.nodeId}: ${ctx.node.description}`.slice(0, 200)]);
        if (!c.ok) return { integrated: false, sha: null, touched: [], detail: `commit refused: ${c.out}` };
      }

      const decision = revalidateForIntegration({
        git: worktreeGit(rec.worktree, projectRoot),
        integrationRef: green,
        verifiedAgainst: rec.baseSha,
        originalTier: 'NORMAL' as Tier,
        adapterId: engine.opts.config.project.adapter,
        confidence: 'MEDIUM' as any,
        commands: engine.opts.config.commands as any,
      });
      if (decision.code === 'REVALIDATION_CONFLICT') {
        return { integrated: false, sha: null, touched: [],
          detail: `rebase onto the mission green conflicted: ${decision.conflicts.join(', ') || decision.detail}` };
      }

      const head = gitSoft(rec.worktree, ['rev-parse', 'HEAD']);
      if (!head.ok) return { integrated: false, sha: null, touched: [], detail: 'the worktree has no HEAD' };
      const touched = gitSoft(rec.worktree, ['diff', '--name-only', `${green}..HEAD`, '--']);
      return {
        integrated: true, sha: head.out,
        touched: touched.ok ? touched.out.split('\n').filter(Boolean) : [],
        detail: decision.escalated
          ? `integrated after escalating to ${decision.tier} (${decision.overlap.length} overlapping path(s))`
          : decision.detail,
      };
    },

    async evaluate(ctx) {
      const taskId = lastTaskId;
      const rec = taskId ? engine.task(taskId) : null;
      const worktree = rec?.worktree ?? projectRoot;
      const run = await evaluateCriteria({
        oracle, projectId: engine.projectId, worktree,
        supervisor: input.supervisor,
        policy: rec ? engine.policyFor(rec) : engine.policyFor({ worktree } as TaskRecord),
        judge: input.judge,
        scope: ctx.scope,
        ledger: input.ledger,
        touched: ctx.touched,
        baseSha: ctx.sha,
      });
      return { results: run.results.map((r) => ({
        criterionId: r.criterionId, outcome: r.outcome, evidence: r.evidence, detail: r.detail,
      })) };
    },

    async observe(node, ctx): Promise<ObservedEvidence> {
      const rec = lastTaskId ? engine.task(lastTaskId) : null;
      const root = rec?.worktree ?? projectRoot;
      const artifacts: Record<string, boolean> = {};
      for (const eff of node.predictedEffects ?? []) {
        if (eff.kind === 'expectedArtifact') {
          // Resolved inside the worktree and refused if it escapes: a
          // predicted path is model output, and model output is not allowed
          // to address the rest of the filesystem.
          const abs = path.resolve(root, eff.path);
          artifacts[eff.path] = abs.startsWith(path.resolve(root) + path.sep) && fs.existsSync(abs);
        }
      }
      return {
        checks: lastTaskId ? checksOf(lastTaskId) : {},
        artifacts,
        // State facts have no deterministic prober yet, so none are answered.
        // Left empty rather than defaulted: an unanswered prediction must
        // read as a mismatch, and a fabricated answer would read as a pass.
        facts: {},
      };
    },

    probe(): PreconditionProbe {
      const rec = lastTaskId ? engine.task(lastTaskId) : null;
      const root = rec?.worktree ?? projectRoot;
      const checks = lastTaskId ? checksOf(lastTaskId) : {};
      const outcomes = engine.events.read(missionId)
        .filter((e) => e.type === 'ORACLE_EVALUATED')
        .flatMap((e) => ((e.payload as any)?.results ?? []) as Array<any>)
        .reduce((acc: Record<string, string>, r: any) => {
          if (r?.criterionId) acc[String(r.criterionId)] = String(r.outcome ?? 'UNEVALUATED');
          return acc;
        }, {});
      return {
        fileExists: (p) => {
          const abs = path.resolve(root, p);
          return abs.startsWith(path.resolve(root) + path.sep) && fs.existsSync(abs);
        },
        checkOutcome: (name) => checks[name] ?? null,
        criterionState: (id) => outcomes[id] ?? 'UNEVALUATED',
      };
    },

    advanceRatchet(sha: string) {
      advanceRatchet(projectRoot, missionId, sha);
      say(`ratchet → ${sha.slice(0, 12)}`);
    },

    async replan(reason, detail) {
      if (!input.replan) return null;
      return input.replan(reason, detail);
    },

    now: () => Date.now(),
  };
}

/** The ledger, read from the accepted oracle rather than from the live one. */
export function ledgerFrom(oracle: Oracle): Set<string> {
  return acceptedCommands(oracle);
}
