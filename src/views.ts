/**
 * The shapes the CLI's `--json` paths emit, extracted so a second caller
 * cannot invent a second shape.
 *
 * The web is a CLIENT of the engine, and the cheapest way for that claim to
 * quietly stop being true is for the HTTP layer to build its own view of a
 * mission "just for the UI". Two serializers drift, and the one that drifts
 * silently is the one a human is looking at. So both callers come here.
 *
 * Everything below is a projection of the EVENT LOG. Nothing consults an
 * in-memory object a caller could have influenced.
 */

import * as fs from 'fs';
import * as path from 'path';
import { TraceStore } from './trace';
import { MissionRegistry } from './mission/registry';
import { MissionRecord } from './mission/types';
import { Oracle } from './mission/oracle';
import {
  missionUsage, progressFrom, providerSpendOf, MissionUsage, ProgressScore,
  applyBudgetRevisions, mergeMissionBudgets, MissionBudgets,
} from './mission/progress';
import { ratchetRef, readRatchet } from './mission/ratchet';
import { StoredEvent } from './engine/events';

/** Provider cost lives on the spawned task's log, not the mission's. */
export function spendReader(missions: MissionRegistry) {
  return (taskId: string) => {
    try { return providerSpendOf(missions.events.read(taskId)); }
    catch { return { costUsd: 0, unmetered: 0 }; }
  };
}

export interface MissionStatusView extends MissionRecord {
  ratchetRef: string;
  ratchetRefSha: string | null;
  /**
   * The limits this mission is operating under, revisions replayed.
   *
   * Part of the RECORD, not a decoration the web adds: it is derived purely
   * from the log, it is the same object checkMissionBudgets is handed, and
   * both callers need it — the console had nothing to draw a gauge against
   * and `mission status --json` never mentioned a ceiling either.
   */
  budgets: MissionBudgets;
}

/** Exactly what `zeus mission status --json` prints. */
export function missionStatusView(missions: MissionRegistry, root: string,
  missionId: string): MissionStatusView | null {
  const rec = missions.mission(missionId);
  if (!rec) return null;
  return {
    ...rec, ratchetRef: ratchetRef(missionId), ratchetRefSha: readRatchet(root, missionId),
    budgets: applyBudgetRevisions(mergeMissionBudgets(), missions.events.read(missionId)),
  };
}

/** Exactly what `zeus mission list --json` prints. */
export function missionListView(missions: MissionRegistry): MissionRecord[] {
  return missions.list().map((id) => missions.mission(id))
    .filter((r): r is MissionRecord => !!r);
}

export interface MissionReportView {
  mission: MissionRecord;
  usage: MissionUsage;
  score: ProgressScore;
  integrations: unknown[];
  mismatches: unknown[];
  flips: unknown[];
  replans: unknown[];
  escalations: unknown[];
}

/** Exactly what `zeus mission report --json` prints. */
export function missionReportView(missions: MissionRegistry,
  missionId: string, now = Date.now()): MissionReportView | null {
  const rec = missions.mission(missionId);
  if (!rec) return null;
  const log = missions.events.read(missionId);
  const of = (t: string) => log.filter((e) => e.type === t).map((e) => e.payload as unknown);
  return {
    mission: rec,
    usage: missionUsage(log, now, spendReader(missions)),
    score: progressFrom(log),
    integrations: of('INTEGRATION_RESULT'),
    mismatches: of('EFFECT_MISMATCH'),
    flips: of('OSCILLATION_DETECTED'),
    replans: of('MISSION_REPLAN'),
    escalations: of('MISSION_ESCALATED'),
  };
}

/**
 * The phase a mission is in, derived from its log.
 *
 * A rendering convenience with no authority: nothing branches on it, and the
 * per-criterion outcomes and terminal fields remain the truth. It exists so a
 * live view can say "Critic" instead of making the reader infer it.
 */
export type MissionPhase =
  | 'CREATED' | 'ORACLE' | 'CONSENT' | 'PLANNING' | 'PLAN_CONSENT'
  | 'RUNNING' | 'INTEGRATING' | 'EVALUATING' | 'TERMINATED';

