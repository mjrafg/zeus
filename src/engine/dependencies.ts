/**
 * Dependency preparation for task worktrees.
 *
 * Zeus creates a fresh worktree per task and, until now, never installed
 * anything into it. On any real Node project the first check therefore died
 * with `Cannot find module` — a validation result that says nothing about the
 * code. The latency baseline recorded this as an open finding.
 *
 * The obvious fix — run `commands.install` in every worktree — replaces a
 * broken check with a slow one: a cold install is the single most expensive
 * thing a task can do, and it is identical for every task whose lockfile has
 * not changed. So preparation happens ONCE per `(project, lockfile-hash)` and
 * every later worktree is materialised from that result.
 *
 * Four properties are non-negotiable, and each one is a boundary rather than a
 * convention:
 *
 *   * **Per project.** The cache lives under the project's own `.zeus/`.
 *     There is no machine-wide Zeus dependency cache, so two projects with
 *     byte-identical lockfiles cannot share one — which also means a poisoned
 *     install in one project cannot reach another.
 *   * **Keyed by content.** The key is the hash of the lockfile's actual
 *     bytes. Nothing expires on a timer: a TTL answers "is this old?" when the
 *     question is "is this the same?".
 *   * **Published atomically.** Preparation happens in a temporary directory,
 *     completes, writes a marker, and is then renamed into place. An
 *     interrupted preparation leaves a `.tmp-*` directory that no reader will
 *     ever mistake for a cache, because a cache without its marker is not one.
 *   * **Contained.** Whatever ends up at `<worktree>/node_modules` must
 *     resolve inside the worktree. A symlink pointing at a shared directory
 *     would make every task's dependencies writable by every other task, and
 *     would let an install script escape the worktree boundary the rest of the
 *     engine is built to hold.
 *
 * The install itself is arbitrary code from the repository — `postinstall` is
 * a shell script a stranger wrote — so it runs through the supervisor like any
 * other project command: governed, confined, bounded, killable, recorded.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { ProcessSupervisor } from './exec';
import { ExecutionPolicy, resolveWithin } from './policy';

/**
 * How a worktree actually got its dependencies.
 *
 * Reported after the fact, never predicted: a method is named only when it
 * ran and succeeded. This is also what lands in the WORKTREE event's `method`
 * field, so it describes what happened rather than what was planned.
 *
 * REUSE ORDER: hardlink → pnpm-store → copy.
 *
 * Chosen from measurement, not from which mechanism is most idiomatic. On the
 * reference host, materialising an already-prepared tree costs:
 *
 *   hardlink      2 ms      (1-dependency fixture)   31.7 ms  (5 deps, 400 files)
 *   pnpm-store  ~700 ms     `pnpm install --frozen-lockfile --offline`
 *   copy          — slower than hardlink, same bytes twice on disk
 *
 * pnpm's store IS pnpm's native reuse mechanism and was tried first
 * originally. It is roughly two orders of magnitude slower than hardlinking
 * the prepared tree, and it pays that cost on every task after the first, so
 * the order was inverted once there were numbers to invert it on.
 *
 * pnpm-store is not dead code: it is the fallback wherever hardlinks are
 * impossible — a cache and a worktree on different filesystems (EXDEV), or a
 * filesystem with no hardlink support. That is feature-detected by making a
 * link and comparing inodes, never assumed, and `DEP9c` exercises the path on
 * a genuinely cross-device fixture rather than a simulated one.
 */
export type PrepMethod = 'pnpm-store' | 'hardlink' | 'copy' | 'install' | 'none';

export type NodePackageManager = 'pnpm' | 'yarn' | 'npm';

/** Cache layout version. Bumped when the on-disk shape changes meaning. */
export const CACHE_SCHEMA = 'v1';

export const MARKER = '.zeus-deps-complete.json';

/** Lockfiles, in the order that decides which package manager owns the tree. */
const LOCKFILES: Array<{ file: string; pm: NodePackageManager }> = [
  { file: 'pnpm-lock.yaml', pm: 'pnpm' },
  { file: 'yarn.lock', pm: 'yarn' },
  { file: 'package-lock.json', pm: 'npm' },
];

