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
import { parseDiff } from '../validation/diff';
import {
  resolveTier, planFor, impactConfidence, TierDecision, HardeningSettings, DEFAULT_HARDENING, Tier,
} from '../validation/tier';
import {
  designContract, inspectIntegrity, evidenceCoupledFiles, accountForTests, IntegrityReport,
} from '../validation/integrity';
import {
  evaluateExpansion, applyExpansion, unproductiveExpansion, ExpansionRequest, ExpansionState,
} from '../validation/expansion';
import { escalation, EscalationReason, EvidenceRef, NeededInput, renderEscalation } from '../validation/escalation';

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

/**
 * Secret-shaped substrings, removed before command output is recorded.
 *
 * Zeus strips credentials on the way INTO a project command and then used to
 * write whatever came back out into the append-only log. A test that echoes a
 * token, a failing assertion printing a connection string, a debug logger — any
 * of them made the secret permanent, because the log is hash-chained and
 * redacting later would break the chain.
 *
 * This is a net, not a guarantee: it catches recognisable shapes. Anything it
 * misses is still a reason to keep project output out of evidence bundles.
 */
const SECRET_SHAPES: Array<[RegExp, string]> = [
  [/\b(sk|pk|rk)-[A-Za-z0-9_-]{16,}/g, '[redacted:api-key]'],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, '[redacted:github-token]'],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, '[redacted:slack-token]'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '[redacted:aws-key-id]'],
  [/\bey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, '[redacted:jwt]'],
  [/\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:[^\s@/]+@/gi, '[redacted:credentialed-url]'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[redacted:private-key]'],
  [/\b([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|CREDENTIAL))\s*[=:]\s*\S+/g, '$1=[redacted]'],
];

