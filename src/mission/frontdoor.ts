/**
 * The front door: what the person actually wants, decided by reading rather
 * than by matching words.
 *
 * WHAT IT REPLACES, AND WHY. The old classifier was a keyword table. It read
 * QUESTION_STARTERS, STATUS_VOCAB and a list of imperative verbs, and broke a
 * tie toward QUESTION because answering is cheaper than building. That is a
 * defensible rule for "how do I fix the failing tests?" and a wrong one for a
 * 3,561-byte specification that opens "Refactor TalkBridge's frontend
 * localization architecture…" and later says "report a concise evidence
 * summary". The words `report` and `findings` were subordinate deliverables;
 * the table counted them as status vocabulary, the tie-break fired, and a
 * plainly imperative work order was answered as though it were a status
 * question. No card appeared and nothing could be built from the chat.
 *
 * The failure is not fixable by adding words. "Can you refactor the landing
 * localization so it doesn't affect app language?" is grammatically a question
 * and is unambiguously work; "What should I do to fix the reviewer?" is
 * grammatically imperative-adjacent and is unambiguously a question. Form does
 * not carry intent. Only meaning does.
 *
 * READ-ONLY BY CONSTRUCTION. This agent holds Read, Grep, Glob, the graph
 * tools and the Zeus state tools. It does NOT hold Bash — which the ordinary
 * read-only profile does grant — because a front door that can run commands is
 * an execution path reachable from an unauthenticated-feeling chat box, and
 * "read-only" would then mean only that it had no Edit tool.
 */

import { createHash } from 'crypto';
import type { Provider, AgentResponse, GraphAccess } from '../engine/providers';
import type { ProcessSupervisor } from '../engine/exec';
import type { ExecutionPolicy } from '../engine/policy';
import { readScopeSummary, type ReadScopeVerdict } from '../engine/readscope';

export const FRONT_DOOR_INTENTS = [
  'QUESTION', 'WORK_REQUEST', 'CONTROL_ACTION', 'AMBIGUOUS',
] as const;
export type FrontDoorIntent = typeof FRONT_DOOR_INTENTS[number];

export interface EvidenceRef {
  /** What was consulted: a tool name, a mission id, a path. */
  kind: string;
  id: string;
  detail?: string;
}

export interface FrontDoorDecision {
  intent: FrontDoorIntent;
  confidence: number;
  summary: string;
  /** What it actually looked at. Derived from the tool log, not from the reply. */
  evidenceUsed: EvidenceRef[];
  /** Present only for WORK_REQUEST. Never a rewrite of the user's words. */
  proposedWork: { goal: string; orientation: string | null } | null;
  /** Present only for AMBIGUOUS: the readings, so a person picks. */
  readings: Array<{ intent: FrontDoorIntent; reading: string }> | null;
  /** Present only for QUESTION: the answer, grounded in evidence. */
  answer: string | null;
  /** Set when the decision could not be made by the agent. */
  degraded: { reason: string; detail: string } | null;
  /** Links the message, the model call, the tool calls and this decision. */
  traceCallId?: string;
}

/* -- deterministic protocol, which is not natural language ------------------ */

/**
 * Machine-level controls keep their lexical rules.
 *
 * These are not intent to be understood; they are a protocol. `/cancel` means
 * cancel, and sending it to a model to be interpreted would add latency, cost
 * and a chance of being wrong about something that has exactly one meaning.
 */
export interface ProtocolCommand { id: string; rest: string }

const PROTOCOL: Array<{ id: string; re: RegExp }> = [
  { id: 'cancel', re: /^\s*\/cancel\b/i },
  { id: 'accept', re: /^\s*\/(accept|approve)\b/i },
  { id: 'refuse', re: /^\s*\/(refuse|reject)\b/i },
  { id: 'help', re: /^\s*\/(help|\?)\s*$/i },
  { id: 'status', re: /^\s*\/status\b/i },
];

export function protocolCommand(raw: string): ProtocolCommand | null {
  const text = (raw ?? '').trim();
  for (const p of PROTOCOL) {
    if (p.re.test(text)) return { id: p.id, rest: text.replace(p.re, '').trim() };
  }
  return null;
}

/* -- the prompt ------------------------------------------------------------ */

