/**
 * Read-only git (finding G-U2).
 *
 * The finding was a phase Zeus DECLARED read-only that mutated a repository:
 * `git fetch` into a temporary ref imported fourteen commits and two tags, and
 * nothing refused it, because "read-only" was a description rather than a
 * boundary. These tests hold the boundary — and, deliberately, they do not
 * only assert that the refusal happened. They assert that the repository is
 * byte-for-byte the same afterwards, because a refusal that fires while the
 * write still lands is the failure mode worth fearing.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { check, section } from './harness';
import {
  readOnlyGit, inspectReadOnlyGit, ReadOnlyGitError,
  GIT_WRITE_REFUSED_READONLY, ALLOWED_FORMS,
} from '../src/engine/gitro';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'zeus-gitro-'));

const git = (cwd: string, args: string[]): string =>
  execFileSync('git', ['-C', cwd, ...args],
    { encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();

function makeRepo(name: string, extraCommits = 1): string {
  const root = path.join(TMP, name);
  fs.mkdirSync(root, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main', root]);
  for (let i = 0; i < extraCommits; i += 1) {
    fs.writeFileSync(path.join(root, `f${i}.txt`), `content ${i}\n`);
    git(root, ['add', '-A']);
    git(root, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', `commit ${i}`]);
  }
  return root;
}

/** Everything that would change if a write got through. */
function repoState(root: string): string {
  return JSON.stringify({
    refs: git(root, ['for-each-ref', '--format=%(refname) %(objectname)']),
    head: git(root, ['rev-parse', 'HEAD']),
    objects: git(root, ['count-objects', '-v']),
    // The directory listing catches FETCH_HEAD, lost-found and friends: writes
    // that leave no ref behind but are still writes.
    gitdir: fs.readdirSync(path.join(root, '.git')).sort().join(','),
  });
}