export interface DependencyPlan {
  ecosystem: 'node' | 'other' | 'none';
  packageManager: NodePackageManager | null;
  /** Lockfile name relative to the worktree, or null when there is none. */
  lockfile: string | null;
  lockfileHash: string | null;
  installCommand: string | null;
  cacheRoot: string;
  /** Where a prepared cache for this lockfile lives, or null when uncacheable. */
  cacheDir: string | null;
  /** Whether that directory currently holds a COMPLETE cache. */
  cached: boolean;
  /** Why this plan looks the way it does, in one line. */
  reason: string;
}

export interface PrepAttempt {
  method: PrepMethod;
  ok: boolean;
  detail: string;
  durationMs: number;
}

export interface PreparationOutcome {
  ok: boolean;
  /** True when the worktree received dependencies. False for `none`. */
  prepared: boolean;
  method: PrepMethod;
  lockfileHash: string | null;
  reused: boolean;
  durationMs: number;
  detail: string;
  /** Install output, on failure only. The caller redacts before recording. */
  output?: string;
  attempts: PrepAttempt[];
}

export function sha256File(file: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/** The project's own dependency cache root. Never machine-wide, never shared. */
export function depsCacheRoot(projectRoot: string, configured?: string | null): string {
  return path.resolve(projectRoot, configured || '.zeus/deps');
}

/**
 * Cache identity.
 *
 * The package manager is part of the key because the same dependency graph
 * installed by npm and by pnpm produces two different `node_modules` layouts,
 * and materialising one where the other is expected fails in ways that look
 * like the project's fault.
 */
export function cacheKey(pm: NodePackageManager, lockfileHash: string): string {
  return `${CACHE_SCHEMA}-${pm}-${lockfileHash.slice(0, 32)}`;
}

export function findLockfile(root: string): { file: string; pm: NodePackageManager } | null {
  return LOCKFILES.find((l) => fs.existsSync(path.join(root, l.file))) ?? null;
}

/**
 * Whether this manifest actually asks for anything to be installed.
 *
 * A lockfile is not the same question. A repository can carry an empty or
 * vestigial lockfile beside a manifest that declares no dependencies at all,
 * and running an install there spends a worktree's time producing an empty
 * directory. Workspaces count even when the root manifest is bare, because the
 * dependencies live in the member packages.
 */
export function declaresDependencies(worktree: string): boolean {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(worktree, 'package.json'), 'utf8'));
    if (pkg.workspaces) return true;
    return ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']
      .some((k) => pkg[k] && Object.keys(pkg[k]).length > 0);
  } catch { return false; }
}

/** A cache directory counts only when its marker says preparation finished. */
export function isCompleteCache(dir: string): boolean {
  try {
    const raw = fs.readFileSync(path.join(dir, MARKER), 'utf8');
    const m = JSON.parse(raw);
    return m.schema === CACHE_SCHEMA && fs.existsSync(path.join(dir, 'node_modules'));
  } catch { return false; }
}

export function readMarker(dir: string): Record<string, unknown> | null {
  try { return JSON.parse(fs.readFileSync(path.join(dir, MARKER), 'utf8')); } catch { return null; }
}

/**
 * Decides what preparation this worktree needs.
 *
 * Node without a lockfile is deliberately `none` rather than "install
 * anyway": `npm ci` requires a lockfile, and a repository that has a
 * `package.json` but no lock is usually documentation or a template. Making it
 * pay for an install would be paying for nothing.
 */
