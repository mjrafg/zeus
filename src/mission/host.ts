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
import { priorAttempt, repairBrief, type PriorAttempt } from './attempt';
import { PlanGraph, TaskNode } from './types';
import { advanceRatchet, readRatchet } from './ratchet';
import { checkWrites } from '../engine/writecheck';
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
/**
 * Whether git ignores a declared write path.
 *
 * `git check-ignore` is asked rather than .gitignore being parsed here: the
 * rules compose across the repo, the worktree and the user's global config,
 * and a second implementation of them would be wrong in exactly the cases
 * that matter. A glob is reduced to its literal prefix, because check-ignore
 * answers about paths and `app/node_modules/**` is a pattern.
 *
 * BOTH forms are asked. A rule written `node_modules/` matches directories
 * only, and check-ignore cannot tell that a path which does not exist yet is
 * one — so the bare form misses it and the trailing-slash form finds it. A
 * node that installs dependencies is asked about a directory that its own run
 * is what creates.
 */
function isIgnored(worktree: string, declared: string): boolean {
  const literal = String(declared).split(/[*?[]/)[0].replace(/\/+$/, '');
  if (!literal) return false;
  for (const form of [`${literal}/`, literal]) {
    if (gitSoft(worktree, ['check-ignore', '-q', '--', form]).ok) return true;
  }
  return false;
}


/**
 * The working tree that actually holds a given revision.
 *
 * THE RULE: A TREE HOLDS A REVISION IF ITS HEAD *IS* THAT REVISION. Verified,
 * never inferred from recency.
 *
 * Everything in this file used to answer "where is the mission's state?" with
 * `lastTaskId`'s worktree - the tree of whichever task ran most recently,
 * integrated or not. That is a guess that happens to be right on the green path
 * and is wrong on every other one. talkbridge/M-0034 showed the cheap version
 * of it (a precondition), and the expensive version is one step away: the FINAL
 * full evaluation runs when no node remains, which is exactly the state a
 * mission reaches after its last node was ABANDONED - so the criteria would
 * have been evaluated inside the refused worktree, and a mission whose only
 * task the reviewer blocked could report ACHIEVED off code it had rejected.
 *
 * Integration commits IN the worktree and advances the ratchet to that commit,
 * so the project root legitimately may not hold an integrated revision, and the
 * integrating worktree legitimately does. Asking each candidate what its HEAD
 * is settles it without knowing which case we are in.
 *
 * NULL IS AN ANSWER. When no tree holds the revision - a pruned worktree, a
 * mission resumed in a process that never created one - the mission's state is
 * not materialised anywhere, and the honest result is UNEVALUATED rather than a
 * verdict read out of whatever directory was nearest.
 */
export function treeAtRevision(candidates: string[], sha: string | null): string | null {
  if (!sha) return null;
  for (const dir of candidates) {
    if (!dir) continue;
    let head: string;
    try { head = fs.existsSync(dir) ? gitSoft(dir, ['rev-parse', 'HEAD']).out.trim() : ''; }
    catch { continue; }
    if (!head || head !== sha) continue;
    // A MATCHING HEAD IS NOT ENOUGH, and this is the half that actually
    // catches M-0034. A task that never integrated never committed, so its
    // worktree HEAD is still the revision it BRANCHED from - the green - while
    // its working tree holds the change the mission refused. By HEAD alone
    // that tree looks exactly like the green, and evaluating in it would prove
    // criteria against rejected code.
    //
    // FAIL CLOSED on an uninspectable tree, for the reason every other check
    // in this codebase does: "could not look" is not "looked and it was fine".
    const w = checkWrites(dir);
    if (!w.inspected || !w.clean) continue;
    return dir;
  }
  return null;
}

export function missionHost(input: MissionHostInput): LoopHost {
  const { engine, missionId, projectRoot, oracle } = input;
  const say = input.onEvent ?? (() => {});
  const tasks = new Map<string, TaskRecord>();

  const greenOf = (): string => readRatchet(projectRoot, missionId)
    ?? (engine.task([...tasks.keys()][0] ?? '')?.baseSha ?? 'HEAD');

  /**
   * Every tree that could hold a revision, project root first.
   *
   * Order is a search order, not a preference: `treeAtRevision` accepts a
   * candidate only when its HEAD matches, so a wrong candidate cannot win by
   * being early.
   */
  const treeCandidates = (): string[] => [projectRoot,
    ...[...tasks.values()].map((t) => t.worktree).filter(Boolean)];

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
    createTask(node: TaskNode, opts: { repair?: boolean; prior?: PriorAttempt | null } = {}): string {
      // A repair used to receive the node description byte-for-byte, so the
      // second attempt re-derived its design from the same words that produced
      // the first one — with no way to know which claims a reviewer had
      // already refused. The findings that refused it travel with it now.
      const description = opts.prior
        ? `${node.description}\n${repairBrief(opts.prior)}`
        : node.description;
      const rec = engine.createTask(description,
        { missionId, ...(opts.repair ? { repair: true } : {}) });
      tasks.set(rec.taskId, rec);
      return rec.taskId;
    },

    priorAttempt(taskId: string, reason: string): PriorAttempt | null {
      return priorAttempt(engine, taskId, reason);
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
        // AN EMPTY DIFF IS NOT ALWAYS AN EMPTY NODE.
        //
        // A node whose declared writes are all git-ignored does its work
        // outside the working tree — installing dependencies, warming a cache,
        // proving a check. It produces no commit BY DESIGN, and the plan said
        // so: `writes: ['api/node_modules/**', 'app/node_modules/**']`.
        //
        // Demanding a diff from one killed a mission. install-workspaces ran
        // correctly, twice, and both times was called "the node changed
        // nothing", refused, repaired into the identical result, and escalated
        // NODE_UNREPAIRABLE — while the install it had just performed was busy
        // proving three of the mission's criteria.
        const declared = (ctx.node.writes ?? []).filter((w) => String(w).trim());
        const effectOnly = declared.length > 0 && declared.every((w) => isIgnored(rec.worktree, w));
        if (effectOnly) {
          return {
            integrated: true, sha: green, touched: [],
            detail: 'nothing to integrate: every path this node declared is git-ignored, '
              + 'so its effect is outside the tree and its criteria are what prove it',
          };
        }
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
      // AGAINST THE REVISION THE CALLER NAMED. `ctx.sha` is already the right
      // answer at both call sites - the green for the final full pass, the
      // just-integrated commit for the incremental one - and it was being
      // ignored in favour of whichever task ran last.
      const worktree = treeAtRevision(treeCandidates(), ctx.sha);
      if (!worktree) {
        // Not a failure of the criteria. Nothing could be evaluated, so
        // nothing is claimed: UNEVALUATED is the outcome that exists for
        // exactly this, and reporting PROVEN or FAILED here would be inventing
        // a verdict about a tree nobody could read.
        return { results: oracle.criteria.map((c) => ({
          criterionId: c.criterionId, outcome: 'UNEVALUATED' as const,
          evidence: [], detail: `no working tree holds ${String(ctx.sha).slice(0, 12)}, `
            + 'so the mission\'s integrated state could not be evaluated' })) };
      }
      const rec = lastTaskId ? engine.task(lastTaskId) : null;
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
      // A PREDICTED ARTIFACT IS A CLAIM ABOUT THE INTEGRATED CHANGE, so it is
      // checked in the tree that holds the revision that was integrated - not
      // in whichever tree happens to be most recent.
      const root = treeAtRevision(treeCandidates(), ctx.sha);
      const artifacts: Record<string, boolean> = {};
      if (!root) {
        // An unanswered prediction must read as a mismatch, never as a pass.
        return { checks: lastTaskId ? checksOf(lastTaskId) : {}, artifacts, facts: {} };
      }
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
      // AGAINST THE MISSION'S INTEGRATED STATE, not against a working tree.
      //
      // This read `lastTaskId`'s WORKTREE, and after a task that did NOT
      // integrate that worktree holds work the mission rejected. M-0034's
      // N-0001 was blocked by its reviewer; its worktree still contained the
      // app/src/i18n.jsx it had written; the next precondition check asked
      // "does app/src/i18n.jsx exist?", got yes from the abandoned worktree,
      // and declared PRECONDITION_DIVERGENCE. The plan was invalidated and the
      // mission terminated - instead of spending the repair it was entitled to.
      //
      // The green sha IS the mission's state: integration commits in the
      // worktree and advances the ratchet to that commit, so the project root
      // may legitimately not contain an integrated file. Asking git about the
      // ratchet answers the actual question, and answers it identically
      // whether or not a task happens to have run.
      const green = greenOf();
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
          // Traversal is refused before git is asked, exactly as it was when
          // this resolved against a directory: a precondition may only ask
          // about paths inside the repository it is a precondition for.
          const abs = path.resolve(projectRoot, p);
          if (!abs.startsWith(path.resolve(projectRoot) + path.sep)) return false;
          const rel = path.relative(path.resolve(projectRoot), abs);
          // `cat-file -e <sha>:<path>` exits non-zero when the path is not in
          // that tree. No checkout, no working tree, no leftovers from a task
          // whose work was refused.
          const seen = gitSoft(projectRoot, ['cat-file', '-e', `${green}:${rel}`]);
          if (seen.ok) return true;
          // BEFORE THE FIRST INTEGRATION there is no green to ask, and the
          // project root is the mission's state. Falling back to it keeps the
          // baseline preconditions answerable on a fresh mission.
          return green === 'HEAD' ? fs.existsSync(abs) : false;
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