export function gitReadOnlySuite(): void {
  // -----------------------------------------------------------------------
  section('read-only git: the allowlist is the boundary');
  {
    const allowed = ['rev-parse', 'log', 'show', 'diff', 'status', 'ls-tree', 'ls-files',
      'cat-file', 'for-each-ref'];
    check('RO1: the read-only verbs are permitted',
      allowed.every((v) => inspectReadOnlyGit([v]).allowed),
      allowed.filter((v) => !inspectReadOnlyGit([v]).allowed).join(', '));
    check('RO2: branch is permitted only in its listing form',
      inspectReadOnlyGit(['branch', '--list']).allowed
      && inspectReadOnlyGit(['branch', '-l']).allowed
      && !inspectReadOnlyGit(['branch', 'new-branch']).allowed
      && !inspectReadOnlyGit(['branch', '-D', 'x']).allowed);
    check('RO3: worktree is permitted only for list',
      inspectReadOnlyGit(['worktree', 'list']).allowed
      && !inspectReadOnlyGit(['worktree', 'add', '/tmp/x']).allowed
      && !inspectReadOnlyGit(['worktree', 'prune']).allowed);
    check('RO4: merge-tree is permitted only without --write-tree',
      inspectReadOnlyGit(['merge-tree', 'a', 'b', 'c']).allowed
      && !inspectReadOnlyGit(['merge-tree', '--write-tree', 'a', 'b']).allowed);

    // The boundary checks the FORM, not the first word.
    const optionTraps: Array<[string[], string]> = [
      [['log', '--output=/tmp/zeus-should-not-exist'], 'log writing a file'],
      [['diff', '-o', '/tmp/zeus-should-not-exist'], 'diff writing a file'],
      [['log', '--git-dir=/somewhere/else/.git'], 'retargeting the repository'],
      [['status', '--work-tree=/'], 'retargeting the working tree'],
      [['diff', '--ext-diff'], 'running an external diff driver'],
      [['log', '--textconv'], 'running a filter program'],
      [['-c', 'core.pager=sh -c evil', 'log'], 'setting config for the invocation'],
      [['-C', '/etc', 'status'], 'choosing another directory'],
    ];
    const leaked = optionTraps.filter(([argv]) => inspectReadOnlyGit(argv).allowed);
    check('RO5: an allowed verb cannot be turned into a write by an option',
      leaked.length === 0, leaked.map(([a]) => a.join(' ')).join(' | '));

    const writers = ['fetch', 'checkout', 'add', 'commit', 'merge', 'rebase', 'gc',
      'fsck', 'reset', 'push', 'pull', 'config', 'notes', 'reflog', 'clone', 'stash'];
    const permitted = writers.filter((v) => inspectReadOnlyGit([v]).allowed);
    check('RO6: every write verb is refused, including ones nobody listed',
      permitted.length === 0, permitted.join(', '));
    // An allowlist means an UNKNOWN verb is refused too — that is the whole
    // difference from a denylist, and the reason a future git cannot surprise it.
    check('RO7: a subcommand that does not exist yet is refused by default',
      !inspectReadOnlyGit(['some-future-subcommand']).allowed
      && !inspectReadOnlyGit(['sparse-checkout', 'set']).allowed);
  }

  // -----------------------------------------------------------------------
  section('read-only git: refused before anything is spawned');
  {
    const root = makeRepo('ro-repo', 2);
    const before = repoState(root);

    // Nothing is executed: the seam records every spawn the runner attempts.
    const spawned: string[][] = [];
    const refusals: string[] = [];
    const ro = readOnlyGit(root, {
      onRefusal: (r) => refusals.push(`${r.code}|${r.verb}`),
      exec: (_f, args) => { spawned.push(args); return ''; },
    });

    let err: any = null;
    try { ro(['fetch', 'origin', 'main:refs/tmp-import']); } catch (e) { err = e; }
    check('RO8: git fetch is refused', err instanceof ReadOnlyGitError, String(err));
    check('RO9: and refused BEFORE spawning — no process was started',
      spawned.length === 0, JSON.stringify(spawned));
    check('RO10: the refusal names the attempted verb',
      err?.verb === 'fetch' && / git fetch /.test(String(err?.message)), String(err?.message));
    check('RO11: the refusal carries the stable code',
      err?.code === GIT_WRITE_REFUSED_READONLY
      && String(err?.message).includes(GIT_WRITE_REFUSED_READONLY));
    check('RO12: the refusal is observable by the caller, not only thrown',
      refusals.length === 1 && refusals[0] === `${GIT_WRITE_REFUSED_READONLY}|fetch`,
      refusals.join(','));
    check('RO13: and it tells the operator what IS allowed',
      ALLOWED_FORMS.every((f) => String(err?.message).includes(f)));

    // The claim that matters: the repository did not move.
    check('RO14: the repository is byte-identical after the refused write',
      repoState(root) === before, 'refs, HEAD, object count or .git contents changed');
    check('RO15: specifically, no FETCH_HEAD and no imported refs appeared',
      !fs.existsSync(path.join(root, '.git', 'FETCH_HEAD'))
      && !/refs\/tmp-import/.test(git(root, ['for-each-ref', '--format=%(refname)'])));

    // Several more, each attempted for real against the live repository.
    const attempts = [['gc', '--aggressive'], ['fsck', '--lost-found'],
      ['checkout', '-b', 'sneaky'], ['config', 'user.name', 'nope'],
      ['worktree', 'add', path.join(TMP, 'wt')], ['reflog', 'expire', '--all']];
    const live = readOnlyGit(root);
    const survived = attempts.filter((argv) => {
      try { live(argv); return true; } catch (e: any) { return e?.code !== GIT_WRITE_REFUSED_READONLY; }
    });
    check('RO16: every mutating attempt is refused against a live repository',
      survived.length === 0, survived.map((a) => a.join(' ')).join(' | '));
    check('RO17: and the repository STILL has not changed',
      repoState(root) === before);
  }

  // -----------------------------------------------------------------------
  section('read-only git: the allowed verbs still do their job');
  {
    const root = makeRepo('ro-usable', 3);
    const ro = readOnlyGit(root);
    const head = ro(['rev-parse', 'HEAD']);
    check('RO18: rev-parse returns the head', /^[0-9a-f]{40}$/.test(head), head);
    check('RO19: log reads history', ro(['log', '--oneline']).split('\n').length === 3);
    check('RO20: status reports a clean tree', ro(['status', '--porcelain']) === '');
    check('RO21: diff and show read content',
      ro(['diff', '--name-only', `${head}~1`, head]) === 'f2.txt'
      && /commit 2/.test(ro(['show', '--stat', head])));
    check('RO22: ls-files and ls-tree list the tree',
      ro(['ls-files']).split('\n').length === 3 && /f0\.txt/.test(ro(['ls-tree', head])));
    check('RO23: branch --list and worktree list work',
      ro(['branch', '--list']).includes('main') && ro(['worktree', 'list']).includes(root));
    check('RO24: cat-file and for-each-ref work',
      ro(['cat-file', '-t', head]) === 'commit'
      && ro(['for-each-ref', '--format=%(refname)']).includes('refs/heads/main'));
    check('RO25: reading does not dirty the repository',
      ro(['status', '--porcelain']) === '' && !fs.existsSync(path.join(root, '.git', 'FETCH_HEAD')));
  }

  // -----------------------------------------------------------------------
  section('read-only git: applied where inspection happens, and only there');
  {
    const REPO = path.resolve(__dirname, '..');
    const read = (rel: string) => fs.readFileSync(path.join(REPO, rel), 'utf8');
    check('RO26: the self-audit inspects the repository under audit read-only',
      /readOnlyGit\(/.test(read('src/selfaudit/checkout.ts'))
      && /inspect\(repoRoot, \['rev-parse', 'HEAD'\]\)/.test(read('src/selfaudit/checkout.ts')));
    check('RO27: revalidate inspects the project read-only',
      /readOnlyGit\(ctx\.root/.test(read('src/cli.ts')));
    check('RO28: the engine reads the project HEAD read-only',
      /readOnlyGit\(this\.opts\.projectRoot/.test(read('src/engine/orchestrator.ts')));
    // And the other half of the boundary: task worktrees are where work
    // happens, and confining them to reads would break the product.
    check('RO29: task worktree mutation is deliberately NOT read-only',
      /'worktree', 'add', '--detach'/.test(read('src/engine/orchestrator.ts'))
      && /'add', '-A', '--intent-to-add'/.test(read('src/engine/orchestrator.ts')));
  }

  fs.rmSync(TMP, { recursive: true, force: true });
}