export function redactSecrets(text: string): { text: string; redactions: number } {
  let out = text;
  let redactions = 0;
  for (const [re, replacement] of SECRET_SHAPES) {
    out = out.replace(re, (...args) => {
      redactions += 1;
      return replacement.includes('$1') ? replacement.replace('$1', String(args[1])) : replacement;
    });
  }
  return { text: out, redactions };
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
    this.events.append({ taskId, type: 'ESCALATION', payload: { ...payload, problems, rendered: renderEscalation(payload) } });
    if (problems.length) {
      this.events.append({ taskId, type: 'ESCALATION_INCOMPLETE', payload: {
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
      // Values, not just key names: a list of field names is not a diagnosis.
      diagnostics: res.diagnostics ?? {},
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
    // The command line is evidence too, and a project's configured command can
    // itself carry a secret (a token in a URL, a password flag). Redacting the
    // output while recording the command verbatim leaks it just as permanently.
    this.events.append({ taskId: rec.taskId, type: 'CHECK_RESULT', payload: {
      name, required, outcome, command: redactSecrets(commandLine).text, exitCode: res.exitCode,
      durationMs: res.durationMs, backend: res.backend, isolationFallback: res.isolationFallback,
      productSignal: res.productSignal, violations: res.violations,
      ...(() => {
        const r = redactSecrets(res.stdout.slice(-500));
        return { tail: r.text, ...(r.redactions ? { redactions: r.redactions } : {}) };
      })(),
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

    // ---- ADAPTIVE VALIDATION -----------------------------------------------
    // Classified per hunk, before anything is run. The tier is the MAXIMUM over
    // every hunk: a risky change bundled with a harmless one buys nothing.
    const rawDiff = this.diff(rec);
    const parsed = parseDiff(rawDiff);
    const hardening = this.hardening();
    const confidence = impactConfidence(parsed, cfg.project?.adapter ?? 'generic');
    let decision: TierDecision = resolveTier({
      diff: parsed, adapterId: cfg.project?.adapter ?? 'generic', confidence, hardening,
    });
    this.events.append({ taskId, type: 'VALIDATION_PLAN', payload: {
      tier: decision.tier, confidence: decision.confidence, fastEligible: decision.fastEligible,
      perHunk: decision.perHunk, escalations: decision.escalations, reasons: decision.reasons,
      testSurfaceFiles: decision.testSurfaceFiles, highRiskFiles: decision.highRiskFiles,
      adapter: cfg.project?.adapter, hardening: decision.hardening,
    } });

    // ---- EVIDENCE-CHAIN INTEGRITY -------------------------------------------
    // The one place where "the tests passed" could be a lie the platform told
    // itself. These rules are not configurable.
    const contract = designContract(design.structured);
    const integrity: IntegrityReport = inspectIntegrity(parsed, contract);
    const evidenceCoupled = evidenceCoupledFiles(parsed, contract);
    this.events.append({ taskId, type: 'EVIDENCE_INTEGRITY', payload: {
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
    const plan = planFor(decision.tier, (cfg.commands ?? {}) as unknown as Record<string, string | null | undefined>);
    const optional: Array<{ name: string; cmd: string; cls: 'light' | 'heavy' }> = [];
    for (const name of plan.additional) {
      const cmd = (cfg.commands as any)?.[name === 'unit-test' ? 'unitTest'
        : name === 'integration-test' ? 'integrationTest' : name];
      if (cmd) optional.push({ name, cmd, cls: name === 'integration-test' ? 'heavy' : 'light' });
    }
    this.events.append({ taskId, type: 'VALIDATION_SCOPE', payload: {
      tier: plan.tier, floor: required.map((r) => r.name), additional: optional.map((o) => o.name),
      note: 'the floor is authoritative and runs at every tier',
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
    const headSha = this.worktreeHead(rec);
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
    const payload = buildReviewPayload({
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
    });
    this.events.append({ taskId, type: 'REVIEW_CONTEXT', payload: {
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
      this.events.append({ taskId, type: 'REVIEW_CLAIM_UNSUPPORTED', payload: {
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
    this.events.append({ taskId, type: 'FINDINGS', payload: { findings, count: findings.length } });
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
      this.events.append({ taskId, type: 'REVIEW_EXPANSION', payload: {
        code: verdict.code, accepted: verdict.accepted, detail: verdict.detail,
        request: req, granted: expansionState.granted, budget: expansionState.budget,
      } });
      if (!verdict.accepted) break;

      expansionState.granted += 1;
      decision = applyExpansion(decision, req);
      this.events.append({ taskId, type: 'VALIDATION_PLAN', payload: {
        tier: decision.tier, confidence: decision.confidence, fastEligible: decision.fastEligible,
        escalations: decision.escalations, reasons: decision.reasons,
        cause: 'reviewerExpansion', perHunk: decision.perHunk,
      } });

      const expanded = planFor(decision.tier, (cfg.commands ?? {}) as unknown as Record<string, string | null | undefined>);
      for (const name of expanded.additional) {
        if (alreadyRun.has(name)) continue;
        const cmd = (cfg.commands as any)?.[name === 'integration-test' ? 'integrationTest' : name];
        if (!cmd) continue;
        alreadyRun.add(name);
        const { outcome } = await this.runCheck(rec, name, cmd, false, name === 'integration-test' ? 'heavy' : 'light');
        additionalOutcomes.push({ name, outcome });
      }

      const overBudget = this.budgetBreach(taskId);
      if (overBudget) return overBudget;

      const before = findings.length;
      const again = await this.agent('reviewer', rec, payload.prompt, true);
      const newFindings = ((again.structured?.findings as any[]) ?? []);
      findings = newFindings.length ? newFindings : findings;
      expansionState.findingsPerExpansion.push(Math.max(0, findings.length - before));
      this.events.append({ taskId, type: 'FINDINGS', payload: {
        findings, count: findings.length, afterExpansion: expansionState.granted,
      } });
      pending = again.structured?.expansionRequest as ExpansionRequest | undefined;
      if (this.task(taskId)?.cancelRequested) return 'CANCELLED';
    }

    const unproductive = unproductiveExpansion(expansionState);
    if (unproductive) this.events.append({ taskId, type: 'REVIEW_EXPANSION_UNPRODUCTIVE', payload: { ...unproductive } });

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
    this.events.append({ taskId, type: 'ACCEPTED', payload: {
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
      const out = cp.execFileSync('git', ['-C', rec.worktree, 'diff', '--name-only', rec.baseSha, '--'],
        { encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'] });
      for (const l of out.split('\n').filter(Boolean)) names.add(l.trim());
    } catch { /* fall through to status */ }
    // Belt and braces: anything git still will not diff (an unreadable path,
    // a submodule) is at least reported as changed rather than lost.
    try {
      const st = cp.execFileSync('git', ['-C', rec.worktree, 'status', '--porcelain'],
        { encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'] });
      for (const l of st.split('\n').filter(Boolean)) names.add(l.slice(3).trim());
    } catch { /* nothing more to add */ }
    return [...names].filter(Boolean);
  }

  diff(rec: TaskRecord): string {
    this.markIntentToAdd(rec);
    try {
      return require('child_process')
        .execFileSync('git', ['-C', rec.worktree, 'diff', '--stat', '-p', rec.baseSha, '--'],
          { encoding: 'utf8', timeout: 60_000, maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch { return '(diff unavailable)'; }
  }

  logs(taskId: string, limit = 200): StoredEvent[] {
    return this.events.read(taskId).slice(-limit);
  }
}
