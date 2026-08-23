/**
 * The portable task lifecycle.
 *
 *   NEW → DESIGN → IMPLEMENT → VERIFY → REVIEW → FINAL_ACCEPTANCE → terminal
 *
 * Everything project-specific arrives through the config and the adapter; there
 * is no repository layout, test command or path baked in here. Every execution
 * goes through the supervisor, and every transition is an event in the
 * hash-chained log, so a crash is recoverable and a claim is checkable.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { EventStore, sha256, StoredEvent } from './events';
import { ProjectLock } from './lock';
import { ProcessSupervisor, ExecutionResult, killRecorded } from './exec';
import { ExecutionPolicy, defaultPolicy } from './policy';
import { prepareDependencies, depsCacheRoot, PrepMethod } from './dependencies';
import { readOnlyGit } from './gitro';
import { isMissionId, requireScope, ScopeMismatchError } from '../mission/types';
import { Provider, AgentResponse, Role } from './providers';
import { ProjectConfig, readUserDefaults } from '../config';
import { PipelineStage, ResolvedRoute, resolveRouting } from '../routing';
import { adapterById } from '../adapters';
import { TaskBudgets, mergeBudgets, usageFrom, checkBudgets } from './taskbudget';
import { buildReviewPayload, DEFAULT_REVIEW_POLICY, ReviewContextPolicy, ReviewInput, reconcileReviewerReport } from './reviewcontext';
import { parseDiff } from '../validation/diff';
import {
  resolveTier, impactConfidence, TierDecision, HardeningSettings, DEFAULT_HARDENING, Tier,
} from '../validation/tier';
import {
  designContract, inspectIntegrity, evidenceCoupledFiles, accountForTests, IntegrityReport,
} from '../validation/integrity';
import {
  evaluateExpansion, applyExpansion, unproductiveExpansion, ExpansionRequest, ExpansionState,
} from '../validation/expansion';
import { escalation, EscalationReason, EvidenceRef, NeededInput, renderEscalation } from '../validation/escalation';
import { SpanRecorder, NO_SPANS } from '../telemetry/spans';
import { classifyAll, Classification } from '../validation/testclass';
import { parseConstraints, ConstraintSet, diffViolations } from '../validation/constraints';
import { selectChecks, SelectionLedger, approvalKey, SelectedCheck, DEFAULT_COST_RATIO } from '../validation/selection';

export type TaskState =
  | 'NEW' | 'DESIGN' | 'IMPLEMENT' | 'VERIFY' | 'REVIEW' | 'FINAL_ACCEPTANCE'
  | 'COMPLETED' | 'BLOCKED' | 'CANCELLED' | 'FAILED' | 'NEEDS_RECONCILIATION'
  | 'AWAITING_HUMAN';

export const TERMINAL: TaskState[] = ['COMPLETED', 'BLOCKED', 'CANCELLED', 'FAILED', 'NEEDS_RECONCILIATION', 'AWAITING_HUMAN'];

/**
 * A globally unambiguous task id.
 *
 * Per-project sequences give every project a `T-0001`, which is fine on disk
 * (state roots are separate) and confusing everywhere else: logs, a shared run
 * registry and any future multi-project view cannot tell them apart. The id
 * therefore carries the project's stable identifier, while the short local
 * label stays available for humans.
 */
export function makeTaskId(projectId: string, seq: number): string {
  return `${projectId}/T-${String(seq).padStart(4, '0')}`;
}
export function localLabel(taskId: string): string {
  return taskId.includes('/') ? taskId.slice(taskId.lastIndexOf('/') + 1) : taskId;
}
/** Filesystem-safe form, since task ids become directory names. */
export function taskIdToDir(taskId: string): string {
  return taskId.replace(/[^A-Za-z0-9_.-]/g, '~');
}

/** Why a required check did not produce a verdict. Kept distinct on purpose. */
export type CheckOutcome =
  | 'PASSED' | 'TEST_FAILED' | 'TEST_TIMEOUT'
  | 'RESOURCE_LIMIT_EXCEEDED' | 'REQUIRED_TEST_NOT_RUN' | 'INFRASTRUCTURE_FAILURE';

export interface TaskRecord {
  taskId: string;
  description: string;
  state: TaskState;
  phase: string;
  createdAt: string;
  updatedAt: string;
  worktree: string;
  baseSha: string;
  cancelRequested: boolean;
  /**
   * Whether this task is a retry of a node that already failed.
   *
   * Carried on the record so the engine can route it to the `repair` stage
   * without reading the mission log — the caller that decided to repair is the
   * one that knows, and asking a lower layer to infer it from a higher layer's
   * events would be the wrong direction.
   */
  repair?: boolean;
}

export interface EngineOptions {
  projectRoot: string;
  config: ProjectConfig;
  supervisor: ProcessSupervisor;
  providers: { planner: Provider; implementer: Provider; reviewer: Provider };
  /** Overrides the state root; defaults to config.paths.state under the project. */
  stateRoot?: string;
  /** Task-level ceilings. Recomputed from the log, so restarts cannot reset them. */
  taskBudgets?: Partial<TaskBudgets>;
  reviewPolicy?: ReviewContextPolicy;
  /**
   * Latency instrumentation. Absent by default, and the null recorder costs
   * nothing, so an unmeasured run executes exactly the code it always did.
   */
  spans?: SpanRecorder;
}

/** Maps a supervisor result onto the check vocabulary the product reasons in. */
/**
 * Zeus's own artifacts inside a task worktree.
 *
 * Named once. These are Zeus scratch, not the project's work, and every place
 * that reads "what did this task change" must agree about them — a diff that
 * excludes them and a status that does not would disagree about whether a task
 * did anything.
 */
export const ZEUS_WORKTREE_EXCLUDES = ['/.zeus-cache/', '/.zeus/'];

export const ZEUS_PATHSPEC_EXCLUDES = [':(exclude).zeus-cache/**', ':(exclude).zeus/**'];

