/**
 * Model providers.
 *
 * Three roles, deliberately separated: a planner, an implementer and an
 * INDEPENDENT reviewer. The reviewer never receives the planner's conclusions —
 * that separation is the point of having a reviewer at all, and it is enforced
 * here by what the caller is allowed to pass, not by asking the model nicely.
 *
 * Every provider runs through the ProcessSupervisor like any other execution,
 * so an agent CLI is bounded, timed and killable exactly like a test suite.
 */

import { ProcessSupervisor, ExecutionRequest } from './exec';
import { unwrapProviderStream, ProviderUsage, RateLimitNote } from './unwrap';
import { ExecutionPolicy } from './policy';
import { redactSecrets } from './redact';

export type Role = 'planner' | 'implementer' | 'reviewer';

export interface AgentRequest {
  role: Role;
  taskId: string;
  projectId: string;
  prompt: string;
  policy: ExecutionPolicy;
  /** Implementers may write; planners and reviewers may not. */
  readOnly: boolean;
  timeoutSeconds?: number;
  /**
   * The model and effort Zeus resolved for this call's pipeline stage.
   *
   * Null means "the provider CLI decides", and that is a STATED position
   * rather than an absence: before these existed, every call ran on whatever
   * those CLIs happened to be configured with, which was invisible to the log
   * and different on another machine. A mission could not say which model
   * wrote its plan.
   */
  model?: string | null;
  reasoning?: string | null;
  /** The stage this call serves, for the record. Roles collapse seven into three. */
  stage?: string;
}

export interface AgentResponse {
  ok: boolean;
  role: Role;
  /** Parsed JSON when the agent produced it, else null. */
  structured: Record<string, unknown> | null;
  text: string;
  raw: string;
  exitCode: number | null;
  durationMs: number;
  outcome: string;
  /** Set when the failure was infrastructure rather than the agent's answer. */
  infrastructureFailure: string | null;
  /** The provider's own error fields, so a failure is diagnosable from the log. */
  diagnostics?: Record<string, unknown>;
  /**
   * Cost and token counts AS THE PROVIDER REPORTED THEM.
   *
   * Never computed, never estimated: Zeus does not know model pricing and any
   * number it invented would be a fiction that later got budgeted against.
   * Absent fields stay absent rather than becoming zero.
   */
  providerUsage?: ProviderUsage;
  /** Quota state, when the CLI volunteered it. */
  rateLimit?: RateLimitNote;
  /**
   * Monotonic instants around the provider's child process, passed straight
   * through from the supervisor. Without this the caller can time the wrapper
   * but not the process, so model startup cost stays invisible.
   */
  timing?: { requestedNs: string; spawnedNs: string; firstOutputNs: string | null; exitedNs: string };
}

export interface Provider {
  id: string;
  /** Whether this provider can run at all right now. */
  available(): Promise<{ ok: boolean; detail: string }>;
  invoke(req: AgentRequest, sup: ProcessSupervisor): Promise<AgentResponse>;
}

/** Extracts the last JSON object in a stream of agent output. */
/**
 * Whether a provider call failed as INFRASTRUCTURE, and why.
 *
 * The keyword sweep is a last resort, and it may only look at output that
 * produced no usable answer.
 *
 * It used to run over stdout unconditionally — the model's own words included.
 * A planner returned exit 0, subtype "success", and a structured payload
 * carrying all four expected keys, and the whole thing was thrown away as
 * PROVIDER_UNAVAILABLE because one of these words appeared somewhere in 376KB
 * of what the model had written. Nothing was unavailable. An outage inferred
 * from the contents of a successful answer is not an inference, it is a
 * coincidence — and this one cost a mission its only node, then told the
 * operator to retry something that had never broken.
 *
 * A call that came back parsed is not an outage, whatever it says.
 */
export function classifyInfrastructure(input: {
  outcome: string; stdout: string; providerError?: string | null; answered: boolean;
}): string | null {
  if (['TIMEOUT', 'RESOURCE_LIMIT_EXCEEDED', 'INFRASTRUCTURE_FAILURE', 'POLICY_DENIED']
    .includes(input.outcome)) {
    return `${input.outcome}: ${input.stdout.slice(-300)}`;
  }
  if (input.providerError) return `PROVIDER_ERROR: ${input.providerError}`;
  if (input.answered) return null;
  return /\b(429|529|overloaded|rate.?limit|ECONNRESET|socket hang up)\b/i.test(input.stdout)
    ? `PROVIDER_UNAVAILABLE: ${input.stdout.slice(-200)}` : null;
}