export function planDependencies(input: {
  projectRoot: string; worktree: string;
  installCommand: string | null; cacheRoot?: string;
}): DependencyPlan {
  const cacheRoot = input.cacheRoot ?? depsCacheRoot(input.projectRoot);
  const isNode = fs.existsSync(path.join(input.worktree, 'package.json'));
  const lock = isNode ? findLockfile(input.worktree) : null;

  if (isNode && lock && !declaresDependencies(input.worktree)) {
    return {
      ecosystem: 'node', packageManager: lock.pm, lockfile: lock.file, lockfileHash: null,
      installCommand: null, cacheRoot, cacheDir: null, cached: false,
      reason: `${lock.file} present but the manifest declares no dependencies — nothing to install`,
    };
  }
  if (isNode && lock) {
    const hash = sha256File(path.join(input.worktree, lock.file));
    const dir = path.join(cacheRoot, cacheKey(lock.pm, hash));
    return {
      ecosystem: 'node', packageManager: lock.pm, lockfile: lock.file, lockfileHash: hash,
      installCommand: input.installCommand, cacheRoot, cacheDir: dir,
      cached: isCompleteCache(dir),
      reason: `node project locked by ${lock.file}`,
    };
  }
  if (isNode) {
    return {
      ecosystem: 'node', packageManager: null, lockfile: null, lockfileHash: null,
      installCommand: null, cacheRoot, cacheDir: null, cached: false,
      reason: 'node project with no lockfile — nothing to install reproducibly',
    };
  }
  if (input.installCommand) {
    return {
      ecosystem: 'other', packageManager: null, lockfile: null, lockfileHash: null,
      installCommand: input.installCommand, cacheRoot, cacheDir: null, cached: false,
      // Per-ecosystem caching is deliberately not attempted: every ecosystem
      // stores its dependencies somewhere different, and guessing wrong
      // produces a cache that is silently never used.
      reason: 'non-node project — install runs per worktree, no cache',
    };
  }
  return {
    ecosystem: 'none', packageManager: null, lockfile: null, lockfileHash: null,
    installCommand: null, cacheRoot, cacheDir: null, cached: false,
    reason: 'no lockfile and no install command — nothing to prepare',
  };
}

/**
 * Whether hardlinks work between two directories, established by making one.
 *
 * Cross-device links fail with EXDEV, some filesystems refuse links entirely,
 * and an overlay mount can allow the link and then break it. Feature detection
 * here means performing the operation, not consulting a table.
 */
export function canHardlink(fromDir: string, toDir: string): { ok: boolean; detail: string } {
  // Distinct names on both sides: probing a directory against itself is a
  // legitimate question ("does this filesystem support links at all?"), and
  // one name would make it a self-link that fails with EEXIST — reporting the
  // filesystem as linkless when it is not.
  const probeSrc = path.join(fromDir, `.zeus-link-probe-${process.pid}-src`);
  const probeDst = path.join(toDir, `.zeus-link-probe-${process.pid}-dst`);
  try {
    fs.mkdirSync(fromDir, { recursive: true });
    fs.mkdirSync(toDir, { recursive: true });
    fs.writeFileSync(probeSrc, 'probe');
    fs.linkSync(probeSrc, probeDst);
    const same = fs.statSync(probeSrc).ino === fs.statSync(probeDst).ino;
    return same ? { ok: true, detail: 'hardlink verified' }
      : { ok: false, detail: 'link created but inodes differ' };
  } catch (e: any) {
    return { ok: false, detail: `hardlink unavailable: ${e?.code ?? e?.message ?? e}` };
  } finally {
    try { fs.unlinkSync(probeSrc); } catch { /* probe cleanup is best effort */ }
    try { fs.unlinkSync(probeDst); } catch { /* probe cleanup is best effort */ }
  }
}

export class EscapingLinkError extends Error {
  constructor(readonly link: string, readonly target: string) {
    super(`symlink escapes the worktree: ${link} -> ${target}`);
  }
}

/**
 * Copies a tree by hardlink or by content, refusing anything that would escape.
 *
 * `readOnlyFiles` is used when writing INTO the cache. See `prepareDependencies`
 * for why a shared dependency tree has to be immutable.
 *
 * Symlinks are recreated verbatim rather than followed — following them would
 * turn `node_modules/.bin/tsc` into a duplicate of the file it points at and
 * quietly double the size of every tree. Because they are recreated, their
 * targets are checked here, at the moment the link is made, rather than
 * audited afterwards.
 */