export function isZeusArtifact(p: string): boolean {
  const clean = p.replace(/^\.\//, '').replace(/^"|"$/g, '');
  return clean === '.zeus-cache' || clean === '.zeus'
    || clean.startsWith('.zeus-cache/') || clean.startsWith('.zeus/');
}

export function classifyCheck(res: ExecutionResult, required: boolean): CheckOutcome {
  switch (res.outcome) {
    case 'COMPLETED': return 'PASSED';
    case 'FAILED': return 'TEST_FAILED';
    case 'TIMEOUT': return 'TEST_TIMEOUT';
    case 'RESOURCE_LIMIT_EXCEEDED': return 'RESOURCE_LIMIT_EXCEEDED';
    case 'POLICY_DENIED': return required ? 'REQUIRED_TEST_NOT_RUN' : 'INFRASTRUCTURE_FAILURE';
    case 'CANCELLED': return 'REQUIRED_TEST_NOT_RUN';
    default: return 'INFRASTRUCTURE_FAILURE';
  }
}

/**
 * Re-exported so existing callers keep one import site.
 *
 * The guarantee itself no longer lives here: `EventStore.append()` redacts
 * every payload before hashing it, so nothing in this file has to remember to.
 * See `src/engine/redact.ts` for why that move happened.
 */
export { redactSecrets } from './redact';

/** Only a real verdict about the code may let acceptance continue. */
export function checkAllowsAcceptance(o: CheckOutcome): boolean { return o === 'PASSED'; }

export class Engine {
  readonly events: EventStore;
  readonly lock: ProjectLock;
  readonly stateRoot: string;
  readonly projectId: string;

  /**
   * The routing table this engine is operating under.
   *
   * Resolved ONCE, at construction, from project over global over the Zeus
   * default. Resolving per call would mean an edit to a config file halfway
   * through a mission silently changing which model wrote the second half of
   * it, and no way afterwards to say which half was which.
   */
  readonly routing: ResolvedRoute[];

  routeFor(stage: PipelineStage): ResolvedRoute {
    return this.routing.find((r) => r.stage === stage)!;
  }

  constructor(readonly opts: EngineOptions) {
    this.stateRoot = opts.stateRoot
      ?? path.resolve(opts.projectRoot, opts.config.paths?.state ?? '.zeus/state');
    this.projectId = opts.config.project?.name ?? path.basename(opts.projectRoot);
    this.routing = resolveRouting({
      project: opts.config.routing ?? null,
      global: readUserDefaults()?.routing ?? null,
    });
    this.events = new EventStore(this.stateRoot);
    this.lock = new ProjectLock(this.stateRoot, this.projectId);
    this.taskBudgets = mergeBudgets(opts.taskBudgets);
    this.reviewPolicy = opts.reviewPolicy ?? DEFAULT_REVIEW_POLICY;
    this.spans = opts.spans ?? NO_SPANS;
  }

  /**
   * Enforces the task ceilings. A breach stops the task with the numbers on
   * the record; it never silently continues, and never pretends the work
   * finished.
   */
  private budgetBreach(taskId: string): TaskState | null {
    const usage = this.spans.sync('state.budget-recompute', 'PERSISTENCE',
      () => usageFrom(this.events.read(taskId)));
    const breach = checkBudgets(this.taskBudgets, usage);
    if (!breach) return null;
    this.record({ taskId, type: 'TASK_BUDGET_EXCEEDED', payload: {
      budget: breach.budget, limit: breach.limit, observed: breach.observed,
      detail: breach.detail, usage,
    } });
    // A budget stop is a decision for a person: the work is unfinished, but
    // nothing is wrong with the code. Say exactly that, and exactly what
    // choice is being asked for.
    return this.escalateToHuman(taskId, 'AWAITING_HUMAN', 'budget', {
      reasonCode: 'TASK_BUDGET_EXCEEDED',
      blocked: `this task reached its ${breach.detail} ceiling (${breach.budget} limit ${breach.limit}, observed ${breach.observed}) and stopped before spending more`,
      tried: [
        `${usage.agentInvocations} agent invocation(s) across ${usage.designAttempts} design attempt(s)`,
        `${usage.reviewCycles} review cycle(s), ${usage.repairCycles} repair cycle(s)`,
        `${Math.round(usage.providerWallClockMs / 1000)}s inside provider calls, ${Math.round(usage.activeExecutionMs / 1000)}s of active execution`,
      ],
      evidence: [
        { kind: 'event', id: 'TASK_BUDGET_EXCEEDED', detail: `${breach.budget}: ${breach.observed} > ${breach.limit}` },
        { kind: 'event', id: 'CHECK_RESULT', detail: 'every check this task ran, with timings' },
      ],
      needed: {
        kind: 'decision',
        description: `decide whether to raise ${breach.budget} for this task, split the work, or abandon it`,
        how: `raise it in .zeus/config.yaml, or re-run the task with a narrower scope`,
      },
      resumeBehavior: 'raising the ceiling and re-running continues from the recorded state; nothing is repeated that already succeeded',
    });
  }

  /** Ownership must be taken before any state is written. */
  acquire(): { ok: boolean; reason?: string } {
    const r = this.lock.acquire();
    return r.ok ? { ok: true } : { ok: false, reason: r.reason };
  }
  release(): void { this.lock.release(); }

  readonly taskBudgets: TaskBudgets;
  readonly reviewPolicy: ReviewContextPolicy;
  readonly spans: SpanRecorder;

  /**
   * Checks approved by the selection path, keyed by name+command.
   *
   * `runCheck` refuses anything absent from this set. That is what makes "one
   * selection path" structural: a future phase that reaches for a command
   * directly does not get to run it, it gets a recorded refusal.
   */
  private approved = new Set<string>();

  /**
   * Adopts a selection ledger as the set of checks that may run.
   *
   * The orchestrator calls this after every selection. It exists as a method
   * rather than an inline assignment so that the approval step is a named,
   * auditable transition — and so anything driving the engine goes through the
   * same door rather than reaching past it.
   */
  applySelection(ledger: SelectionLedger, mode: 'replace' | 'extend' = 'replace'): void {
    if (mode === 'replace') this.approved = new Set();
    for (const c of ledger.selected) this.approved.add(approvalKey(c.name, c.command));
  }

  /**
   * The hardening profile in force.
   *
   * Read from config for the tunable parts; the anti-gaming rules are set here
   * regardless of what the file says, because they are what make an unattended
   * result believable rather than a preference about strictness.
   */
  hardening(): HardeningSettings {
    const h = (this.opts.config as any)?.validation?.hardening ?? {};
    const floor = String(h.genericAdapterFloor ?? 'normal').toUpperCase();
    return {
      ...DEFAULT_HARDENING,
      mixedDiffMaxTier: true,
      testSurfaceRisk: true,
      unknownPlusRiskDirectDeep: h.unknownPlusRiskDirectDeep !== false,
      genericAdapterFloor: (['NORMAL', 'DEEP'].includes(floor) ? floor : 'NORMAL') as Tier,
      reviewerExpansionBudget: Number.isInteger(h.reviewerExpansionBudget)
        ? Number(h.reviewerExpansionBudget) : DEFAULT_HARDENING.reviewerExpansionBudget,
    };
  }

  /**
   * Sends a task to a human WITH everything needed to resolve it in minutes.
   *
   * An incomplete payload is recorded as a defect in Zeus rather than shipped
   * as a message: "task needs attention" costs more of a person's day than the
   * problem usually does.
   */
  private escalateToHuman(taskId: string, to: TaskState, phase: string, spec: {
    reasonCode: EscalationReason; blocked: string; tried: string[];
    evidence: EvidenceRef[]; needed: NeededInput; resumeBehavior: string;
  }): TaskState {
    const { payload, problems } = escalation({ taskId, ...spec });
    this.record({ taskId, type: 'ESCALATION', payload: { ...payload, problems, rendered: renderEscalation(payload) } });
    if (problems.length) {
      this.record({ taskId, type: 'ESCALATION_INCOMPLETE', payload: {
        problems, detail: 'this escalation would have cost a human more time than it should',
      } });
    }
    this.setState(taskId, to, phase, { reason: `${payload.reasonCode}: ${payload.blocked}`, reasonCode: payload.reasonCode });
    return to;
  }

  nextTaskId(): string {
    const seqs = this.events.listTasks()
      .map((t) => /T-(\d+)$/.exec(t)?.[1]).filter(Boolean).map(Number);
    const n = seqs.length ? Math.max(...seqs) + 1 : 1;
    return makeTaskId(this.projectId, n);
  }

  /**
   * Reads the project's HEAD. Inspection, so it goes through the read-only
   * boundary — the project repository is not this engine's to modify; only the
   * task worktree is.
   */
  private gitSha(): string {
    try { return readOnlyGit(this.opts.projectRoot, { timeoutMs: 15_000 })(['rev-parse', 'HEAD']); }
    catch { return 'unknown'; }
  }

  /**
   * Creates a task.
   *
   * `missionId` is present ONLY for a task a mission spawned. A standalone
   * task's TASK_CREATED payload is byte-for-byte what it always was — this
   * stage adds a field to missions' tasks, not to everyone's.
   */
  createTask(description: string,
    opts: { missionId?: string; repair?: boolean } = {}): TaskRecord {
    const taskId = this.nextTaskId();
    const worktree = path.resolve(this.opts.projectRoot,
      this.opts.config.paths?.worktrees ?? '.zeus/worktrees', taskIdToDir(taskId));
    const rec: TaskRecord = {
      taskId, description, state: 'NEW', phase: 'new',
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      worktree, baseSha: this.gitSha(), cancelRequested: false,
      ...(opts.repair ? { repair: true } : {}),
    };
    if (opts.missionId) requireScope('MISSION', opts.missionId);
    this.record({ taskId, type: 'TASK_CREATED', payload: {
      description, worktree, baseSha: rec.baseSha, projectId: this.projectId,
      adapter: this.opts.config.project?.adapter,
      ...(opts.missionId ? { missionId: opts.missionId } : {}),
      ...(opts.repair ? { repair: true } : {}),
    } });
    return rec;
  }

  /** The task's current record, derived from its log. Never stored twice. */
  task(taskId: string): TaskRecord | null {
    // A mission id is not a task id, and the two are strings of the same
    // shape. Returning null here would be indistinguishable from "no such
    // task" and would let a caller quietly operate on the wrong domain
    // object; the failure a caller needs is the loud one.
    if (isMissionId(taskId)) throw new ScopeMismatchError('TASK', taskId);
    const evs = this.spans.sync('state.read-log', 'PERSISTENCE', () => this.events.read(taskId));
    if (!evs.length) return null;
    const created = evs.find((e) => e.type === 'TASK_CREATED');
    if (!created) return null;
    const p = created.payload as any;
    let state: TaskState = 'NEW';
    let phase = 'new';
    let cancelRequested = false;
    for (const e of evs) {
      if (e.type === 'STATE_CHANGED') { state = (e.payload as any).to; phase = (e.payload as any).phase ?? phase; }
      if (e.type === 'CANCEL_REQUESTED') cancelRequested = true;
    }
    return {
      taskId, description: String(p.description ?? ''), state, phase,
      createdAt: created.ts, updatedAt: evs[evs.length - 1].ts,
      worktree: String(p.worktree), baseSha: String(p.baseSha), cancelRequested,
    };
  }

  private setState(taskId: string, to: TaskState, phase: string, extra: Record<string, unknown> = {}): void {
    const cur = this.task(taskId);
    // Cancellation is absorbing: nothing may advance a cancelled task.
    if (cur?.cancelRequested && to !== 'CANCELLED') {
      this.record({ taskId, type: 'NOTE', payload: { refusedAfterCancel: `${cur.state} -> ${to}` } });
      return;
    }
    this.record({ taskId, type: 'STATE_CHANGED', payload: { from: cur?.state ?? 'NEW', to, phase, ...extra } });
  }

  policyFor(rec: TaskRecord): ExecutionPolicy {
    const p = defaultPolicy(this.opts.projectRoot, rec.worktree);
    // The state directory must stay writable so evidence survives even when
    // the worktree is confined.
    return { ...p, writablePaths: [rec.worktree, this.stateRoot] };
  }

  /**
   * Keeps Zeus's own scratch out of the project's change surface.
   *
   * The dependency cache is materialised INSIDE the worktree, so git sees it
   * as the agent's work. The first live mission made the consequence plain:
   * a task that changed nothing reported 43 changed files, all of them cache
   * blobs, and the validator classified binary cache objects as hunks of
   * unknown surface — which forced a heavier tier and, worse, hid the fact
   * that the agent had produced no change at all.
   */
  private excludeZeusArtifacts(worktree: string): void {
    try {
      const cp = require('child_process');
      // --git-common-dir, NOT --git-dir.
      //
      // In a linked worktree — which is the only kind Zeus makes — --git-dir
      // is that worktree's private metadata directory, and git does not read
      // info/exclude from it. It reads $GIT_COMMON_DIR/info/exclude. So this
      // wrote a correct exclude file to a path nothing consults, and every
      // task worktree saw .zeus-cache/ as untracked project work: `git add -A`
      // staged an npm cache, and the next node's rebase conflicted on several
      // hundred cache index files. The comment was right that the path has to
      // be asked for; it asked the wrong question.
      const gitDir = cp.execFileSync('git', ['-C', worktree, 'rev-parse', '--git-common-dir'],
        { encoding: 'utf8', timeout: 30_000 }).trim();
      const abs = path.isAbsolute(gitDir) ? gitDir : path.join(worktree, gitDir);
      const info = path.join(abs, 'info');
      fs.mkdirSync(info, { recursive: true });
      const file = path.join(info, 'exclude');
      const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
      if (existing.includes(ZEUS_WORKTREE_EXCLUDES[0])) return;
      fs.writeFileSync(file, `${existing}${existing.endsWith('\n') || !existing ? '' : '\n'}`
        + `# Zeus scratch, never the project's work\n${ZEUS_WORKTREE_EXCLUDES.join('\n')}\n`, 'utf8');
    } catch { /* an un-excludable worktree still works; the diff is just noisier */ }
  }

  /** Creates the task's isolated worktree from the project's git repository. */
  private prepareWorktree(rec: TaskRecord): { ok: boolean; detail: string } {
    const { execFileSync } = require('child_process');
    try {
      fs.mkdirSync(path.dirname(rec.worktree), { recursive: true });
      if (fs.existsSync(rec.worktree)) return { ok: true, detail: 'worktree already present' };
      execFileSync('git', ['-C', this.opts.projectRoot, 'worktree', 'add', '--detach', rec.worktree, rec.baseSha],
        { encoding: 'utf8', timeout: 300_000 });
      this.excludeZeusArtifacts(rec.worktree);
      return { ok: true, detail: 'worktree created' };
    } catch (e: any) {
      // A repository with no commits cannot produce a worktree; copy instead so
      // a brand-new project still works.
      try {
        fs.mkdirSync(rec.worktree, { recursive: true });
        // Deliberately NOT a plain `cp -a .`: that clones .git (so the agent's
        // commits would land in a copy nobody reads), duplicates node_modules,
        // and copies untracked local files such as .env into a directory the
        // agent controls.
        execFileSync('sh', ['-c',
          `cd "${this.opts.projectRoot}" && tar -cf - --exclude=.git --exclude=node_modules --exclude=.zeus . `
          + `| tar -xf - -C "${rec.worktree}" 2>/dev/null || true`], { timeout: 300_000 });
        fs.rmSync(path.join(rec.worktree, '.zeus'), { recursive: true, force: true });
        return { ok: true, detail: 'worktree copied (repository has no commit to check out)' };
      } catch (e2: any) {
        return { ok: false, detail: `cannot create worktree: ${e?.message ?? e} / ${e2?.message ?? e2}` };
      }
    }
  }

  private async agent(role: Role, rec: TaskRecord, prompt: string, readOnly: boolean,
    stage?: PipelineStage): Promise<AgentResponse> {
    const provider = role === 'planner' ? this.opts.providers.planner
      : role === 'implementer' ? this.opts.providers.implementer : this.opts.providers.reviewer;
    // A stage is more specific than a role and is used when the caller knows
    // one: `repair` and `implementer` are both implementers, and an operator
    // may want a cheaper model for the retry than for the first attempt.
    const route = this.routeFor(stage ?? (role === 'planner' ? 'planner'
      : role === 'implementer' ? (rec.repair ? 'repair' : 'implementer') : 'reviewer'));
    // ONE TRACE RECORD PER INVOCATION, opened BEFORE the provider is called.
    //
    // A task is not one model interaction: a single task calls a designer, an
    // implementer and a reviewer, and a mission calls many more. Correlating
    // them afterwards from timestamps is guesswork, so the id is minted here
    // and written down with everything known at call time.
    //
    // Written first because of what happened to M-0012: the runner was killed
    // four minutes into a call, and the log had an AGENT_STARTED and nothing
    // else. If the host dies mid-call we still know exactly what was in flight,
    // under which routing, asking which model.
    const traceCallId = `TC-${sha256(`${rec.taskId}:${route.stage}:${Date.now()}:${prompt.length}`).slice(0, 20)}`;
    this.record({ taskId: rec.taskId, type: 'MODEL_CALL_STARTED', payload: {
      traceCallId,
      stage: route.stage, role, provider: provider.id, readOnly,
      // What Zeus ASKED FOR. What actually answered is read from the stream and
      // recorded on MODEL_CALL_FINISHED; the two are never folded into one field.
      configuredModel: route.model,
      configuredReasoning: route.reasoning,
      reasoningSource: route.source.reasoning,
      modelSource: route.source.model,
      promptHash: `sha256:${sha256(prompt).slice(0, 32)}`,
      promptBytes: prompt.length,
      // The policy that applied WHEN THIS CALL BEGAN. Changing a project's
      // routing halfway through a mission must not rewrite what an earlier
      // call ran under.
      policySnapshot: { projectId: this.projectId, baseSha: rec.baseSha },
      pid: process.pid,
      startedAt: new Date().toISOString(),
    } });
    this.record({ taskId: rec.taskId, type: 'AGENT_STARTED', payload: {
      role, provider: provider.id, readOnly,
      stage: route.stage, traceCallId,
      configuredModel: route.model, configuredReasoning: route.reasoning,
      reasoningSource: route.source.reasoning,
    } });
    // The provider span covers the whole invocation; the process instants the
    // supervisor captured are then attached as children, so queue wait, spawn
    // cost and generation are separable rather than one opaque number.
    // The reviewer's model time is REVIEW, not PROVIDER: the buckets describe
    // what the time was spent ON, and a task blocked on its reviewer is blocked
    // on review whichever process happens to be running.
    const providerBucket = role === 'reviewer' ? 'REVIEW' : 'PROVIDER';
    const invokeId = this.spans.start(`provider.invoke.${role}`, providerBucket, { role, provider: provider.id });
    const res = await provider.invoke({
      role, taskId: rec.taskId, projectId: this.projectId, prompt,
      policy: this.policyFor(rec), readOnly,
      model: route.model, reasoning: route.reasoning, stage: route.stage,
    }, this.opts.supervisor);
    this.spans.end(invokeId, { outcome: String(res.outcome), promptBytes: prompt.length });
    const pt = (res as any).timing;
    if (pt) {
      const req = BigInt(pt.requestedNs); const sp = BigInt(pt.spawnedNs); const ex = BigInt(pt.exitedNs);
      const fo = pt.firstOutputNs ? BigInt(pt.firstOutputNs) : null;
      this.spans.externalUnder(invokeId, `provider.queue+spawn.${role}`, 'IDLE', req, sp, { role });
      if (fo) {
        this.spans.externalUnder(invokeId, `provider.startup.${role}`, providerBucket, sp, fo, { role });
        this.spans.externalUnder(invokeId, `provider.generation.${role}`, providerBucket, fo, ex, { role });
      } else {
        this.spans.externalUnder(invokeId, `provider.process.${role}`, providerBucket, sp, ex, { role, noOutput: true });
      }
    }
    this.record({ taskId: rec.taskId, type: res.ok ? 'AGENT_FINISHED' : 'AGENT_FAILED', payload: {
      role, provider: provider.id, outcome: res.outcome, exitCode: res.exitCode,
      durationMs: res.durationMs, infrastructureFailure: res.infrastructureFailure,
      structuredKeys: res.structured ? Object.keys(res.structured) : [],
      // Values, not just key names: a list of field names is not a diagnosis.
      diagnostics: res.diagnostics ?? {},
      // Provider-REPORTED cost and tokens. Recorded because mission budgeting
      // will consume them, and because a number Zeus computed itself would be
      // a guess that later got spent against.
      ...(res.providerUsage ? { providerUsage: res.providerUsage } : {}),
      ...(res.rateLimit ? { rateLimit: res.rateLimit } : {}),
      // WHAT ANSWERED, beside what was asked for.
      //
      // The provider reports the model that actually handled the call, the
      // session, the tools it used and its own timing — all of it arriving on
      // every call and dropped at the door until now. Kept apart from
      // configuredModel so a provider alias, router or fallback resolving to
      // something else is visible as a discrepancy rather than erased.
      ...(res.identity ? { identity: res.identity } : {}),
      ...(res.identity?.model && route.model && res.identity.model !== route.model
        ? { modelDiscrepancy: { configured: route.model, actual: res.identity.model } }
        : {}),
      traceCallId,
    } });
    // Closes the trace record. Its ABSENCE, with a dead pid, is what tells a
    // later reader the call was abandoned rather than merely slow.
    this.record({ taskId: rec.taskId, type: 'MODEL_CALL_FINISHED', payload: {
      traceCallId, stage: route.stage, role, provider: provider.id,
      outcome: res.outcome,
      configuredModel: route.model, configuredReasoning: route.reasoning,
      actualModel: res.identity?.model ?? null,
      ...(res.identity?.model && route.model && res.identity.model !== route.model
        ? { modelDiscrepancy: { configured: route.model, actual: res.identity.model } }
        : {}),
      parsed: {
        ok: res.structured !== null,
        structuredKeys: res.structured ? Object.keys(res.structured) : [],
      },
      infrastructureFailure: res.infrastructureFailure,
      wallMs: res.durationMs,
      ...(res.identity ? { providerTiming: {
        ttftMs: res.identity.ttftMs ?? null,
        timeToRequestMs: res.identity.timeToRequestMs ?? null,
        durationApiMs: res.identity.durationApiMs ?? null,
      } } : {}),
      ...(res.providerUsage ? { usage: res.providerUsage } : {}),
      ...(res.identity?.toolsUsed ? { toolsUsed: res.identity.toolsUsed } : {}),
      finishedAt: new Date().toISOString(),
    } });
    return res;
  }

  /** Every state write goes through here, so PERSISTENCE is measured at source. */
  private record(input: Parameters<EventStore['append']>[0]): void {
    this.spans.sync('event.append', 'PERSISTENCE', () => this.events.append(input), { type: String(input.type) });
  }

  /** Runs one project command through the supervisor and classifies it. */
  async runCheck(rec: TaskRecord, name: string, commandLine: string, required: boolean,
    cls: 'light' | 'heavy' = 'light'): Promise<{ outcome: CheckOutcome; res: ExecutionResult }> {
    // Off-ledger execution is refused here rather than trusted not to happen.
    if (!this.approved.has(approvalKey(name, commandLine))) {
      this.record({ taskId: rec.taskId, type: 'CHECK_REFUSED', payload: {
        name, command: commandLine, required,
        code: 'NOT_IN_SELECTION',
        detail: 'this check was not approved by the validation selection path; '
          + 'every phase selects through selectChecks() and nothing runs off-plan',
      } });
      return { outcome: 'REQUIRED_TEST_NOT_RUN' as CheckOutcome, res: {
        id: name, outcome: 'POLICY_DENIED', exitCode: null, signal: null, stdout: '',
        queueWaitMs: 0, durationMs: 0, pid: null, pgid: null,
        backend: 'process-group', isolationFallback: false, enforced: [], violations: [],
        productSignal: false,
        budgets: { memoryMaxMb: 0, cpuQuotaPercent: 0, maxProcesses: 0, testWorkers: 0 },
      } as unknown as ExecutionResult };
    }
    const [cmd, ...args] = commandLine.split(/\s+/);
    const checkId = this.spans.start('check.' + name, 'VALIDATION', { command: commandLine, required });
    const res = await this.opts.supervisor.run({
      id: `${rec.taskId}-${name}-${Date.now()}`,
      projectId: this.projectId, taskId: rec.taskId, cls,
      command: cmd, args, cwd: rec.worktree,
      policy: this.policyFor(rec),
      confineFilesystem: true,          // project commands are the untrusted ones
    });
    const outcome = classifyCheck(res, required);
    this.spans.end(checkId, { outcome });
    // Runner startup and actual test execution are wildly different costs and
    // are normally invisible as one number. First output is the boundary: a
    // runner has compiled and collected by the time it prints anything.
    const ct = res.timing;
    if (ct) {
      const req = BigInt(ct.requestedNs); const sp = BigInt(ct.spawnedNs); const ex = BigInt(ct.exitedNs);
      const fo = ct.firstOutputNs ? BigInt(ct.firstOutputNs) : null;
      this.spans.externalUnder(checkId, `check.${name}.queue+spawn`, 'IDLE', req, sp, {});
      if (fo) {
        this.spans.externalUnder(checkId, `check.${name}.runner-startup`, 'VALIDATION', sp, fo, {});
        this.spans.externalUnder(checkId, `check.${name}.execution`, 'VALIDATION', fo, ex, {});
      } else {
        this.spans.externalUnder(checkId, `check.${name}.total`, 'VALIDATION', sp, ex, { noOutput: true });
      }
    }
    // The command line and the output tail are both project-derived text, and
    // both are recorded verbatim here: the sink in EventStore.append() redacts
    // them on the way to disk. Doing it again at this call site would be the
    // per-producer pattern this deliberately replaced.
    this.record({ taskId: rec.taskId, type: 'CHECK_RESULT', payload: {
      name, required, outcome, command: commandLine, exitCode: res.exitCode,
      durationMs: res.durationMs, backend: res.backend, isolationFallback: res.isolationFallback,
      productSignal: res.productSignal, violations: res.violations,
      tail: res.stdout.slice(-500),
    } });
    return { outcome, res };
  }

  /**
   * Cancels a task from ANY process.
   *
   * The in-memory kill only reaches executions this process started, so the
   * on-disk run registry is authoritative when `cancel` is typed in another
   * terminal — which is the normal case. Both are used, and the number
   * reported is what actually died.
   */
  cancel(taskId: string, reason: string): { cancelled: boolean; killed: number } {
    this.record({ taskId, type: 'CANCEL_REQUESTED', payload: { reason } });
    const local = this.opts.supervisor.killTask(taskId, reason);
    const recorded = killRecorded(this.stateRoot, { taskId }, reason);
    const killed = local + recorded.killed;
    this.record({ taskId, type: 'PROCESSES_TERMINATED', payload: {
      local, fromRegistry: recorded.killed, prunedStale: recorded.pruned,
      groups: recorded.records.map((r) => ({ pgid: r.pgid, command: r.command })),
    } });
    this.record({ taskId, type: 'STATE_CHANGED', payload: {
      from: this.task(taskId)?.state ?? 'NEW', to: 'CANCELLED', phase: 'cancelled', killed, reason } });
    return { cancelled: true, killed };
  }

  /**
   * Runs the lifecycle to a terminal state.
   *
   * Each phase records its intent BEFORE acting, so a crash leaves evidence of
   * what was in flight rather than an ambiguous silence.
   */
  async run(taskId: string): Promise<TaskState> {
    let rec = this.task(taskId);
    if (!rec) throw new Error(`unknown task ${taskId}`);
    const cfg = this.opts.config;
    const adapter = adapterById(cfg.project?.adapter ?? 'generic');

    const wt = this.spans.sync('worktree.prepare', 'SETUP', () => this.prepareWorktree(rec));
    if (!wt.ok) {
      this.record({ taskId, type: 'WORKTREE', payload: {
        ...wt, prepared: false, method: 'none' as PrepMethod, lockfileHash: null,
        reused: false, durationMs: 0 } });
      this.setState(taskId, 'FAILED', 'worktree');
      return 'FAILED';
    }

    // Dependencies BEFORE design, because every phase after this point runs
    // commands in the worktree and a worktree without dependencies produces
    // `Cannot find module` — a validation result that says nothing about the
    // code. Measured under SETUP so its true cost is visible in the latency
    // report rather than hidden inside the first check.
    const deps = await this.spans.async('setup.dependencies', 'SETUP',
      () => prepareDependencies({
        projectRoot: this.opts.projectRoot, worktree: rec.worktree,
        taskId, projectId: this.projectId,
        // The configured command wins: the adapter supplies a default, the
        // project's config is the contract. A project that declares it has no
        // install step must not have one inferred for it.
        // `??` would be wrong here: a configured `install: null` means "this
        // project has no install step", and coalescing it away would infer one
        // anyway. Presence of the key is the signal, not its truthiness.
        installCommand: cfg.commands && 'install' in cfg.commands
          ? cfg.commands.install : (adapter?.commands(rec.worktree).install ?? null),
        supervisor: this.opts.supervisor, policy: this.policyFor(rec),
        cacheRoot: depsCacheRoot(this.opts.projectRoot, this.opts.config.paths?.deps),
      }));
    // WORKTREE payload semantics — every field describes what HAPPENED:
    //
    //   prepared      the worktree received dependencies (false for `none`)
    //   method        pnpm-store | hardlink | copy | install | none, named only
    //                 when it ran AND succeeded, never predicted
    //   lockfileHash  the cache identity: sha256 of the lockfile's bytes
    //   reused        true when an existing cache was materialised rather than
    //                 built, so first-vs-later cost is separable in telemetry
    //   durationMs    wall clock for the whole preparation
    //   attempts      every method tried, in order, with ok/detail/durationMs —
    //                 including the ones that FAILED, which is where a fallback
    //                 shows itself
    //
    // Reuse order is hardlink → pnpm-store → copy, inverted from the original
    // pnpm-first order once it was measured: hardlinking a prepared tree costs
    // 2–32 ms where `pnpm install --offline` costs ~700 ms, and that difference
    // is paid on every task after the first. pnpm-store remains the fallback
    // where hardlinks are impossible (different filesystems, no link support),
    // which `attempts` makes visible rather than silent.
    this.record({ taskId, type: 'WORKTREE', payload: {
      ...wt, prepared: deps.prepared, method: deps.method, lockfileHash: deps.lockfileHash,
      reused: deps.reused, durationMs: deps.durationMs,
      dependencyDetail: deps.detail, attempts: deps.attempts,
    } });
    if (!deps.ok) {
      // A dependency install that fails is INFRASTRUCTURE_FAILURE, never a
      // failing test: the code under test never ran. Proceeding to checks that
      // cannot pass would turn a broken environment into a verdict about the
      // change.
      this.record({ taskId, type: 'DEPENDENCIES_FAILED', payload: {
        method: deps.method, lockfileHash: deps.lockfileHash, detail: deps.detail,
        outcome: 'INFRASTRUCTURE_FAILURE', attempts: deps.attempts,
        installOutput: (deps.output ?? '').slice(-4000),
      } });
      return this.escalateToHuman(taskId, 'NEEDS_RECONCILIATION', 'dependencies', {
        reasonCode: 'MISSING_ENVIRONMENT',
        blocked: `dependency preparation failed in the task worktree: ${deps.detail}`,
        tried: deps.attempts.map((a) => `${a.method}: ${a.detail}`),
        evidence: [{ kind: 'event', id: 'DEPENDENCIES_FAILED', detail: 'install output, redacted' }],
        needed: {
          kind: 'fix',
          description: 'a worktree that can install this project\'s dependencies',
          how: 'reproduce the install command shown in the event, then fix the cause '
            + '(unreachable registry, missing toolchain, or a lockfile the manifest disagrees with)',
        },
        resumeBehavior: 'rerun the task: preparation is retried and, once it succeeds, '
          + 'is published to the project cache so later tasks reuse it',
      });
    }

    // ---- DESIGN ------------------------------------------------------------
    this.setState(taskId, 'DESIGN', 'design');
    const design = await this.agent('planner', rec, [
      'You are planning a change in an existing repository.',
      `TASK: ${rec.description}`,
      `PROJECT TYPE: ${adapter?.name ?? 'unknown'}`,
      `WORKTREE: ${rec.worktree}`,
      'Inspect current source before planning. Reply with ONLY a JSON object:',
      '{"plan":"...","scopeAllowlist":["path"],"requiredTests":["command"],"acceptance":["..."]}',
    ].join('\n'), true);
    if (!design.ok) {
      // A provider outage is not a failed design.
      const state: TaskState = design.infrastructureFailure ? 'NEEDS_RECONCILIATION' : 'FAILED';
      this.setState(taskId, state, 'design', { reason: design.infrastructureFailure ?? 'design failed' });
      return state;
    }
    this.record({ taskId, type: 'DESIGN_RECORDED', payload: { design: design.structured ?? {} } });
    if (this.task(taskId)?.cancelRequested) return 'CANCELLED';

    const afterDesign = this.budgetBreach(taskId);
    if (afterDesign) return afterDesign;

    // ---- IMPLEMENT ---------------------------------------------------------
    const implementStartedAt = Date.now();
    this.setState(taskId, 'IMPLEMENT', 'implement');
    const impl = await this.agent('implementer', rec, [
      'Implement the following change in the current worktree.',
      `TASK: ${rec.description}`,
      `PLAN: ${JSON.stringify(design.structured ?? {})}`,
      'Reply with ONLY: {"status":"IMPLEMENTED"|"FAILED","filesChanged":[],"reason":""}',
    ].join('\n'), false);
    if (!impl.ok) {
      const state: TaskState = impl.infrastructureFailure ? 'NEEDS_RECONCILIATION' : 'FAILED';
      this.setState(taskId, state, 'implement', { reason: impl.infrastructureFailure ?? 'implementation failed' });
      return state;
    }
    const changed = this.spans.sync('decision.changed-files', 'DECISION', () => this.changedFiles(rec));
    this.record({ taskId, type: 'CODE_CHANGE', payload: { filesChanged: changed } });
    if (this.task(taskId)?.cancelRequested) return 'CANCELLED';

    const afterImpl = this.budgetBreach(taskId);
    if (afterImpl) return afterImpl;

    // ---- ADAPTIVE VALIDATION -----------------------------------------------
    // Classified per hunk, before anything is run. The tier is the MAXIMUM over
    // every hunk: a risky change bundled with a harmless one buys nothing.
    const rawDiff = this.spans.sync('decision.diff', 'DECISION', () => this.diff(rec));
    const parsed = this.spans.sync('decision.parse-diff', 'DECISION', () => parseDiff(rawDiff), { bytes: rawDiff.length });
    const hardening = this.hardening();
    const confidence = impactConfidence(parsed, cfg.project?.adapter ?? 'generic');
    let decision: TierDecision = this.spans.sync('decision.resolve-tier', 'DECISION', () => resolveTier({
      diff: parsed, adapterId: cfg.project?.adapter ?? 'generic', confidence, hardening,
    }), { files: parsed.files.length });
    this.record({ taskId, type: 'VALIDATION_PLAN', payload: {
      tier: decision.tier, confidence: decision.confidence, fastEligible: decision.fastEligible,
      perHunk: decision.perHunk, escalations: decision.escalations, reasons: decision.reasons,
      testSurfaceFiles: decision.testSurfaceFiles, highRiskFiles: decision.highRiskFiles,
      adapter: cfg.project?.adapter, hardening: decision.hardening,
    } });

    // ---- EVIDENCE-CHAIN INTEGRITY -------------------------------------------
    // The one place where "the tests passed" could be a lie the platform told
    // itself. These rules are not configurable.
    const contract = this.spans.sync('decision.design-contract', 'DECISION', () => designContract(design.structured));
    const integrity: IntegrityReport = this.spans.sync('decision.integrity', 'DECISION',
      () => inspectIntegrity(parsed, contract));
    const evidenceCoupled = this.spans.sync('decision.evidence-coupling', 'DECISION',
      () => evidenceCoupledFiles(parsed, contract));
    this.record({ taskId, type: 'EVIDENCE_INTEGRITY', payload: {
      findings: integrity.findings, blocking: integrity.blocking.length,
      testFilesChanged: integrity.testFilesChanged, testsRemoved: integrity.testsRemoved,
      testsDisabled: integrity.testsDisabled, evidenceCoupledFiles: evidenceCoupled,
      requiredTests: contract.requiredTests,
    } });
    if (integrity.blocking.length) {
      const b = integrity.blocking;
      return this.escalateToHuman(taskId, 'BLOCKED', 'implement', {
        reasonCode: b.some((f) => f.code === 'REQUIRED_TEST_TAMPERED')
          ? 'REQUIRED_TEST_TAMPERED' : 'TEST_SURFACE_UNJUSTIFIED',
        blocked: `the implementation modified the test surface in ${b.length} way(s) the task design does not justify, so a passing run would not mean anything`,
        tried: [
          'classified every changed hunk and resolved the validation tier',
          'checked the diff against the required tests declared in task design',
          'looked for a justification for each test-surface change in the design output',
        ],
        evidence: [
          ...b.slice(0, 5).map((f) => ({ kind: 'finding' as const, id: f.code, detail: `${f.file}: ${f.detail}` })),
          { kind: 'event' as const, id: 'EVIDENCE_INTEGRITY', detail: 'full per-file integrity report' },
        ],
        needed: {
          kind: 'decision',
          description: b[0].code === 'REQUIRED_TEST_TAMPERED'
            ? `confirm whether ${b[0].file} should still be a required test, or re-plan the task with it removed deliberately`
            : `confirm whether removing or weakening the tests in ${b.map((f) => f.file).join(', ')} is intended`,
          how: 'reply on the task, or re-run with a design that names the test change and why it is correct',
        },
        resumeBehavior: 'the task re-enters implementation with the decision recorded; validation continues automatically',
      });
    }

    // ---- VERIFY ------------------------------------------------------------
    this.setState(taskId, 'VERIFY', 'verify');
    // Constraints stated in the task become data here, once, and every
    // selection from now on is made against them.
    const constraints: ConstraintSet = this.spans.sync('decision.constraints', 'DECISION',
      () => parseConstraints(rec.description));
    const declared = Object.entries(cfg.commands ?? {})
      .filter(([, v]) => typeof v === 'string' && v)
      .map(([name, command]) => ({
        name: name === 'unitTest' ? 'unit-test' : name === 'integrationTest' ? 'integration-test' : name,
        command: String(command),
      }));
    const classifications: Classification[] = this.spans.sync('decision.classify-suites', 'DECISION',
      () => classifyAll(declared, this.opts.projectRoot));
    this.record({ taskId, type: 'TASK_CONSTRAINTS', payload: {
      constraints: constraints.constraints, unparsed: constraints.unparsed,
      classifications: classifications.map((c) => ({ check: c.check, klass: c.klass, signals: c.signals })),
    } });

    // Constraints about the diff itself are reported now, before anything runs.
    const dViolations = diffViolations(constraints, { files: changed });
    if (dViolations.length) {
      this.record({ taskId, type: 'CONSTRAINT_VIOLATION', payload: { scope: 'diff', violations: dViolations } });
    }

    const ledger: SelectionLedger = this.spans.sync('decision.select-checks', 'DECISION', () => selectChecks({
      phase: 'VERIFY', tier: decision.tier,
      commands: (cfg.commands ?? {}) as unknown as Record<string, string | null | undefined>,
      classifications, constraints,
      affectedSurfaces: decision.highRiskFiles,
      cost: {
        implementMs: Math.max(1, Date.now() - implementStartedAt),
        filesChanged: changed.length, hunks: decision.perHunk.length,
      },
      costRatioThreshold: Number((cfg as any)?.validation?.hardening?.costRatioThreshold) || DEFAULT_COST_RATIO,
    }));
    this.applySelection(ledger);
    this.record({ taskId, type: 'VALIDATION_SELECTION', payload: {
      phase: ledger.phase, tier: ledger.tier,
      selected: ledger.selected.map((c) => ({ name: c.name, required: c.required, klass: c.klass, reason: c.reason })),
      refused: ledger.refused,
      cost: ledger.cost, conflict: ledger.conflict, reasons: ledger.reasons,
    } });

    // A required check the task forbade is not Zeus's decision to make.
    if (ledger.conflict) {
      return this.escalateToHuman(taskId, 'AWAITING_HUMAN', 'verify', {
        reasonCode: 'POLICY_APPROVAL_REQUIRED',
        blocked: ledger.conflict.detail,
        tried: [
          `classified the change as ${decision.tier}`,
          `parsed ${constraints.constraints.length} constraint(s) from the task text`,
          `classified ${classifications.length} configured check(s) by what they start`,
        ],
        evidence: [
          { kind: 'event', id: 'TASK_CONSTRAINTS', detail: 'the parsed constraint set' },
          { kind: 'event', id: 'VALIDATION_SELECTION', detail: 'the selection ledger and its refusals' },
          { kind: 'check', id: ledger.conflict.check, detail: 'the required check in conflict' },
        ],
        needed: {
          kind: 'decision',
          description: `decide whether "${ledger.conflict.check}" should run despite the task forbidding it, or whether the constraint stands and the required check is waived for this task`,
        },
        resumeBehavior: 'the task resumes at verification with the decision recorded against it',
      });
    }

    const required: Array<{ name: string; cmd: string; cls: 'light' | 'heavy' }> =
      ledger.selected.filter((c) => c.required).map((c) => ({ name: c.name, cmd: c.command, cls: c.cls }));
    // A project with nothing executable to run cannot be "verified". Claiming
    // COMPLETED here would be the worst kind of false acceptance: confident,
    // fast and based on nothing. Opt in explicitly if that is really intended.
    if (!required.length) {
      const allowed = (this.opts.config.policy as any)?.allowUnverifiedAcceptance === true;
      this.record({ taskId, type: 'NO_VERIFICATION_CONFIGURED', payload: {
        adapter: cfg.project?.adapter, commands: cfg.commands ?? {},
        allowUnverifiedAcceptance: allowed,
        detail: 'no typecheck or unit-test command is configured for this project',
      } });
      if (!allowed) {
        return this.escalateToHuman(taskId, 'NEEDS_RECONCILIATION', 'verify', {
          reasonCode: 'NO_VERIFICATION_CONFIGURED',
          blocked: 'this project declares no typecheck and no unit-test command, so there is nothing that could confirm the change works',
          tried: [
            `detected the project as "${cfg.project?.adapter}"`,
            `read the commands it declares: ${Object.entries(cfg.commands ?? {}).filter(([, v]) => v).map(([k]) => k).join(', ') || 'none'}`,
            'declined to report success on the basis of no evidence',
          ],
          evidence: [
            { kind: 'event', id: 'NO_VERIFICATION_CONFIGURED', detail: 'the commands detected for this project' },
            { kind: 'file', id: '.zeus/config.yaml', detail: 'where the commands are declared' },
          ],
          needed: {
            kind: 'information',
            description: 'a test or typecheck command for this project, or an explicit decision to accept changes without one',
            how: 'set commands.unitTest in .zeus/config.yaml, or set policy.allowUnverifiedAcceptance: true',
            example: 'commands.unitTest: npm test',
          },
          resumeBehavior: 'the task re-runs verification with the new command and continues to review automatically',
        });
      }
    }
    // The tier decides what runs ON TOP of the floor, never how much of the
    // floor runs. Every required check runs at every tier, including FAST.
    const optional: Array<{ name: string; cmd: string; cls: 'light' | 'heavy' }> =
      ledger.selected.filter((c) => !c.required).map((c) => ({ name: c.name, cmd: c.command, cls: c.cls }));
    this.record({ taskId, type: 'VALIDATION_SCOPE', payload: {
      tier: ledger.tier, floor: required.map((r) => r.name), additional: optional.map((o) => o.name),
      refused: ledger.refused.map((r) => ({ name: r.name, code: r.code })),
      note: 'the floor is authoritative and runs at every tier; everything here came from selectChecks()',
    } });

    const outcomes: CheckOutcome[] = [];
    for (const c of required) {
      if (this.task(taskId)?.cancelRequested) return 'CANCELLED';
      const { outcome } = await this.runCheck(rec, c.name, c.cmd, true, c.cls);
      outcomes.push(outcome);
    }
    // Tier-added checks are real evidence but are not the required floor: a
    // failure here blocks, but a non-verdict does not masquerade as one.
    const additionalOutcomes: Array<{ name: string; outcome: CheckOutcome }> = [];
    for (const c of optional) {
      if (this.task(taskId)?.cancelRequested) return 'CANCELLED';
      const { outcome } = await this.runCheck(rec, c.name, c.cmd, false, c.cls);
      additionalOutcomes.push({ name: c.name, outcome });
    }
    // A declared required test that did not actually execute is not a pass.
    const notRun = outcomes.filter((o) => o !== 'PASSED' && o !== 'TEST_FAILED');
    const failed = outcomes.filter((o) => o === 'TEST_FAILED');
    const additionalFailed = additionalOutcomes.filter((a) => a.outcome === 'TEST_FAILED');
    if (failed.length || additionalFailed.length) {
      const names = [
        ...required.filter((_, i) => outcomes[i] === 'TEST_FAILED').map((r) => r.name),
        ...additionalFailed.map((a) => a.name),
      ];
      return this.escalateToHuman(taskId, 'BLOCKED', 'verify', {
        reasonCode: 'REVIEW_FINDINGS_BLOCKING',
        blocked: `validation failed: ${names.join(', ')} reported a real failure against the change`,
        tried: [
          `classified the diff as ${decision.tier} (${decision.reasons[0] ?? 'per-hunk maximum'})`,
          `ran the required floor: ${required.map((r) => r.name).join(', ') || '(none configured)'}`,
          optional.length ? `ran tier-added checks: ${optional.map((o) => o.name).join(', ')}` : 'no tier-added checks applied',
        ],
        evidence: names.map((n) => ({ kind: 'check' as const, id: n, detail: 'see CHECK_RESULT for the command and output tail' })),
        needed: { kind: 'fix', description: `decide whether ${names[0]} is failing because of this change or was already failing on the base commit` },
        resumeBehavior: 'once the failure is resolved or attributed, the task continues from verification',
      });
    }
    if (notRun.length) {
      const names = required.filter((_, i) => outcomes[i] !== 'PASSED' && outcomes[i] !== 'TEST_FAILED').map((r) => r.name);
      return this.escalateToHuman(taskId, 'NEEDS_RECONCILIATION', 'verify', {
        reasonCode: 'REQUIRED_TEST_NOT_RUN',
        blocked: `${names.join(', ')} never produced a verdict (${notRun.join(', ')}), so the change is unverified rather than failing`,
        tried: [
          `ran each required check through the supervisor at ${decision.tier}`,
          'classified the outcome apart from a test failure, because a missing toolchain is not a broken change',
        ],
        evidence: names.map((n) => ({ kind: 'check' as const, id: n, detail: 'see CHECK_RESULT for the command, exit code and output tail' })),
        needed: {
          kind: 'fix',
          description: `make ${names[0]} runnable in this environment — the check did not fail, it did not run`,
        },
        resumeBehavior: 'the required checks re-run and the task continues to review automatically',
      });
    }

    const afterVerify = this.budgetBreach(taskId);
    if (afterVerify) return afterVerify;

    // ---- REVIEW ------------------------------------------------------------
    this.setState(taskId, 'REVIEW', 'review');
    const diff = this.diff(rec);
    const headSha = this.spans.sync('review.head-sha', 'REVIEW', () => this.worktreeHead(rec));
    // A reviewer that silently receives the first 20KB of a large change can
    // report "no findings" having seen a fraction of it, and that verdict is
    // recorded as a review of the whole thing. If it must be cut, say so.
    const DIFF_LIMIT = 20000;
    const diffTruncated = diff.length > DIFF_LIMIT;
    const truncatedDiff = diffTruncated
      ? `${diff.slice(0, DIFF_LIMIT)}\n\n*** DIFF TRUNCATED ***\n`
        + `This section shows the first ${DIFF_LIMIT} of ${diff.length} bytes. `
        + `${changed.length} file(s) changed in total; the remainder is NOT included above.\n`
        + 'You have not seen the whole change. Say so in your evidence summary, and treat any\n'
        + 'conclusion about the unseen portion as unsupported.\n'
      : diff;

    // The reviewer's payload is assembled under policy and hashed, so what it
    // received is a matter of record rather than of trust. Anything carrying
    // planner reasoning or implementer transcripts is refused outright.
    const reviewInputs: ReviewInput[] = [
      { kind: 'task-requirement', label: 'TASK', content: rec.description },
      { kind: 'changed-files', label: 'CHANGED FILES', content: changed.join('\n') || '(none)' },
      { kind: 'diff', label: 'DIFF (base..head)', content: truncatedDiff },
      { kind: 'protected-paths', label: 'PROTECTED PATHS',
        content: (cfg.policy?.protectedPaths ?? []).join('\n') || '(none)' },
      { kind: 'test-evidence', label: 'CHECKS ALREADY RUN',
        content: [
          ...outcomes.map((o, i) => `${required[i]?.name ?? 'check'}: ${o} (required)`),
          ...additionalOutcomes.map((a) => `${a.name}: ${a.outcome} (tier ${decision.tier})`),
        ].join('\n') || '(none)' },
    ];
    // §2 — when the change touches the test surface, the reviewer is told so
    // explicitly and asked the specific question. Facts only: what moved, what
    // the design said about it. Whether that is acceptable is the reviewer's
    // own call, which is the whole point of an independent review.
    if (integrity.testFilesChanged.length || integrity.testsDisabled.length || evidenceCoupled.length) {
      reviewInputs.push({
        kind: 'test-surface',
        label: 'TEST SURFACE CHANGED: verify the modification is justified',
        content: [
          `Files: ${integrity.testFilesChanged.join(', ') || '(none)'}`,
          `Tests removed: ${integrity.testsRemoved.join(', ') || '(none)'}`,
          `Disabled or skipped: ${integrity.testsDisabled.map((d) => `${d.file} ${d.name} ${d.annotation}`).join('; ') || '(none)'}`,
          `Files the required tests depend on: ${evidenceCoupled.join(', ') || '(none)'}`,
          `Justifications given in task design: ${contract.testChangeJustifications.map((j) => `${j.path}: ${j.reason}`).join(' | ') || '(none)'}`,
          '',
          'A change to the tests changes what "passing" means. Decide whether each',
          'modification above is justified by the task, and report an unjustified',
          'removal, skip or weakened assertion as a CRITICAL finding.',
        ].join('\n'),
      });
    }
    const payload = this.spans.sync('review.assemble-payload', 'REVIEW', () => buildReviewPayload({
      taskId, projectId: this.projectId, baseSha: rec.baseSha, headSha,
      inputs: reviewInputs, policy: this.reviewPolicy,
      header: [
        'Independently review this change against current source.',
        'No planning rationale, implementation notes or previous verdicts are included:',
        'your review must be your own, formed from the task and the code.',
        'If you believe a specific behaviour may be affected that the checks above do',
        'not cover, you may request more validation — but you must NAME the behaviour.',
        '"Run everything to be safe" is rejected and recorded.',
        'Reply with ONLY: {"findings":[{"severity":"CRITICAL|IMPORTANT|SUGGESTION","claim":"...","file":"..."}],',
        ' "evidence":{"sourceInspected":true,"filesInspected":[],"evidenceSummary":"..."},',
        ' "usedContext":["task-requirement","diff"],',
        ' "expansionRequest":{"behavior":"session refresh may break for expired tokens","scope":["path"]}}',
      ].join('\n'),
    }));
    this.record({ taskId, type: 'REVIEW_CONTEXT', payload: {
      diffBytes: diff.length, diffTruncated, diffDelivered: truncatedDiff.length,
      reviewInvocationId: payload.reviewInvocationId,
      baseSha: payload.baseSha, headSha: payload.headSha,
      configuredContext: payload.configuredContext,
      deliveredContext: payload.deliveredContext,
      hashes: payload.hashes, promptHash: payload.promptHash, promptBytes: payload.promptBytes,
      violations: payload.violations, valid: payload.valid,
    } });
    if (!payload.valid) {
      // A contaminated review is not a review. It is refused, not annotated.
      return this.escalateToHuman(taskId, 'NEEDS_RECONCILIATION', 'review', {
        reasonCode: 'REVIEW_CONTEXT_POLICY_VIOLATION',
        blocked: `the review payload contained material the reviewer must never see (${payload.violations.map((v) => v.detail).join('; ')}), so the review was refused rather than run and annotated`,
        tried: [
          'assembled the reviewer payload section by section under policy',
          'hashed each section and scanned the contents for forbidden material',
          'refused to send the prompt',
        ],
        evidence: [
          { kind: 'event', id: 'REVIEW_CONTEXT', detail: `invocation ${payload.reviewInvocationId}, per-section hashes` },
          ...payload.violations.slice(0, 3).map((v) => ({ kind: 'finding' as const, id: v.code, detail: v.detail })),
        ],
        needed: {
          kind: 'fix',
          description: 'the leaking section must be removed from the review payload; this is a defect in Zeus, not in the change under review',
        },
        resumeBehavior: 'once the payload is clean the review runs and the task continues automatically',
      });
    }
    const review = await this.agent('reviewer', rec, payload.prompt, true);
    const reported = reconcileReviewerReport(payload, review.structured);
    if (!reported.consistent) {
      // Self-report is never authoritative; a claim about unsupplied context
      // goes on the record rather than being believed.
      this.record({ taskId, type: 'REVIEW_CLAIM_UNSUPPORTED', payload: {
        reviewInvocationId: payload.reviewInvocationId, unsupportedClaims: reported.unsupportedClaims,
      } });
    }
    if (!review.ok && review.infrastructureFailure) {
      return this.escalateToHuman(taskId, 'NEEDS_RECONCILIATION', 'review', {
        reasonCode: 'PROVIDER_OUTAGE',
        blocked: `the independent reviewer could not be reached (${review.infrastructureFailure}), and an unreviewed change is not an accepted change`,
        tried: [
          `validated the change at ${decision.tier} and recorded the evidence`,
          'assembled and hashed a policy-clean review payload',
          'invoked the reviewer provider',
        ],
        evidence: [
          { kind: 'event', id: 'AGENT_FAILED', detail: `reviewer: ${review.infrastructureFailure}` },
          { kind: 'event', id: 'REVIEW_CONTEXT', detail: `payload ${payload.reviewInvocationId} is ready and unchanged` },
        ],
        needed: { kind: 'fix', description: 'restore access to the reviewer provider (check `zeus doctor`)' },
        resumeBehavior: 'the review re-runs against the same recorded payload; nothing already validated is repeated',
      });
    }
    let findings = ((review.structured?.findings as any[]) ?? []);
    this.record({ taskId, type: 'FINDINGS', payload: { findings, count: findings.length } });
    if (this.task(taskId)?.cancelRequested) return 'CANCELLED';

    // ---- REVIEWER EXPANSION (§7) -------------------------------------------
    // Valuable, and bounded. Each grant costs a review cycle, must name a
    // concrete behaviour, and is recorded whether or not it is granted.
    const expansionState: ExpansionState = {
      granted: 0, budget: hardening.reviewerExpansionBudget, findingsPerExpansion: [],
    };
    const alreadyRun = new Set<string>([...required.map((r) => r.name), ...optional.map((o) => o.name)]);
    let pending = review.structured?.expansionRequest as ExpansionRequest | undefined;

    while (pending && typeof pending === 'object') {
      const req: ExpansionRequest = {
        behavior: String((pending as any).behavior ?? (pending as any).reason ?? ''),
        rationale: (pending as any).rationale ? String((pending as any).rationale) : undefined,
        scope: Array.isArray((pending as any).scope) ? (pending as any).scope.map(String) : undefined,
      };
      const verdict = evaluateExpansion(req, expansionState);
      this.record({ taskId, type: 'REVIEW_EXPANSION', payload: {
        code: verdict.code, accepted: verdict.accepted, detail: verdict.detail,
        request: req, granted: expansionState.granted, budget: expansionState.budget,
      } });
      if (!verdict.accepted) break;

      expansionState.granted += 1;
      decision = applyExpansion(decision, req);
      this.record({ taskId, type: 'VALIDATION_PLAN', payload: {
        tier: decision.tier, confidence: decision.confidence, fastEligible: decision.fastEligible,
        escalations: decision.escalations, reasons: decision.reasons,
        cause: 'reviewerExpansion', perHunk: decision.perHunk,
      } });

      // The expansion goes through the SAME selection path as VERIFY. It used to
      // reach into cfg.commands directly, which meant an escalated tier could
      // acquire a heavy suite the task's own constraints forbade — the
      // Zeus-native version of the defect this fix exists for.
      const expandLedger = selectChecks({
        phase: 'REVIEW_EXPANSION', tier: decision.tier,
        commands: (cfg.commands ?? {}) as unknown as Record<string, string | null | undefined>,
        classifications, constraints,
        affectedSurfaces: [...decision.highRiskFiles, ...(req.scope ?? [])],
        alreadyRun,
      });
      this.record({ taskId, type: 'VALIDATION_SELECTION', payload: {
        phase: expandLedger.phase, tier: expandLedger.tier, cause: 'reviewerExpansion',
        selected: expandLedger.selected.map((c) => ({ name: c.name, required: c.required, klass: c.klass, reason: c.reason })),
        refused: expandLedger.refused, reasons: expandLedger.reasons,
      } });
      this.applySelection(expandLedger, 'extend');
      for (const c of expandLedger.selected) {
        if (alreadyRun.has(c.name)) continue;
        alreadyRun.add(c.name);
        const { outcome } = await this.runCheck(rec, c.name, c.command, c.required, c.cls);
        additionalOutcomes.push({ name: c.name, outcome });
      }

      const overBudget = this.budgetBreach(taskId);
      if (overBudget) return overBudget;

      const before = findings.length;
      const again = await this.agent('reviewer', rec, payload.prompt, true);
      const newFindings = ((again.structured?.findings as any[]) ?? []);
      findings = newFindings.length ? newFindings : findings;
      expansionState.findingsPerExpansion.push(Math.max(0, findings.length - before));
      this.record({ taskId, type: 'FINDINGS', payload: {
        findings, count: findings.length, afterExpansion: expansionState.granted,
      } });
      pending = again.structured?.expansionRequest as ExpansionRequest | undefined;
      if (this.task(taskId)?.cancelRequested) return 'CANCELLED';
    }

    const unproductive = unproductiveExpansion(expansionState);
    if (unproductive) this.record({ taskId, type: 'REVIEW_EXPANSION_UNPRODUCTIVE', payload: { ...unproductive } });

    const blockers = findings.filter((f) => ['CRITICAL', 'IMPORTANT'].includes(String(f?.severity)));

    // ---- FINAL ACCEPTANCE --------------------------------------------------
    this.setState(taskId, 'FINAL_ACCEPTANCE', 'final');
    if (blockers.length) {
      return this.escalateToHuman(taskId, 'BLOCKED', 'final', {
        reasonCode: 'REVIEW_FINDINGS_BLOCKING',
        blocked: `the independent reviewer raised ${blockers.length} material finding(s) against this change`,
        tried: [
          `validated at ${decision.tier}`,
          `ran ${[...alreadyRun].join(', ') || 'no checks'}`,
          expansionState.granted ? `granted ${expansionState.granted} reviewer expansion(s)` : 'no reviewer expansion was requested',
        ],
        evidence: blockers.slice(0, 5).map((f: any) => ({
          kind: 'finding' as const, id: String(f.severity), detail: `${f.file ?? '(file unstated)'}: ${f.claim}`,
        })),
        needed: {
          kind: 'decision',
          description: `decide whether "${String(blockers[0]?.claim ?? '').slice(0, 140)}" must be fixed before this change is accepted`,
        },
        resumeBehavior: 'accepting the finding sends the task to repair; dismissing it resumes acceptance, and both are recorded',
      });
    }
    // §3(d) — "passed" and "passed after this task edited the tests" are
    // different claims. They are never merged into one number.
    const accounting = accountForTests(
      [...required.map((r, i) => ({ name: r.name, outcome: String(outcomes[i]) })),
        ...additionalOutcomes.map((a) => ({ name: a.name, outcome: String(a.outcome) }))],
      integrity.testFilesChanged,
    );
    this.record({ taskId, type: 'ACCEPTED', payload: {
      filesChanged: changed, checks: outcomes,
      validationTier: decision.tier, confidence: decision.confidence,
      testAccounting: accounting,
      testsPassed: accounting.passed,
      testsModifiedThenPassed: accounting.modifiedThenPassed,
      reviewerExpansions: expansionState.granted,
      note: 'merge and deploy are separate, explicitly enabled operations',
    } });
    this.setState(taskId, 'COMPLETED', 'final');
    return 'COMPLETED';
  }

  /** HEAD of the task worktree, for review provenance. */
  worktreeHead(rec: TaskRecord): string {
    try {
      return require('child_process')
        .execFileSync('git', ['-C', rec.worktree, 'rev-parse', 'HEAD'], { encoding: 'utf8', timeout: 15_000 }).trim();
    } catch { return rec.baseSha; }
  }

  /**
   * Makes every shape of change visible to git.
   *
   * `git diff` alone reports tracked, unstaged modifications — which is a
   * fraction of what an implementer actually does. A file it CREATES is
   * untracked and invisible; work it COMMITS is invisible twice over. Both are
   * ordinary agent behaviour, and both used to produce an empty diff, which
   * meant zero hunks classified, no integrity inspection, and an empty payload
   * handed to the reviewer.
   *
   * `--intent-to-add` records the existence of untracked paths without staging
   * their content, so they appear as additions; diffing against the task's BASE
   * commit rather than the worktree HEAD then also captures anything committed.
   * The index of a per-task, disposable worktree is Zeus's own scratch space.
   */
  private markIntentToAdd(rec: TaskRecord): void {
    try {
      require('child_process').execFileSync('git', ['-C', rec.worktree, 'add', '-A', '--intent-to-add', '--'],
        { encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch { /* a path git refuses to index still shows through status below */ }
  }

  changedFiles(rec: TaskRecord): string[] {
    this.markIntentToAdd(rec);
    const cp = require('child_process');
    const names = new Set<string>();
    try {
      const out = cp.execFileSync('git',
        ['-C', rec.worktree, 'diff', '--name-only', rec.baseSha, '--', ...ZEUS_PATHSPEC_EXCLUDES],
        { encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'] });
      for (const l of out.split('\n').filter(Boolean)) names.add(l.trim());
    } catch { /* fall through to status */ }
    // Belt and braces: anything git still will not diff (an unreadable path,
    // a submodule) is at least reported as changed rather than lost.
    try {
      const st = cp.execFileSync('git', ['-C', rec.worktree, 'status', '--porcelain'],
        { encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'] });
      for (const l of st.split('\n').filter(Boolean)) {
        const name = l.slice(3).trim();
        if (!isZeusArtifact(name)) names.add(name);
      }
    } catch { /* nothing more to add */ }
    return [...names].filter(Boolean);
  }

  diff(rec: TaskRecord): string {
    this.markIntentToAdd(rec);
    try {
      return require('child_process')
        .execFileSync('git',
          ['-C', rec.worktree, 'diff', '--stat', '-p', rec.baseSha, '--', ...ZEUS_PATHSPEC_EXCLUDES],
          { encoding: 'utf8', timeout: 60_000, maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch { return '(diff unavailable)'; }
  }

  logs(taskId: string, limit = 200): StoredEvent[] {
    return this.events.read(taskId).slice(-limit);
  }
}
