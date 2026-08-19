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
import { EventStore, StoredEvent } from './events';
import { ProjectLock } from './lock';
import { ProcessSupervisor, ExecutionResult, killRecorded } from './exec';
import { ExecutionPolicy, defaultPolicy } from './policy';
import { Provider, AgentResponse, Role } from './providers';
import { ProjectConfig } from '../config';
import { adapterById } from '../adapters';
import { TaskBudgets, mergeBudgets, usageFrom, checkBudgets } from './taskbudget';
import { buildReviewPayload, DEFAULT_REVIEW_POLICY, ReviewContextPolicy, ReviewInput, reconcileReviewerReport } from './reviewcontext';

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
}

/** Maps a supervisor result onto the check vocabulary the product reasons in. */
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

/** Only a real verdict about the code may let acceptance continue. */
export function checkAllowsAcceptance(o: CheckOutcome): boolean { return o === 'PASSED'; }

export class Engine {
  readonly events: EventStore;
  readonly lock: ProjectLock;
  readonly stateRoot: string;
  readonly projectId: string;

  constructor(readonly opts: EngineOptions) {
    this.stateRoot = opts.stateRoot
      ?? path.resolve(opts.projectRoot, opts.config.paths?.state ?? '.zeus/state');
    this.projectId = opts.config.project?.name ?? path.basename(opts.projectRoot);
    this.events = new EventStore(this.stateRoot);
    this.lock = new ProjectLock(this.stateRoot, this.projectId);
    this.taskBudgets = mergeBudgets(opts.taskBudgets);
    this.reviewPolicy = opts.reviewPolicy ?? DEFAULT_REVIEW_POLICY;
  }

  /**
   * Enforces the task ceilings. A breach stops the task with the numbers on
   * the record; it never silently continues, and never pretends the work
   * finished.
   */
  private budgetBreach(taskId: string): TaskState | null {
    const usage = usageFrom(this.events.read(taskId));
    const breach = checkBudgets(this.taskBudgets, usage);
    if (!breach) return null;
    this.events.append({ taskId, type: 'TASK_BUDGET_EXCEEDED', payload: {
      budget: breach.budget, limit: breach.limit, observed: breach.observed,
      detail: breach.detail, usage,
    } });
    // A budget stop is a decision for a person: the work is unfinished, but
    // nothing is wrong with the code.
    this.setState(taskId, 'AWAITING_HUMAN', 'budget', {
      reason: `TASK_BUDGET_EXCEEDED: ${breach.budget} limit ${breach.limit}, observed ${breach.observed} (${breach.detail})`,
    });
    return 'AWAITING_HUMAN';
  }

  /** Ownership must be taken before any state is written. */
  acquire(): { ok: boolean; reason?: string } {
    const r = this.lock.acquire();
    return r.ok ? { ok: true } : { ok: false, reason: r.reason };
  }
  release(): void { this.lock.release(); }

  readonly taskBudgets: TaskBudgets;
  readonly reviewPolicy: ReviewContextPolicy;

  nextTaskId(): string {
    const seqs = this.events.listTasks()
      .map((t) => /T-(\d+)$/.exec(t)?.[1]).filter(Boolean).map(Number);
    const n = seqs.length ? Math.max(...seqs) + 1 : 1;
    return makeTaskId(this.projectId, n);
  }

