/**
 * Terminal prompting for the setup wizard.
 *
 * Deliberately small and synchronous: setup is a linear conversation, and
 * reading the TTY directly avoids pulling a prompt library into a runtime that
 * has no third-party dependencies.
 *
 * Two rules are enforced here rather than left to callers:
 *   * secret input is never echoed and never logged;
 *   * a non-TTY stdin can never be silently interpreted as consent.
 */

import * as fs from 'fs';
import { Consent } from './wizard';

const C = process.stdout.isTTY
  ? { b: '\x1b[1m', dim: '\x1b[2m', x: '\x1b[0m' }
  : { b: '', dim: '', x: '' };

/**
 * Reads one line from the controlling terminal.
 *
 * Returns `null` when the terminal ends without one — a closed or empty tty is
 * NOT the same as someone pressing enter. Conflating the two is how a default
 * of "yes" gets applied by a process nobody is watching, so callers must treat
 * `null` as a refusal rather than as acceptance of the default.
 */
function readLine(): string | null {
  // /dev/tty rather than stdin: the installer is commonly run as
  // `curl … | bash`, where stdin is the script itself.
  let fd: number | null = null;
  try { fd = fs.openSync('/dev/tty', 'r'); } catch { fd = null; }
  const handle = fd ?? 0;
  const buf = Buffer.alloc(1);
  let line = '';
  let sawEnter = false;
  for (;;) {
    let n = 0;
    try { n = fs.readSync(handle, buf, 0, 1, null); } catch { break; }
    if (n === 0) break;                     // end of stream: nobody is there
    const ch = buf.toString('utf8');
    if (ch === '\n') { sawEnter = true; break; }
    if (ch === '\r') continue;
    line += ch;
  }
  if (fd !== null) fs.closeSync(fd);
  if (!sawEnter && line === '') return null;
  return line.trim();
}

function write(s: string): void { process.stdout.write(s); }

/** Prompts on the terminal. Every question states its default. */
export class TtyConsent implements Consent {
  confirm(question: string, def: boolean): boolean {
    for (;;) {
      write(`${question} ${C.dim}[${def ? 'Y/n' : 'y/N'}]${C.x} `);
      const raw = readLine();
      // No terminal on the other end. Refuse, whatever the default was.
      if (raw === null) { write('\n  no answer received; assuming no\n'); return false; }
      const a = raw.toLowerCase();
      if (!a) return def;
      if (['y', 'yes'].includes(a)) return true;
      if (['n', 'no'].includes(a)) return false;
      write('  please answer y or n\n');
    }
  }

  choose(prompt: string, options: Array<{ id: string; label: string; selected: boolean }>): string[] {
    if (!options.length) return [];
    write(`${C.b}${prompt}${C.x}\n`);
    options.forEach((o, i) => {
      write(`  ${String(i + 1).padStart(2)}) [${o.selected ? 'x' : ' '}] ${o.label}\n`);
    });
    const preset = options.filter((o) => o.selected).map((o) => o.id);
    write(`${C.dim}Enter numbers separated by spaces, "all", "none", or press enter for the ticked items.${C.x}\n> `);
    const raw = readLine();
    if (raw === null) return [];        // nobody answered: select nothing
    const a = raw.toLowerCase();
    if (!a) return preset;
    if (a === 'all') return options.map((o) => o.id);
    if (a === 'none') return [];
    const picked = new Set<string>();
    for (const tok of a.split(/[\s,]+/).filter(Boolean)) {
      const n = Number(tok);
      if (Number.isInteger(n) && n >= 1 && n <= options.length) picked.add(options[n - 1].id);
    }
    return [...picked];
  }

  pick(prompt: string, options: Array<{ id: string; label: string }>, def: string): string {
    write(`${C.b}${prompt}${C.x}\n`);
    options.forEach((o, i) => {
      write(`  ${String(i + 1).padStart(2)}) ${o.label}${o.id === def ? `  ${C.dim}(default)${C.x}` : ''}\n`);
    });
    write('> ');
    const a = readLine();
    // A role choice has no side effect of its own, so an unanswered prompt can
    // safely keep the recommended pairing.
    if (a === null || !a) return def;
    const n = Number(a);
    if (Number.isInteger(n) && n >= 1 && n <= options.length) return options[n - 1].id;
    const byId = options.find((o) => o.id === a.toLowerCase());
    return byId ? byId.id : def;
  }

  /** Delegates to the non-echoing reader; the value never reaches this class. */
  secret(prompt: string): string { return readSecret(prompt); }
}

/**
 * Reads a secret without echoing it.
 *
 * The value is returned to the caller and nothing else: it is not printed, not
 * written to state, and not placed in a process argument list.
 */
export function readSecret(prompt: string): string {
  const ETX = String.fromCharCode(3);     // ctrl-c
  const DEL = String.fromCharCode(127);   // backspace
  let fd: number;
  try { fd = fs.openSync('/dev/tty', 'r+'); } catch { return ''; }
  fs.writeSync(fd, `${prompt} `);
  const wasRaw = process.stdin.isTTY && (process.stdin as any).isRaw;
  let value = '';
  try {
    if (process.stdin.isTTY) (process.stdin as any).setRawMode?.(true);
    const buf = Buffer.alloc(1);
    for (;;) {
      const n = fs.readSync(fd, buf, 0, 1, null);
      if (n === 0) break;
      const ch = buf.toString('utf8');
      if (ch === '\n' || ch === '\r') break;
      if (ch === ETX) { value = ''; break; }
      if (ch === DEL || ch === '\b') { value = value.slice(0, -1); continue; }
      value += ch;
    }
  } finally {
    if (process.stdin.isTTY) (process.stdin as any).setRawMode?.(!!wasRaw);
    fs.writeSync(fd, '\n');   // the newline the user's keypress never echoed
    fs.closeSync(fd);
  }
  return value;
}

/** True when a human can actually answer a question. */
export function interactivePossible(): boolean {
  if (process.env.ZEUS_NON_INTERACTIVE === '1') return false;
  if (process.stdout.isTTY) return true;
  // `curl | bash` leaves stdin non-tty but /dev/tty still reaches the user.
  try { fs.closeSync(fs.openSync('/dev/tty', 'r')); return true; } catch { return false; }
}