export const FRONT_DOOR_HEADER = [
  'You are the front door of Zeus, an autonomous engineering system. A person',
  'has sent one message. Decide what they actually want, then either answer it',
  'or hand it on as work. You are READ-ONLY: you can inspect, and you cannot',
  'change anything.',
  '',
  'DECIDE THE PRIMARY INTENT.',
  '',
  '  QUESTION       they want to KNOW something. Answer it from evidence.',
  '  WORK_REQUEST   they want something CHANGED in the repository.',
  '  CONTROL_ACTION they want to operate Zeus itself (cancel, accept, retry).',
  '  AMBIGUOUS      you genuinely cannot tell, and the two readings differ in',
  '                 what would happen next.',
  '',
  'GRAMMATICAL FORM IS NOT INTENT.',
  '"Can you refactor the landing localization so it does not affect app',
  'language?" is a question in form and a WORK_REQUEST in fact. "What should I',
  'do about the failing reviewer?" is a QUESTION even though it names a fix.',
  'Decide on what the person wants to HAPPEN, not on the punctuation.',
  '',
  'A SUBORDINATE DELIVERABLE IS NOT THE PRIMARY INTENT.',
  '"Refactor X and report an evidence summary afterwards" is a WORK_REQUEST.',
  'The report is part of the work, not a request for a status update. Words',
  'like report, findings, summary and status do not make a message a QUESTION',
  'when the thing being asked for is a change.',
  '',
  'INVESTIGATION DOES NOT MAKE A QUESTION.',
  '"Investigate why the reviewer fails and fix it" is a WORK_REQUEST. Needing',
  'to look before acting is normal; it does not change what was asked for.',
  '',
  'READING CODE DOES NOT AUTHORISE CHANGING IT.',
  'You may use your tools to answer a QUESTION. Having read a file to explain',
  'why something happens NEVER turns the message into a WORK_REQUEST. If the',
  'person asked why, answer why.',
  '',
  'USE TOOLS ONLY WHEN THEY CAN CHANGE YOUR ANSWER OR YOUR CLASSIFICATION.',
  '"Create a button on the landing page" needs no inspection to classify.',
  '"Why did my last mission stop?" needs the mission log. "Will changing',
  'content.js affect the signed-in app?" needs graph_dependents and then the',
  'source itself. Do not browse for its own sake, and do not dump the',
  'repository into your reply.',
  '',
  'YOU HAVE NO SHELL. There is no Bash, no command execution, no git. If you',
  'want to know something, read it with Read/Grep/Glob, the graph tools or the',
  'zeus_* tools. Reaching for a shell wastes a turn and will be refused.',
  '',
  'THE GRAPH IS NAVIGATION. THE SOURCE IS TRUTH. If the graph and the current',
  'source disagree, believe the source and say the graph disagreed.',
  '',
  'DO NOT FABRICATE. If a tool fails or the evidence is not there, say what you',
  'could not establish. An invented mission id or file path is worse than',
  '"I could not check that".',
  '',
  'IF YOU GENUINELY CANNOT TELL, say AMBIGUOUS and give both readings. Do not',
  'pick the cheaper one to be safe — silently answering a work request is not',
  'safe, it is just quiet.',
  '',
  'Reply with ONLY a JSON object:',
  '{"intent":"QUESTION|WORK_REQUEST|CONTROL_ACTION|AMBIGUOUS",',
  ' "confidence":0.0-1.0,',
  ' "summary":"one sentence on what they want and why you decided that",',
  ' "answer":"<for QUESTION: the answer, grounded in what you inspected>",',
  ' "orientation":"<for WORK_REQUEST: what you learned that would orient the',
  '   work — files, dependencies, prior findings. May be null. NEVER a rewrite',
  '   of what they asked for>",',
  ' "control":"<for CONTROL_ACTION: which operation they mean>",',
  ' "readings":[{"intent":"...","reading":"..."}]  // for AMBIGUOUS only',
  '}',
  '',
  'Tool calls are not your final message: investigate first, then answer. When',
  'you do need to look, start from the graph and let it point you at the source,',
  'and stop once more looking cannot change your answer or your classification.',
].join('\n');

export function buildPrompt(message: string, context: string | null): string {
  const parts = [FRONT_DOOR_HEADER, ''];
  if (context) {
    parts.push('--- what this project is ---', context, '');
  }
  parts.push('--- the message ---', message);
  return parts.join('\n');
}

/* -- parsing --------------------------------------------------------------- */

const clamp01 = (n: unknown): number => {
  const v = Number(n);
  if (!Number.isFinite(v)) return 0.5;
  return Math.max(0, Math.min(1, v));
};

/**
 * Turns the agent's reply into a decision, refusing to invent one.
 *
 * An unparseable reply is DEGRADED, never a quiet QUESTION: the whole reason
 * this exists is that a wrong-but-cheap default silently swallowed a work
 * order.
 */