  private gitSha(): string {
    try {
      return require('child_process')
        .execFileSync('git', ['-C', this.opts.projectRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8', timeout: 15_000 }).trim();
    } catch { return 'unknown'; }
  }

  createTask(description: string): TaskRecord {
    const taskId = this.nextTaskId();
    const worktree = path.resolve(this.opts.projectRoot,
      this.opts.config.paths?.worktrees ?? '.zeus/worktrees', taskIdToDir(taskId));
    const rec: TaskRecord = {
      taskId, description, state: 'NEW', phase: 'new',
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      worktree, baseSha: this.gitSha(), cancelRequested: false,
    };
    this.events.append({ taskId, type: 'TASK_CREATED', payload: {
      description, worktree, baseSha: rec.baseSha, projectId: this.projectId,
      adapter: this.opts.config.project?.adapter,
    } });
    return rec;
  }

  /** The task's current record, derived from its log. Never stored twice. */
  task(taskId: string): TaskRecord | null {
    const evs = this.events.read(taskId);
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
      this.events.append({ taskId, type: 'NOTE', payload: { refusedAfterCancel: `${cur.state} -> ${to}` } });
      return;
    }
    this.events.append({ taskId, type: 'STATE_CHANGED', payload: { from: cur?.state ?? 'NEW', to, phase, ...extra } });
  }

  policyFor(rec: TaskRecord): ExecutionPolicy {
    const p = defaultPolicy(this.opts.projectRoot, rec.worktree);
    // The state directory must stay writable so evidence survives even when
    // the worktree is confined.
    return { ...p, writablePaths: [rec.worktree, this.stateRoot] };
  }

  /** Creates the task's isolated worktree from the project's git repository. */
  private prepareWorktree(rec: TaskRecord): { ok: boolean; detail: string } {
    const { execFileSync } = require('child_process');
    try {
      fs.mkdirSync(path.dirname(rec.worktree), { recursive: true });
      if (fs.existsSync(rec.worktree)) return { ok: true, detail: 'worktree already present' };
      execFileSync('git', ['-C', this.opts.projectRoot, 'worktree', 'add', '--detach', rec.worktree, rec.baseSha],
        { encoding: 'utf8', timeout: 300_000 });
      return { ok: true, detail: 'worktree created' };
    } catch (e: any) {
      // A repository with no commits cannot produce a worktree; copy instead so
      // a brand-new project still works.
      try {
        fs.mkdirSync(rec.worktree, { recursive: true });
        execFileSync('sh', ['-c', `cp -a "${this.opts.projectRoot}/." "${rec.worktree}/" 2>/dev/null || true`], { timeout: 300_000 });
        fs.rmSync(path.join(rec.worktree, '.zeus'), { recursive: true, force: true });
        return { ok: true, detail: 'worktree copied (repository has no commit to check out)' };
      } catch (e2: any) {
        return { ok: false, detail: `cannot create worktree: ${e?.message ?? e} / ${e2?.message ?? e2}` };
      }
    }
  }

  private async agent(role: Role, rec: TaskRecord, prompt: string, readOnly: boolean): Promise<AgentResponse> {
    const provider = role === 'planner' ? this.opts.providers.planner
      : role === 'implementer' ? this.opts.providers.implementer : this.opts.providers.reviewer;
    this.events.append({ taskId: rec.taskId, type: 'AGENT_STARTED', payload: { role, provider: provider.id, readOnly } });
    const res = await provider.invoke({
      role, taskId: rec.taskId, projectId: this.projectId, prompt,
      policy: this.policyFor(rec), readOnly,
    }, this.opts.supervisor);
    this.events.append({ taskId: rec.taskId, type: res.ok ? 'AGENT_FINISHED' : 'AGENT_FAILED', payload: {
      role, provider: provider.id, outcome: res.outcome, exitCode: res.exitCode,
      durationMs: res.durationMs, infrastructureFailure: res.infrastructureFailure,
      structuredKeys: res.structured ? Object.keys(res.structured) : [],
    } });
    return res;
  }

  /** Runs one project command through the supervisor and classifies it. */
  async runCheck(rec: TaskRecord, name: string, commandLine: string, required: boolean,
    cls: 'light' | 'heavy' = 'light'): Promise<{ outcome: CheckOutcome; res: ExecutionResult }> {
    const [cmd, ...args] = commandLine.split(/\s+/);
    const res = await this.opts.supervisor.run({
      id: `${rec.taskId}-${name}-${Date.now()}`,
      projectId: this.projectId, taskId: rec.taskId, cls,
      command: cmd, args, cwd: rec.worktree,
      policy: this.policyFor(rec),
      confineFilesystem: true,          // project commands are the untrusted ones
    });
    const outcome = classifyCheck(res, required);
    this.events.append({ taskId: rec.taskId, type: 'CHECK_RESULT', payload: {
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
    this.events.append({ taskId, type: 'CANCEL_REQUESTED', payload: { reason } });
    const local = this.opts.supervisor.killTask(taskId, reason);
    const recorded = killRecorded(this.stateRoot, { taskId }, reason);
    const killed = local + recorded.killed;
    this.events.append({ taskId, type: 'PROCESSES_TERMINATED', payload: {
      local, fromRegistry: recorded.killed, prunedStale: recorded.pruned,
      groups: recorded.records.map((r) => ({ pgid: r.pgid, command: r.command })),
    } });
    this.events.append({ taskId, type: 'STATE_CHANGED', payload: {
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

    const wt = this.prepareWorktree(rec);
    this.events.append({ taskId, type: 'WORKTREE', payload: wt });
    if (!wt.ok) { this.setState(taskId, 'FAILED', 'worktree'); return 'FAILED'; }

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
    this.events.append({ taskId, type: 'DESIGN_RECORDED', payload: { design: design.structured ?? {} } });
    if (this.task(taskId)?.cancelRequested) return 'CANCELLED';

    const afterDesign = this.budgetBreach(taskId);
    if (afterDesign) return afterDesign;

    // ---- IMPLEMENT ---------------------------------------------------------
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
    const changed = this.changedFiles(rec);
    this.events.append({ taskId, type: 'CODE_CHANGE', payload: { filesChanged: changed } });
    if (this.task(taskId)?.cancelRequested) return 'CANCELLED';

    const afterImpl = this.budgetBreach(taskId);
    if (afterImpl) return afterImpl;

    // ---- VERIFY ------------------------------------------------------------
    this.setState(taskId, 'VERIFY', 'verify');
    const required: Array<{ name: string; cmd: string; cls: 'light' | 'heavy' }> = [];
    if (cfg.commands?.typecheck) required.push({ name: 'typecheck', cmd: cfg.commands.typecheck, cls: 'light' });
    if (cfg.commands?.unitTest) required.push({ name: 'unit-test', cmd: cfg.commands.unitTest, cls: 'heavy' });
    // A project with nothing executable to run cannot be "verified". Claiming
    // COMPLETED here would be the worst kind of false acceptance: confident,
    // fast and based on nothing. Opt in explicitly if that is really intended.
    if (!required.length) {
      const allowed = (this.opts.config.policy as any)?.allowUnverifiedAcceptance === true;
      this.events.append({ taskId, type: 'NO_VERIFICATION_CONFIGURED', payload: {
        adapter: cfg.project?.adapter, commands: cfg.commands ?? {},
        allowUnverifiedAcceptance: allowed,
        detail: 'no typecheck or unit-test command is configured for this project',
      } });
      if (!allowed) {
        this.setState(taskId, 'NEEDS_RECONCILIATION', 'verify', {
          reason: 'REQUIRED_TEST_NOT_RUN: the project declares no executable verification; '
            + 'set policy.allowUnverifiedAcceptance: true to accept changes without it',
        });
        return 'NEEDS_RECONCILIATION';
      }
    }
    const outcomes: CheckOutcome[] = [];
    for (const c of required) {
      if (this.task(taskId)?.cancelRequested) return 'CANCELLED';
      const { outcome } = await this.runCheck(rec, c.name, c.cmd, true, c.cls);
      outcomes.push(outcome);
    }
    // A declared required test that did not actually execute is not a pass.
    const notRun = outcomes.filter((o) => o !== 'PASSED' && o !== 'TEST_FAILED');
    const failed = outcomes.filter((o) => o === 'TEST_FAILED');
    if (failed.length) { this.setState(taskId, 'BLOCKED', 'verify', { reason: 'required test failed' }); return 'BLOCKED'; }
    if (notRun.length) {
      this.setState(taskId, 'NEEDS_RECONCILIATION', 'verify', { reason: `required checks did not run: ${notRun.join(', ')}` });
      return 'NEEDS_RECONCILIATION';
    }

    const afterVerify = this.budgetBreach(taskId);
    if (afterVerify) return afterVerify;

    // ---- REVIEW ------------------------------------------------------------
    this.setState(taskId, 'REVIEW', 'review');
    const diff = this.diff(rec);
    const headSha = this.worktreeHead(rec);

    // The reviewer's payload is assembled under policy and hashed, so what it
    // received is a matter of record rather than of trust. Anything carrying
    // planner reasoning or implementer transcripts is refused outright.
    const reviewInputs: ReviewInput[] = [
      { kind: 'task-requirement', label: 'TASK', content: rec.description },
      { kind: 'changed-files', label: 'CHANGED FILES', content: changed.join('\n') || '(none)' },
      { kind: 'diff', label: 'DIFF (base..head)', content: diff.slice(0, 20000) },
      { kind: 'protected-paths', label: 'PROTECTED PATHS',
        content: (cfg.policy?.protectedPaths ?? []).join('\n') || '(none)' },
      { kind: 'test-evidence', label: 'CHECKS ALREADY RUN',
        content: outcomes.map((o, i) => `${required[i]?.name ?? 'check'}: ${o}`).join('\n') || '(none)' },
    ];
    const payload = buildReviewPayload({
      taskId, projectId: this.projectId, baseSha: rec.baseSha, headSha,
      inputs: reviewInputs, policy: this.reviewPolicy,
      header: [
        'Independently review this change against current source.',
        'No planning rationale, implementation notes or previous verdicts are included:',
        'your review must be your own, formed from the task and the code.',
        'Reply with ONLY: {"findings":[{"severity":"CRITICAL|IMPORTANT|SUGGESTION","claim":"...","file":"..."}],',
        ' "evidence":{"sourceInspected":true,"filesInspected":[],"evidenceSummary":"..."},',
        ' "usedContext":["task-requirement","diff"]}',
      ].join('\n'),
    });
    this.events.append({ taskId, type: 'REVIEW_CONTEXT', payload: {
      reviewInvocationId: payload.reviewInvocationId,
      baseSha: payload.baseSha, headSha: payload.headSha,
      configuredContext: payload.configuredContext,
      deliveredContext: payload.deliveredContext,
      hashes: payload.hashes, promptHash: payload.promptHash, promptBytes: payload.promptBytes,
      violations: payload.violations, valid: payload.valid,
    } });
    if (!payload.valid) {
      // A contaminated review is not a review. It is refused, not annotated.
      this.setState(taskId, 'NEEDS_RECONCILIATION', 'review', {
        reason: `REVIEW_CONTEXT_POLICY_VIOLATION: ${payload.violations.map((v) => v.detail).join('; ')}`,
      });
      return 'NEEDS_RECONCILIATION';
    }
    const review = await this.agent('reviewer', rec, payload.prompt, true);
    const reported = reconcileReviewerReport(payload, review.structured);
    if (!reported.consistent) {
      // Self-report is never authoritative; a claim about unsupplied context
      // goes on the record rather than being believed.
      this.events.append({ taskId, type: 'REVIEW_CLAIM_UNSUPPORTED', payload: {
        reviewInvocationId: payload.reviewInvocationId, unsupportedClaims: reported.unsupportedClaims,
      } });
    }
    if (!review.ok && review.infrastructureFailure) {
      this.setState(taskId, 'NEEDS_RECONCILIATION', 'review', { reason: review.infrastructureFailure });
      return 'NEEDS_RECONCILIATION';
    }
    const findings = ((review.structured?.findings as any[]) ?? []);
    this.events.append({ taskId, type: 'FINDINGS', payload: { findings, count: findings.length } });
    const blockers = findings.filter((f) => ['CRITICAL', 'IMPORTANT'].includes(String(f?.severity)));
    if (this.task(taskId)?.cancelRequested) return 'CANCELLED';

    // ---- FINAL ACCEPTANCE --------------------------------------------------
    this.setState(taskId, 'FINAL_ACCEPTANCE', 'final');
    if (blockers.length) {
      this.setState(taskId, 'BLOCKED', 'final', { reason: `${blockers.length} material finding(s)` });
      return 'BLOCKED';
    }
    this.events.append({ taskId, type: 'ACCEPTED', payload: {
      filesChanged: changed, checks: outcomes,
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

  changedFiles(rec: TaskRecord): string[] {
    try {
      const out = require('child_process')
        .execFileSync('git', ['-C', rec.worktree, 'status', '--porcelain'], { encoding: 'utf8', timeout: 30_000 });
      return out.split('\n').filter(Boolean).map((l: string) => l.slice(3).trim());
    } catch { return []; }
  }

  diff(rec: TaskRecord): string {
    try {
      return require('child_process')
        .execFileSync('git', ['-C', rec.worktree, 'diff', '--stat', '-p'], { encoding: 'utf8', timeout: 60_000, maxBuffer: 32 * 1024 * 1024 });
    } catch { return '(diff unavailable)'; }
  }

  logs(taskId: string, limit = 200): StoredEvent[] {
    return this.events.read(taskId).slice(-limit);
  }
}
