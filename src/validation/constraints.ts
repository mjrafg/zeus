/**
 * Task constraints, as data rather than as prose.
 *
 * A task said "do not start frontend/backend/database services" and "use
 * lightweight static or targeted checks only". Those sentences reached the
 * agents as text and reached the validation planner not at all, so a heavy
 * integration suite ran anyway. The instruction was real; the constraint was
 * not.
 *
 * This turns the sentences into a structured set that the planner and the
 * execution policy can enforce. Two design rules follow from how it failed:
 *
 *   * **Parse conservatively.** A sentence we do not recognise produces no
 *     constraint, and the task proceeds as if unconstrained. Inventing a
 *     constraint from an ambiguous phrase would block work for no stated
 *     reason, which is its own failure.
 *   * **Never resolve a conflict silently.** If a REQUIRED test violates a
 *     stated constraint, both were asked for and only a human can say which
 *     wins.
 */

export type ConstraintKind =
  | 'NO_SERVICE_DEPENDENT'
  | 'NO_E2E'
  | 'MAX_FILES_CHANGED'
  | 'FORBIDDEN_PATHS'
  | 'NO_NEW_DEPENDENCIES';

export interface Constraint {
  kind: ConstraintKind;
  /** The literal sentence it came from, so the parse can be checked. */
  source: string;
  /** For MAX_FILES_CHANGED. */
  limit?: number;
  /** For FORBIDDEN_PATHS. */
  paths?: string[];
}

export interface ConstraintSet {
  constraints: Constraint[];
  /** Sentences that looked like constraints but were not understood. */
  unparsed: string[];
  has(kind: ConstraintKind): boolean;
  get(kind: ConstraintKind): Constraint | undefined;
}

interface Matcher {
  kind: ConstraintKind;
  re: RegExp;
  build?: (m: RegExpMatchArray, sentence: string) => Partial<Constraint>;
}