export function replicateTree(src: string, dest: string, mode: 'link' | 'copy',
  containRoot: string, opts: { readOnlyFiles?: boolean } = {}):
  { files: number; links: number; dirs: number } {
  const stats = { files: 0, links: 0, dirs: 0 };
  const walk = (from: string, to: string): void => {
    fs.mkdirSync(to, { recursive: true });
    stats.dirs += 1;
    for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
      const s = path.join(from, entry.name);
      const d = path.join(to, entry.name);
      if (entry.isDirectory()) { walk(s, d); continue; }
      if (entry.isSymbolicLink()) {
        const target = fs.readlinkSync(s);
        const resolved = path.resolve(path.dirname(d), target);
        if (!resolveWithin(containRoot, resolved).ok) throw new EscapingLinkError(d, target);
        try { fs.unlinkSync(d); } catch { /* first write */ }
        fs.symlinkSync(target, d);
        stats.links += 1;
        continue;
      }
      if (!entry.isFile()) continue;   // sockets, fifos: never part of a dep tree
      try { fs.unlinkSync(d); } catch { /* first write */ }
      if (mode === 'link') fs.linkSync(s, d); else fs.copyFileSync(s, d);
      if (opts.readOnlyFiles) {
        // A hardlink shares an INODE, and permissions live on the inode. Making
        // the cached file unwritable therefore makes every worktree's view of
        // it unwritable too — which is the whole point. Directories are left
        // writable so a file can still be REPLACED (unlink + create), which is
        // a private operation that does not touch the shared inode.
        try { fs.chmodSync(d, fs.statSync(d).mode & ~0o222); } catch { /* best effort */ }
      }
      stats.files += 1;
    }
  };
  walk(src, dest);
  return stats;
}

/**
 * Finds the first symlink under `dir` whose target leaves `containRoot`.
 *
 * Used on trees a package manager produced rather than trees we replicated:
 * pnpm builds `node_modules` almost entirely out of symlinks, and a `file:`
 * dependency pointing outside the repository would produce exactly the escape
 * this refuses.
 */
export function findEscapingLink(dir: string, containRoot: string): { link: string; target: string } | null {
  if (!fs.existsSync(dir)) return null;
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop()!;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(cur, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const p = path.join(cur, entry.name);
      if (entry.isSymbolicLink()) {
        let target: string;
        try { target = fs.readlinkSync(p); } catch { continue; }
        const resolved = path.resolve(path.dirname(p), target);
        if (!resolveWithin(containRoot, resolved).ok) return { link: p, target };
      } else if (entry.isDirectory()) stack.push(p);
    }
  }
  return null;
}

export function dirSizeBytes(dir: string): number {
  if (!fs.existsSync(dir)) return 0;
  let total = 0;
  const seen = new Set<number>();
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop()!;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(cur, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const p = path.join(cur, entry.name);
      if (entry.isDirectory()) { stack.push(p); continue; }
      if (!entry.isFile()) continue;
      try {
        const st = fs.statSync(p);
        // Hardlinked files are counted once: a linked cache that reports the
        // sum of its links describes disk that was never allocated.
        if (st.nlink > 1) { if (seen.has(st.ino)) continue; seen.add(st.ino); }
        total += st.size;
      } catch { /* vanished mid-walk */ }
    }
  }
  return total;
}

/** Removes Zeus's dependency-preparation artifacts, and nothing else. */
export function cleanDependencyCache(cacheRoot: string): { removed: string[]; bytes: number } {
  const removed: string[] = [];
  let bytes = 0;
  if (!fs.existsSync(cacheRoot)) return { removed, bytes };
  for (const name of fs.readdirSync(cacheRoot)) {
    const p = path.join(cacheRoot, name);
    // Only Zeus's own artifacts: a prepared cache, or the debris of an
    // interrupted preparation. Anything else under this directory was put
    // there by someone else and is not ours to delete.
    const ours = name.startsWith(`${CACHE_SCHEMA}-`) || name.startsWith('.tmp-');
    if (!ours) continue;
    bytes += dirSizeBytes(p);
    fs.rmSync(p, { recursive: true, force: true });
    removed.push(name);
  }
  return { removed, bytes };
}

function tmpDirIn(cacheRoot: string): string {
  const p = path.join(cacheRoot, `.tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`);
  fs.mkdirSync(p, { recursive: true });
  return p;
}

