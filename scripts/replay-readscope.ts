/**
 * Replays the read-scope check over a trace blob that already exists.
 *
 * The check runs live on every stage from now on, but the interesting evidence
 * is the runs that happened BEFORE it existed. Every debug-level call kept its
 * raw provider transcript in the trace store, so the question "how often has
 * this been happening" is answerable today rather than in a month.
 *
 *   ts-node --transpile-only scripts/replay-readscope.ts \
 *     <blob.gz> <projectRoot> [zeusRoot]
 *
 * Roots come from argv rather than from this file on purpose: a diagnostic that
 * hard-codes one machine's layout is a diagnostic that only ever tells you
 * about that machine.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';
import { checkReadScope, readScopeSummary } from '../src/engine/readscope';

const [blob, projectRoot, zeusRootArg] = process.argv.slice(2);
if (!blob || !projectRoot) {
  console.error('usage: replay-readscope.ts <blob.gz> <projectRoot> [zeusRoot]');
  process.exit(2);
}
const zeusRoot = zeusRootArg ?? path.resolve(__dirname, '..');

const bytes = fs.readFileSync(blob);
// Trace blobs are gzipped; a plain file is accepted too so a transcript pasted
// out of a report can be checked without repackaging it.
const raw = blob.endsWith('.gz') ? zlib.gunzipSync(bytes).toString('utf8') : bytes.toString('utf8');

const verdict = checkReadScope(raw, {
  projectRoot: path.resolve(projectRoot),
  zeusRoot: path.resolve(zeusRoot),
  stateRoot: path.join(path.resolve(projectRoot), '.zeus', 'state'),
}, { stage: 'replay', traceCallId: path.basename(blob), provider: null });

console.log(JSON.stringify(readScopeSummary(verdict), null, 1));
if (verdict.state === 'ROLE_READ_ESCAPE') {
  for (const r of verdict.reaches) {
    console.log(`  ${r.kind.padEnd(16)} ${r.resolved}`);
    console.log(`  ${' '.repeat(16)} via ${r.tool}: ${r.via.slice(0, 120)}`);
  }
}
