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
import { ExecutionPolicy } from './policy';

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
}

export interface Provider {
  id: string;
  /** Whether this provider can run at all right now. */
  available(): Promise<{ ok: boolean; detail: string }>;
  invoke(req: AgentRequest, sup: ProcessSupervisor): Promise<AgentResponse>;
}

/** Extracts the last JSON object in a stream of agent output. */
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

  const infra = ['TIMEOUT', 'RESOURCE_LIMIT_EXCEEDED', 'INFRASTRUCTURE_FAILURE', 'POLICY_DENIED'].includes(res.outcome)
    ? `${res.outcome}: ${res.stdout.slice(-300)}`
    : /\b(429|529|overloaded|rate.?limit|ECONNRESET|socket hang up)\b/i.test(res.stdout)
      ? `PROVIDER_UNAVAILABLE: ${res.stdout.slice(-200)}` : null;

  return {
    ok: res.outcome === 'COMPLETED' && !infra,
    role: req.role, structured: parseStructured(res.stdout), text: res.stdout.slice(-4000),
    raw: res.stdout, exitCode: res.exitCode, durationMs: res.durationMs,
    outcome: res.outcome, infrastructureFailure: infra,
  };
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
      'exec', '--json', '--sandbox', 'read-only', '--skip-git-repo-check', r.prompt,
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

function defaultMockReply(req: AgentRequest): unknown {
  if (req.role === 'planner') {
    return { plan: 'mock plan', scopeAllowlist: [], requiredTests: [], predictions: [], acceptance: [] };
  }
  if (req.role === 'implementer') return { status: 'IMPLEMENTED', filesChanged: [] };
  return { findings: [], evidence: { sourceInspected: true, filesInspected: [], evidenceSummary: 'mock review' } };
}