const MATCHERS: Matcher[] = [
  {
    kind: 'NO_SERVICE_DEPENDENT',
    re: /\b(do not|don'?t|never|no)\b[^.]*\b(start|spin up|boot|launch|run)\b[^.]*\b(service|services|database|db|backend|frontend|server|container|docker)\b/i,
  },
  {
    kind: 'NO_SERVICE_DEPENDENT',
    re: /\b(no|without)\b[^.]*\b(service-dependent|integration)\b[^.]*\b(test|suite)/i,
  },
  {
    kind: 'NO_SERVICE_DEPENDENT',
    re: /\b(lightweight|static|targeted)\b[^.]*\bchecks?\b[^.]*\bonly\b/i,
  },
  {
    kind: 'NO_E2E',
    re: /\b(do not|don'?t|never|no)\b[^.]*\b(playwright|cypress|e2e|end.to.end|browser)\b/i,
  },
  {
    kind: 'MAX_FILES_CHANGED',
    re: /\b(at most|no more than|maximum(?: of)?|max|limit(?:ed)? to)\s+(\d+)\s+files?\b/i,
    build: (m) => ({ limit: Number(m[2]) }),
  },
  {
    kind: 'MAX_FILES_CHANGED',
    re: /\bchange\s+(?:only\s+)?(one|a single)\s+file\b/i,
    build: () => ({ limit: 1 }),
  },
  {
    kind: 'FORBIDDEN_PATHS',
    re: /\b(do not|don'?t|never)\b[^.]*\b(touch|modify|change|edit)\b[^.]*?((?:[\w.*/-]+\/[\w.*/-]+|[\w-]+\.[a-z]{1,5})(?:\s*,\s*[\w.*/-]+)*)/i,
    build: (m) => ({
      paths: m[3].split(/\s*,\s*/).map((s) => s.trim()).filter(Boolean),
    }),
  },
  {
    kind: 'NO_NEW_DEPENDENCIES',
    re: /\b(do not|don'?t|never|no)\b[^.]*\b(add|install|introduce)\b[^.]*\b(dependenc|package|library|module)/i,
  },
];

/** Sentences that read like a restriction, for the unparsed report. */
const LOOKS_LIKE_A_CONSTRAINT = /\b(do not|don'?t|never|must not|avoid|only|no)\b/i;

function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Extracts a constraint set from the task description.
 *
 * Only the task text is parsed. Model output is never a source of constraints:
 * a planner that could relax its own limits by describing them differently
 * would be no limit at all.
 */
export function parseConstraints(taskText: string): ConstraintSet {
  const constraints: Constraint[] = [];
  const unparsed: string[] = [];

  for (const sentence of sentences(taskText)) {
    let matched = false;
    for (const m of MATCHERS) {
      const hit = sentence.match(m.re);
      if (!hit) continue;
      matched = true;
      const extra = m.build ? m.build(hit, sentence) : {};
      // Keep the strictest instance of a kind rather than the first.
      const existing = constraints.find((c) => c.kind === m.kind);
      if (existing) {
        if (m.kind === 'MAX_FILES_CHANGED' && typeof extra.limit === 'number'
            && (existing.limit ?? Infinity) > extra.limit) {
          existing.limit = extra.limit; existing.source = sentence;
        }
        if (m.kind === 'FORBIDDEN_PATHS' && extra.paths) {
          existing.paths = [...new Set([...(existing.paths ?? []), ...extra.paths])];
        }
        continue;
      }
      constraints.push({ kind: m.kind, source: sentence, ...extra });
    }
    if (!matched && LOOKS_LIKE_A_CONSTRAINT.test(sentence) && sentence.length < 240) {
      unparsed.push(sentence);
    }
  }

  return {
    constraints,
    unparsed,
    has(kind) { return constraints.some((c) => c.kind === kind); },
    get(kind) { return constraints.find((c) => c.kind === kind); },
  };
}

export type ViolationCode =
  | 'CONSTRAINT_SERVICE_DEPENDENT'
  | 'CONSTRAINT_E2E'
  | 'CONSTRAINT_FORBIDDEN_PATH'
  | 'CONSTRAINT_MAX_FILES'
  | 'CONSTRAINT_NEW_DEPENDENCY';

export interface Violation {
  code: ViolationCode;
  constraint: Constraint;
  detail: string;
  /** The check or path that violated it. */
  subject: string;
}

/**
 * Does this check violate a stated constraint?
 *
 * Returns every violation rather than the first, because a refusal should say
 * everything that is wrong with a selection at once.
 */
export function checkViolations(
  set: ConstraintSet,
  check: { name: string; klass: string },
): Violation[] {
  const out: Violation[] = [];
  const service = set.get('NO_SERVICE_DEPENDENT');
  if (service && (check.klass === 'SERVICE_DEPENDENT' || check.klass === 'UNKNOWN')) {
    out.push({
      code: 'CONSTRAINT_SERVICE_DEPENDENT', constraint: service, subject: check.name,
      detail: check.klass === 'UNKNOWN'
        ? `"${check.name}" could not be classified, and an unclassifiable suite is treated as service-dependent`
        : `"${check.name}" starts a service`,
    });
  }
  const e2e = set.get('NO_E2E');
  if (e2e && check.klass === 'E2E') {
    out.push({
      code: 'CONSTRAINT_E2E', constraint: e2e, subject: check.name,
      detail: `"${check.name}" drives a browser`,
    });
  }
  // A constraint against services also excludes E2E, which is a superset.
  if (service && check.klass === 'E2E' && !e2e) {
    out.push({
      code: 'CONSTRAINT_SERVICE_DEPENDENT', constraint: service, subject: check.name,
      detail: `"${check.name}" drives a browser, which starts services`,
    });
  }
  return out;
}

/** Violations of the diff itself, rather than of a selected check. */
export function diffViolations(
  set: ConstraintSet,
  diff: { files: string[]; addedDependencies?: string[] },
): Violation[] {
  const out: Violation[] = [];

  const max = set.get('MAX_FILES_CHANGED');
  if (max && typeof max.limit === 'number' && diff.files.length > max.limit) {
    out.push({
      code: 'CONSTRAINT_MAX_FILES', constraint: max, subject: `${diff.files.length} files`,
      detail: `${diff.files.length} files changed, limit was ${max.limit}`,
    });
  }

  const forbidden = set.get('FORBIDDEN_PATHS');
  if (forbidden?.paths?.length) {
    for (const f of diff.files) {
      const hit = forbidden.paths.find((p) => f === p || f.startsWith(`${p.replace(/\/$/, '')}/`) || f.endsWith(`/${p}`));
      if (hit) {
        out.push({
          code: 'CONSTRAINT_FORBIDDEN_PATH', constraint: forbidden, subject: f,
          detail: `${f} is under a path the task forbade (${hit})`,
        });
      }
    }
  }

  const deps = set.get('NO_NEW_DEPENDENCIES');
  if (deps && diff.addedDependencies?.length) {
    out.push({
      code: 'CONSTRAINT_NEW_DEPENDENCY', constraint: deps,
      subject: diff.addedDependencies.join(', '),
      detail: `added ${diff.addedDependencies.length} dependenc(ies) the task forbade`,
    });
  }

  return out;
}