export function parseDecision(res: AgentResponse, message: string): FrontDoorDecision {
  const degraded = (reason: string, detail: string): FrontDoorDecision => ({
    intent: 'AMBIGUOUS', confidence: 0, summary:
      'Zeus could not decide what this message asks for.',
    evidenceUsed: [], proposedWork: null, answer: null,
    readings: [
      { intent: 'QUESTION', reading: 'answer this from the mission log and the repository' },
      { intent: 'WORK_REQUEST', reading: 'propose a mission to do this as work' },
    ],
    degraded: { reason, detail },
  });

  if (res.infrastructureFailure) {
    return degraded('FRONT_DOOR_UNAVAILABLE', res.infrastructureFailure);
  }
  const s = res.structured as Record<string, unknown> | null;
  if (!s || typeof s !== 'object') {
    return degraded('FRONT_DOOR_UNPARSEABLE',
      `the front door did not return a decision (outcome ${res.outcome})`);
  }
  const raw = String(s.intent ?? '').toUpperCase().replace(/[^A-Z_]/g, '');
  const intent = (FRONT_DOOR_INTENTS as readonly string[]).includes(raw)
    ? raw as FrontDoorIntent : null;
  if (!intent) {
    return degraded('FRONT_DOOR_UNKNOWN_INTENT', `it answered "${String(s.intent)}"`);
  }

  const summary = String(s.summary ?? '').slice(0, 600) || 'no summary given';
  const answer = typeof s.answer === 'string' && s.answer.trim() ? s.answer.trim() : null;
  const orientation = typeof s.orientation === 'string' && s.orientation.trim()
    ? s.orientation.trim() : null;
  const readings = Array.isArray(s.readings)
    ? (s.readings as any[]).map((r) => ({
      intent: String(r?.intent ?? 'AMBIGUOUS') as FrontDoorIntent,
      reading: String(r?.reading ?? '').slice(0, 400),
    })).filter((r) => r.reading)
    : null;

  // A QUESTION with no answer answered nothing. Say so rather than rendering
  // an empty bubble that looks like a considered reply.
  if (intent === 'QUESTION' && !answer) {
    return degraded('FRONT_DOOR_EMPTY_ANSWER',
      'it classified the message as a question and returned no answer');
  }
  if (intent === 'AMBIGUOUS' && (!readings || readings.length < 2)) {
    return degraded('FRONT_DOOR_NO_READINGS',
      'it said the message was ambiguous without saying what the readings were');
  }

  return {
    intent,
    confidence: clamp01(s.confidence),
    summary,
    evidenceUsed: [],
    answer: intent === 'QUESTION' ? answer : null,
    readings: intent === 'AMBIGUOUS' ? readings : null,
    // THE USER'S OWN WORDS. Orientation rides alongside; it never replaces the
    // goal. A front door that paraphrases a 3,561-byte specification into one
    // helpful sentence has thrown away the specification.
    proposedWork: intent === 'WORK_REQUEST' ? { goal: message, orientation } : null,
    degraded: null,
  };
}

/* -- the call -------------------------------------------------------------- */

export interface FrontDoorInput {
  message: string;
  context?: string | null;
  /** Correlates the whole interaction: message, call, tools, decision. */
  traceCallId?: string;
  traceLevel?: string;
  traceLevelSource?: string;
  /** Keeps prompt/reply under the level's policy, or returns null. */
  keep?: (content: string) => unknown | null;
  /** Reads back what the tool server actually answered, for the record. */
  readOps?: () => Array<Record<string, unknown>>;
  /**
   * Records WHERE this call looked, from its own transcript.
   *
   * The front door holds no Bash, so its reach is already narrowed by which
   * tools it was given — but Read and Glob take absolute paths, and a tool
   * list is not a filesystem boundary.
   */
  inspectReads?: ((traceCallId: string, raw: string) => ReadScopeVerdict) | null;
  provider: Provider;
  supervisor: ProcessSupervisor;
  policy: ExecutionPolicy;
  projectId: string;
  model?: string | null;
  reasoning?: string | null;
  graph?: GraphAccess | null;
  /** Read-only tool names this call may use. Bash is deliberately absent. */
  tools: string[];
  trace?: (type: string, payload: Record<string, unknown>) => void;
}

