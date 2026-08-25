/**
 * Zeus's own state, as tools the front door can call.
 *
 * READ-ONLY BY CONSTRUCTION, the same way the graph tools are: this module
 * opens JSONL logs and returns what it read. There is no code path here that
 * appends an event, spawns a process or touches a worktree. A front door that
 * could cancel a mission by being asked nicely would not be a front door.
 *
 * TRACE POLICY IS HONOURED, not re-decided. Prompts and raw replies live in
 * the blob store only when the level kept them, and this returns their
 * metadata always and their content only when the ref says it was kept. An
 * inspector that could read words the level said were not stored would make
 * the level a suggestion.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { ToolSpec, Answer } from './mcp';

export interface StateSource {
  /** Where the event store lives. */
  stateRoot: string;
  projectId: string;
}

const taskDir = (root: string) => path.join(root, 'tasks');

function readLog(root: string, taskId: string, limit = 400): any[] {
  const file = path.join(taskDir(root), taskId.replace(/[^A-Za-z0-9_.-]/g, '~'), 'events.jsonl');
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const out: any[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* a torn line is not evidence */ }
  }
  return out.slice(-limit);
}

function listTaskIds(root: string): string[] {
  try {
    return fs.readdirSync(taskDir(root))
      .map((d) => d.replace(/~/g, '/'))
      .sort();
  } catch { return []; }
}

export const STATE_TOOLS: ToolSpec[] = [
  { name: 'zeus_missions',
    description: 'List this project’s missions with their goal, phase and outcome. '
      + 'Start here when the person refers to "my last mission" or a mission by number.',
    inputSchema: { type: 'object', properties: {
      limit: { type: 'number', description: 'How many, newest last (default 40)' },
    } } },
  { name: 'zeus_mission',
    description: 'One mission: goal, phase, achievement, plan version, cost, and the '
      + 'tasks it spawned.',
    inputSchema: { type: 'object', properties: {
      missionId: { type: 'string', description: 'e.g. M-0027 or talkbridge/M-0027' },
    }, required: ['missionId'] } },
  { name: 'zeus_events',
    description: 'The event log of a mission or task, newest last. This is the record '
      + 'of what actually happened — use it to answer "why did X stop".',
    inputSchema: { type: 'object', properties: {
      id: { type: 'string', description: 'A mission id (M-0027) or task id (T-0019)' },
      types: { type: 'string', description: 'Optional comma-separated event types to keep' },
      limit: { type: 'number' },
    }, required: ['id'] } },
  { name: 'zeus_findings',
    description: 'Every finding recorded against a mission or task — what a reviewer '
      + 'or critic actually objected to.',
    inputSchema: { type: 'object', properties: {
      id: { type: 'string' },
    }, required: ['id'] } },
  { name: 'zeus_trace',
    description: 'The model calls on a mission or task: stage, provider, configured and '
      + 'actual model, outcome, timing, and whether prompts were kept. Prompt and reply '
      + 'CONTENT is returned only when the trace level kept it.',
    inputSchema: { type: 'object', properties: {
      id: { type: 'string' },
      callId: { type: 'string', description: 'Optional TC- id to fetch one call’s content' },
    }, required: ['id'] } },
];

const ok = (payload: unknown): Answer => {
  const arr = payload as unknown[];
  const n = Array.isArray(arr) ? arr.length : 1;
  return { ok: true, results: n, truncated: false, text: JSON.stringify(payload, null, 1) };
};

const empty = (what: string): Answer => ({
  ok: true, results: 0, truncated: false,
  // Absence stated as absence. "[]" reads to a model as a fact about the
  // world; this says it is a fact about the search.
  text: `No ${what} found. This means Zeus has no such record — check the id with `
    + 'zeus_missions before concluding anything from the absence.',
});

function resolveId(root: string, projectId: string, raw: string): string | null {
  const want = raw.trim();
  const ids = listTaskIds(root);
  const exact = ids.find((i) => i === want || i === `${projectId}/${want}`);
  if (exact) return exact;
  const suffix = ids.filter((i) => i.split('/').pop() === want.split('/').pop());
  return suffix[0] ?? null;
}

/** Derives a mission's shape from its log, so nothing is claimed that is not recorded. */
function missionSummary(root: string, id: string): Record<string, unknown> {
  const log = readLog(root, id, 4000);
  const first = log.find((e) => e.type === 'MISSION_CREATED');
  const term = [...log].reverse().find((e) => e.type === 'MISSION_TERMINATED');
  const plan = [...log].reverse().find((e) => e.type === 'PLAN_ACCEPTED');
  const spawned = log.filter((e) => e.type === 'TASK_SPAWNED')
    .map((e) => e.payload?.taskId).filter(Boolean);
  const outcomes = log.filter((e) => e.type === 'TASK_OUTCOME')
    .map((e) => ({ taskId: e.payload?.taskId, state: e.payload?.state }));
  const escalations = log.filter((e) => e.type === 'MISSION_ESCALATED')
    .map((e) => ({ kind: e.payload?.kind, detail: String(e.payload?.detail ?? '').slice(0, 200) }));
  return {
    missionId: id,
    goal: first?.payload?.goal ?? null,
    createdAt: first?.ts ?? null,
    terminated: !!term,
    achievement: term?.payload?.achievement ?? null,
    terminationReason: term?.payload?.terminationReason ?? null,
    acceptedPlanVersion: plan?.payload?.version ?? null,
    tasks: spawned,
    taskOutcomes: outcomes,
    escalations,
    events: log.length,
  };
}

