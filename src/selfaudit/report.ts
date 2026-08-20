/**
 * Audit reporting.
 *
 * The report is the product of a cycle, so its shape enforces the evidence
 * rules: every finding prints its reproduction and its observed output, and
 * the coverage matrix prints every section including the ones nobody tested.
 * A reader must be able to see the holes without going looking for them.
 */

import { CycleResult } from './runner';
import { Finding, CoverageEntry } from './types';

function table(rows: string[][]): string {
  if (!rows.length) return '';
  const w = rows[0].map((_, i) => Math.max(...rows.map((r) => (r[i] ?? '').length)));
  const line = (r: string[]) => `| ${r.map((c, i) => (c ?? '').padEnd(w[i])).join(' | ')} |`;
  return [line(rows[0]), `|${w.map((n) => '-'.repeat(n + 2)).join('|')}|`, ...rows.slice(1).map(line)].join('\n');
}

function findingBlock(f: Finding): string {
  return [
    `#### ${f.id} — ${f.title}`,
    '',
    `**${f.severity} · ${f.status}**${f.fixed ? ' · FIXED' : ''} — sections ${f.sections.join(', ')}`,
    '',
    f.detail,
    '',
    `*Impact.* ${f.impact}`,
    '',
    f.reproduction ? `*Reproduction.* \`${f.reproduction}\`` : '*Reproduction.* none — reasoned only, not reproduced.',
    '',
    '```',
    f.observed || '(no output captured)',
    '```',
    f.regressionTest ? `\n*Regression test.* \`${f.regressionTest}\`` : '',
    f.disputeNote ? `\n*Dispute.* ${f.disputeNote}` : '',
  ].filter(Boolean).join('\n');
}

export function renderMarkdown(c: CycleResult, extra: { title?: string; preamble?: string } = {}): string {
  const out: string[] = [];
  out.push(`# ${extra.title ?? `Zeus self-audit — cycle ${c.cycleId}`}`);
  out.push('');
  out.push(`Candidate \`${c.head}\` · started ${c.startedAt} · finished ${c.finishedAt}`);
  out.push('');
  if (extra.preamble) { out.push(extra.preamble); out.push(''); }

  out.push('## Verdict');
  out.push('');
  out.push(`**${c.verdict}**`);
  out.push('');
  out.push('The verdict is a statement about what was tested, not about what exists:');
  out.push('');
  for (const e of c.evidenceChain) out.push(`- ${e}`);
  out.push('');

  out.push('## Findings');
  out.push('');
  out.push(table([
    ['Severity', 'CONFIRMED', 'SUSPECTED', 'UNRESOLVED', 'REJECTED'],
    ...(['P0', 'P1', 'P2', 'P3'] as const).map((s) => [
      s,
      String(c.findings.filter((f) => f.severity === s && f.status === 'CONFIRMED').length),
      String(c.findings.filter((f) => f.severity === s && f.status === 'SUSPECTED').length),
      String(c.findings.filter((f) => f.severity === s && f.status === 'UNRESOLVED').length),
      String(c.findings.filter((f) => f.severity === s && f.status === 'REJECTED_WITH_EVIDENCE').length),
    ]),
  ]));
  out.push('');
  out.push('CONFIRMED and SUSPECTED are counted separately and never added together: '
    + 'a CONFIRMED finding has an executable reproduction, a SUSPECTED one has an argument.');
  out.push('');

  for (const f of [...c.findings].sort((a, b) => a.severity.localeCompare(b.severity))) {
    out.push(findingBlock(f));
    out.push('');
  }
  if (!c.findings.length) out.push('_No findings._\n');

  out.push('## Coverage matrix');
  out.push('');
  const rows: string[][] = [['Lane', 'Section', 'Area', 'Status', 'Probes / reason']];
  for (const l of c.lanes) {
    for (const cv of l.coverage) {
      rows.push([l.lane, cv.section, cv.title, cv.status,
        cv.status === 'TESTED' ? cv.probes.join(', ') : (cv.reason ?? '(no reason given)')]);
    }
  }
  out.push(table(rows));
  out.push('');
  if (c.coverageGaps.length) {
    out.push('> **Reporting defect.** The sections above marked NOT_TESTED without a specific reason are '
      + 'themselves audit defects: an untested area with no stated reason cannot be told apart from an area '
      + 'nobody considered.');
    out.push('');
  }

  out.push('## Lanes');
  out.push('');
  out.push(table([
    ['Lane', 'Area', 'Probes', 'Held', 'Findings', 'Duration', 'Complete'],
    ...c.lanes.map((l) => [
      l.lane, l.title, String(l.probesRun), String(l.probesHeld),
      String(l.findings.length), `${Math.round(l.durationMs / 100) / 10}s`, String(l.complete),
    ]),
  ]));
  out.push('');
  for (const l of c.lanes.filter((x) => x.notes.length)) {
    out.push(`**Lane ${l.lane} notes**`);
    for (const n of l.notes) out.push(`- ${n}`);
    out.push('');
  }
  return out.join('\n');
}

export function renderTerminal(c: CycleResult, colour = false): string {
  const C = colour
    ? { b: '\x1b[1m', d: '\x1b[2m', g: '\x1b[32m', y: '\x1b[33m', r: '\x1b[31m', x: '\x1b[0m' }
    : { b: '', d: '', g: '', y: '', r: '', x: '' };
  const out: string[] = [];
  out.push(`${C.b}Zeus self-audit${C.x} ${C.d}cycle ${c.cycleId} · candidate ${c.head.slice(0, 12)}${C.x}`);
  out.push('');
  for (const l of c.lanes) {
    const bad = l.findings.length;
    const mark = !l.complete ? `${C.y}!${C.x}` : bad ? `${C.r}✗${C.x}` : `${C.g}✓${C.x}`;
    out.push(`  ${mark} Lane ${l.lane}  ${l.title.padEnd(46)} ${l.probesHeld}/${l.probesRun} held  ${bad} finding(s)`);
    for (const f of l.findings) {
      out.push(`      ${f.severity} ${f.id}  ${f.title}`);
    }
    for (const cv of l.coverage.filter((x) => x.status !== 'TESTED')) {
      out.push(`      ${C.d}${cv.status} ${cv.section} ${cv.title}${C.x}`);
    }
  }
  out.push('');
  out.push(`  CONFIRMED ${c.confirmed}   SUSPECTED ${c.suspected}   `
    + `P0 ${c.bySeverity.P0}  P1 ${c.bySeverity.P1}  P2 ${c.bySeverity.P2}  P3 ${c.bySeverity.P3}`);
  out.push('');
  const ok = c.verdict === 'CANDIDATE_SAFE_TO_INSTALL';
  out.push(`  ${ok ? C.g : C.y}${c.verdict}${C.x}`);
  for (const e of c.evidenceChain) out.push(`    ${C.d}${e}${C.x}`);
  out.push('');
  out.push(`  ${C.d}Zeus never installs a candidate on its own. Review the report, then install deliberately.${C.x}`);
  return out.join('\n');
}