export function missionPhase(events: StoredEvent[]): MissionPhase {
  let phase: MissionPhase = 'CREATED';
  for (const e of events) {
    switch (e.type) {
      case 'ORACLE_COMPILED': case 'ORACLE_RECOMPILED': phase = 'ORACLE'; break;
      case 'ORACLE_CRITIQUED': phase = 'CONSENT'; break;
      case 'ORACLE_ACCEPTED': phase = 'PLANNING'; break;
      case 'PLAN_RECORDED': case 'PLAN_REJECTED': phase = 'PLANNING'; break;
      case 'PLAN_CRITIQUED': phase = 'PLAN_CONSENT'; break;
      case 'PLAN_ACCEPTED': phase = 'RUNNING'; break;
      case 'TASK_SPAWNED': phase = 'RUNNING'; break;
      case 'INTEGRATION_RESULT': phase = 'INTEGRATING'; break;
      case 'ORACLE_EVALUATED': phase = 'EVALUATING'; break;
      case 'MISSION_TERMINATED': phase = 'TERMINATED'; break;
      default: break;
    }
  }
  return phase;
}

/**
 * Spend, broken down by the phase that incurred it.
 *
 * Reads providerUsage wherever it was recorded — the mission's own events for
 * pre-execution calls, and each spawned task's log for execution. Unpriced
 * calls stay counted as unmetered, never folded in as zero.
 */
export interface CostBreakdown {
  byPhase: Record<string, number>;
  totalUsd: number;
  unmeteredCalls: number;
  /** True when at least one call reported no price, so the total is a floor. */
  isLowerBound: boolean;
}

const PHASE_OF: Record<string, string> = {
  ORACLE_COMPILED: 'oracle', ORACLE_RECOMPILED: 'oracle', ORACLE_CRITIQUED: 'critic',
  PLAN_RECORDED: 'planner', PLAN_CRITIQUED: 'plan-critic',
};

export function costBreakdown(missions: MissionRegistry, missionId: string): CostBreakdown {
  const byPhase: Record<string, number> = {};
  let unmeteredCalls = 0;
  const add = (phase: string, e: StoredEvent) => {
    const u = (e.payload as any)?.providerUsage as { totalCostUsd?: unknown } | undefined;
    if (!u || typeof u !== 'object') return;
    if (typeof u.totalCostUsd === 'number' && Number.isFinite(u.totalCostUsd)) {
      byPhase[phase] = Number(((byPhase[phase] ?? 0) + u.totalCostUsd).toFixed(6));
    } else unmeteredCalls += 1;
  };

  const log = missions.events.read(missionId);
  for (const e of log) add(PHASE_OF[e.type] ?? 'other', e);
  for (const e of log) {
    if (e.type !== 'TASK_SPAWNED') continue;
    const taskId = (e.payload as any)?.taskId;
    if (typeof taskId !== 'string') continue;
    try { for (const te of missions.events.read(taskId)) add('execution', te); }
    catch { /* a task whose log is unreadable contributes nothing, and says so via unmetered */ }
  }
  const totalUsd = Number(Object.values(byPhase).reduce((a, b) => a + b, 0).toFixed(6));
  return { byPhase, totalUsd, unmeteredCalls, isLowerBound: unmeteredCalls > 0 };
}

/**
 * Everything on the record about one mission, as one readable document.
 *
 * The mission's own log, every task it spawned, the project chat from the
 * moment it began, and the runner's own output. Assembled for a person to
 * paste somewhere — into an issue, a message, another model — which is why it
 * is text rather than JSON: the reader is not always a program.
 *
 * WHAT IS NOT HERE is stated at the top of the document rather than left to be
 * discovered. Prompts and raw model replies are not stored anywhere: events
 * carry promptHash and promptBytes, a fingerprint and a size, never the words.
 * What the agents PRODUCED — designs, findings, reviews, constraints — is
 * here in full, because that is what the log keeps.
 */