export interface PrepareInput {
  projectRoot: string;
  worktree: string;
  taskId: string;
  projectId: string;
  installCommand: string | null;
  supervisor: ProcessSupervisor;
  policy: ExecutionPolicy;
  cacheRoot?: string;
  /**
   * Whether the install may reach the network. True by default: a package
   * manager that cannot reach its registry cannot install anything, so
   * refusing the network here would make preparation fail on every real
   * project. Confinement, resource caps, the timeout and killability all still
   * apply — this grants reachability, not trust.
   */
  network?: boolean;
  timeoutSeconds?: number;
  /** Test seam: lets a test observe every execution the preparation performs. */
  onExec?: (label: string) => void;
}

const NODE_MODULES = 'node_modules';

/** Splits a configured command string. Paths Zeus builds are passed as argv. */
export function splitCommand(commandLine: string): string[] {
  return commandLine.split(/\s+/).filter(Boolean);
}

/**
 * The install command for a lockfile.
 *
 * A configured command is honoured only when it drives the package manager the
 * lockfile names. A project whose adapter computed `npm ci` against a root
 * with no lockfile must not run `npm ci` in a worktree locked by pnpm.
 */
export function installArgvFor(pm: NodePackageManager, configured: string | null): string[] {
  const fallback: Record<NodePackageManager, string[]> = {
    pnpm: ['pnpm', 'install', '--frozen-lockfile'],
    yarn: ['yarn', 'install', '--frozen-lockfile'],
    npm: ['npm', 'ci'],
  };
  const argv = configured ? splitCommand(configured) : [];
  return argv[0] === pm ? argv : fallback[pm];
}

async function runInstall(input: PrepareInput, argv: string[], extraWritable: string[],
  extraEnv: Record<string, string>, network: boolean):
  Promise<{ ok: boolean; detail: string; output: string; outcome: string }> {
  const commandLine = argv.join(' ');
  const [cmd, ...args] = argv;
  const cacheRoot = input.cacheRoot ?? depsCacheRoot(input.projectRoot);
  fs.mkdirSync(path.join(cacheRoot, 'corepack'), { recursive: true });
  const policy: ExecutionPolicy = {
    ...input.policy,
    writablePaths: [...input.policy.writablePaths, cacheRoot, ...extraWritable],
    network,
  };
  input.onExec?.(commandLine);
  // Corepack's cache is a package-manager cache, and the supervisor redirects
  // HOME into the worktree so a confined command has somewhere to write. Those
  // two facts together mean `pnpm` and `yarn` — which are corepack shims on
  // most Node installs — re-download themselves for every task and then throw
  // the download away with the worktree. Pointing COREPACK_HOME at the
  // project's dependency cache makes the package manager itself something
  // prepared once, like everything else here.
  const env = {
    COREPACK_HOME: path.join(input.cacheRoot ?? depsCacheRoot(input.projectRoot), 'corepack'),
    COREPACK_ENABLE_DOWNLOAD_PROMPT: '0',
    ...extraEnv,
  };
  const res = await input.supervisor.run({
    id: `${input.taskId}-deps-${Date.now()}`,
    projectId: input.projectId, taskId: input.taskId,
    // Heavy: an install saturates disk and CPU, and the governor is the only
    // thing that stops several of them starting at once.
    cls: 'heavy',
    command: cmd, args, cwd: input.worktree,
    policy,
    confineFilesystem: true,     // repository install scripts are the untrusted ones
    env,
    timeoutSeconds: input.timeoutSeconds,
  });
  return {
    ok: res.outcome === 'COMPLETED',
    outcome: res.outcome,
    detail: `${commandLine} -> ${res.outcome}${res.exitCode === null ? '' : ` (exit ${res.exitCode})`}`,
    output: res.stdout,
  };
}

/**
 * Gives this worktree runnable dependencies, preparing the cache if needed.
 *
 * Returns rather than throws: a preparation failure is INFRASTRUCTURE_FAILURE
 * for the task, and the caller needs the install output to put in front of a
 * human. A thrown exception would lose exactly the evidence that makes the
 * escalation worth reading.
 */
