/**
 * Project chat: conversation in, confirmed missions out.
 *
 * The chat is an INTERFACE, not a brain. It answers questions from the event
 * log and turns work requests into a rendered card — and a card is a proposal
 * until a human accepts it. No message becomes a mission on its own, because
 * creating a mission spends money and triggers consent stops downstream, which
 * makes the act of creating one a consent moment in its own right.
 *
 * THE ERROR DIRECTION IS FIXED: when in doubt, ask. A message is classified as
 * work only when it matches an explicit work shape; everything else that is
 * not plainly a question is rendered as a proposal with the doubt visible,
 * including the option that it was only a question after all. A classifier
 * that guesses toward building is a classifier that spends money on a
 * misreading.
 */

import * as crypto from 'crypto';
import { MissionRegistry } from './registry';
import { EventStore, StoredEvent } from '../engine/events';
import { MissionRecord } from './types';
import { Oracle } from './oracle';
import { missionUsage, progressFrom } from './progress';
import { spendReader } from '../views';

/**
 * Chat lives in the event log like everything else.
 *
 * Not a database, not a file beside it: the same append-only, hash-chained,
 * redacted-at-the-sink log the rest of the product reasons about. That is what
 * makes chat history survive a restart, and what makes a message that led to a
 * mission auditable next to the mission it created.
 */
export const CHAT_EVENT_TYPES = ['CHAT_MESSAGE', 'CHAT_CARD_DECISION'] as const;

/**
 * The stream chat lives on. Deliberately NOT a mission or task id: it is
 * project-scoped, and `scopeOf` returns null for it, so neither `zeus status`
 * nor `zeus mission list` will mistake it for their business.
 */
export function chatStreamId(projectId: string): string { return `${projectId}/CHAT`; }

/* ------------------------------------------------------------------------ *
 * Canonical digests
 * ------------------------------------------------------------------------ */

/**
 * A digest of what was rendered, stable under key reordering.
 *
 * Same rule the consent boundary uses, for the same reason: a serialiser that
 * reorders fields must not invalidate a decision a human genuinely made, and a
 * caller must not be able to manufacture a match by reordering either.
 */
