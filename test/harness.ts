/** Shared assertion helpers, so every suite reports the same way. */
export let passed = 0, failed = 0;
export const failures: string[] = [];

/**
 * Every check name seen, in order, so identity can be asserted.
 *
 * The gates refuse BY NAME — `zeus self-check` parses `FAIL <name>` and puts
 * that name in front of the operator. Two checks answering to the same name
 * make a refusal ambiguous: the person reading it cannot tell which suite
 * failed, and 171 checks shared a name with another before this was measured.
 */
const seen: string[] = [];

/** The leading token, which is what a refusal message identifies a check by. */
export function checkToken(name: string): string {
  const m = /^([A-Za-z0-9_.-]+)/.exec(name);
  return m ? m[1] : name;
}

export function check(name: string, cond: boolean, detail = ''): void {
  seen.push(name);
  if (cond) { passed += 1; console.log(`  ok   ${name}${detail ? ` — ${detail}` : ''}`); }
  else { failed += 1; failures.push(name); console.log(` FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}
export function section(t: string): void { console.log(`\n- ${t}`); }

/** Every name recorded so far, for suites that assert about the suite itself. */
export function seenNames(): string[] { return [...seen]; }

/** Tokens claimed by more than one check, with how many claim them. */
export function duplicateCheckNames(): Array<{ token: string; count: number; names: string[] }> {
  const byToken = new Map<string, string[]>();
  for (const n of seen) {
    const t = checkToken(n);
    byToken.set(t, [...(byToken.get(t) ?? []), n]);
  }
  return [...byToken.entries()]
    .filter(([, names]) => names.length > 1)
    .map(([token, names]) => ({ token, count: names.length, names }))
    .sort((a, b) => b.count - a.count || a.token.localeCompare(b.token));
}

export function totals(): { passed: number; failed: number; failures: string[] } {
  return { passed, failed, failures };
}