export async function prepareDependencies(input: PrepareInput): Promise<PreparationOutcome> {
  const started = Date.now();
  const attempts: PrepAttempt[] = [];
  const plan = planDependencies({
    projectRoot: input.projectRoot, worktree: input.worktree,
    installCommand: input.installCommand, cacheRoot: input.cacheRoot,
  });
  const done = (o: Omit<PreparationOutcome, 'durationMs' | 'attempts'>): PreparationOutcome =>
    ({ ...o, durationMs: Date.now() - started, attempts });

  if (plan.ecosystem === 'none' || (plan.ecosystem === 'node' && !plan.cacheDir)) {
    return done({ ok: true, prepared: false, method: 'none', lockfileHash: null, reused: false,
      detail: plan.reason });
  }

  // ---- non-node: install per worktree, no cache -----------------------------
  if (plan.ecosystem === 'other') {
    const t0 = Date.now();
    const r = await runInstall(input, splitCommand(plan.installCommand!), [], {}, input.network !== false);
    attempts.push({ method: 'install', ok: r.ok, detail: r.detail, durationMs: Date.now() - t0 });
    if (!r.ok) {
      return done({ ok: false, prepared: false, method: 'install', lockfileHash: null, reused: false,
        detail: r.detail, output: r.output });
    }
    return done({ ok: true, prepared: true, method: 'install', lockfileHash: null, reused: false,
      detail: plan.reason });
  }

  // ---- node ----------------------------------------------------------------
  const cacheDir = plan.cacheDir!;
  const cacheRoot = plan.cacheRoot;
  fs.mkdirSync(cacheRoot, { recursive: true });
  const worktreeModules = path.join(input.worktree, NODE_MODULES);

  if (isCompleteCache(cacheDir)) {
    const m = await materialize(input, plan, cacheDir, attempts);
    if (m.ok) {
      return done({ ok: true, prepared: true, method: m.method, lockfileHash: plan.lockfileHash,
        reused: true, detail: m.detail });
    }
    // Every reuse method failed. Falling through to a fresh install is
    // correct — the cache may be damaged — but it must be visible, not silent.
    attempts.push({ method: 'install', ok: false, durationMs: 0,
      detail: 'cache present but unusable; falling back to a fresh install' });
  }

  // ---- prepare: install once, then publish ---------------------------------
  const tmp = tmpDirIn(cacheRoot);
  const store = path.join(tmp, 'store');
  const usePnpmStore = plan.packageManager === 'pnpm';
  const t0 = Date.now();
  const argv = [...installArgvFor(plan.packageManager!, plan.installCommand),
    ...(usePnpmStore ? ['--store-dir', store] : [])];
  const command = argv.join(' ');
  const r = await runInstall(input, argv, [cacheRoot], {}, input.network !== false);
  attempts.push({ method: 'install', ok: r.ok, detail: r.detail, durationMs: Date.now() - t0 });
  if (!r.ok) {
    fs.rmSync(tmp, { recursive: true, force: true });
    return done({ ok: false, prepared: false, method: 'install', lockfileHash: plan.lockfileHash,
      reused: false, detail: r.detail, output: r.output });
  }
  if (!fs.existsSync(worktreeModules)) {
    fs.rmSync(tmp, { recursive: true, force: true });
    return done({ ok: false, prepared: false, method: 'install', lockfileHash: plan.lockfileHash,
      reused: false, detail: `${command} reported success but created no ${NODE_MODULES}`,
      output: r.output });
  }
  const escaped = findEscapingLink(worktreeModules, input.worktree);
  if (escaped) {
    fs.rmSync(tmp, { recursive: true, force: true });
    return done({ ok: false, prepared: false, method: 'install', lockfileHash: plan.lockfileHash,
      reused: false, output: r.output,
      detail: `install produced a symlink leaving the worktree: ${escaped.link} -> ${escaped.target}` });
  }

  // Publish: complete first, mark second, rename third. A reader that sees the
  // final name sees a finished cache, or nothing at all.
  try {
    const link = canHardlink(cacheRoot, path.dirname(worktreeModules));
    // Published immutable, and that is a correctness boundary rather than
    // tidiness.
    //
    // Reuse hardlinks the cache into each worktree, and a hardlink shares the
    // inode: measured, an in-place write to `node_modules/pkg/index.js` inside
    // ONE task's worktree changed the cache and every other worktree that had
    // materialised from it. `patch-package`, a postinstall script and any tool
    // that rewrites a file in place all do exactly that, so a single task could
    // silently poison a content-addressed cache that every later task then
    // trusts by hash.
    //
    // Unwritable files make that attempt fail loudly (EACCES) instead of
    // succeeding invisibly. Replacing a file still works, because that unlinks
    // and creates rather than writing through the shared inode. This is the
    // same guarantee pnpm gives its own content-addressed store, for the same
    // reason.
    replicateTree(worktreeModules, path.join(tmp, NODE_MODULES),
      link.ok ? 'link' : 'copy', tmp, { readOnlyFiles: true });
    fs.writeFileSync(path.join(tmp, MARKER), `${JSON.stringify({
      schema: CACHE_SCHEMA, packageManager: plan.packageManager, lockfile: plan.lockfile,
      lockfileHash: plan.lockfileHash, publishedBy: input.taskId,
      publishedAt: new Date().toISOString(), store: usePnpmStore && fs.existsSync(store),
    }, null, 1)}\n`);
    try {
      fs.renameSync(tmp, cacheDir);
    } catch (e: any) {
      // EEXIST/ENOTEMPTY: another task published this exact key first. Its
      // cache is as valid as ours would have been, so discard ours.
      fs.rmSync(tmp, { recursive: true, force: true });
      if (!isCompleteCache(cacheDir)) throw e;
    }
  } catch (e: any) {
    fs.rmSync(tmp, { recursive: true, force: true });
    // The worktree is installed and usable even though publication failed, so
    // the task proceeds; the next task simply pays the install again.
    return done({ ok: true, prepared: true, method: 'install', lockfileHash: plan.lockfileHash,
      reused: false, detail: `installed, but the cache could not be published: ${e?.message ?? e}` });
  }
  return done({ ok: true, prepared: true, method: 'install', lockfileHash: plan.lockfileHash,
    reused: false, detail: `installed and published cache ${path.basename(cacheDir)}` });
}