export async function decide(input: FrontDoorInput): Promise<FrontDoorDecision> {
  const prompt = buildPrompt(input.message, input.context ?? null);
  const traceCallId = input.traceCallId
    ?? `TC-${createHash('sha256').update(`${input.projectId}:front-door:${Date.now()}`)
      .digest('hex').slice(0, 20)}`;
  const started = Date.now();

  // Opened BEFORE the provider is called, the same as every other stage. If the
  // host dies mid-call the log still says exactly what was in flight — which
  // model, at what effort, holding which tools, against which message.
  input.trace?.('MODEL_CALL_STARTED', {
    traceCallId, stage: 'front-door', role: 'reviewer',
    provider: input.provider.id, readOnly: true,
    configuredModel: input.model ?? null, configuredReasoning: input.reasoning ?? null,
    promptHash: `sha256:${createHash('sha256').update(prompt).digest('hex')}`,
    promptBytes: Buffer.byteLength(prompt),
    // What the front door was ACTUALLY given, so a decision can be argued with
    // rather than guessed at.
    userMessage: input.message,
    userMessageBytes: Buffer.byteLength(input.message),
    contextBytes: input.context ? Buffer.byteLength(input.context) : 0,
    toolsOffered: input.tools,
    graphAttached: !!input.graph,
    traceLevel: input.traceLevel ?? 'normal',
    traceLevelSource: input.traceLevelSource ?? 'zeus-default',
    ...(input.keep ? { promptBlob: input.keep(prompt) } : {}),
    pid: process.pid,
    startedAt: new Date().toISOString(),
  });

  let res: AgentResponse;
  try {
    res = await input.provider.invoke({
      role: 'reviewer', taskId: `${input.projectId}/CHAT`, projectId: input.projectId,
      prompt, policy: input.policy, readOnly: true,
      model: input.model ?? null, reasoning: input.reasoning ?? null,
      stage: 'front-door',
      graph: input.graph ?? null,
      tools: input.tools,
    }, input.supervisor);
  } catch (e: any) {
    const failed = parseDecision({
      outcome: 'FAILED', structured: null, text: '', raw: '',
      infrastructureFailure: `front door threw: ${e?.message ?? e}`,
    } as any, input.message);
    input.trace?.('MODEL_CALL_FINISHED', {
      traceCallId, stage: 'front-door', provider: input.provider.id,
      outcome: 'FAILED', wallMs: Date.now() - started,
      infrastructureFailure: `front door threw: ${e?.message ?? e}`,
      finishedAt: new Date().toISOString(),
    });
    input.trace?.('FRONT_DOOR_DECISION', {
      traceCallId, intent: failed.intent, confidence: failed.confidence,
      degraded: failed.degraded, summary: failed.summary,
    });
    return failed;
  }

  const decision = parseDecision(res, input.message);
  const ops = input.readOps ? input.readOps() : [];
  // The graph log says what the TOOL SERVER answered. It says nothing about
  // Read, Grep or Glob, which do not go through it — so without this the front
  // door's file access is the one part of the call with no record at all.
  const readScope = input.inspectReads
    ? input.inspectReads(traceCallId, res.raw ?? res.text ?? '') : null;

  input.trace?.('MODEL_CALL_FINISHED', {
    traceCallId, stage: 'front-door', provider: input.provider.id,
    outcome: res.outcome,
    configuredModel: input.model ?? null, configuredReasoning: input.reasoning ?? null,
    actualModel: (res as any).identity?.model ?? null,
    ...((res as any).identity?.model && input.model
      && (res as any).identity.model !== input.model
      ? { modelDiscrepancy: { configured: input.model, actual: (res as any).identity.model } }
      : {}),
    parsed: { ok: res.structured !== null,
      structuredKeys: res.structured ? Object.keys(res.structured) : [] },
    infrastructureFailure: res.infrastructureFailure,
    wallMs: Date.now() - started,
    ...((res as any).providerUsage ? { usage: (res as any).providerUsage } : {}),
    // Every tool the agent actually called, from the server's own log rather
    // than from anything it said about itself.
    graphOps: ops, graphQueryCount: ops.length,
    ...(readScope ? { readScope: readScopeSummary(readScope) } : {}),
    ...(input.keep ? { responseBlob: input.keep(res.raw ?? res.text ?? '') } : {}),
    finishedAt: new Date().toISOString(),
  });

  // The decision itself, as its own event: what Zeus concluded, how sure it
  // was, and what it proposed to do next. The pair above says what the call
  // cost; this says what it MEANT.
  input.trace?.('FRONT_DOOR_DECISION', {
    traceCallId,
    intent: decision.intent,
    confidence: decision.confidence,
    summary: decision.summary,
    degraded: decision.degraded,
    answerBytes: decision.answer ? Buffer.byteLength(decision.answer) : 0,
    orientationBytes: decision.proposedWork?.orientation
      ? Buffer.byteLength(decision.proposedWork.orientation) : 0,
    // The card would carry the user's own words; recording the length proves
    // the goal was not quietly rewritten on the way through.
    proposedGoalBytes: decision.proposedWork
      ? Buffer.byteLength(decision.proposedWork.goal) : 0,
    readings: decision.readings,
    toolsUsed: ops.map((o) => o.tool),
  });

  return decision;
}
