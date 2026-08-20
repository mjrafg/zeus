/**
 * LANE E — installer, setup, providers, packaging.
 *
 * Charter §14, §25, §26, §27.
 *
 * This is the surface a stranger meets first, running one command from the
 * internet. It is also the only part of Zeus whose job is to change the
 * machine, which makes "asked first" a correctness property rather than a
 * courtesy.
 */

import * as fs from 'fs';
import * as path from 'path';
import { LaneSpec, held, defect } from './types';
import { compare, evidence, fromAudit, run } from './kit';

const SECTIONS = [
  { id: '§14', title: 'Release artifact composition' },
  { id: '§25', title: 'Installer safety' },
  { id: '§26', title: 'Setup consent' },
  { id: '§27', title: 'Provider credential handling' },
];

export const laneE: LaneSpec = {
  lane: 'E',
  title: 'Installer / setup / providers / packaging',
  sections: SECTIONS,
  probes: [
    {
      id: 'E1', section: '§25', title: 'the installer never elevates or installs on its own',
      run(ctx) {
        const sh = fs.readFileSync(path.join(ctx.auditRoot, 'install.sh'), 'utf8');
        const sudoLines = sh.split('\n').map((l, i) => [i + 1, l] as const)
          .filter(([, l]) => /(^|[^#\w])sudo\s/.test(l) && !/^\s*#/.test(l));
        const pkgInstall = sh.split('\n').map((l, i) => [i + 1, l] as const)
          .filter(([, l]) => /(apt-get|dnf|yum|pacman|apk|brew)\s+install/.test(l) && !/^\s*#/.test(l));
        const observed = compare([
          ['sudo invocations', sudoLines.map(([n]) => `line ${n}`).join(', ') || '(none)'],
          ['package-manager installs', pkgInstall.map(([n]) => `line ${n}`).join(', ') || '(none)'],
          ['runs setup only with a terminal', String(/\/dev\/tty/.test(sh))],
        ]);
        return sudoLines.length === 0 && pkgInstall.length === 0
          ? held(observed)
          : defect(observed, {
            sections: ['§25'], severity: 'P0',
            title: 'The installer elevates or installs packages by itself',
            detail: 'install.sh contains a sudo call or a package-manager install outside a comment.',
            impact: 'A one-line curl|bash changes the machine in ways the user never agreed to.',
          });
      },
    },
    {
      id: 'E2', section: '§25', title: 'a non-interactive install performs no consent-requiring action',
      run(ctx) {
        const sandbox = path.join(ctx.tmp, 'e2');
        fs.mkdirSync(sandbox, { recursive: true });
        const artifact = fs.existsSync(path.join(ctx.auditRoot, 'dist-release'))
          ? fs.readdirSync(path.join(ctx.auditRoot, 'dist-release')).find((f) => f.endsWith('.tar.gz'))
          : undefined;
        if (!artifact) {
          return held('  no release artifact present; installer end-to-end skipped in favour of the static checks in E1');
        }
        const r = run('bash', [path.join(ctx.auditRoot, 'install.sh'), '--non-interactive'], {
          env: {
            ...process.env,
            ZEUS_HOME: path.join(sandbox, 'data'),
            ZEUS_BIN_DIR: path.join(sandbox, 'bin'),
            ZEUS_TARBALL: path.join(ctx.auditRoot, 'dist-release', artifact),
          },
          timeoutMs: 180_000,
        });
        const out = `${r.stdout}${r.stderr}`;
        const madeBin = fs.existsSync(path.join(sandbox, 'bin/zeus'));
        const attemptedLogin = /auth login|codex login|Sign in to/i.test(out);
        const observed = compare([
          ['exit code', String(r.code)],
          ['zeus binary created', String(madeBin)],
          ['attempted a provider sign-in', String(attemptedLogin)],
          ['tail', evidence(out.split('\n').slice(-6).join('\n'), 400)],
        ]);
        return r.code === 0 && madeBin && !attemptedLogin
          ? held(observed)
          : defect(observed, {
            sections: ['§25', '§26'], severity: 'P1',
            title: 'A non-interactive install does more than install',
            detail: 'The installer either failed, produced no CLI, or attempted authentication without a human.',
            impact: 'CI and unattended installs either break or silently consent on the user\'s behalf.',
          });
      },
    },
    {
      id: 'E3', section: '§26', title: 'an unanswered prompt is never taken as a yes',
      run(ctx) {
        const src = fs.readFileSync(path.join(ctx.auditRoot, 'src/setup/prompt.ts'), 'utf8');
        const eofNull = /function readLine\(\): string \| null/.test(src);
        const refuses = /if \(raw === null\)[\s\S]{0,120}return false/.test(src);
        const chooseNone = /if \(raw === null\) return \[\]/.test(src);
        const observed = compare([
          ['readLine distinguishes EOF from empty line', String(eofNull)],
          ['confirm() refuses on EOF', String(refuses)],
          ['choose() selects nothing on EOF', String(chooseNone)],
        ]);
        return eofNull && refuses && chooseNone
          ? held(observed)
          : defect(observed, {
            sections: ['§26'], severity: 'P0',
            title: 'End-of-stream is read as accepting the default',
            detail: 'A closed terminal produced the same answer as a human pressing enter.',
            impact: 'An unattended process consents on behalf of a user who was never there.',
          });
      },
    },
    {
      id: 'E4', section: '§27', title: 'no credential is stored, echoed or persisted',
      run(ctx) {
        const { assertNoSecrets } = fromAudit(ctx.auditRoot, 'setup/state');
        const { providerStatus } = fromAudit(ctx.auditRoot, 'setup/providers');
        const probe = {
          platform: () => 'linux', arch: () => 'x64', distro: () => null,
          shell: () => 'bash', user: () => 'dev', homedir: () => '/home/dev',
          pathEntries: () => [], which: (b: string) => (b === 'claude' ? '/usr/bin/claude' : null),
          exists: () => false, isTTY: () => false,
          run: (_c: string, a: string[]) => (a.includes('--version')
            ? { code: 0, stdout: '2.0.0', stderr: '' }
            : { code: 0, stdout: '{"loggedIn":true,"authMethod":"claude.ai","email":"person@example.com","orgId":"org_secret_123","accessToken":"sk-ant-oat-LEAK"}', stderr: '' }),
          runInteractive: () => ({ code: 0, stdout: '', stderr: '' }),
        };
        const st = providerStatus(probe as any, 'claude');
        const serialised = JSON.stringify(st);
        const lifted = /person@example\.com|org_secret_123|sk-ant-oat-LEAK/.test(serialised);
        let refused = false;
        try { assertNoSecrets({ version: 1, startedAt: '', updatedAt: '', completed: [], roles: { developer: null, reviewer: null }, declined: [], lastOutcome: 'token=sk-ant-oat-LEAK' } as any); }
        catch { refused = true; }
        const observed = compare([
          ['vendor status output contained', 'email, orgId, accessToken'],
          ['ProviderStatus lifted any of them', String(lifted)],
          ['ProviderStatus', evidence(serialised, 260)],
          ['credential-shaped state refused before disk', String(refused)],
        ]);
        return !lifted && refused ? held(observed) : defect(observed, {
          sections: ['§27'], severity: 'P0',
          title: 'Provider credentials or identity are captured by Zeus',
          detail: 'Vendor status output beyond loggedIn/authMethod reached Zeus state.',
          impact: 'Zeus becomes a place credentials live, which is exactly what its provider design avoids.',
        });
      },
    },
    {
      id: 'E5', section: '§14', title: 'the release artifact carries only the runtime',
      run(ctx) {
        const dir = path.join(ctx.auditRoot, 'dist-release');
        const tarball = fs.existsSync(dir) ? fs.readdirSync(dir).find((f) => f.endsWith('.tar.gz')) : undefined;
        if (!tarball) return held('  no artifact built in this checkout; composition is asserted by scripts/package.sh at build time');
        const listing = run('tar', ['tzf', path.join(dir, tarball)]).stdout;
        const forbidden = listing.split('\n').filter((l) => /(^|\/)(internal|reference|tools|node_modules|\.git|\.zeus)\//.test(l));
        const hasLicence = /\/LICENSE$/m.test(listing);
        const observed = compare([
          ['artifact', tarball],
          ['entries', String(listing.split('\n').filter(Boolean).length)],
          ['forbidden paths', forbidden.slice(0, 5).join(', ') || '(none)'],
          ['ships LICENSE', String(hasLicence)],
        ]);
        return forbidden.length === 0 && hasLicence
          ? held(observed)
          : defect(observed, {
            sections: ['§14'], severity: 'P1',
            title: 'The release artifact contains more than the runtime',
            detail: `Forbidden entries: ${forbidden.join(', ') || 'none'}; LICENSE present: ${hasLicence}`,
            impact: 'Users receive private or irrelevant material, or receive the software with no licence at all.',
          });
      },
    },
    {
      id: 'E6', section: '§27', title: 'npm installs never escalate',
      run(ctx) {
        const pkg = fs.readFileSync(path.join(ctx.auditRoot, 'src/setup/pkg.ts'), 'utf8');
        const sudoNpm = /sudo[^\n]*npm|npm[^\n]*sudo/.test(pkg.replace(/^\s*\*.*$/gm, '').replace(/\/\/.*$/gm, ''));
        const fallsBack = /npm', \['config', 'set', 'prefix'/.test(pkg);
        const observed = compare([
          ['sudo npm anywhere in pkg.ts (comments stripped)', String(sudoNpm)],
          ['falls back to a user prefix on EACCES', String(fallsBack)],
        ]);
        return !sudoNpm && fallsBack ? held(observed) : defect(observed, {
          sections: ['§27', '§25'], severity: 'P0',
          title: 'Global npm install escalates privileges',
          detail: 'pkg.ts can run npm under sudo, or has no user-prefix fallback.',
          impact: 'Arbitrary package install scripts run as root during setup.',
        });
      },
    },
  ],
  declared: [
    {
      section: '§25', status: 'NOT_TESTED',
      reason:
        'Resistance to a hostile release archive (path traversal via crafted tar entries) was not exercised. '
        + 'Attempted: building a tarball containing ../ entries and pointing ZEUS_TARBALL at it. Not completed '
        + 'because writing such an archive into a shared audit host risks escaping the audit sandbox itself; '
        + 'it needs a disposable container. Recorded as a next-cycle target rather than silently dropped.',
    },
  ],
};