export function parseStructured(text: string): Record<string, unknown> | null {
  const objects: string[] = [];
  let depth = 0, start = -1, inStr = false, esc = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (esc) { esc = false; continue; }
    if (inStr) { if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') { inStr = true; continue; }
    if (c === '{') { if (depth === 0) start = i; depth += 1; }
    else if (c === '}') { depth -= 1; if (depth === 0 && start >= 0) { objects.push(text.slice(start, i + 1)); start = -1; } }
  }
  for (let i = objects.length - 1; i >= 0; i -= 1) {
    try { const o = JSON.parse(objects[i]); if (o && typeof o === 'object' && !Array.isArray(o)) return o; }
    catch { /* try the next one */ }
  }
  return null;
}

/** Shared CLI-provider implementation: build argv, run it, parse the reply. */
async function runCli(id: string, bin: string, argv: (req: AgentRequest) => string[],
  req: AgentRequest, sup: ProcessSupervisor): Promise<AgentResponse> {
  const started = Date.now();
  const res = await sup.run({
    id: `${req.taskId}-${req.role}-${started}`,
    projectId: req.projectId, taskId: req.taskId,
    cls: 'agent', command: bin, args: argv(req),
    cwd: req.policy.worktreeRoot,
    policy: req.readOnly
      ? { ...req.policy, writablePaths: [] }   // a reviewer cannot write, structurally
      : req.policy,
    // Agents need their own config/auth in $HOME, so filesystem confinement is
    // applied by the policy's writable set rather than a bwrap jail here.
    confineFilesystem: false,
    // The prompt is prose we authored; scanning it for shell patterns would
    // reject a task description that merely mentions a path.
    inspectArgs: false,
    timeoutSeconds: req.timeoutSeconds ?? 1200,
  } as ExecutionRequest);

  // The model's text lives inside stream events; unwrap before parsing. See
  // src/engine/unwrap.ts for the captured shapes this is derived from.
  const stream = unwrapProviderStream(id, res.stdout);
  const structured = parseStructured(stream.text);

  // The vendor CLIs report their own failures in structured fields, not only in
  // prose. Reading just the text meant an API error arrived as a plain non-zero
  // exit and became "design failed" — a statement about the user's task, when
  // the truth was that Zeus could not run the planner at all. That is precisely
  // the confusion the outcome vocabulary exists to prevent, so the provider's
  // own signal is now believed before any pattern matching.
  // Read the CLI's OWN terminal event for this, not the model's payload: the
  // payload knows nothing about is_error, subtype or permission_denials, and
  // reading it here would quietly undo the fix that made a provider outage
  // stop looking like a failed design.
  const providerError = providerReportedError(stream.controlEvent ?? structured);

  const infra = classifyInfrastructure({
    outcome: res.outcome, stdout: res.stdout, providerError,
    answered: structured !== null && structured !== undefined,
  });

  // Diagnostics worth the name. "It didn't parse" cost a supervised session a
  // manual reproduction; the next failure explains itself.
  const diagnostics: Record<string, unknown> = {
    ...providerDiagnostics(stream.controlEvent ?? structured),
    exitCode: res.exitCode,
    outputBytes: Buffer.byteLength(res.stdout),
    streamEvents: stream.events,
    nonJsonLines: stream.nonJsonLines,
    unwrapSource: stream.source,
    parsedStructured: !!structured,
  };
  if (!structured) {
    // The tail of the UNWRAPPED text, which is what failed to parse — the raw
    // stream's tail is a wrapper event and tells the reader nothing.
    diagnostics.unwrappedTail = redactSecrets(stream.text.slice(-400)).text;
  }
  if (stream.rateLimit) {
    diagnostics.rateLimit = stream.rateLimit;
    if (stream.rateLimit.constrained) {
      // "Quota exhausted until <time>" is a different human action from "the
      // provider is broken", and they used to be the same sentence.
      diagnostics.quotaNote = `${stream.rateLimit.status}`
        + (stream.rateLimit.overageStatus ? `, overage ${stream.rateLimit.overageStatus}` : '')
        + (stream.rateLimit.overageDisabledReason ? ` (${stream.rateLimit.overageDisabledReason})` : '')
        + (stream.rateLimit.resetsAtIso ? `, resets at ${stream.rateLimit.resetsAtIso}` : '');
    }
  }

  return {
    ok: res.outcome === 'COMPLETED' && !infra,
    role: req.role, structured,
    // The UNWRAPPED text: what the model actually said.
    text: stream.text.slice(-4000),
    // The raw stream survives for diagnostics.
    raw: res.stdout, exitCode: res.exitCode, durationMs: res.durationMs,
    outcome: res.outcome, infrastructureFailure: infra,
    diagnostics,
    ...(stream.usage ? { providerUsage: stream.usage } : {}),
    ...(stream.rateLimit ? { rateLimit: stream.rateLimit } : {}),
    timing: res.timing,
  };
}