export function missionBundle(missions: MissionRegistry, missionId: string,
  opts: { projectRoot?: string; stateRoot?: string; now?: string } = {}): string | null {
  const rec = missions.mission(missionId);
  if (!rec) return null;

  const lines: string[] = [];
  const rule = (title: string) => {
    lines.push('');
    lines.push(`${'\u2500'.repeat(8)} ${title} ${'\u2500'.repeat(8)}`);
    lines.push('');
  };
  const dump = (events: StoredEvent[]) => {
    for (const e of events) {
      lines.push(`[${e.seq}] ${e.ts} ${e.type}`);
      const payload = JSON.stringify(e.payload ?? {}, null, 1);
      for (const l of payload.split('\n')) lines.push(`    ${l}`);
      lines.push('');
    }
  };

  const missionLog = missions.events.read(missionId);
  const startedAt = missionLog.length ? missionLog[0].ts : '';
  const taskIds = rec.spawned.map((s) => s.taskId);

  const taskLogs: Array<{ taskId: string; events: StoredEvent[] }> = [];
  for (const taskId of taskIds) {
    try { taskLogs.push({ taskId, events: missions.events.read(taskId) }); }
    catch { taskLogs.push({ taskId, events: [] }); }
  }

  let chat: StoredEvent[] = [];
  // The project id is the mission id's first segment. The chat stream lives
  // beside the missions, under the same project.
  const chatId = `${missionId.split('/')[0]}/CHAT`;
  try {
    chat = missions.events.read(chatId).filter((e) => !startedAt || e.ts >= startedAt);
  } catch { chat = []; }

  /**
   * The conversations themselves, when the level kept them.
   *
   * The bundle used to state flatly that prompts and raw replies "are not
   * stored" — the same claim the trace footer made while audit was busy
   * storing them. What is on disk belongs in the document that says it is the
   * whole record, and what is NOT on disk has to be said as a fact about this
   * mission rather than as a fact about Zeus.
   *
   * Level is not consulted here. The refs on the log say what was kept and
   * whether it was redacted; reading the CURRENT level would describe a
   * setting rather than these bytes, and the two differ the moment it changes.
   */
  const convo: Array<{ taskId: string; callId: string; stage: string; kind: string;
    ref: any; text: string | null }> = [];
  const store = opts.stateRoot ? new TraceStore(opts.stateRoot) : null;
  for (const t of [{ taskId: missionId, events: missionLog }, ...taskLogs]) {
    for (const e of t.events) {
      const pl = (e.payload ?? {}) as any;
      for (const kind of ['promptBlob', 'responseBlob']) {
        const ref = pl[kind];
        if (!ref || typeof ref.hash !== 'string') continue;
        convo.push({
          taskId: t.taskId,
          callId: String(pl.traceCallId ?? '?'),
          stage: String(pl.stage ?? pl.role ?? '?'),
          kind: kind === 'promptBlob' ? 'prompt' : 'reply',
          ref,
          text: store ? store.get(ref) : null,
        });
      }
    }
  }
  const rawKept = convo.filter((c) => c.text !== null && !c.ref.redacted).length;
  const redactedKept = convo.filter((c) => c.text !== null && c.ref.redacted).length;
  const gone = convo.filter((c) => c.text === null).length;

  let runLog = '';
  let runLogPath: string | null = null;
  if (opts.projectRoot) {
    runLogPath = path.join(opts.projectRoot, '.zeus', 'logs',
      `mission-run-${missionId.split('/').pop()}.log`);
    try { runLog = fs.readFileSync(runLogPath, 'utf8'); } catch { runLog = ''; }
  }

  lines.push('ZEUS MISSION TRANSCRIPT');
  lines.push(`mission    ${missionId}`);
  lines.push(`goal       ${rec.goal}`);
  lines.push(`started    ${startedAt || 'unknown'}`);
  lines.push(`generated  ${opts.now ?? new Date().toISOString()}`);
  lines.push(`state      ${rec.terminated
    ? `${rec.achievement} / ${rec.terminationReason}` : 'not terminated'}`);
  lines.push('');
  lines.push('CONTAINS');
  lines.push(`  mission log        ${missionLog.length} event(s)`);
  lines.push(`  task logs          ${taskLogs.length} task(s), `
    + `${taskLogs.reduce((a, t) => a + t.events.length, 0)} event(s)`);
  lines.push(`  project chat       ${chat.length} event(s) since this mission began`);
  lines.push(`  runner output      ${runLog ? `${runLog.split('\n').length} line(s)` : 'none on disk'}`);
  lines.push(`  model conversation ${convo.length
    ? `${convo.length} of them \u2014 ${rawKept} raw, ${redactedKept} redacted`
      + `${gone ? `, ${gone} expired or swept` : ''}`
    : 'none kept for this mission'}`);
  lines.push('');
  if (rawKept) {
    // Said at the top, in the document itself, because the person who pastes
    // this somewhere is not the person who set the level three days ago.
    lines.push('\u26a0 THIS TRANSCRIPT CONTAINS UNREDACTED MODEL CONVERSATIONS');
    lines.push(`  ${rawKept} prompt(s)/reply(s) were captured at trace level debug and are`);
    lines.push('  included below exactly as sent and received. They may contain source');
    lines.push('  code, secrets, credentials and personal data. Read before sending this');
    lines.push('  anywhere.');
    lines.push('');
  }
  lines.push('NOT CONTAINED');
  if (!convo.length) {
    lines.push('  No prompts or raw replies were kept for this mission — its calls ran at');
    lines.push('  trace level normal, which records promptHash and promptBytes: a');
    lines.push('  fingerprint and a size, never the words. Raising the level now cannot');
    lines.push('  reach back and fill them in.');
  } else if (gone) {
    lines.push(`  ${gone} kept conversation(s) have expired and been swept from disk. The`);
    lines.push('  event log still records that they existed, with their hash and size.');
  } else {
    lines.push('  Everything the log kept for this mission is included.');
  }
  lines.push('  What the agents PRODUCED is here in full either way: designs, findings,');
  lines.push('  reviews, constraints, checks and their outcomes.');
  lines.push('');
  lines.push('  Event payloads passed the redacting sink when they were written. The');
  lines.push('  runner output did NOT — it is the process\u2019s own stdout, kept as it');
  lines.push('  was printed. Read it before sending this anywhere.');
  lines.push('');
  lines.push('  The chat stream is per PROJECT, not per mission, so messages about other');
  lines.push('  missions in the same window are included rather than guessed at.');

  rule(`mission ${missionId}`);
  dump(missionLog);

  for (const t of taskLogs) {
    rule(`task ${t.taskId}`);
    if (!t.events.length) lines.push('(no log on disk for this task)');
    else dump(t.events);
  }

  rule(`project chat since ${startedAt || 'the beginning'}`);
  if (!chat.length) lines.push('(nothing)');
  else dump(chat);

  if (convo.length) {
    rule('model conversations');
    for (const c of convo) {
      const state = c.text === null
        ? 'EXPIRED — swept from disk'
        : (c.ref.redacted ? 'redacted before it was written' : 'RAW, unredacted');
      lines.push(`\u2500\u2500 ${c.taskId} \u00b7 ${c.stage} \u00b7 ${c.kind}`
        + ` \u00b7 ${c.callId}`);
      lines.push(`   ${state} \u00b7 ${c.ref.bytes ?? '?'} bytes`
        + `${c.ref.truncated ? ' \u00b7 TRUNCATED by Zeus' : ''}`
        + `${c.ref.expiresAt ? ` \u00b7 expires ${c.ref.expiresAt}` : ''}`);
      lines.push('');
      lines.push(c.text ?? '(content is gone; the log keeps only the hash and the size)');
      lines.push('');
    }
  }

  rule(`runner output${runLogPath ? ` \u2014 ${runLogPath}` : ''}`);
  lines.push(runLog || '(no runner output on disk; the mission may never have been run,'
    + ' or was run before output was captured)');

  return lines.join('\n');
}

