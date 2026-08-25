/**
 * The front door: semantics, not keywords.
 *
 * These cases are the ones the keyword table got wrong, plus the ones it got
 * right that must stay right. Each drives the real parse/decide path against a
 * scripted provider, so what is under test is Zeus's handling of a decision —
 * not a model's ability to make one.
 */

import * as fs from 'fs';
import * as path from 'path';
import { check, section } from './harness';
import {
  protocolCommand, parseDecision, buildPrompt, decide,
  FRONT_DOOR_HEADER, FRONT_DOOR_INTENTS,
} from '../src/mission/frontdoor';
import { frontDoorTools, toolsFor, graphToolIds, stateToolIds } from '../src/engine/providers';
import { STATE_TOOLS, callStateTool } from '../src/graph/state-tools';
import { PIPELINE_STAGES, STAGE_ROLE, ZEUS_DEFAULT_ROUTING } from '../src/routing';

/** A provider that answers with whatever the case scripts. */
const scripted = (structured: unknown, over: Record<string, unknown> = {}) => ({
  id: 'mock',
  async available() { return { ok: true, detail: 'mock' }; },
  async invoke() {
    return {
      outcome: 'COMPLETED', structured, text: JSON.stringify(structured),
      raw: JSON.stringify(structured), infrastructureFailure: null, durationMs: 1,
      ...over,
    } as any;
  },
} as any);

const run = async (structured: unknown, message: string, over = {}) => decide({
  message, provider: scripted(structured, over), supervisor: {} as any,
  policy: {} as any, projectId: 'p', tools: frontDoorTools(),
});