export function callStateTool(src: StateSource, name: string,
  args: Record<string, any>): Answer {
  const root = src.stateRoot;
  switch (name) {
    case 'zeus_missions': {
      const limit = Math.max(1, Math.min(200, Number(args.limit) || 40));
      const ids = listTaskIds(root).filter((i) => /\/M-\d+$/.test(i));
      if (!ids.length) return empty('missions');
      const rows = ids.slice(-limit).map((id) => {
        const m = missionSummary(root, id);
        return { missionId: m.missionId, goal: String(m.goal ?? '').slice(0, 160),
          achievement: m.achievement, terminationReason: m.terminationReason,
          tasks: (m.tasks as string[]).length };
      });
      return ok(rows);
    }
    case 'zeus_mission': {
      const id = resolveId(root, src.projectId, String(args.missionId ?? ''));
      if (!id) return empty(`mission ${args.missionId}`);
      return ok(missionSummary(root, id));
    }
    case 'zeus_events': {
      const id = resolveId(root, src.projectId, String(args.id ?? ''));
      if (!id) return empty(`record ${args.id}`);
      const limit = Math.max(1, Math.min(500, Number(args.limit) || 120));
      const want = String(args.types ?? '').split(',').map((s) => s.trim()).filter(Boolean);
      let log = readLog(root, id, 4000);
      if (want.length) log = log.filter((e) => want.includes(e.type));
      if (!log.length) return empty(`events on ${id}`);
      return ok(log.slice(-limit).map((e) => ({
        seq: e.seq, ts: e.ts, type: e.type,
        payload: JSON.parse(JSON.stringify(e.payload ?? {})),
      })));
    }
    case 'zeus_findings': {
      const id = resolveId(root, src.projectId, String(args.id ?? ''));
      if (!id) return empty(`record ${args.id}`);
      const out: unknown[] = [];
      const seen = new Set<string>();
      for (const e of readLog(root, id, 4000)) {
        const list = e.payload?.findings;
        if (!Array.isArray(list)) continue;
        for (const f of list) {
          const claim = String(f?.claim ?? f?.detail ?? '').trim();
          if (!claim || seen.has(claim.toLowerCase())) continue;
          seen.add(claim.toLowerCase());
          out.push({ at: e.ts, from: e.type, severity: f?.severity ?? f?.code ?? null,
            claim: claim.slice(0, 400), file: f?.file ?? f?.criterionId ?? null });
        }
      }
      return out.length ? ok(out) : empty(`findings on ${id}`);
    }
    case 'zeus_trace': {
      const id = resolveId(root, src.projectId, String(args.id ?? ''));
      if (!id) return empty(`record ${args.id}`);
      const log = readLog(root, id, 4000);
      const calls = new Map<string, Record<string, unknown>>();
      for (const e of log) {
        const p = e.payload ?? {};
        const cid = p.traceCallId;
        if (!cid) continue;
        const cur = calls.get(cid) ?? { traceCallId: cid };
        if (e.type === 'MODEL_CALL_STARTED') {
          Object.assign(cur, { stage: p.stage, provider: p.provider,
            configuredModel: p.configuredModel, configuredReasoning: p.configuredReasoning,
            promptBytes: p.promptBytes, traceLevel: p.traceLevel,
            graphAttached: p.graphAttached ?? null, startedAt: p.startedAt });
        }
        if (e.type === 'MODEL_CALL_FINISHED') {
          Object.assign(cur, { outcome: p.outcome, actualModel: p.actualModel,
            wallMs: p.wallMs, infrastructureFailure: p.infrastructureFailure ?? null,
            graphQueryCount: p.graphQueryCount ?? null,
            // Metadata always; the words only if the level kept them.
            promptKept: !!p.promptBlob, replyKept: !!p.responseBlob });
        }
        calls.set(cid, cur);
      }
      const rows = [...calls.values()];
      if (!rows.length) return empty(`model calls on ${id}`);
      const one = String(args.callId ?? '');
      return ok(one ? rows.filter((r) => String(r.traceCallId).includes(one)) : rows);
    }
    default:
      return { ok: false, results: 0, truncated: false, text: `unknown tool ${name}` };
  }
}