export interface TraceCall {
  traceCallId: string;
  stage: string | null;
  role?: string;
  provider: string | null;
  configuredModel: string | null;
  configuredReasoning: string | null;
  reasoningSource?: string | null;
  actualModel: string | null;
  modelDiscrepancy: { configured: string; actual: string } | null;
  promptHash: string | null;
  promptBytes: number | null;
  /** What the model was actually given, derived from the assembly itself. */
  manifest: Array<Record<string, unknown>> | null;
  delivered: string[] | null;
  checklist: Array<Record<string, unknown>> | null;
  /** The policy this call captured when it began. Never re-read afterwards. */
  traceLevel: string | null;
  traceLevelSource: string | null;
  /** References, not content. Content is fetched deliberately, never listed. */
  promptBlob: Record<string, unknown> | null;
  responseBlob: Record<string, unknown> | null;
  /**
   * Whether this call HELD repository tools, and what it actually asked.
   *
   * Both, because they answer different questions. A call with no ops and no
   * attachment had nothing to ask with; a call with tools and no ops chose not
   * to ask, and that was a real bug once — the tools were attached, the server
   * was running, and the prompt had already told the model to answer.
   */
  graphAttached: boolean | null;
  graphOps: Array<Record<string, unknown>> | null;
  outcome: string | null;
  wallMs: number | null;
  providerTiming: Record<string, unknown> | null;
  usage: Record<string, unknown> | null;
  toolsUsed: string[] | null;
  parsed: { ok: boolean; structuredKeys: string[] } | null;
  infrastructureFailure: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  pid: number | null;
  /** RUNNING, COMPLETED, or ABANDONED when the process that opened it is gone. */
  status: 'RUNNING' | 'COMPLETED' | 'ABANDONED';
}

