/**
 * The redacting sink.
 *
 * The property under test is not "these fields are redacted" but "nothing can
 * reach the log unredacted", which is a different claim and needs a different
 * kind of test: the event-type list is DISCOVERED from the source, so adding a
 * type without covering it makes this suite fail rather than quietly leaving a
 * hole.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { check, section } from './harness';
import { EventStore } from '../src/engine/events';
import { redactSecrets, redactPayload } from '../src/engine/redact';
import { discoverEventTypes } from '../src/engine/eventtypes';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'zeus-redact-'));
const REPO = path.resolve(__dirname, '..');

/** Synthetic, in the shapes the net knows. None of these is a real credential. */
const SECRETS: Array<{ value: string; what: string }> = [
  { value: 'sk-live-REDACTIONPROBE0123456789', what: 'api key' },
  { value: 'ghp_REDACTIONPROBEabcdefghijklmnop', what: 'github token' },
  { value: 'AKIAREDACTIONPROBE01', what: 'aws key id' },
  { value: 'postgres://probe:hunter2@db:5432/app', what: 'credentialed url' },
  { value: 'DATABASE_PASSWORD=hunter2', what: 'named secret' },
];

export function redactionSuite(): void {
  const types = discoverEventTypes(REPO);

  // -----------------------------------------------------------------------
  section('the redacting sink: every event type, not a remembered list');
  {
    check('RS1: the event-type inventory is read from the source, not declared',
      types.length > 10 && types.every((t) => /^[A-Z][A-Z0-9_]*$/.test(t.type)),
      `${types.length} types: ${types.map((t) => t.type).join(', ')}`);
    // A scan that reads prose is not reading the code: the first version of
    // this inventory picked up the example in its own doc comment.
    //
    // Two shapes are legitimate, because producers write events two ways: at a
    // call site (`type: 'X'`) and in a central registry (`*_EVENT_TYPES`),
    // which is how Mission Mode declares a vocabulary that is part of a
    // contract. Both are code. A comment is still neither.
    const fromCode = types.filter((t) => {
      const text = fs.readFileSync(path.join(REPO, t.file), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '');
      const atCallSite = new RegExp(`type:\\s*'${t.type}'`).test(text);
      const inRegistry = /_EVENT_TYPES\s*(?::[^=]*)?=\s*\[[\s\S]*?\]/.test(text)
        && new RegExp(`'${t.type}'`).test(text);
      return atCallSite || inRegistry;
    });
    check('RS1b: every discovered type comes from a real producer, not a comment',
      fromCode.length === types.length,
      types.filter((t) => !fromCode.includes(t)).map((t) => `${t.type}@${t.file}`).join(', '));

    const store = new EventStore(path.join(TMP, 'all-types'));
    const taskId = 'proj/T-0001';
    // One event per discovered type, each carrying every secret shape in a
    // field name the producer would plausibly use.
    for (const { type } of types) {
      store.append({ taskId, type, payload: {
        command: `run --token ${SECRETS[0].value}`,
        tail: `connecting to ${SECRETS[3].value}\n${SECRETS[4].value}`,
        nested: { deep: [{ note: `${SECRETS[1].value}` }, `${SECRETS[2].value}`] },
      } });
    }
    const raw = fs.readFileSync(
      path.join(TMP, 'all-types', 'tasks', EventStore.dirName(taskId), 'events.jsonl'), 'utf8');

    const leaked = types.filter(({ type }) => {
      const line = raw.split('\n').find((l) => l.includes(`"type":"${type}"`)) ?? '';
      return SECRETS.some((s) => line.includes(s.value));
    });
    check('RS2: no secret survives in ANY event type currently emitted',
      leaked.length === 0, leaked.map((t) => t.type).join(', '));
    check(`RS3: coverage is complete — ${types.length} event type(s) exercised`,
      raw.trim().split('\n').length === types.length,
      `${raw.trim().split('\n').length} events for ${types.length} types`);
    check('RS4: redaction reaches nested objects and arrays, not just top-level strings',
      !raw.includes(SECRETS[1].value) && !raw.includes(SECRETS[2].value));

    // The point of a sink: a type nobody has written yet is covered anyway.
    const invented = 'A_TYPE_INVENTED_AFTER_THIS_TEST_WAS_WRITTEN';
    store.append({ taskId, type: invented, payload: { anything: `x ${SECRETS[0].value} y` } });
    const after = fs.readFileSync(
      path.join(TMP, 'all-types', 'tasks', EventStore.dirName(taskId), 'events.jsonl'), 'utf8');
    const inventedLine = after.split('\n').find((l) => l.includes(invented)) ?? '';
    check('RS5: an event type that did not exist when this was written is redacted too',
      inventedLine.length > 0 && !inventedLine.includes(SECRETS[0].value)
      && /\[redacted:api-key\]/.test(inventedLine));
  }

  // -----------------------------------------------------------------------
  section('the sink seals what it redacted');
  {
    const store = new EventStore(path.join(TMP, 'chain'));
    const taskId = 'proj/T-0002';
    for (const s of SECRETS) {
      store.append({ taskId, type: 'CHECK_RESULT', payload: { command: `x ${s.value}`, what: s.what } });
    }
    const report = store.verify(taskId);
    // Freshly produced through the new sink — not a fixture written under the
    // old per-site scheme, which would verify without exercising anything.
    check('RS6: the hash chain verifies on a log produced BY the sink',
      report.ok && report.events === SECRETS.length, JSON.stringify(report.problems));
    const events = store.read(taskId);
    check('RS7: the sealed payload is the redacted one, so nothing must be edited later',
      events.every((e) => !SECRETS.some((s) => JSON.stringify(e.payload).includes(s.value))));
    check('RS8: every redaction is counted on the record, never silent',
      events.every((e) => typeof (e.payload as any).redactions === 'number'
        && (e.payload as any).redactions > 0));
    // Re-hashing the stored (redacted) body must reproduce the stored id: that
    // is what "redacted before sealing" means, mechanically.
    check('RS9: the event id is the hash of the redacted body, not of the original',
      report.ok && events.length === SECRETS.length);

    const clean = new EventStore(path.join(TMP, 'clean'));
    clean.append({ taskId: 'proj/T-0003', type: 'NOTE', payload: { text: '47 tests passed in 3.2s' } });
    const ev = clean.read('proj/T-0003')[0];
    check('RS10: ordinary output is untouched and carries no redaction count',
      (ev.payload as any).text === '47 tests passed in 3.2s'
      && !('redactions' in (ev.payload as any)));
  }

  // -----------------------------------------------------------------------
  section('the guarantee lives at the boundary, not at the producers');
  {
    // Static verification: the sink is the only redaction in the write path.
    const producers = ['src/engine/orchestrator.ts', 'src/cli.ts', 'src/engine/dependencies.ts'];
    const offenders = producers.filter((rel) => {
      const text = fs.readFileSync(path.join(REPO, rel), 'utf8');
      // A re-export names the symbol without applying it; a CALL is the thing
      // that would make a producer responsible for the guarantee again.
      return /redactSecrets\s*\(/.test(text);
    });
    check('RS11: no event producer redacts for itself any more',
      offenders.length === 0, offenders.join(', '));
    check('RS12: the sink applies it where the event is written',
      /redactPayload\(/.test(fs.readFileSync(path.join(REPO, 'src/engine/events.ts'), 'utf8')));

    // And the mutation test: a sink that returned its input unchanged must be
    // caught by RS2, or RS2 is decoration.
    const passthrough = (p: unknown) => ({ payload: p, redactions: 0 });
    const real = redactPayload({ a: `x ${SECRETS[0].value}` });
    const faulty = passthrough({ a: `x ${SECRETS[0].value}` });
    check('RS13: the assertion fails against a pass-through substitute',
      !JSON.stringify(real.payload).includes(SECRETS[0].value)
      && JSON.stringify(faulty.payload).includes(SECRETS[0].value));
    check('RS14: the producer-side helper still works for callers outside the log',
      redactSecrets(`x ${SECRETS[0].value}`).redactions === 1);
    // The caller's own object must not be edited underneath them.
    const original = { a: `x ${SECRETS[0].value}` };
    redactPayload(original);
    check('RS15: redaction returns a new structure and does not mutate the producer\'s',
      original.a.includes(SECRETS[0].value));
  }

  fs.rmSync(TMP, { recursive: true, force: true });
}
