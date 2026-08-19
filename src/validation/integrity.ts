/**
 * Protection for the evidence chain itself.
 *
 * Every other safeguard in Zeus assumes the tests mean something. When nobody
 * is watching, the cheapest route to a green run is not to write better code —
 * it is to edit the thing doing the measuring. Delete the failing test, add
 * `.skip`, weaken the assertion, rename the file the required command points
 * at, and the pipeline reports success in good faith.
 *
 * So the rules in this module are not configurable. They are not preferences
 * about how strict a team wants to be; they are the reason an unattended run
 * can be believed at all. Everything here is deterministic pattern work on the
 * diff — no model judgement anywhere near the safety floor.
 */

import { ParsedDiff, FileDiff, hunksOf } from './diff';
import { classifyPath } from './surface';

export type IntegrityCode =
  | 'REQUIRED_TEST_TAMPERED'
  | 'TEST_DELETED_WITHOUT_JUSTIFICATION'
  | 'ASSERTION_WEAKENED_WITHOUT_JUSTIFICATION'
  | 'TEST_DISABLED'
  | 'TEST_SURFACE_CHANGED';

export type IntegritySeverity = 'BLOCKING' | 'REVIEW';

export interface IntegrityFinding {
  code: IntegrityCode;
  severity: IntegritySeverity;
  file: string;
  detail: string;
  /** The exact lines that triggered it, so a reviewer need not hunt. */
  evidence: string[];
}

/** What the planner declared, and therefore what may not move underneath it. */
export interface DesignContract {
  requiredTests: string[];
  /**
   * Explicit, per-path justification for changing a test surface. A design
   * that does not name the path does not justify it.
   */
  testChangeJustifications: Array<{ path: string; reason: string }>;
}

/** Reads the contract out of whatever the planner returned, defensively. */
export function designContract(design: unknown): DesignContract {
  const d = (design ?? {}) as any;
  const requiredTests = Array.isArray(d.requiredTests) ? d.requiredTests.map(String) : [];
  const raw = Array.isArray(d.testChangeJustifications) ? d.testChangeJustifications
    : Array.isArray(d.testChanges) ? d.testChanges : [];
  const testChangeJustifications = raw
    .map((j: any) => ({ path: String(j?.path ?? ''), reason: String(j?.reason ?? j?.justification ?? '') }))
    .filter((j: { path: string; reason: string }) => j.path && j.reason.trim().length >= 12);
  return { requiredTests, testChangeJustifications };
}

