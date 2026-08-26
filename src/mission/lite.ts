/**
 * Zeus Lite: two stages, and everything that makes a review worth having.
 *
 * WHAT IT IS. One agent plans and writes the change; one independent reviewer
 * reads the diff. On a blocking finding the builder gets ONE repair carrying
 * those findings, and if that is refused too the task stops for a person - who
 * can add a note and send it back for one more.
 *
 * WHAT IT IS NOT. It is not a second engine. The worktree, the checks, the
 * review context policy that keeps the reviewer from seeing the builder's
 * reasoning, the write check, the read-scope check and the event log are the
 * same code the full pipeline uses. What Mission Mode adds - a compiled
 * contract, two critics, a plan graph, a ratchet - is ceremony that earns its
 * cost when being wrong about WHAT to build is the expensive mistake, and does
 * not when the goal is one obvious change.
 *
 * NOTHING IS INTEGRATED HERE, deliberately. A lite run leaves its change in the
 * task's worktree and says where. Landing it is a person's decision, and
 * inventing ratchet semantics without a mission to own them would be a second
 * answer to a question Mission Mode already answers.
 */

import { Engine } from '../engine/orchestrator';
import { TaskState } from '../engine/orchestrator';
import { priorAttempt, repairBrief, PriorAttempt } from './attempt';

/** One build-and-review pass. */
export interface LiteAttemptResult {
  taskId: string;
  state: TaskState;
  /** Blocking findings the reviewer raised against this attempt. */
  findings: PriorAttempt['findings'];
  /** Checks that did not pass. */
  failedChecks: PriorAttempt['failedChecks'];
  worktree: string | null;
  repair: boolean;
}

export interface LiteRunResult {
  attempts: LiteAttemptResult[];
  /** The last attempt, which is the one a person is being asked about. */
  final: LiteAttemptResult;
  accepted: boolean;
  /**
   * What a person can do next, in their own terms rather than a state name.
   *
   * Present whenever the run stopped short, because a run that stops without
   * saying what would unstick it is a run that gets abandoned.
   */
  nextStep: string | null;
}

/** How many automatic repairs a lite run spends before asking a person. */
export const LITE_REPAIRS = 1;

/**
 * States that mean "a person has to look", as distinct from "this failed".
 *
 * BLOCKED is the reviewer refusing a change, which is a finished, correct piece
 * of work by the reviewer and a resumable position for the builder. Treating it
 * as terminal failure is what M-0034 did one layer up, and it cost that mission
 * the repair it was entitled to.
 */
const HUMAN_PENDING = new Set<TaskState>(['BLOCKED', 'AWAITING_HUMAN']);

function outcomeOf(engine: Engine, taskId: string, state: TaskState,
  repair: boolean): LiteAttemptResult {
  const prior = priorAttempt(engine, taskId, `task ${taskId} finished ${state}`);
  return {
    taskId,
    state,
    findings: prior?.findings ?? [],
    failedChecks: prior?.failedChecks ?? [],
    worktree: engine.task(taskId)?.worktree ?? null,
    repair,
  };
}

export interface LiteRunInput {
  engine: Engine;
  goal: string;
  /**
   * A person's own words, carried into the FIRST attempt of this run.
   *
   * This is how `lite continue` works: the note rides in front of the previous
   * attempt's findings, so the builder is answering the reviewer AND the person
   * rather than choosing between them.
   */
  note?: string | null;
  /**
   * A previous run's blocked attempt, when a person is sending it back.
   *
   * Read from the event log rather than passed as state, so a note added days
   * later in a fresh process reaches the same findings.
   */
  resumeFrom?: string | null;
  onEvent?: (line: string) => void;
}

export async function runLite(input: LiteRunInput): Promise<LiteRunResult> {
  const { engine, goal } = input;
  const say = input.onEvent ?? (() => {});
  const attempts: LiteAttemptResult[] = [];

  // A CONTINUATION IS A REPAIR, not a new task, and it must inherit what
  // refused the last one. Building the brief from the log means a note added
  // in a different process still arrives with the findings attached.
  let brief = '';
  let isRepair = false;
  if (input.resumeFrom) {
    const prior = priorAttempt(engine, input.resumeFrom,
      'a person sent this back after the reviewer refused it');
    if (prior) { brief = repairBrief(prior); isRepair = true; }
  }
  const note = (input.note ?? '').trim();
  const noteBlock = note
    ? `\n\nWHAT THE PERSON WHO SENT THIS BACK ASKED FOR, which takes precedence`
      + ` over your own reading of the task:\n${note}`
    : '';

  for (let round = 0; round <= LITE_REPAIRS; round += 1) {
    const description = `${goal}${noteBlock}${brief}`;
    const rec = engine.createTask(description, isRepair ? { repair: true } : {});
    say(`${isRepair ? 'repair' : 'build'} → ${rec.taskId}`);

    let state: TaskState;
    try { state = await engine.run(rec.taskId); }
    catch (e: any) { state = 'FAILED'; say(`${rec.taskId} threw: ${e?.message ?? e}`); }

    const attempt = outcomeOf(engine, rec.taskId, state, isRepair);
    attempts.push(attempt);

    if (state === 'COMPLETED') {
      return { attempts, final: attempt, accepted: true, nextStep: null };
    }
    // AN INFRASTRUCTURE FAILURE IS NOT A REFUSED CHANGE. Spending the repair
    // on a provider outage would burn the one attempt a person is entitled to
    // on something no repair can fix.
    if (!HUMAN_PENDING.has(state)) {
      return { attempts, final: attempt, accepted: false,
        nextStep: `${rec.taskId} finished ${state}, which is not a review verdict; `
          + 'run it again once the cause is cleared' };
    }
    if (round === LITE_REPAIRS) break;

    // The repair answers THIS attempt, so the brief is rebuilt from it rather
    // than carried forward from an older one.
    const prior = priorAttempt(engine, rec.taskId, `the reviewer refused ${rec.taskId}`);
    if (!prior) {
      return { attempts, final: attempt, accepted: false,
        nextStep: `${rec.taskId} is blocked but recorded no findings or failed checks, `
          + 'so there is nothing for a repair to answer; read its log' };
    }
    brief = repairBrief(prior);
    isRepair = true;
    say(`${prior.findings.length} finding(s) go to the repair`);
  }

  const final = attempts[attempts.length - 1];
  return {
    attempts, final, accepted: false,
    nextStep: `${final.taskId} is blocked after ${attempts.length} attempt(s). `
      + `Its change is in ${final.worktree ?? 'its worktree'}. `
      + `Add guidance and send it back with: zeus lite continue ${final.taskId} --note "..."`,
  };
}
