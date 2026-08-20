/**
 * The one place that decides what runs.
 *
 * The defect this exists to prevent: a phase acquiring checks by its own route.
 * In the predecessor system that was FINAL_ACCEPTANCE running an integration
 * suite a FAST task had already been cleared without. In Zeus today the same
 * shape survives in the reviewer-expansion loop, which re-derives a plan and
 * spawns from it directly rather than going through the tier planner the way
 * VERIFY does.
 *
 * Two paths that pick checks will eventually disagree. So there is one
 * function, every phase calls it, and it returns a **ledger**: the checks
 * approved, and the checks refused with the reason. The supervisor then refuses
 * anything not on the ledger, which is what makes the single path structural
 * rather than a convention that holds until someone adds a line.
 *
 * Selection answers four questions in a fixed order, and the order matters:
 *
 *   1. what does the deterministic floor require?   (never negotiable)
 *   2. what does the tier add?                      (cheap → expensive)
 *   3. does a task constraint forbid any of it?     (refuse, do not silently drop)
 *   4. is the total wildly out of proportion?       (escalate, do not proceed)
 */

import { Tier, ValidationPlan, planFor } from './tier';
import { Classification, TestClass } from './testclass';
import { ConstraintSet, Violation, checkViolations } from './constraints';

export type SelectionPhase = 'VERIFY' | 'REVIEW_EXPANSION' | 'FINAL_ACCEPTANCE';

export interface SelectedCheck {
  name: string;
  command: string;
  /** Required checks are the deterministic floor; they are never dropped. */
  required: boolean;
  cls: 'light' | 'heavy';
  klass: TestClass;
  /** Which signal put this check on the list. Never "final acceptance runs everything". */
  reason: string;
}

export interface RefusedCheck {
  name: string;
  command: string;
  code: 'CONSTRAINT_VIOLATION' | 'TIER_EXCLUDES_SERVICE' | 'COST_DISPROPORTION';
  detail: string;
  violations?: Violation[];
}

export interface CostSignals {
  /** How long the implementation itself took. */
  implementMs: number;
  /** Files in the diff. */
  filesChanged: number;
  /** Hunks classified. */
  hunks: number;
  /** Historic wall clock per check name, when known. */
  observedMs?: Record<string, number>;
}

export interface CostAssessment {
  estimatedValidationMs: number;
  workMs: number;
  ratio: number;
  threshold: number;
  disproportionate: boolean;
  detail: string;
}

export interface SelectionLedger {
  phase: SelectionPhase;
  tier: Tier;
  selected: SelectedCheck[];
  refused: RefusedCheck[];
  classifications: Classification[];
  cost: CostAssessment | null;
  /** Present when a REQUIRED check conflicts with a stated constraint. */
  conflict: {
    code: 'REQUIRED_TEST_CONSTRAINT_CONFLICT';
    check: string;
    violations: Violation[];
    detail: string;
  } | null;
  reasons: string[];
}

/**
 * Default cost estimate for a check we have never timed, by class.
 *
 * Deliberately coarse. The point is to notice a 1:110 disproportion, not to
 * predict a runtime — and a precise-looking estimate would invite trust it has
 * not earned.
 */
const DEFAULT_MS: Record<TestClass, number> = {
  UNIT: 3_000,
  INTEGRATION: 30_000,
  SERVICE_DEPENDENT: 300_000,
  E2E: 600_000,
  UNKNOWN: 300_000,
};

/** Validation may cost this many times the work before it needs a reason. */
export const DEFAULT_COST_RATIO = 20;

/** The tier at which a service-dependent suite may be selected at all. */
function tierAllowsService(tier: Tier, klass: TestClass, namedSurface: boolean): { ok: boolean; why: string } {
  if (klass !== 'SERVICE_DEPENDENT' && klass !== 'E2E' && klass !== 'UNKNOWN') {
    return { ok: true, why: '' };
  }
  if (tier === 'FAST') {
    return { ok: false, why: 'FAST never selects a service-dependent, browser-driving or unclassifiable suite' };
  }
  if (tier === 'NORMAL' && !namedSurface) {
    return {
      ok: false,
      why: 'NORMAL selects a service-dependent suite only when impact analysis names a concrete affected surface, and it named none',
    };
  }
  return { ok: true, why: tier === 'DEEP' ? 'tier DEEP' : 'impact analysis named an affected surface' };
}

export interface SelectionInput {
  phase: SelectionPhase;
  tier: Tier;
  commands: Record<string, string | null | undefined>;
  classifications: Classification[];
  constraints: ConstraintSet;
  /** Files impact analysis identified as affected. Empty means "none named". */
  affectedSurfaces: string[];
  /** Checks already run in this task, so a phase cannot repeat one. */
  alreadyRun?: Set<string>;
  cost?: CostSignals;
  costRatioThreshold?: number;
}

const COMMAND_KEY: Record<string, string> = {
  'unit-test': 'unitTest',
  'integration-test': 'integrationTest',
};

function commandFor(commands: SelectionInput['commands'], name: string): string | null {
  const key = COMMAND_KEY[name] ?? name;
  const v = commands[key];
  return typeof v === 'string' && v.trim() ? v : null;
}

/**
 * Selects the checks for a phase.
 *
 * Every phase calls this. A phase that wants something extra changes the tier
 * or the constraints and calls it again; it does not reach for a command
 * itself.
 */