/** True when the design explicitly justified changing this path. */
export function isJustified(contract: DesignContract, file: string): boolean {
  return contract.testChangeJustifications.some((j) => {
    const p = j.path.replace(/^\.\//, '');
    return p === file || file.endsWith(`/${p}`) || p.endsWith(`/${file}`);
  });
}

/**
 * Path-like tokens inside a required-test command.
 *
 * `npm test -- tests/auth.spec.ts` names a file the command depends on. If the
 * diff deletes or renames that file, the required test no longer means what
 * the design said it meant, whatever the command's exit code says.
 */
export function pathsReferencedBy(command: string): string[] {
  const tokens = command.split(/\s+/).filter(Boolean);
  return tokens.filter((t) =>
    !t.startsWith('-') &&
    /[\/.]/.test(t) &&
    /\.[a-z0-9]+$|\//i.test(t) &&
    !/^https?:/i.test(t));
}

/** Test-declaration names added or removed by a hunk. */
const TEST_DECL = /\b(?:it|test|describe|context|scenario)\s*(?:\.\s*\w+\s*)?\(\s*(['"`])(.+?)\1/;
const PY_TEST_DECL = /^\s*def\s+(test_\w+)\s*\(/;
const GO_TEST_DECL = /^\s*func\s+(Test\w+)\s*\(/;

function declaredNames(lines: string[]): string[] {
  const names: string[] = [];
  for (const l of lines) {
    const m = TEST_DECL.exec(l);
    if (m) { names.push(m[2]); continue; }
    const py = PY_TEST_DECL.exec(l);
    if (py) { names.push(py[1]); continue; }
    const go = GO_TEST_DECL.exec(l);
    if (go) names.push(go[1]);
  }
  return names;
}

/** Annotations that stop a test running while leaving it looking present. */
const DISABLING = [
  { re: /\b(?:it|test|describe|context)\s*\.\s*(skip|only|todo|failing)\b/, what: (m: RegExpExecArray) => `.${m[1]}` },
  { re: /\b(xit|xdescribe|xtest|fit|fdescribe)\s*\(/, what: (m: RegExpExecArray) => m[1] },
  { re: /@(?:pytest\.mark\.)?(skip|skipif|xfail)\b/, what: (m: RegExpExecArray) => `@${m[1]}` },
  { re: /\bt\.Skip\s*\(/, what: () => 't.Skip()' },
  { re: /#\[\s*ignore\s*\]/, what: () => '#[ignore]' },
  { re: /@(Disabled|Ignore)\b/, what: (m: RegExpExecArray) => `@${m[1]}` },
];

function disablingIn(line: string): string | null {
  for (const d of DISABLING) {
    const m = d.re.exec(line);
    if (m) return d.what(m);
  }
  return null;
}

/** Lines that assert something. Removing one removes a guarantee. */
const ASSERTION = /\b(expect|assert|assertEquals|assertTrue|assertThat|should|must|require\.(?:NoError|Equal)|t\.(?:Error|Fatal))\b|\bassert\s/;

export interface IntegrityReport {
  findings: IntegrityFinding[];
  /** Test files this diff touched, whatever the outcome. */
  testFilesChanged: string[];
  /** Test names this diff removed. */
  testsRemoved: string[];
  /** Disabling annotations this diff added. */
  testsDisabled: Array<{ file: string; name: string; annotation: string }>;
  blocking: IntegrityFinding[];
}

/**
 * Inspects an implementer diff against the design contract.
 *
 * Returns findings rather than throwing: the caller decides what a blocking
 * finding does to the lifecycle, and every finding is recorded either way.
 */
export function inspectIntegrity(diff: ParsedDiff, contract: DesignContract): IntegrityReport {
  const findings: IntegrityFinding[] = [];
  const testFilesChanged: string[] = [];
  const testsRemoved: string[] = [];
  const testsDisabled: IntegrityReport['testsDisabled'] = [];

  // --- (a) required tests are immutable during IMPLEMENT/FIX ----------------
  const requiredPaths = new Set<string>();
  for (const cmd of contract.requiredTests) {
    for (const p of pathsReferencedBy(cmd)) requiredPaths.add(p.replace(/^\.\//, ''));
  }
  for (const f of diff.files) {
    if (f.status !== 'deleted' && f.status !== 'renamed') continue;
    const gone = f.status === 'renamed' ? f.oldPath! : f.path;
    for (const rp of requiredPaths) {
      if (gone === rp || gone.endsWith(`/${rp}`) || rp.endsWith(`/${gone}`)) {
        findings.push({
          code: 'REQUIRED_TEST_TAMPERED', severity: 'BLOCKING', file: gone,
          detail: f.status === 'renamed'
            ? `a required test file was renamed to ${f.path}; required tests declared in Task Design are immutable during IMPLEMENT and FIX`
            : 'a required test file was deleted; required tests declared in Task Design are immutable during IMPLEMENT and FIX',
          evidence: contract.requiredTests.filter((c) => pathsReferencedBy(c).some((p) => p.replace(/^\.\//, '') === rp)),
        });
      }
    }
  }

  for (const f of diff.files) {
    const sc = classifyPath(f.path);
    const oldSc = f.oldPath ? classifyPath(f.oldPath) : null;
    if (!sc.testSurface && !oldSc?.testSurface) continue;
    testFilesChanged.push(f.path);

    const justified = isJustified(contract, f.path) || (f.oldPath ? isJustified(contract, f.oldPath) : false);

    // --- a whole test file removed ------------------------------------------
    if (f.status === 'deleted' && !justified) {
      findings.push({
        code: 'TEST_DELETED_WITHOUT_JUSTIFICATION', severity: 'BLOCKING', file: f.path,
        detail: 'a test file was deleted and the task design gives no justification for removing it',
        evidence: [`${f.path} (deleted)`],
      });
    }

    const added = hunksOf(f).flatMap((h) => h.added);
    const removed = hunksOf(f).flatMap((h) => h.removed);

    // --- (c) disabling annotations -------------------------------------------
    const addedAnnotations = added
      .map((l) => ({ line: l, ann: disablingIn(l) }))
      .filter((x) => x.ann);
    for (const a of addedAnnotations) {
      // Only surface it when it was NOT already there: a test that arrives
      // skipped in the same diff that creates it is a different story from a
      // previously running test being switched off.
      const wasThere = removed.some((r) => disablingIn(r) && r.trim() === a.line.trim());
      if (wasThere) continue;
      const name = declaredNames([a.line])[0] ?? '(unnamed)';
      testsDisabled.push({ file: f.path, name, annotation: a.ann! });
      findings.push({
        code: 'TEST_DISABLED', severity: f.status === 'added' ? 'REVIEW' : 'REVIEW', file: f.path,
        detail: `${a.ann} was added to ${name === '(unnamed)' ? 'a test' : `"${name}"`}, which stops it running while leaving it looking present`,
        evidence: [a.line.trim()],
      });
    }

    // --- individual tests removed --------------------------------------------
    const before = declaredNames(removed);
    const after = declaredNames(added);
    const dropped = before.filter((n) => !after.includes(n));
    for (const n of dropped) {
      testsRemoved.push(`${f.path}::${n}`);
      if (!justified) {
        findings.push({
          code: 'TEST_DELETED_WITHOUT_JUSTIFICATION', severity: 'BLOCKING', file: f.path,
          detail: `test "${n}" was removed and the task design gives no justification for removing it`,
          evidence: removed.filter((l) => l.includes(n)).map((l) => l.trim()).slice(0, 3),
        });
      }
    }

    // --- assertions weakened ---------------------------------------------------
    const assertionsRemoved = removed.filter((l) => ASSERTION.test(l));
    const assertionsAdded = added.filter((l) => ASSERTION.test(l));
    if (assertionsRemoved.length > assertionsAdded.length && !justified && f.status !== 'added') {
      findings.push({
        code: 'ASSERTION_WEAKENED_WITHOUT_JUSTIFICATION', severity: 'BLOCKING', file: f.path,
        detail: `${assertionsRemoved.length} assertion(s) removed and ${assertionsAdded.length} added, with no justification in the task design`,
        evidence: assertionsRemoved.slice(0, 3).map((l) => l.trim()),
      });
    }
  }

  if (testFilesChanged.length) {
    findings.push({
      code: 'TEST_SURFACE_CHANGED', severity: 'REVIEW', file: testFilesChanged.join(', '),
      detail: 'this change modifies the test surface; the modification needs to be verified as justified',
      evidence: testFilesChanged,
    });
  }

  return {
    findings, testFilesChanged, testsRemoved, testsDisabled,
    blocking: findings.filter((f) => f.severity === 'BLOCKING'),
  };
}

/**
 * (b) Files that acceptance evidence depends on.
 *
 * A diff touching one of these is flagged for risk-focused review even when it
 * breaks no rule: "the code under the required test changed" is exactly the
 * situation where a second pair of eyes is worth the cost.
 */
export function evidenceCoupledFiles(diff: ParsedDiff, contract: DesignContract): string[] {
  const referenced = new Set<string>();
  for (const cmd of contract.requiredTests) {
    for (const p of pathsReferencedBy(cmd)) referenced.add(p.replace(/^\.\//, ''));
  }
  const touched = new Set<string>();
  for (const f of diff.files) {
    for (const rp of referenced) {
      if (f.path === rp || f.path.endsWith(`/${rp}`) || rp.endsWith(`/${f.path}`)) touched.add(f.path);
    }
  }
  return [...touched];
}

/**
 * (d) The acceptance report's test accounting.
 *
 * "Tests passed" and "tests this task edited, which then passed" are different
 * claims and are never merged. The second is the one a reader needs to see.
 */
export interface TestAccounting {
  passed: string[];
  modifiedThenPassed: string[];
  /** Convenience for the report: the honest headline. */
  summary: string;
}

export function accountForTests(
  checks: Array<{ name: string; outcome: string }>,
  testFilesChanged: string[],
  /** Maps a check name to the files it covers, when the project declares it. */
  coverage: Record<string, string[]> = {},
): TestAccounting {
  const passed: string[] = [];
  const modifiedThenPassed: string[] = [];
  for (const c of checks) {
    if (c.outcome !== 'PASSED') continue;
    const covers = coverage[c.name] ?? [];
    const touchesModified = testFilesChanged.length > 0
      && (covers.length === 0 || covers.some((f) => testFilesChanged.includes(f)));
    if (touchesModified) modifiedThenPassed.push(c.name);
    else passed.push(c.name);
  }
  const summary = modifiedThenPassed.length
    ? `${passed.length} passed; ${modifiedThenPassed.length} passed after this task modified the test surface`
    : `${passed.length} passed`;
  return { passed, modifiedThenPassed, summary };
}
