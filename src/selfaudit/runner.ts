/**
 * The self-audit runner.
 *
 * Runs lanes against a disposable checkout, assembles the coverage matrix, and
 * produces a verdict. Two rules are enforced here rather than trusted to the
 * report author:
 *
 *   * a CONFIRMED finding must come from a probe that ran and captured output;
 *   * a section that was not tested must carry a specific reason, and a lane
 *     that silently omits one is itself reported as a coverage defect.
 *
 * The verdict is deliberately narrow. It says what was tested and what held,
 * never "no bugs remain".
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  LaneSpec, LaneResult, Finding, CoverageEntry, ProbeContext, Severity,
} from './types';

export interface RunLaneOptions {
  auditRoot: string;
  cycleId: string;
  /** Where probe scratch directories live. Removed afterwards. */
  scratch?: string;
}

export async function runLane(spec: LaneSpec, opts: RunLaneOptions): Promise<LaneResult> {
  const started = Date.now();
  const tmp = fs.mkdtempSync(path.join(opts.scratch ?? os.tmpdir(), `zeus-lane-${spec.lane}-`));
  const notes: string[] = [];
  const findings: Finding[] = [];
  const probedSections = new Map<string, string[]>();
  let held = 0;
  let ran = 0;
  let error: string | undefined;

  const ctx: ProbeContext = { tmp, auditRoot: opts.auditRoot, note: (s) => notes.push(s) };

  for (const probe of spec.probes) {
    ran += 1;
    const list = probedSections.get(probe.section) ?? [];
    list.push(probe.id);
    probedSections.set(probe.section, list);
    try {
      const outcome = await probe.run(ctx);
      if (outcome.held) { held += 1; continue; }
      const f = outcome.finding!;
      findings.push({
        ...f,
        id: `${spec.lane}-${probe.id}`,
        lane: spec.lane,
        // A finding produced by a probe that executed IS reproducible: the
        // probe is the reproduction, and its output is the evidence.
        status: 'CONFIRMED',
        reproduction: `audits/harness/lane-${spec.lane.toLowerCase()}.ts :: probe ${probe.id}`,
        observed: outcome.observed,
      });
    } catch (e: any) {
      // A probe that crashes has not proved anything. It is reported as an
      // untested area rather than as a pass or as a finding.
      notes.push(`probe ${probe.id} threw: ${String(e?.message ?? e)}`);
      const list2 = probedSections.get(probe.section) ?? [];
      probedSections.set(probe.section, list2.filter((x) => x !== probe.id));
      error = error ?? `probe ${probe.id} threw`;
    }
  }

  const coverage: CoverageEntry[] = spec.sections.map((s) => {
    const probes = probedSections.get(s.id) ?? [];
    if (probes.length) {
      return { section: s.id, title: s.title, status: 'TESTED' as const, probes };
    }
    const declared = spec.declared?.find((d) => d.section === s.id);
    if (declared) {
      return { section: s.id, title: s.title, status: declared.status, reason: declared.reason, probes: [] };
    }
    return {
      section: s.id, title: s.title, status: 'NOT_TESTED' as const, probes: [],
      reason:
        'REPORTING DEFECT: this section has no probe and the lane declared no reason. '
        + 'An untested area with no stated reason is indistinguishable from an area nobody thought about.',
    };
  });

  fs.rmSync(tmp, { recursive: true, force: true });

  return {
    lane: spec.lane, title: spec.title, findings, coverage,
    probesRun: ran, probesHeld: held, notes,
    durationMs: Date.now() - started,
    complete: !error, error,
  };
}

export type Verdict = 'CANDIDATE_SAFE_TO_INSTALL' | 'FINDINGS_OPEN';

export interface CycleResult {
  cycleId: string;
  head: string;
  startedAt: string;
  finishedAt: string;
  lanes: LaneResult[];
  findings: Finding[];
  confirmed: number;
  suspected: number;
  bySeverity: Record<Severity, number>;
  coverageGaps: CoverageEntry[];
  verdict: Verdict;
  /** The chain of facts the verdict rests on. Never a summary adjective. */
  evidenceChain: string[];
}

const SEVERITIES: Severity[] = ['P0', 'P1', 'P2', 'P3'];

export function consolidate(cycleId: string, head: string, lanes: LaneResult[], startedAt: string): CycleResult {
  const findings = lanes.flatMap((l) => l.findings);
  const bySeverity = Object.fromEntries(SEVERITIES.map((s) => [s, 0])) as Record<Severity, number>;
  for (const f of findings) bySeverity[f.severity] += 1;

  const confirmed = findings.filter((f) => f.status === 'CONFIRMED').length;
  const suspected = findings.filter((f) => f.status === 'SUSPECTED').length;

  // A section nobody tested and nobody explained is a hole in the audit, and
  // it counts against the verdict exactly like a finding does.
  const coverageGaps = lanes.flatMap((l) => l.coverage)
    .filter((c) => c.status === 'NOT_TESTED' && (c.reason ?? '').startsWith('REPORTING DEFECT'));

  const openBlocking = findings.filter(
    (f) => (f.severity === 'P0' || f.severity === 'P1')
      && (f.status === 'CONFIRMED' || f.status === 'UNRESOLVED')
      && !f.fixed,
  );
  const incompleteLanes = lanes.filter((l) => !l.complete);

  const verdict: Verdict = openBlocking.length === 0 && coverageGaps.length === 0 && incompleteLanes.length === 0
    ? 'CANDIDATE_SAFE_TO_INSTALL'
    : 'FINDINGS_OPEN';

  const evidenceChain = [
    `${lanes.length} lane(s) ran ${lanes.reduce((a, l) => a + l.probesRun, 0)} probe(s) against ${head.slice(0, 12)}`,
    `${lanes.reduce((a, l) => a + l.probesHeld, 0)} probe(s) observed the invariant holding`,
    `${confirmed} finding(s) CONFIRMED by executable reproduction; ${suspected} SUSPECTED (not reproduced)`,
    `${openBlocking.length} unfixed P0/P1 finding(s) remain open`,
    `${coverageGaps.length} charter section(s) untested with no stated reason`,
    `${incompleteLanes.length} lane(s) failed to complete`,
    verdict === 'CANDIDATE_SAFE_TO_INSTALL'
      ? 'no additional defects were found under the tested threat and failure model'
      : 'the candidate has open findings or coverage gaps and is not cleared for installation',
  ];

  return {
    cycleId, head, startedAt, finishedAt: new Date().toISOString(),
    lanes, findings, confirmed, suspected, bySeverity, coverageGaps, verdict, evidenceChain,
  };
}