/**
 * Every model call this mission made, paired from the log.
 *
 * A STARTED with no FINISHED is not a call that is still going — it is a call
 * whose process may be dead, and the difference is the whole point. M-0012 was
 * killed four minutes into a call and left a record that would otherwise look
 * permanently in flight; the pid is checked against the world, exactly as the
 * mission runner's claim is.
 */
export function missionTrace(missions: MissionRegistry, missionId: string): TraceCall[] {
  const open = new Map<string, TraceCall>();
  const order: string[] = [];
  const logs: StoredEvent[][] = [missions.events.read(missionId)];
  const rec = missions.mission(missionId);
  for (const t of (rec?.spawned ?? [])) {
    try { logs.push(missions.events.read(t.taskId)); } catch { /* unreadable task log */ }
  }

  for (const log of logs) {
    for (const e of log) {
      const p = (e.payload ?? {}) as any;
      const id = typeof p.traceCallId === 'string' ? p.traceCallId : null;
      if (!id) continue;
      if (e.type === 'MODEL_CALL_STARTED') {
        if (!open.has(id)) order.push(id);
        open.set(id, {
          traceCallId: id,
          stage: p.stage ?? null, role: p.role, provider: p.provider ?? null,
          configuredModel: p.configuredModel ?? null,
          configuredReasoning: p.configuredReasoning ?? null,
          reasoningSource: p.reasoningSource ?? null,
          actualModel: null, modelDiscrepancy: null,
          promptHash: p.promptHash ?? null, promptBytes: p.promptBytes ?? null,
          manifest: Array.isArray(p.manifest) ? p.manifest : null,
          delivered: Array.isArray(p.delivered) ? p.delivered : null,
          checklist: Array.isArray(p.checklist) ? p.checklist : null,
          traceLevel: p.traceLevel ?? null,
          traceLevelSource: p.traceLevelSource ?? null,
          promptBlob: p.promptBlob ?? null,
          graphAttached: typeof p.graphAttached === 'boolean' ? p.graphAttached : null,
          graphOps: null,
          responseBlob: null,
          outcome: null, wallMs: null, providerTiming: null, usage: null,
          toolsUsed: null, parsed: null, infrastructureFailure: null,
          startedAt: p.startedAt ?? e.ts, finishedAt: null,
          pid: typeof p.pid === 'number' ? p.pid : null,
          status: 'RUNNING',
        });
      } else if (e.type === 'MODEL_CALL_FINISHED') {
        const call = open.get(id);
        if (!call) continue;
        call.actualModel = p.actualModel ?? null;
        call.modelDiscrepancy = p.modelDiscrepancy ?? null;
        call.outcome = p.outcome ?? null;
        call.wallMs = typeof p.wallMs === 'number' ? p.wallMs : null;
        // From the graph server's own log, carried onto the call it belongs to.
        call.graphOps = Array.isArray(p.graphOps) ? p.graphOps as any : null;
        call.providerTiming = p.providerTiming ?? null;
        call.usage = p.usage ?? null;
        call.toolsUsed = p.toolsUsed ?? null;
        call.parsed = p.parsed ?? null;
        call.infrastructureFailure = p.infrastructureFailure ?? null;
        call.responseBlob = p.responseBlob ?? null;
        call.finishedAt = p.finishedAt ?? e.ts;
        call.status = 'COMPLETED';
      }
    }
  }

  return order.map((id) => {
    const call = open.get(id)!;
    if (call.status !== 'RUNNING') return call;
    // Unfinished. Alive or abandoned is a question about the world, not the log.
    if (call.pid === null) return call;
    let alive = false;
    try { process.kill(call.pid, 0); alive = true; } catch { alive = false; }
    return alive ? call : { ...call, status: 'ABANDONED' as const };
  });
}

