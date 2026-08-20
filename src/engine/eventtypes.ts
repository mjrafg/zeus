/**
 * The set of event types this build actually emits.
 *
 * Discovered from the source rather than declared, and that is deliberate. A
 * hand-maintained list is a promise about the code; this is a reading of it.
 * The redaction-coverage probe needs to fail when someone adds an event type,
 * and a list written from memory cannot do that — it would keep passing while
 * the new type went uncovered, which is precisely how the leak this closes got
 * in.
 *
 * Event types are string literals at the `type:` key of an append. There is no
 * enum to read: `AppendInput.type` is `string`, so that any producer can add
 * one without editing a central file. The cost of that freedom is that the
 * only honest inventory is a scan.
 */

import * as fs from 'fs';
import * as path from 'path';

/** The shape every producer uses to name an event: a `type` key, upper-case. */
const TYPE_LITERAL = /\btype:\s*'([A-Z][A-Z0-9_]*)'/g;

/**
 * The second shape: a central registry of event names.
 *
 * Mission Mode declares its event vocabulary in one place —
 * `MISSION_EVENT_TYPES` — because the names are part of a contract and a name
 * invented at a call site is a name nobody can search for. Scanning only for
 * `type: 'X'` would have missed every one of them, and the redaction
 * coverage probe would have gone on reporting "complete" while a whole family
 * of event types went unexercised. That is probe staleness, so the scanner
 * learns the shape rather than the mission code bending to the scanner.
 *
 * The suffix is load-bearing: `RESERVED_MISSION_EVENT_NAMES` deliberately does
 * NOT match, because names reserved for later stages are not events anyone
 * emits, and an inventory should describe what exists.
 */
const TYPE_REGISTRY = /\b[A-Z][A-Z0-9_]*_EVENT_TYPES\s*(?::[^=]*)?=\s*\[([\s\S]*?)\]/g;
const REGISTRY_MEMBER = /'([A-Z][A-Z0-9_]*)'/g;

/**
 * Block comments are removed before scanning.
 *
 * Found by running this against itself: the doc comment that ILLUSTRATED the
 * pattern was picked up as an event type, so the inventory contained a type no
 * producer emits. A scan that reads prose is not reading the code.
 */
const BLOCK_COMMENT = /\/\*[\s\S]*?\*\//g;

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', '.zeus', 'dist-release']);

function tsFilesUnder(dir: string, out: string[] = []): string[] {
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (SKIP_DIRS.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) tsFilesUnder(p, out);
    else if (e.isFile() && p.endsWith('.ts')) out.push(p);
  }
  return out;
}

export interface EventTypeSite { type: string; file: string }

/**
 * Every event type emitted from the given roots, with where it is emitted.
 *
 * Roots default to the product and the CLI. The audit harness is deliberately
 * excluded: its `NOTE` fixtures are test data, not the product's vocabulary.
 */
export function discoverEventTypes(repoRoot: string,
  roots: string[] = ['src']): EventTypeSite[] {
  const found = new Map<string, string>();
  for (const r of roots) {
    for (const file of tsFilesUnder(path.join(repoRoot, r))) {
      const text = fs.readFileSync(file, 'utf8').replace(BLOCK_COMMENT, '');
      for (const m of text.matchAll(TYPE_LITERAL)) {
        if (!found.has(m[1])) found.set(m[1], path.relative(repoRoot, file));
      }
      for (const reg of text.matchAll(TYPE_REGISTRY)) {
        for (const member of reg[1].matchAll(REGISTRY_MEMBER)) {
          if (!found.has(member[1])) found.set(member[1], path.relative(repoRoot, file));
        }
      }
    }
  }
  return [...found.entries()].map(([type, file]) => ({ type, file }))
    .sort((a, b) => a.type.localeCompare(b.type));
}