export function canonicalDigest(value: unknown): string {
  const canon = JSON.stringify(value, (_k, v) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      return Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(
        ([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
    }
    return v;
  });
  return crypto.createHash('sha256').update(canon ?? '').digest('hex').slice(0, 32);
}

/* ------------------------------------------------------------------------ *
 * Intent routing
 * ------------------------------------------------------------------------ */

export type Intent = 'QUESTION' | 'WORK' | 'AMBIGUOUS';

export interface Classification {
  intent: Intent;
  /** Which patterns fired, so a routing decision can be argued with. */
  matched: string[];
  reason: string;
}

/** Interrogative openers. English and Persian. */
const QUESTION_STARTERS = [
  'what', 'why', 'how', 'when', 'which', 'who', 'where', 'whose',
  'is', 'are', 'was', 'were', 'do', 'does', 'did', 'can', 'could',
  'should', 'will', 'would', 'has', 'have', 'am',
  'چی', 'چه', 'چرا', 'چطور', 'چگونه', 'کی', 'کدام', 'کجا', 'آیا', 'چند', 'چقدر',
];

/** Words that name things the log already knows. */
const STATUS_VOCAB = [
  'status', 'cost', 'report', 'progress', 'criteria', 'criterion', 'outcome',
  'ratchet', 'budget', 'events', 'findings', 'missions', 'mission', 'tasks',
  'readiness', 'doctor', 'spent', 'terminated', 'achievement',
  'وضعیت', 'هزینه', 'گزارش', 'پیشرفت', 'معیار', 'نتیجه', 'بودجه', 'رویداد',
  'ماموریت', 'مأموریت', 'خرج',
];

/** Imperative openers that plainly ask for work. */
const WORK_PATTERNS: Array<{ id: string; re: RegExp }> = [
  { id: 'en-imperative', re: /^\s*(please\s+)?(fix|add|make|create|implement|refactor|write|update|remove|delete|rename|migrate|upgrade|build|introduce|extract|split|merge|optimi[sz]e|clean\s*up|port|convert|replace|document)\b/i },
  { id: 'en-request', re: /\b(i\s+(want|need)\s+you\s+to|can\s+you\s+(please\s+)?(fix|add|make|write|implement|refactor|update|remove))\b/i },
  { id: 'fa-imperative', re: /(درست\s*کن|اضافه\s*کن|بساز|بنویس|حذف\s*کن|تغییر\s*بده|رفع\s*کن|اصلاح\s*کن|پیاده\s*سازی\s*کن|بازنویسی\s*کن|به\s*روز\s*کن)/ },
];

const startsWith = (text: string, words: string[]): string | null => {
  const first = text.trim().toLowerCase().split(/[\s،,؟?!.]+/).filter(Boolean)[0] ?? '';
  return words.includes(first) ? first : null;
};

/**
 * Classifies a message. MECHANICAL, and deliberately so in V1.
 *
 * A model could route more subtly, and it would also cost money on every
 * message and be unable to explain itself in a table. The rules below are
 * arguable, testable and free; model routing waits until real chat use says
 * where they actually fall down.
 */
export function classifyMessage(raw: string): Classification {
  const text = (raw ?? '').trim();
  if (!text) {
    return { intent: 'AMBIGUOUS', matched: [],
      reason: 'the message is empty, so there is nothing to route on' };
  }
  const matched: string[] = [];

  const opener = startsWith(text, QUESTION_STARTERS);
  if (opener) matched.push(`question-opener:${opener}`);
  if (/[?؟]\s*$/.test(text)) matched.push('question-mark');
  const vocab = STATUS_VOCAB.filter((w) => text.toLowerCase().includes(w));
  if (vocab.length) matched.push(...vocab.map((w) => `status-vocab:${w}`));

  const work = WORK_PATTERNS.filter((p) => p.re.test(text));
  if (work.length) matched.push(...work.map((p) => `work:${p.id}`));

  const questionish = !!opener || /[?؟]\s*$/.test(text) || vocab.length > 0;

  // A question wins a tie. "How do I fix the failing tests?" asks for an
  // explanation, not for the tests to be fixed — and answering costs nothing
  // while building costs money, so the tie breaks toward the cheap, reversible
  // reading.
  if (questionish) {
    return {
      intent: 'QUESTION', matched,
      reason: work.length
        ? 'it reads as a question even though it also names work — a question is the cheaper reading, so it wins the tie'
        : 'it opens as a question, ends in a question mark, or names something the log already knows',
    };
  }
  if (work.length) {
    return { intent: 'WORK', matched, reason: `it matches an explicit work pattern (${work.map((p) => p.id).join(', ')})` };
  }
  return {
    intent: 'AMBIGUOUS', matched,
    reason: 'it matches neither a question shape nor an explicit work pattern, so the doubt is rendered rather than resolved',
  };
}

/* ------------------------------------------------------------------------ *
 * The mission card
 * ------------------------------------------------------------------------ */

export interface CardAction { id: string; label: string }

export interface MissionCard {
  intent: Intent;
  /** The user's own words, trimmed. V1 does not rewrite goals silently. */
  originalGoal: string;
  /** A model's tightened wording, when one was asked for. Never automatic. */
  proposedGoal: string | null;
  /** What that model call cost, shown on the card that used it. */
  proposalCostUsd: number | null;
  whatHappensNext: string[];
  costExpectation: string;
  actions: CardAction[];
  digest: string;
}

/** When a message is long enough that a tightened wording is worth offering. */
export function wantsTightening(text: string): boolean {
  const sentences = text.split(/[.!?؟]\s+/).filter((s) => s.trim().length > 0);
  return sentences.length > 1;
}

/**
 * What a mission will do, and what it is expected to cost.
 *
 * The cost line cites COMMITTED evidence and nothing else. There is no
 * established per-mission average to quote: the only end-to-end figures on
 * record are one live execution-loop run and one plan-time stop, so that is
 * what the card says. Quoting an average that no artifact contains would be
 * exactly the invented number this product refuses elsewhere.
 */
export function costExpectationLine(): string {
  return 'Cost is not yet predictable from a committed baseline. The only figures on '
    + 'record are audits/missions/M-0004.md ($1.3814 across two tasks, terminated '
    + 'PARTIAL/BLOCKED) and audits/missions/BC-2-rerun.md (stopped at plan time on an '
    + 'estimate of ~$89 for 14 nodes). Expect the compile and plan steps alone to cost '
    + 'real money before any task runs.';
}

export function draftCard(input: {
  intent: Intent; message: string;
  proposedGoal?: string | null; proposalCostUsd?: number | null;
}): MissionCard {
  const originalGoal = input.message.trim();
  const actions: CardAction[] = [
    { id: 'create', label: 'Create mission' },
    { id: 'edit', label: 'Edit goal' },
    { id: 'cancel', label: 'Cancel' },
  ];
  // The doubt is an option on the card, not a decision taken quietly.
  if (input.intent === 'AMBIGUOUS') {
    actions.push({ id: 'answer', label: 'Just answer my question' });
  }
  const card: Omit<MissionCard, 'digest'> = {
    intent: input.intent,
    originalGoal,
    proposedGoal: input.proposedGoal ?? null,
    proposalCostUsd: input.proposalCostUsd ?? null,
    whatHappensNext: [
      'compile — a model turns this goal into a contract of checkable criteria',
      'critic — a second, independent model reviews that contract',
      'consent — you read the findings and decide; nothing is accepted without you',
      'plan — a model proposes the task graph, and a critic reviews that too',
      'consent — scope mismatches and budget shortfalls stop here for you',
      'run — tasks execute one at a time, each integrated only if it stays green',
    ],
    costExpectation: costExpectationLine(),
    actions,
  };
  return { ...card, digest: canonicalDigest(card) };
}

/* ------------------------------------------------------------------------ *
 * Answering from the log
 * ------------------------------------------------------------------------ */

export interface AnswerRef { kind: 'mission' | 'task' | 'event'; id: string; seq?: number }

export interface Answer {
  answered: boolean;
  text: string;
  refs: AnswerRef[];
}

const latestMission = (missions: MissionRegistry): MissionRecord | null => {
  const ids = missions.list();
  return ids.length ? missions.mission(ids[ids.length - 1]) : null;
};

/**
 * Answers a question from the log, or says plainly that it cannot.
 *
 * ZERO provider calls. An answer here is a claim, so it carries refs the way a
 * mission report does; and when the log does not hold the answer, the honest
 * sentence plus what CAN be asked beats a model improvising something
 * plausible. V1 does not invoke a model to cover a gap in its own vocabulary.
 */
export function answerFromLog(missions: MissionRegistry, message: string): Answer {
  const text = message.toLowerCase();
  const rec = latestMission(missions);
  // The refusal lists what CAN be asked, which makes it a CLAIM — the same
  // rule doctor output follows. Every item below is answered by a branch in
  // this function, and adding a branch means adding it here.
  const cannot = (): Answer => ({
    answered: false,
    text: 'I cannot answer that from the event log. I can answer questions about: '
      + 'which missions exist in this project, '
      + 'mission status and per-criterion outcomes, what a mission cost '
      + '(observed, estimated and unmetered kept apart), progress and findings, '
      + 'the tasks a mission spawned, whether anything is waiting on you, '
      + 'and the most recent events. '
      + 'Anything else needs a model, and V1 does not call one to improvise an answer.',
    refs: [],
  });

  // The most obvious question a person can ask, and the resolver used to
  // decline it. The data was already on screen in the left column; the gap was
  // vocabulary, not capability.
  if (/(what|which|list|show|how many)?.*(missions|mission list)|میشن|مأموریت|ماموریت/.test(text)
    && /(missions|list|چه|چند|لیست|کدام)/.test(text)) {
    const all = missions.list().map((id) => missions.mission(id))
      .filter((m): m is MissionRecord => !!m);
    if (!all.length) {
      return { answered: true, refs: [], text: 'There are no missions in this project yet.' };
    }
    const lines = all.map((m) => {
      const state = m.terminated ? `${m.achievement} / ${m.terminationReason}` : 'active';
      const waiting = !m.terminated && !!m.oracle && !m.oracleAccepted ? '  ← waiting on you' : '';
      return `  ${m.missionId.split('/').pop()}  ${state}${waiting}\n      ${m.goal.slice(0, 72)}`;
    });
    return {
      answered: true,
      refs: all.map((m) => ({ kind: 'mission' as const, id: m.missionId })),
      text: `${all.length} mission(s) in this project:\n${lines.join('\n')}`,
    };
  }

  if (/(waiting|pending|blocked on me|needs? me|consent|منتظر|در انتظار)/.test(text)) {
    const all = missions.list().map((id) => missions.mission(id))
      .filter((m): m is MissionRecord => !!m)
      .filter((m) => !m.terminated && !!m.oracle && !m.oracleAccepted);
    return {
      answered: true,
      refs: all.map((m) => ({ kind: 'mission' as const, id: m.missionId })),
      text: all.length
        ? `${all.length} mission(s) waiting on a decision from you:\n`
          + all.map((m) => `  ${m.missionId.split('/').pop()}  ${m.goal.slice(0, 66)}`).join('\n')
        : 'Nothing is waiting on you right now.',
    };
  }

  if (!rec) {
    return { answered: true, refs: [],
      text: 'There are no missions in this project yet. Describe a change you want and '
        + 'I will draft a mission card for you to approve.' };
  }
  const refs: AnswerRef[] = [{ kind: 'mission', id: rec.missionId }];
  const log = missions.events.read(rec.missionId);

  if (/(cost|spend|spent|budget|هزینه|خرج|بودجه)/.test(text)) {
    const usage = missionUsage(log, Date.now(), spendReader(missions));
    return {
      answered: true, refs,
      text: `${rec.missionId} has ${usage.costUsd > 0 ? `$${usage.costUsd.toFixed(4)} of provider-reported spend`
        : 'no provider-reported spend'}`
        + `${usage.unmeteredCalls ? `, plus ${usage.unmeteredCalls} call(s) that reported no price — so that total is a lower bound` : ''}`
        + `. ${usage.tasksSpawned} task(s) spawned, ${usage.replans} replan(s).`,
    };
  }

  if (/(criteri|outcome|proven|failed|معیار|نتیجه)/.test(text)) {
    const oracle = rec.oracle as Oracle | null;
    if (!oracle) {
      return { answered: true, refs, text: `${rec.missionId} has no compiled oracle, so there are no criteria yet.` };
    }
    const lines = oracle.criteria.map((c) =>
      `  ${c.criterionId.split('/').pop()} ${rec.criterionOutcomes[c.criterionId] ?? 'UNEVALUATED'} — ${c.statement.slice(0, 70)}`);
    return { answered: true, refs, text: `${rec.missionId} criteria:\n${lines.join('\n')}` };
  }

  if (/(status|state|وضعیت|چطور پیش)/.test(text)) {
    return {
      answered: true, refs,
      text: `${rec.missionId} is ${rec.terminated ? `${rec.achievement} / ${rec.terminationReason}` : 'active'}`
        + `. Plan: ${rec.acceptedPlanVersion === null ? 'none accepted'
          : `v${rec.acceptedPlanVersion}${rec.acceptedPlan ? '' : ' (invalidated)'}`}`
        + `. Ratchet: ${rec.ratchetSha ? rec.ratchetSha.slice(0, 12) : 'never advanced'}.`,
    };
  }

  if (/(task|worktree|تسک)/.test(text)) {
    return {
      answered: true,
      refs: [...refs, ...rec.spawned.map((s) => ({ kind: 'task' as const, id: s.taskId }))],
      text: rec.spawned.length
        ? `${rec.missionId} spawned ${rec.spawned.length} task(s):\n`
          + rec.spawned.map((s) => `  ${s.taskId} ${s.outcome ?? 'RUNNING'} (node ${s.nodeId || '—'})`).join('\n')
        : `${rec.missionId} has not spawned any tasks.`,
    };
  }

  if (/(event|log|رویداد)/.test(text)) {
    const tail = log.slice(-5);
    return {
      answered: true,
      refs: [...refs, ...tail.map((e) => ({ kind: 'event' as const, id: e.taskId, seq: e.seq }))],
      text: `The last ${tail.length} event(s) on ${rec.missionId}:\n`
        + tail.map((e) => `  seq ${e.seq} ${e.ts.slice(11, 19)} ${e.type}`).join('\n'),
    };
  }

  if (/(progress|finding|پیشرفت|یافته)/.test(text)) {
    const score = progressFrom(log);
    return {
      answered: true, refs,
      text: `${rec.missionId}: ${score.provenRequired} required criterion(s) proven, `
        + `${score.enablingCredits.length} enabling credit(s), `
        + `${score.consecutiveNoProgress} consecutive cycle(s) that proved nothing.`,
    };
  }

  return cannot();
}

/* ------------------------------------------------------------------------ *
 * Recording
 * ------------------------------------------------------------------------ */

export function recordChatMessage(store: EventStore, projectId: string, spec: {
  message: string; classification: Classification; led: string; cardDigest?: string | null;
}): StoredEvent {
  return store.append({
    taskId: chatStreamId(projectId), type: 'CHAT_MESSAGE',
    payload: {
      message: spec.message, intent: spec.classification.intent,
      matched: spec.classification.matched, reason: spec.classification.reason,
      led: spec.led, cardDigest: spec.cardDigest ?? null,
    },
  });
}

export function recordCardDecision(store: EventStore, projectId: string, spec: {
  cardDigest: string; decision: string; missionId: string | null; detail?: string;
}): StoredEvent {
  return store.append({
    taskId: chatStreamId(projectId), type: 'CHAT_CARD_DECISION',
    payload: {
      cardDigest: spec.cardDigest, decision: spec.decision,
      missionId: spec.missionId, detail: spec.detail ?? null,
    },
  });
}

/** Chat history, reconstructed from the log — which is where it lives. */
export function chatHistory(store: EventStore, projectId: string): StoredEvent[] {
  try { return store.read(chatStreamId(projectId)); } catch { return []; }
}