/**
 * Materialises a prepared cache into this worktree.
 *
 * Order is hardlink, then pnpm store, then copy — see `PrepMethod` for the
 * measurements that decided it. Each is attempted for real and recorded
 * whether it worked, because the alternative — assuming pnpm behaves like pnpm
 * because `pnpm` is on PATH — is how a report comes to describe a method that
 * never ran.
 */
async function materialize(input: PrepareInput, plan: DependencyPlan, cacheDir: string,
  attempts: PrepAttempt[]): Promise<{ ok: boolean; method: PrepMethod; detail: string }> {
  const worktreeModules = path.join(input.worktree, NODE_MODULES);
  const store = path.join(cacheDir, 'store');
  const cacheModules = path.join(cacheDir, NODE_MODULES);
  const clear = () => fs.rmSync(worktreeModules, { recursive: true, force: true });

  // 1 — hardlink. Same bytes, one copy on disk, a worktree that is a real
  // directory rather than a pointer at shared state, and two orders of
  // magnitude cheaper than re-running a package manager offline.
  const link = canHardlink(cacheDir, path.dirname(worktreeModules));
  if (link.ok) {
    const t0 = Date.now();
    try {
      const st = replicateTree(cacheModules, worktreeModules, 'link', input.worktree);
      attempts.push({ method: 'hardlink', ok: true, durationMs: Date.now() - t0,
        detail: `${st.files} file(s), ${st.links} symlink(s), ${st.dirs} dir(s)` });
      return { ok: true, method: 'hardlink', detail: `hardlinked from ${path.basename(cacheDir)}` };
    } catch (e: any) {
      attempts.push({ method: 'hardlink', ok: false, durationMs: Date.now() - t0, detail: `${e?.message ?? e}` });
      clear();
      // An escaping symlink is a property of the CACHED TREE, not of the
      // method, so every other method would reproduce it. Refuse them all.
      if (e instanceof EscapingLinkError) return { ok: false, method: 'hardlink', detail: e.message };
    }
  } else {
    attempts.push({ method: 'hardlink', ok: false, detail: link.detail, durationMs: 0 });
  }

  // 2 — pnpm's own store. Slower, but it is the fallback that works when the
  // cache and the worktree are not on the same filesystem.
  if (plan.packageManager === 'pnpm' && fs.existsSync(store)) {
    const t0 = Date.now();
    const r = await runInstall(input,
      ['pnpm', 'install', '--frozen-lockfile', '--offline', '--store-dir', store],
      [cacheDir], {}, false);
    const escaped = r.ok ? findEscapingLink(worktreeModules, input.worktree) : null;
    const ok = r.ok && fs.existsSync(worktreeModules) && !escaped;
    attempts.push({ method: 'pnpm-store', ok, durationMs: Date.now() - t0,
      detail: escaped ? `escaping symlink ${escaped.link} -> ${escaped.target}` : r.detail });
    if (ok) return { ok: true, method: 'pnpm-store', detail: `reused pnpm store ${path.basename(cacheDir)}` };
    clear();
  }

  // 3 — copy. Slower and larger, but it works across devices.
  const t0 = Date.now();
  try {
    const s = replicateTree(cacheModules, worktreeModules, 'copy', input.worktree);
    attempts.push({ method: 'copy', ok: true, durationMs: Date.now() - t0,
      detail: `${s.files} file(s), ${s.links} symlink(s), ${s.dirs} dir(s)` });
    return { ok: true, method: 'copy', detail: `copied from ${path.basename(cacheDir)}` };
  } catch (e: any) {
    attempts.push({ method: 'copy', ok: false, durationMs: Date.now() - t0, detail: `${e?.message ?? e}` });
    clear();
    return { ok: false, method: 'copy', detail: `${e?.message ?? e}` };
  }
}