/**
 * The provider's own verdict on whether IT failed.
 *
 * Returns a human-readable reason when the CLI says the call did not succeed,
 * or null when it reports success. Deliberately conservative: an absent field
 * is not evidence of failure, because treating "no opinion" as an outage would
 * turn every parse miss into an infrastructure incident.
 */
export function providerReportedError(structured: Record<string, unknown> | null): string | null {
  if (!structured) return null;
  const s = structured as any;
  const parts: string[] = [];
  if (s.is_error === true) parts.push('is_error=true');
  if (typeof s.api_error_status === 'number' || (typeof s.api_error_status === 'string' && s.api_error_status)) {
    parts.push(`api_error_status=${s.api_error_status}`);
  }
  if (typeof s.subtype === 'string' && /error|refus|denied|limit/i.test(s.subtype)) parts.push(`subtype=${s.subtype}`);
  if (typeof s.terminal_reason === 'string' && !/completed|end_turn|success/i.test(s.terminal_reason)) {
    parts.push(`terminal_reason=${s.terminal_reason}`);
  }
  if (Array.isArray(s.permission_denials) && s.permission_denials.length) {
    parts.push(`permission_denials=${s.permission_denials.length}`);
  }
  return parts.length ? parts.join(' ') : null;
}

/**
 * The fields worth recording when an agent call fails.
 *
 * The failure that produced this function recorded only the NAMES of the
 * provider's response fields, so an operator debugging it had a list of keys
 * and no values. Diagnosing a failure should not require reproducing it.
 */
export function providerDiagnostics(structured: Record<string, unknown> | null): Record<string, unknown> {
  if (!structured) return {};
  const s = structured as any;
  const out: Record<string, unknown> = {};
  for (const k of ['is_error', 'subtype', 'api_error_status', 'terminal_reason', 'stop_reason', 'num_turns']) {
    if (s[k] !== undefined) out[k] = s[k];
  }
  if (Array.isArray(s.permission_denials) && s.permission_denials.length) {
    out.permission_denials = s.permission_denials.slice(0, 3);
  }
  if (typeof s.result === 'string') out.resultExcerpt = s.result.slice(0, 300);
  return out;
}

function whichSync(bin: string): string | null {
  const { spawnSync } = require('child_process');
  const r = spawnSync('sh', ['-c', `command -v ${bin}`], { encoding: 'utf8', timeout: 5_000 });
  return (r.stdout ?? '').trim() || null;
}

/** Claude CLI — planning and implementation. Subscription auth only. */
export function claudeProvider(binOverride?: string): Provider {
  const bin = binOverride ?? process.env.ZEUS_CLAUDE_BIN ?? 'claude';
  return {
    id: 'claude',
    async available() {
      const found = binOverride ?? whichSync(bin);
      return found ? { ok: true, detail: found } : { ok: false, detail: `${bin} not found on PATH` };
    },
    invoke: (req, sup) => runCli('claude', bin, (r) => [
      '-p', r.prompt,
      // Only when Zeus resolved one. Passing an empty --model is not the same
      // as not passing it, and the difference is a failed call.
      ...(r.model ? ['--model', r.model] : []),
      ...(r.reasoning ? ['--effort', r.reasoning] : []),
      '--output-format', 'stream-json', '--include-partial-messages', '--verbose',
      '--permission-mode', r.readOnly ? 'manual' : 'acceptEdits',
      '--allowed-tools', ...(r.readOnly ? ['Read', 'Grep', 'Glob', 'Bash'] : ['Read', 'Grep', 'Glob', 'Edit', 'Write', 'Bash']),
    ], req, sup),
  };
}

/** Codex CLI — the independent reviewer, read-only by construction. */
export function codexProvider(binOverride?: string): Provider {
  const bin = binOverride ?? process.env.ZEUS_CODEX_BIN ?? 'codex';
  return {
    id: 'codex',
    async available() {
      const found = binOverride ?? whichSync(bin);
      return found ? { ok: true, detail: found } : { ok: false, detail: `${bin} not found on PATH` };
    },
    invoke: (req, sup) => runCli('codex', bin, (r) => [
      'exec', '--json', '--sandbox', 'read-only', '--skip-git-repo-check',
      ...(r.model ? ['--model', r.model] : []),
      // Codex takes effort as a config override rather than a flag of its own.
      ...(r.reasoning ? ['-c', `model_reasoning_effort=\"${r.reasoning}\"`] : []),
      r.prompt,
    ], req, sup),
  };
}

/**
 * Deterministic fake provider for tests and for `--dry-run`.
 *
 * It runs a real subprocess (so the supervisor, policy and governor are all
 * genuinely exercised) that echoes a canned structured reply.
 */
