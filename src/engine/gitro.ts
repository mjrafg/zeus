/**
 * Read-only git.
 *
 * Finding G-U2: a phase Zeus declared read-only mutated the repository anyway.
 * `git fetch` into a temporary ref imported fourteen commits and two tags, and
 * `git fsck --lost-found` wrote into `.git/`. Neither broke any stated
 * prohibition — the prohibitions were a list of forbidden things, and these
 * were not on it. A person caught it afterwards by re-checking.
 *
 * The lesson is the one that keeps recurring in this codebase: a constraint
 * that exists only as instruction is not a constraint, and a denylist is an
 * instruction with extra steps. Git has hundreds of subcommands and grows more;
 * writing down the dangerous ones means being wrong every time git gains a
 * feature, and being wrong silently.
 *
 * So this is an allowlist, and it is the security boundary. A verb that is not
 * named here is refused BEFORE anything is spawned, whatever it does.
 *
 * The allowlist is on the FORM, not the first word. Several allowed verbs
 * become writes with one option:
 *
 *   * `branch` lists refs; `branch <name>` creates one.
 *   * `log --output=FILE` and `diff --output=FILE` write files.
 *   * `merge-tree --write-tree` writes objects into the database.
 *   * `-c core.pager=...` and `--ext-diff` run programs of the caller's choosing.
 *   * `--git-dir` / `--work-tree` point an allowed verb at another repository.
 *
 * This mode is for INSPECTION paths only — inventory, doctor, the self-audit's
 * reads of the repository it is auditing. A task's own worktree is where work
 * is supposed to happen, and those paths are deliberately not routed through
 * here.
 */

import { execFileSync } from 'child_process';

/** Stable across versions: callers and tests match on this exact string. */
export const GIT_WRITE_REFUSED_READONLY = 'GIT_WRITE_REFUSED_READONLY';

export interface GitRefusal {
  code: typeof GIT_WRITE_REFUSED_READONLY;
  /** The subcommand that was attempted, or `(global option)` when there is none. */
  verb: string;
  /** Why this form is not read-only, in one clause. */
  reason: string;
  argv: string[];
  /** The stable operator-facing line. Contains the code and the verb. */
  message: string;
}

/**
 * Options that turn an allowed verb into a write or into code execution.
 *
 * Checked for EVERY verb, before the verb's own rule, because the verb is not
 * what makes `git log --output=/etc/cron.d/x` dangerous.
 */
const REFUSED_OPTIONS: Array<[RegExp, string]> = [
  [/^--output(=|$)/, 'writes its output to a file'],
  [/^-o$/, 'writes its output to a file'],
  [/^--output-directory(=|$)/, 'writes files into a directory'],
  [/^--git-dir(=|$)/, 'points git at a different repository'],
  [/^--work-tree(=|$)/, 'points git at a different working tree'],
  [/^--namespace(=|$)/, 'retargets which refs are visible and writable'],
  [/^--exec-path(=|$)/, 'redirects git to another set of executables'],
  [/^-c$/, 'sets configuration for this invocation, which can run a program'],
  [/^--config-env(=|$)/, 'sets configuration for this invocation, which can run a program'],
  [/^-C$/, 'chooses the directory; the inspection root is not the caller\'s to change'],
  [/^--ext-diff$/, 'runs an external diff driver — arbitrary code'],
  [/^--textconv$/, 'runs a configured filter program'],
  [/^--upload-pack(=|$)/, 'names a program to execute'],
  [/^--receive-pack(=|$)/, 'names a program to execute'],
  [/^--write-tree$/, 'writes tree objects into the database'],
];

/**
 * The allowlist.
 *
 * Each entry returns `null` when the FORM is read-only, or the reason it is
 * not. `for-each-ref` is here alongside the obvious readers because asking
 * "did the refs change?" is itself an inspection, and a read-only mode that
 * cannot answer it forces callers back out to a raw git.
 */
const ALLOWED: Record<string, (rest: string[]) => string | null> = {
  'rev-parse': () => null,
  log: () => null,
  show: () => null,
  diff: () => null,
  status: () => null,
  'ls-tree': () => null,
  'ls-files': () => null,
  'cat-file': () => null,
  'for-each-ref': () => null,
  branch: (rest) => (rest.includes('--list') || rest.includes('-l')
    ? null
    : 'branch creates, moves, copies or deletes refs unless --list is given'),
  worktree: (rest) => (rest[0] === 'list'
    ? null
    : `worktree ${rest[0] ?? '<no subcommand>'} adds, moves, removes or prunes worktrees; only "worktree list" reads`),
  // The classic three-argument form computes a merge in memory and prints it.
  // `--write-tree` is the one that puts objects in the database.
  'merge-tree': () => null,
};