export function selectChecks(input: SelectionInput): SelectionLedger {
  const reasons: string[] = [];
  const selected: SelectedCheck[] = [];
  const refused: RefusedCheck[] = [];
  const alreadyRun = input.alreadyRun ?? new Set<string>();
  const byName = new Map(input.classifications.map((c) => [c.check, c]));
  const namedSurface = input.affectedSurfaces.length > 0;

  const plan: ValidationPlan = planFor(input.tier, input.commands);
  reasons.push(`tier ${input.tier}: floor [${plan.floor.join(', ') || 'none'}], additional [${plan.additional.join(', ') || 'none'}]`);

  let conflict: SelectionLedger['conflict'] = null;

  const consider = (name: string, required: boolean, why: string) => {
    if (alreadyRun.has(name)) return;
    const command = commandFor(input.commands, name);
    if (!command) return;
    const klass = byName.get(name)?.klass ?? 'UNKNOWN';
    const violations = checkViolations(input.constraints, { name, klass });

    if (required) {
      // The floor is not subject to tier or cost. It IS subject to being
      // impossible: if the task forbade what the required check does, both
      // instructions were given and only a human can choose between them.
      //
      // But only on a POSITIVE finding. UNKNOWN means "we could not classify
      // this", and treating that as a violation escalated every constrained
      // task to a human the moment its type checker went unrecognised. UNKNOWN
      // is conservative for SELECTION — it keeps optional work out — and must
      // not be conservative for the floor, which is never optional.
      const positive = violations.filter((v) => klass === 'SERVICE_DEPENDENT' || klass === 'E2E');
      if (klass === 'UNKNOWN' && violations.length) {
        reasons.push(`"${name}" is required and could not be classified; it runs, and the uncertainty is recorded rather than escalated`);
      }
      if (positive.length && !conflict) {
        conflict = {
          code: 'REQUIRED_TEST_CONSTRAINT_CONFLICT',
          check: name,
          violations: positive,
          detail: `the deterministic floor requires "${name}", and the task forbids it: `
            + positive.map((v) => v.detail).join('; ')
            + '. Both were asked for; Zeus will not choose between them silently.',
        };
      }
      selected.push({ name, command, required: true, cls: name === 'unit-test' ? 'heavy' : 'light', klass, reason: why });
      return;
    }

    if (violations.length) {
      refused.push({
        name, command, code: 'CONSTRAINT_VIOLATION', violations,
        detail: violations.map((v) => v.detail).join('; '),
      });
      return;
    }
    const allowed = tierAllowsService(input.tier, klass, namedSurface);
    if (!allowed.ok) {
      refused.push({ name, command, code: 'TIER_EXCLUDES_SERVICE', detail: `${allowed.why} (${name} is ${klass})` });
      return;
    }
    selected.push({
      name, command, required: false,
      cls: klass === 'SERVICE_DEPENDENT' || klass === 'E2E' || name === 'integration-test' ? 'heavy' : 'light',
      klass, reason: allowed.why ? `${why}; ${allowed.why}` : why,
    });
  };

  for (const name of plan.floor) consider(name, true, 'deterministic floor — runs at every tier');
  for (const name of plan.additional) consider(name, false, `tier ${input.tier} adds this`);

  // ---- cost disproportion ---------------------------------------------------
  let cost: CostAssessment | null = null;
  if (input.cost) {
    const threshold = input.costRatioThreshold ?? DEFAULT_COST_RATIO;
    const estimate = (c: SelectedCheck) =>
      input.cost?.observedMs?.[c.name] ?? DEFAULT_MS[c.klass];
    const estimatedValidationMs = selected.reduce((a, c) => a + estimate(c), 0);
    const workMs = Math.max(1, input.cost.implementMs);
    const ratio = estimatedValidationMs / workMs;
    const disproportionate = ratio > threshold;
    cost = {
      estimatedValidationMs, workMs, ratio, threshold, disproportionate,
      detail: `${Math.round(estimatedValidationMs / 1000)}s of validation estimated against `
        + `${Math.round(workMs / 1000)}s of implementation over ${input.cost.filesChanged} file(s) `
        + `— ratio ${ratio.toFixed(1)}:1, threshold ${threshold}:1`,
    };

    if (disproportionate) {
      // Drop to the justified minimum: the floor stays, the optional extras go,
      // and each removal is recorded. Cost never removes a required check.
      const droppable = selected.filter((c) => !c.required);
      for (const c of droppable) {
        refused.push({
          name: c.name, command: c.command, code: 'COST_DISPROPORTION',
          detail: `dropped to the justified minimum: ${cost.detail}`,
        });
      }
      for (let i = selected.length - 1; i >= 0; i -= 1) {
        if (!selected[i].required) selected.splice(i, 1);
      }
      reasons.push(`cost disproportion: ${cost.detail}; reduced to the deterministic floor`);
    }
  }

  if (refused.length) {
    reasons.push(`${refused.length} check(s) refused before execution`);
  }

  return {
    phase: input.phase, tier: input.tier, selected, refused,
    classifications: input.classifications, cost, conflict, reasons,
  };
}

/**
 * The approved set, as a lookup the supervisor can enforce against.
 *
 * A check not on this list does not run, whichever phase asked. That is what
 * makes "one selection path" a property of the system rather than a promise
 * about how carefully the orchestrator was written.
 */
export function approvedKeys(ledger: SelectionLedger): Set<string> {
  return new Set(ledger.selected.map((c) => `${c.name} ${c.command}`));
}

export function approvalKey(name: string, command: string): string {
  return `${name} ${command}`;
}