export interface CallComparison {
  a: string;
  b: string;
  /** Sections both calls got, byte for byte. */
  same: string[];
  /** In b and not in a — what the second call was told that the first was not. */
  added: string[];
  /** In a and not in b — what the second call LOST. */
  removed: string[];
  /** In both, but different content. */
  changed: string[];
  modelChanged: { from: string | null; to: string | null } | null;
  reasoningChanged: { from: string | null; to: string | null } | null;
  costDeltaMs: number | null;
}

/**
 * What the second call was given that the first was not.
 *
 * Two planner calls in a row repeated the same mistake because the second was
 * never given the critic's findings on the first. Establishing that took a
 * code read. Compared by SECTION HASH, this is one line: `blocking-findings`
 * appears in neither, or in both, and the answer is not an inference from the
 * plan that came back.
 */
export function compareCalls(calls: TraceCall[], aId: string, bId: string): CallComparison | null {
  const a = calls.find((c) => c.traceCallId === aId);
  const b = calls.find((c) => c.traceCallId === bId);
  if (!a || !b) return null;

  const index = (c: TraceCall) => {
    const m = new Map<string, string>();
    for (const entry of (c.manifest ?? [])) {
      const e = entry as any;
      // A withheld section was not given, whatever its hash says.
      if (e.included === false) continue;
      m.set(String(e.label), String(e.hash));
    }
    return m;
  };
  const ma = index(a); const mb = index(b);

  const same: string[] = []; const changed: string[] = [];
  for (const [label, hash] of ma) {
    if (!mb.has(label)) continue;
    (mb.get(label) === hash ? same : changed).push(label);
  }
  return {
    a: aId, b: bId,
    same: same.sort(),
    changed: changed.sort(),
    added: [...mb.keys()].filter((l) => !ma.has(l)).sort(),
    removed: [...ma.keys()].filter((l) => !mb.has(l)).sort(),
    modelChanged: (a.configuredModel ?? null) === (b.configuredModel ?? null) ? null
      : { from: a.configuredModel ?? null, to: b.configuredModel ?? null },
    reasoningChanged: (a.configuredReasoning ?? null) === (b.configuredReasoning ?? null) ? null
      : { from: a.configuredReasoning ?? null, to: b.configuredReasoning ?? null },
    costDeltaMs: (a.wallMs !== null && b.wallMs !== null) ? b.wallMs - a.wallMs : null,
  };
}

/** The oracle a mission accepted, or null. Read from the record, not a cache. */
export function oracleOf(rec: MissionRecord): Oracle | null {
  const o = rec.oracle as Oracle | null;
  return o && Array.isArray(o.criteria) ? o : null;
}

/** Where a mission's diff line runs from, for the read-only diff route. */
export function integrationLine(rec: MissionRecord): { from: string; to: string } {
  return { from: rec.baseSha, to: rec.ratchetSha ?? rec.baseSha };
}

export { path };