export const ALLOWED_FORMS: string[] = [
  'rev-parse', 'log', 'show', 'diff', 'status', 'ls-tree', 'ls-files', 'cat-file',
  'for-each-ref', 'branch --list', 'worktree list', 'merge-tree (without --write-tree)',
];

function refuse(verb: string, reason: string, argv: string[]): GitRefusal {
  return {
    code: GIT_WRITE_REFUSED_READONLY,
    verb,
    reason,
    argv,
    message: `${GIT_WRITE_REFUSED_READONLY}: git ${verb} is refused in a read-only context — ${reason}. `
      + `Read-only forms: ${ALLOWED_FORMS.join(', ')}.`,
  };
}

export type GitInspection =
  | { allowed: true; verb: string }
  | { allowed: false; refusal: GitRefusal };

/** Decides, without running anything, whether this argv is read-only. */
export function inspectReadOnlyGit(argv: string[]): GitInspection {
  const verb = argv[0] ?? '';
  if (!verb) return { allowed: false, refusal: refuse('(none)', 'no subcommand was given', argv) };
  if (verb.startsWith('-')) {
    return { allowed: false, refusal: refuse('(global option)',
      `${verb} is a global option, and global options are chosen by the inspection context, not by the caller`, argv) };
  }
  for (const arg of argv.slice(1)) {
    const hit = REFUSED_OPTIONS.find(([re]) => re.test(arg));
    if (hit) return { allowed: false, refusal: refuse(verb, `${arg} ${hit[1]}`, argv) };
  }
  const rule = ALLOWED[verb];
  if (!rule) {
    return { allowed: false, refusal: refuse(verb,
      'it is not one of the forms known to be read-only. This is an allowlist: a subcommand '
      + 'absent from it is refused whether or not it writes', argv) };
  }
  const why = rule(argv.slice(1));
  if (why) return { allowed: false, refusal: refuse(verb, why, argv) };
  return { allowed: true, verb };
}

export class ReadOnlyGitError extends Error {
  readonly code = GIT_WRITE_REFUSED_READONLY;
  readonly verb: string;
  readonly refusal: GitRefusal;
  constructor(refusal: GitRefusal) {
    super(refusal.message);
    this.name = 'ReadOnlyGitError';
    this.verb = refusal.verb;
    this.refusal = refusal;
  }
}

export interface ReadOnlyGitOptions {
  /**
   * Return git's output byte-for-byte instead of trimmed.
   *
   * `.trim()` is right for `rev-parse HEAD` and WRONG for anything whose first
   * column is meaningful whitespace. `git status --porcelain` encodes the index
   * in column one and the worktree in column two, so " M file" means "modified,
   * not staged" — and trimming turns it into "M file", which reads as staged
   * and shifts every offset by one. It cost a missed modification and a missed
   * deletion, silently, in the check whose entire job is noticing them.
   */
  raw?: boolean;
  /** Called before the error is thrown, so a caller can record an event. */
  onRefusal?: (refusal: GitRefusal) => void;
  timeoutMs?: number;
  maxBuffer?: number;
  /** Test seam. Nothing in the product passes this. */
  exec?: (file: string, args: string[], opts: Record<string, unknown>) => string;
}

/**
 * A git callable that can only read.
 *
 * The root is fixed by the caller who creates the context, and `-C` is refused
 * from the argv, so an inspection cannot wander into another repository.
 * `--no-optional-locks` is added because `git status` will otherwise refresh
 * and rewrite the index — a write nobody asked for, in a mode that promises
 * none.
 */
export function readOnlyGit(root: string, opts: ReadOnlyGitOptions = {}):
  ((args: string[]) => string) & { inspect: typeof inspectReadOnlyGit } {
  const run = (args: string[]): string => {
    const verdict = inspectReadOnlyGit(args);
    if (!verdict.allowed) {
      opts.onRefusal?.(verdict.refusal);
      throw new ReadOnlyGitError(verdict.refusal);
    }
    const exec = opts.exec
      ?? ((file, a, o) => execFileSync(file, a, o as any) as unknown as string);
    const out = String(exec('git', ['--no-optional-locks', '-C', root, ...args], {
      encoding: 'utf8',
      timeout: opts.timeoutMs ?? 60_000,
      maxBuffer: opts.maxBuffer ?? 32 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    }));
    return opts.raw ? out : out.trim();
  };
  return Object.assign(run, { inspect: inspectReadOnlyGit });
}
