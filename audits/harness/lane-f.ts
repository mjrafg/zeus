/**
 * LANE F — git, worktrees, project isolation, revalidation.
 *
 * Charter §17, §19, §20, §30.
 *
 * Zeus operates on somebody's repository. The invariants here are about not
 * damaging it, not confusing two projects with each other, and not integrating
 * work that was verified against something else.
 */

import * as fs from 'fs';
import * as path from 'path';
import { LaneSpec, held, defect } from './types';
import { compare, evidence, fromAudit, repo, git, write, run } from './kit';

const SECTIONS = [
  { id: '§17', title: 'Worktree creation and isolation' },
  { id: '§19', title: 'Project state isolation' },
  { id: '§20', title: 'Task identity and path isolation' },
  { id: '§30', title: 'Integration revalidation' },
];

export const laneF: LaneSpec = {
  lane: 'F',
  title: 'Git / worktrees / project isolation / revalidate',
  sections: SECTIONS,
  probes: [
    {
      id: 'F1', section: '§20', title: 'two projects cannot collide on task identity or paths',
      run(ctx) {
        const { makeTaskId, taskIdToDir } = fromAudit(ctx.auditRoot, '../src/engine/orchestrator');
        const a = makeTaskId('alpha', 1);
        const b = makeTaskId('beta', 1);
        const hostile = makeTaskId('../../etc', 1);
        const observed = compare([
          ['alpha first task', a],
          ['beta first task', b],
          ['ids differ', String(a !== b)],
          ['hostile project name', hostile],
          ['as a directory', taskIdToDir(hostile)],
          ['directory contains traversal', String(taskIdToDir(hostile).includes('..' + path.sep))],
        ]);
        return a !== b && !taskIdToDir(hostile).includes(`..${path.sep}`)
          ? held(observed)
          : defect(observed, {
            sections: ['§20'], severity: 'P1',
            title: 'Task identity collides or escapes',
            detail: 'Two projects produced the same first task id, or a project name produced a traversing path.',
            impact: 'Logs and worktrees from different projects overwrite each other, or land outside the state root.',
          });
      },
    },
    {
      id: 'F2', section: '§17', title: 'a task worktree does not carry the project state directory',
      run(ctx) {
        const root = repo(path.join(ctx.tmp, 'f2'), {
          'a.ts': 'export const a = 1;\n',
          '.zeus/config.yaml': 'version: 1\n',
          '.zeus/state/tasks/x/events.jsonl': '{"seq":1}\n',
        });
        const wt = path.join(ctx.tmp, 'f2-wt');
        git(root, ['worktree', 'add', '-q', '--detach', wt, 'HEAD']);
        const stateInWorktree = fs.existsSync(path.join(wt, '.zeus/state'));
        const observed = compare([
          ['project has .zeus/state', String(fs.existsSync(path.join(root, '.zeus/state')))],
          ['worktree has .zeus/state', String(stateInWorktree)],
          ['worktree entries', fs.readdirSync(wt).join(', ')],
        ]);
        return !stateInWorktree ? held(observed) : defect(observed, {
          sections: ['§17', '§19'], severity: 'P1',
          title: 'Task state is visible inside the task worktree',
          detail: 'The worktree contains .zeus/state, so an agent can read and rewrite its own evidence.',
          impact: 'The implementer can edit the hash-chained log that is supposed to hold it to account.',
        });
      },
    },
    {
      id: 'F3', section: '§17', title: 'the no-commit fallback does not copy the git directory or dependencies',
      run(ctx) {
        const src = fs.readFileSync(path.join(ctx.auditRoot, 'src/engine/orchestrator.ts'), 'utf8');
        const m = /cp -a "\$\{?[^"]*\}?\/\." "[^"]*"/.exec(src) || /cp -a "([^"]*)" "([^"]*)"/.exec(src);
        const removesState = /rmSync\(path\.join\(rec\.worktree, '\.zeus'\)/.test(src);
        const excludesGit = /--exclude|\.git/.test(m ? m[0] : '');
        const observed = compare([
          ['fallback copy command', m ? m[0] : '(none found)'],
          ['removes .zeus after copying', String(removesState)],
          ['excludes .git / node_modules', String(excludesGit)],
        ]);
        return !m || excludesGit
          ? held(observed)
          : defect(observed, {
            sections: ['§17'], severity: 'P2',
            title: 'The empty-repository fallback copies .git and node_modules into the worktree',
            detail:
              'When a repository has no commit to check out, prepareWorktree falls back to `cp -a <root>/. <worktree>/`. '
              + 'That copies .git (making the worktree a full second clone whose commits never reach the project) and '
              + 'node_modules, plus any untracked local files including .env.',
            impact:
              'Commits an agent makes in that worktree are invisible to the project, the copy can be very large, and '
              + 'untracked secrets in the project root are duplicated into a directory the agent controls.',
          });
      },
    },
    {
      id: 'F4', section: '§30', title: 'an overlapping rebase escalates before integration',
      run(ctx) {
        const { revalidateForIntegration } = fromAudit(ctx.auditRoot, 'validation/revalidate');
        const rebased = [
          'diff --git a/src/lib/session.ts b/src/lib/session.ts',
          '--- a/src/lib/session.ts', '+++ b/src/lib/session.ts', '@@ -1 +1 @@',
          '-const ttl = 1;', '+const ttl = 2;',
        ].join('\n');
        const mk = (intervening: string[], conflicts: string[] = []) => ({
          headOf: () => 'yyyyyyyy',
          filesChangedBetween: () => intervening,
          rebase: () => (conflicts.length ? { ok: false, conflicts, detail: 'conflict' } : { ok: true, conflicts: [], detail: 'ok' }),
          diffAgainst: () => rebased,
        });
        const common = {
          integrationRef: 'main', verifiedAgainst: 'xxxxxxxx', originalTier: 'NORMAL',
          adapterId: 'node', confidence: 'KNOWN',
          commands: { typecheck: 'tsc', unitTest: 'jest', integrationTest: 'i' },
        };
        const overlap = revalidateForIntegration({ ...common, git: mk(['src/lib/session.ts']) } as any);
        const disjoint = revalidateForIntegration({ ...common, git: mk(['docs/x.md']) } as any);
        const conflict = revalidateForIntegration({ ...common, git: mk(['src/lib/session.ts'], ['src/lib/session.ts']) } as any);
        const observed = compare([
          ['overlapping', `${overlap.code} tier=${overlap.tier} escalated=${overlap.escalated}`],
          ['disjoint', `${disjoint.code} tier=${disjoint.tier} escalated=${disjoint.escalated}`],
          ['conflicting', `${conflict.code} plan=${String(conflict.plan)}`],
          ['floor rerun when disjoint', JSON.stringify(disjoint.plan?.floor ?? null)],
        ]);
        const ok = overlap.escalated && overlap.tier === 'DEEP'
          && !disjoint.escalated && (disjoint.plan?.floor ?? []).length > 0
          && conflict.code === 'REVALIDATION_CONFLICT' && conflict.plan === null;
        return ok ? held(observed) : defect(observed, {
          sections: ['§30'], severity: 'P1',
          title: 'Integration revalidation does not escalate on overlap',
          detail: 'An overlapping rebased diff was not escalated, or a conflict produced a validation plan anyway.',
          impact: 'Work verified against an old head is integrated without rechecking what moved underneath it.',
        });
      },
    },
    {
      id: 'F5', section: '§30', title: 'revalidation leaves the worktree in a stated condition',
      run(ctx) {
        const cli = fs.readFileSync(path.join(ctx.auditRoot, 'src/cli.ts'), 'utf8');
        const abortsOnConflict = /rebase', '--abort'/.test(cli);
        const saysItRebased = /rebased onto/.test(cli);
        const warnsOnSuccess = /leaves the worktree rebased|worktree is now rebased/i.test(cli);
        const observed = compare([
          ['aborts the rebase on conflict', String(abortsOnConflict)],
          ['reports that it rebased', String(saysItRebased)],
          ['tells the operator the worktree was left rebased', String(warnsOnSuccess)],
        ]);
        return abortsOnConflict && warnsOnSuccess
          ? held(observed)
          : defect(observed, {
            sections: ['§30'], severity: 'P3',
            title: 'A successful revalidation mutates the task worktree without saying so',
            detail:
              '`zeus revalidate` rebases the task worktree onto the integration head. On conflict it aborts and says '
              + 'so, but on success it leaves the worktree rebased and reports only the tier decision.',
            impact:
              'An operator running revalidate as a read-only "should I integrate?" query silently changes the task\'s '
              + 'commit history. Recoverable, but surprising, and the evidence recorded against the task now describes '
              + 'a different base than the one it was verified on.',
          });
      },
    },
    {
      id: 'F6', section: '§19', title: 'two projects keep separate state roots',
      run(ctx) {
        const { defaultConfig } = fromAudit(ctx.auditRoot, '../src/config');
        const a = repo(path.join(ctx.tmp, 'f6a'), { 'package.json': '{"name":"a"}\n' });
        const b = repo(path.join(ctx.tmp, 'f6b'), { 'package.json': '{"name":"b"}\n' });
        const ca = defaultConfig(a); const cb = defaultConfig(b);
        const ra = path.resolve(a, ca.paths.state); const rb = path.resolve(b, cb.paths.state);
        const observed = compare([
          ['project a state root', ra],
          ['project b state root', rb],
          ['distinct', String(ra !== rb)],
          ['each contained by its project', String(ra.startsWith(a) && rb.startsWith(b))],
        ]);
        return ra !== rb && ra.startsWith(a) && rb.startsWith(b)
          ? held(observed)
          : defect(observed, {
            sections: ['§19'], severity: 'P0',
            title: 'Projects share a state root',
            detail: 'Two distinct projects resolved to the same state directory.',
            impact: 'Task logs, leases and worktrees from unrelated repositories overwrite one another.',
          });
      },
    },
  ],
};