export function mockProvider(scripts: Partial<Record<Role, unknown>> = {}): Provider {
  return {
    id: 'mock',
    async available() { return { ok: true, detail: 'built-in deterministic provider' }; },
    async invoke(req, sup) {
      const reply = scripts[req.role] ?? defaultMockReply(req);
      const started = Date.now();
      const res = await sup.run({
        id: `${req.taskId}-${req.role}-${started}`,
        projectId: req.projectId, taskId: req.taskId, cls: 'agent',
        command: process.execPath,
        args: ['-e', `process.stdout.write(process.argv[1])`, JSON.stringify(reply)],
        cwd: req.policy.worktreeRoot, policy: req.policy, inspectArgs: false, timeoutSeconds: 60,
      } as ExecutionRequest);
      return {
        ok: res.outcome === 'COMPLETED', role: req.role,
        structured: parseStructured(res.stdout), text: res.stdout, raw: res.stdout,
        exitCode: res.exitCode, durationMs: res.durationMs, outcome: res.outcome,
        infrastructureFailure: res.productSignal ? null : `${res.outcome}`,
      };
    },
  };
}

/**
 * A deterministic reply shaped like the prompt that asked for it.
 *
 * The fake provider has to answer mission prompts as well as task prompts, and
 * it decides which from the PROMPT rather than from a flag: a caller that had
 * to remember to say "this is an oracle prompt" would be a caller that can
 * forget. Nothing here is model behaviour — it exists so the machinery around
 * a model can be exercised without one.
 */
function defaultMockReply(req: AgentRequest): unknown {
  const p = req.prompt ?? '';
  if (/Compile this mission goal into a CONTRACT/.test(p)) {
    // Derive one EXECUTABLE criterion per declared command, each tied to a
    // command the project really has, so the compiled contract is resolvable.
    const commands = (() => {
      const m = /--- declared commands ---\n([\s\S]*?)\n--- /.exec(p);
      try { return m ? JSON.parse(m[1]) as Record<string, string> : {}; } catch { return {}; }
    })();
    const failing = (() => {
      const m = /--- currently failing checks ---\n([\s\S]*?)\n--- /.exec(p);
      return m ? m[1].split('\n').map((x) => x.trim()).filter((x) => x && x !== '(none)') : [];
    })();
    const names = Object.keys(commands).filter((k) => commands[k]);
    return { criteria: names.slice(0, 3).map((name, i) => ({
      criterionId: `${req.taskId}/C-${String(i + 1).padStart(4, '0')}`,
      type: 'EXECUTABLE',
      statement: `the ${name} check passes`,
      evaluator: { kind: 'command', command: commands[name], expect: 'PASSED' },
      affectedBy: ['src/**'], required: true, requiresAuthority: [],
      derivedFrom: failing.includes(name) ? [name] : [],
    })) };
  }
  if (/^Plan the work that will satisfy this mission contract/.test(p)) {
    // One node per required criterion, each covering exactly that criterion.
    // Enough for the coverage rule to be satisfiable and for the scheduler to
    // have real edges, without pretending to be a planner.
    const criteria = (() => {
      const m = /--- accepted criteria ---\n([\s\S]*?)\n--- /.exec(p);
      try { return m ? JSON.parse(m[1]) as Array<any> : []; } catch { return []; }
    })();
    const required = criteria.filter((c) => c?.required);
    return { nodes: required.map((c, i) => ({
      nodeId: `node-${i + 1}`,
      description: `satisfy ${c.statement ?? c.criterionId}`,
      dependsOn: i === 0 ? [] : [`node-${i}`],
      preconditions: [], reads: ['src/**'], writes: ['src/**'],
      affectedCriteria: [c.criterionId],
      predictedEffects: [], estimatedTier: 'FAST', estimatedCost: 1, risk: 'LOW',
    })) };
  }
  if (/^Review this plan INDEPENDENTLY/.test(p)) {
    return { findings: [], usedContext: ['mission-goal', 'accepted-criteria', 'task-plan'] };
  }
  if (/reviewing a compiled mission contract/.test(p)) {
    return { findings: [], modeOpinion: null, usedContext: ['mission-goal', 'compiled-criteria'] };
  }
  if (/Decide whether the artifacts below satisfy the rubric/.test(p)) {
    return { satisfied: true, findings: [], evidenceSummary: 'mock judgment',
      usedContext: ['criterion-rubric', 'judged-artifact'] };
  }
  if (req.role === 'planner') {
    return { plan: 'mock plan', scopeAllowlist: [], requiredTests: [], predictions: [], acceptance: [] };
  }
  if (req.role === 'implementer') return { status: 'IMPLEMENTED', filesChanged: [] };
  return { findings: [], evidence: { sourceInspected: true, filesInspected: [], evidenceSummary: 'mock review' } };
}