/**
 * What `zeus doctor` needs to explain this project's preparation behaviour.
 *
 * Reports the state that exists, not the state that should: "would use" is
 * separated from "has", so a cache that was never built and a cache that was
 * built and deleted do not look the same.
 */
export function describeDependencyState(projectRoot: string, installCommand: string | null,
  cacheRoot?: string): {
    ecosystem: string; packageManager: string | null; lockfile: string | null;
    lockfileHash: string | null; cacheDir: string | null; cached: boolean;
    cacheBytes: number; wouldUse: PrepMethod; detail: string; caches: number;
  } {
  const plan = planDependencies({ projectRoot, worktree: projectRoot, installCommand, cacheRoot });
  const dir = plan.cacheDir;
  const cached = plan.cached;
  let wouldUse: PrepMethod = 'none';
  let detail = plan.reason;
  if (plan.ecosystem === 'other') { wouldUse = 'install'; }
  else if (plan.ecosystem === 'node' && plan.cacheDir) {
    if (!cached) { wouldUse = 'install'; detail = 'no prepared cache for this lockfile yet'; }
    else if (dir && fs.existsSync(dir) && canHardlink(dir, dir).ok) {
      // Hardlink first, matching materialize(): doctor predicting a method the
      // engine would not choose is worse than doctor saying nothing.
      wouldUse = 'hardlink'; detail = 'prepared cache present, hardlink verified';
    } else if (plan.packageManager === 'pnpm' && dir && fs.existsSync(path.join(dir, 'store'))) {
      wouldUse = 'pnpm-store'; detail = 'no hardlinks here; prepared pnpm store present';
    } else if (dir && fs.existsSync(dir)) {
      // Probe inside the cache directory that already exists: describing a
      // project must not create anything on disk.
      wouldUse = 'copy';
      detail = `prepared cache present, ${canHardlink(dir, dir).detail}`;
    } else {
      wouldUse = 'copy';
      detail = 'prepared cache present but unreadable';
    }
  }
  let caches = 0;
  try {
    caches = fs.readdirSync(plan.cacheRoot)
      .filter((n) => n.startsWith(`${CACHE_SCHEMA}-`) && isCompleteCache(path.join(plan.cacheRoot, n))).length;
  } catch { caches = 0; }
  return {
    ecosystem: plan.ecosystem, packageManager: plan.packageManager, lockfile: plan.lockfile,
    lockfileHash: plan.lockfileHash, cacheDir: dir, cached, caches,
    cacheBytes: dir && cached ? dirSizeBytes(dir) : 0, wouldUse, detail,
  };
}