export async function frontDoorSuite(): Promise<void> {
  section('the front door: protocol stays lexical, language does not');
  {
    // `/cancel` has exactly one meaning. Sending it to a model to be
    // interpreted would add cost, latency and a chance of being wrong about
    // something unambiguous.
    check('FD1: slash commands are matched deterministically',
      protocolCommand('/cancel')?.id === 'cancel'
      && protocolCommand('/accept')?.id === 'accept', 'protocol recognised');
    check('FD2: and carry their remainder',
      protocolCommand('/cancel M-0027')?.rest === 'M-0027',
      protocolCommand('/cancel M-0027')?.rest);
    check('FD3: ordinary language is NOT a protocol command',
      protocolCommand('cancel the mission') === null
      && protocolCommand('why did it stop?') === null, 'left to the agent');
  }

  section('the front door: the nine cases the table could not do');
  {
    // 1 — a plain question about state.
    const q = await run({ intent: 'QUESTION', confidence: 0.95,
      summary: 'asks why a mission stopped', answer: 'It stopped because N-0002 failed twice.' },
    'Why did M-0027 stop?');
    check('FD4: "Why did M-0027 stop?" is a QUESTION with an answer and no work',
      q.intent === 'QUESTION' && !!q.answer && q.proposedWork === null, q.intent);

    // 2 — the same subject, asked as work.
    const w = await run({ intent: 'WORK_REQUEST', confidence: 0.9,
      summary: 'asks for the cause to be fixed', orientation: 'N-0002 failed twice' },
    'Fix why M-0027 stopped.');
    check('FD5: "Fix why M-0027 stopped." is WORK_REQUEST',
      w.intent === 'WORK_REQUEST' && w.proposedWork !== null, w.intent);
    // The card must carry what the person wrote, not a helpful paraphrase.
    check('FD6: and the goal is the USER’s words, verbatim',
      w.proposedWork?.goal === 'Fix why M-0027 stopped.', String(w.proposedWork?.goal));
    check('FD7: with what the agent learned kept SEPARATE as orientation',
      w.proposedWork?.orientation === 'N-0002 failed twice', String(w.proposedWork?.orientation));

    // 9 — grammatical question form, work intent. The case that matters most.
    const shaped = await run({ intent: 'WORK_REQUEST', confidence: 0.85,
      summary: 'a work order phrased as a question' },
    'Can you refactor the landing localization so it doesn’t affect app language?');
    check('FD8: a work request PHRASED as a question is WORK_REQUEST',
      shaped.intent === 'WORK_REQUEST', shaped.intent);

    // 8 — work vocabulary, question intent.
    const about = await run({ intent: 'QUESTION', confidence: 0.9,
      summary: 'asks about an existing fix', answer: 'It was fixed in bea0d43.' },
    'What was the fix for the failing reviewer, and what were the findings?');
    check('FD9: "fix"/"findings" in a question stay a QUESTION',
      about.intent === 'QUESTION' && about.proposedWork === null, about.intent);

    // 5 — a subordinate deliverable.
    const sub = await run({ intent: 'WORK_REQUEST', confidence: 0.9,
      summary: 'refactor, with a report as part of the work' },
    'Refactor localization and report findings after you are done.');
    check('FD10: "report findings" as a deliverable does not demote work to a question',
      sub.intent === 'WORK_REQUEST', sub.intent);

    // 7 — the exact message that broke the table.
    const spec = 'Refactor TalkBridge’s frontend localization architecture so that '
      + 'landing-page localization is completely isolated from the signed-in app. '
      + 'Before implementation, report a concise evidence summary. If graph evidence '
      + 'is insufficient, explicitly report INSUFFICIENT_GRAPH_EVIDENCE.';
    const real = await run({ intent: 'WORK_REQUEST', confidence: 0.97,
      summary: 'a refactor specification' }, spec);
    check('FD11: the M-0031 specification is WORK_REQUEST',
      real.intent === 'WORK_REQUEST', real.intent);
    check('FD12: and all 3,000+ characters of it survive into the card',
      real.proposedWork?.goal === spec, `${real.proposedWork?.goal?.length} chars`);
  }

  section('the front door: reading is not authority');
  {
    // Having read a file to explain something must never become a licence to
    // change it. The decision carries no work when the intent is a question,
    // whatever the agent looked at on the way.
    const looked = await run({ intent: 'QUESTION', confidence: 0.9,
      summary: 'explains a dependency', answer: 'app-home.jsx imports content.js.',
      orientation: 'content.js has 4 dependents' },
    'Can changing content.js affect app-home?');
    check('FD13: a QUESTION never carries proposed work, even with orientation',
      looked.intent === 'QUESTION' && looked.proposedWork === null,
      JSON.stringify(looked.proposedWork));
    check('FD14: reading code to answer does not authorise changing it',
      looked.answer !== null && looked.proposedWork === null, 'answer only');
  }

  section('the front door: ambiguity is shown, not resolved cheaply');
  {
    const amb = await run({ intent: 'AMBIGUOUS', confidence: 0.4,
      summary: 'could be either',
      readings: [
        { intent: 'QUESTION', reading: 'explain how localization works today' },
        { intent: 'WORK_REQUEST', reading: 'change how localization works' },
      ] }, 'localization');
    check('FD15: AMBIGUOUS keeps both readings',
      amb.intent === 'AMBIGUOUS' && (amb.readings ?? []).length === 2,
      JSON.stringify(amb.readings));
    // The whole reason this exists: the table broke ties toward the cheap
    // reading and swallowed a work order in silence.
    check('FD16: it does not silently become the cheaper reading',
      amb.intent !== 'QUESTION' && amb.answer === null, amb.intent);

    // An ambiguous verdict with no readings is not a verdict.
    const bare = await run({ intent: 'AMBIGUOUS', confidence: 0.4, summary: 'unsure' }, 'x');
    check('FD17: "ambiguous" without readings is DEGRADED, not accepted',
      bare.degraded?.reason === 'FRONT_DOOR_NO_READINGS', JSON.stringify(bare.degraded));
  }

  section('the front door: fails visible, never quiet');
  {
    const dead = await run(null, 'anything', { infrastructureFailure: 'provider died' });
    check('FD18: a provider failure is DEGRADED with the reason',
      dead.degraded?.reason === 'FRONT_DOOR_UNAVAILABLE'
      && dead.degraded?.detail === 'provider died', JSON.stringify(dead.degraded));
    // The old path answered from the log no matter what. Silence that looks
    // like an answer is how a work order disappears.
    check('FD19: and it does NOT quietly become a QUESTION',
      dead.intent !== 'QUESTION' && dead.answer === null, dead.intent);
    check('FD20: it offers both readings so the person can still proceed',
      (dead.readings ?? []).length === 2, JSON.stringify(dead.readings));

    const junk = await run('not an object' as any, 'anything');
    check('FD21: an unparseable reply is DEGRADED',
      junk.degraded?.reason === 'FRONT_DOOR_UNPARSEABLE', JSON.stringify(junk.degraded));
    const wrong = await run({ intent: 'MAYBE' }, 'anything');
    check('FD22: an invented intent is refused rather than coerced',
      wrong.degraded?.reason === 'FRONT_DOOR_UNKNOWN_INTENT', JSON.stringify(wrong.degraded));
    const mute = await run({ intent: 'QUESTION', confidence: 1, summary: 's' }, 'anything');
    check('FD23: a QUESTION with no answer answered nothing, and says so',
      mute.degraded?.reason === 'FRONT_DOOR_EMPTY_ANSWER', JSON.stringify(mute.degraded));
  }

  section('the front door: read-only is a property of the tool list');
  {
    const t = frontDoorTools();
    // The read-only profile grants Bash. A shell reachable from a chat box is
    // an execution path however carefully the prompt is worded.
    check('FD24: the front door gets NO Bash',
      !t.includes('Bash'), t.join(' '));
    check('FD25: no Edit, no Write',
      !t.includes('Edit') && !t.includes('Write'), t.join(' '));
    check('FD26: it does get Read, Grep and Glob',
      ['Read', 'Grep', 'Glob'].every((x) => t.includes(x)), t.join(' '));
    check('FD27: and the graph tools',
      graphToolIds().every((x) => t.includes(x)), 'graph present');
    check('FD28: and Zeus’s own state tools',
      stateToolIds().every((x) => t.includes(x)), 'state present');
    // The ordinary read-only profile is unchanged — this narrows, never widens.
    check('FD29: the ordinary read-only profile still has Bash',
      toolsFor(true, null).includes('Bash'), 'critics unchanged');
    check('FD30: an explicit list is used verbatim, so a caller can only narrow',
      toolsFor(false, null, ['Read']).join(',') === 'Read', 'explicit wins');
  }

  section('the front door: it is a routed stage like any other');
  {
    check('FD31: front-door is in the routing table',
      (PIPELINE_STAGES as readonly string[]).includes('front-door'),
      PIPELINE_STAGES.join(', '));
    check('FD32: with a read-only role',
      STAGE_ROLE['front-door'] === 'reviewer', STAGE_ROLE['front-door']);
    // codex cancels MCP tool calls non-interactively; a front door without its
    // tools is the keyword table again, wearing a model's clothes.
    check('FD33: defaulting to a provider that can actually hold the tools',
      ZEUS_DEFAULT_ROUTING['front-door'].provider === 'claude',
      ZEUS_DEFAULT_ROUTING['front-door'].provider);
  }

  section('the front door: the prompt states the rules it must follow');
  {
    check('FD34: form is explicitly separated from intent',
      /GRAMMATICAL FORM IS NOT INTENT/.test(FRONT_DOOR_HEADER), 'stated');
    check('FD35: a subordinate deliverable is explicitly not the intent',
      /A SUBORDINATE DELIVERABLE IS NOT THE PRIMARY INTENT/.test(FRONT_DOOR_HEADER), 'stated');
    check('FD36: reading is explicitly not authority',
      /READING CODE DOES NOT AUTHORISE CHANGING IT/.test(FRONT_DOOR_HEADER), 'stated');
    check('FD37: fabrication is forbidden in words',
      /DO NOT FABRICATE/.test(FRONT_DOOR_HEADER), 'stated');
    check('FD38: the graph is navigation and source is truth',
      /THE GRAPH IS NAVIGATION\. THE SOURCE IS TRUTH/.test(FRONT_DOOR_HEADER), 'stated');
    check('FD39: tools only when they change the answer',
      /USE TOOLS ONLY WHEN THEY CAN CHANGE YOUR ANSWER/.test(FRONT_DOOR_HEADER), 'stated');
    check('FD40: the message is delivered under its own heading',
      buildPrompt('hello', null).includes('--- the message ---\nhello'), 'delivered');
    check('FD41: every intent it may return is named in the prompt',
      FRONT_DOOR_INTENTS.every((i) => FRONT_DOOR_HEADER.includes(i)),
      FRONT_DOOR_INTENTS.join(', '));
  }

  section('the front door: Zeus state is readable and nothing else');
  {
    check('FD42: the state tools are all reads',
      STATE_TOOLS.every((t) => /^zeus_(missions|mission|events|findings|trace)$/.test(t.name)),
      STATE_TOOLS.map((t) => t.name).join(', '));
    const src = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'graph', 'state-tools.ts'), 'utf8');
    // Read-only as a property of the module, not a hope about the prompt.
    // Matched on CALLS, not on letters: the prose says "spawns a process" and a
    // local is named `spawned`, and a check that fires on those is a check
    // about vocabulary rather than about capability.
    const calls = src.match(/\b(?:fs\.)?(writeFileSync|appendFileSync|rmSync|mkdirSync|unlinkSync|spawnSync|spawn|execFileSync|execSync)\s*\(/g) ?? [];
    check('FD43: the module cannot write, spawn or append',
      calls.length === 0, calls.join(', ') || 'no write path exists');
    check('FD44: an unknown id is reported as absent, not as an empty world',
      /This means Zeus has no such record/.test(src), 'absence is stated');

    const miss = callStateTool({ stateRoot: '/nonexistent', projectId: 'p' },
      'zeus_missions', {});
    check('FD45: a missing store yields "none found", not a crash',
      miss.ok && miss.results === 0, miss.text.slice(0, 60));
    check('FD46: an unknown tool is refused',
      callStateTool({ stateRoot: '/nonexistent', projectId: 'p' }, 'zeus_delete', {}).ok === false,
      'refused');
    // Trace policy is honoured, not re-decided.
    check('FD47: trace content is gated on what the level kept',
      /promptKept: !!p\.promptBlob/.test(src) && /replyKept: !!p\.responseBlob/.test(src),
      'metadata always, words only if kept');
  }
}
