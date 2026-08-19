/** Shared assertion helpers, so every suite reports the same way. */
export let passed = 0, failed = 0;
export const failures: string[] = [];

export function check(name: string, cond: boolean, detail = ''): void {
  if (cond) { passed += 1; console.log(`  ok   ${name}${detail ? ` — ${detail}` : ''}`); }
  else { failed += 1; failures.push(name); console.log(` FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}
export function section(t: string): void { console.log(`\n- ${t}`); }
export function totals(): { passed: number; failed: number; failures: string[] } {
  return { passed, failed, failures };
}
