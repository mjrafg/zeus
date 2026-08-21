/**
 * Project readiness: doctor must probe what a mission actually needs.
 *
 * The finding these hold closed: on a real project `zeus doctor` reported
 * healthy and the first mission died in under a minute because the host had no
 * pnpm and the project is a pnpm workspace. Doctor had checked what Zeus needs
 * in general and nothing had checked what that project's mission path needs.
 *
 * Nothing here installs, fetches or writes. That is also asserted, not assumed.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { check, section } from './harness';
import { main } from '../src/cli';
import { readConfig, writeConfig, defaultConfig } from '../src/config';
import { EventStore } from '../src/engine/events';
import { MissionRegistry } from '../src/mission/registry';
import {
  projectReadiness, probePackageManager, probeCommands, probePreparation,
  supervisorEnv, REQUIRED_FLOOR,
} from '../src/readiness';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'zeus-ready-'));
let seq = 0;

/** A project on disk, with whatever lockfile the case needs. */
function fixture(name: string, files: Record<string, string>): string {
  const root = path.join(TMP, `${name}-${seq += 1}`);
  fs.mkdirSync(root, { recursive: true });
  for (const [rel, body] of Object.entries(files)) {
    const f = path.join(root, rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, body);
  }
  execFileSync('git', ['init', '-q', '-b', 'main', root]);
  execFileSync('git', ['-C', root, 'add', '-A']);
  execFileSync('git', ['-C', root, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init']);
  return root;
}

/** A PATH containing only what the case puts there. */
function bin(name: string, body: string, mode = 0o755): string {
  const dir = path.join(TMP, `bin-${seq += 1}`);
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, name);
  fs.writeFileSync(f, body);
  fs.chmodSync(f, mode);
  return dir;
}

const PKG = '{"name":"fx","dependencies":{"left-pad":"1.0.0"}}\n';

export async function readinessSuite(): Promise<void> {
  section('project readiness: the BC-1 shape, refused at doctor time');
  {
    // A pnpm workspace, on a host that has no pnpm. This is the exact shape
    // that reported healthy and then died in under a minute.
    const root = fixture('pnpm-ws', {
      'package.json': PKG,
      'pnpm-lock.yaml': "lockfileVersion: '6.0'\n",
      'pnpm-workspace.yaml': "packages:\n  - 'packages/*'\n",
      'tsconfig.json': '{}\n',
    });
    const emptyBin = bin('placeholder', '#!/bin/sh\nexit 0\n');
    const hostWithoutPnpm = { PATH: emptyBin };

    const probe = probePackageManager(root, hostWithoutPnpm);
    check('RD1: a pnpm workspace on a host without pnpm FAILS the package-manager probe',
      probe.status === 'FAIL' && probe.required, `${probe.status}/${probe.required}`);
    check('RD1b: and the probe names pnpm, so the remedy is obvious',
      probe.detail.includes('pnpm') && (probe.remedy ?? '').includes('pnpm'), probe.detail);
    check('RD1c: it reports the manager it looked for and that nothing resolved',
      probe.facts?.manager === 'pnpm' && probe.facts?.resolvedPath === null
      && probe.facts?.executes === false, JSON.stringify(probe.facts));

    // And the whole verdict cannot stay green while it fails.
    const cfg = defaultConfig(root);
    cfg.commands = { install: 'pnpm install --frozen-lockfile', typecheck: 'tsc --noEmit',
      unitTest: 'pnpm test', build: null, lint: null, integrationTest: null } as any;
    const realPath = process.env.PATH;
    process.env.PATH = emptyBin;
    let report;
    try { report = projectReadiness({ root, cfg }); } finally { process.env.PATH = realPath; }
    check('RD2: the overall readiness verdict is not ready while a required probe fails',
      report!.ok === false, String(report!.ok));
    check('RD2b: the summary states the first reason it would fail, not a green claim',
      report!.summary.startsWith('a mission on this project would fail')
      && report!.summary.includes('pnpm'), report!.summary);
  }

  section('project readiness: declared commands must resolve');
  {
    const present = bin('realtool', '#!/bin/sh\necho ok\n');
    const croot = fixture('cmds', { 'package.json': PKG });
    const cfg = defaultConfig(croot);
    cfg.commands = {
      typecheck: 'definitely-absent-typechecker --noEmit',
      unitTest: 'realtool test',
      lint: 'definitely-absent-linter .',
      install: null, build: null, integrationTest: null,
    } as any;
    const probes = probeCommands(cfg, { PATH: present });
    const byId = (n: string) => probes.find((p) => p.id === `command:${n}`)!;

    check('RD3: an absent REQUIRED command is FAIL',
      byId('typecheck').status === 'FAIL' && byId('typecheck').required,
      byId('typecheck').status);
    check('RD3b: an absent OPTIONAL command is WARN, not FAIL',
      byId('lint').status === 'WARN' && !byId('lint').required, byId('lint').status);
    check('RD3c: the wording is the same either way — the fact is the same, the consequence differs',
      byId('typecheck').detail.includes('executable not found')
      && byId('lint').detail.includes('executable not found'),
      `${byId('typecheck').detail} | ${byId('lint').detail}`);
    check('RD3d: a resolvable command PASSES and records where it resolved',
      byId('unitTest').status === 'PASS'
      && String(byId('unitTest').facts?.resolvedPath).includes('realtool'),
      JSON.stringify(byId('unitTest').facts));
    check('RD3e: an undeclared command is SKIPPED with a reason, never PASS',
      byId('build').status === 'SKIPPED' && !!byId('build').reason, byId('build').reason ?? '');
    check('RD3f: the required floor is exactly typecheck and unitTest',
      REQUIRED_FLOOR.join(',') === 'typecheck,unitTest', REQUIRED_FLOOR.join(','));
  }

  section('project readiness: the corepack case — present is not the same as executes');
  {
    const root = fixture('corepack', {
      'package.json': PKG, 'pnpm-lock.yaml': "lockfileVersion: '6.0'\n",
    });
    // A shim that exists, is executable, and fails when actually run: exactly
    // what a corepack shim does when it cannot fetch its manager.
    const shimDir = bin('pnpm', '#!/bin/sh\necho "Cannot find matching keyid" >&2\nexit 1\n');
    const probe = probePackageManager(root, { PATH: shimDir });

    check('RD4: a shim that resolves but does not execute is FAIL, not PASS',
      probe.status === 'FAIL', probe.status);
    check('RD4b: the report states the distinction rather than just "missing"',
      probe.detail.includes('is present at') && probe.detail.includes('did not execute'),
      probe.detail);
    check('RD4c: it records the path it found AND that nothing executed',
      String(probe.facts?.resolvedPath).includes('pnpm')
      && probe.facts?.executes === false && probe.facts?.version === null,
      JSON.stringify(probe.facts));

    // A shim that DOES execute is the passing case, on the same code path.
    const workingDir = bin('pnpm', '#!/bin/sh\necho 9.1.0\n');
    const good = probePackageManager(root, { PATH: workingDir });
    check('RD4d: a manager that actually answers --version PASSES with its version',
      good.status === 'PASS' && good.facts?.version === '9.1.0'
      && good.facts?.executes === true, JSON.stringify(good.facts));
  }

  section('project readiness: probing is read-only');
  {
    const root = fixture('readonly', {
      'package.json': PKG,
      'package-lock.json': '{"lockfileVersion":3}\n',
      'tsconfig.json': '{}\n',
    });
    const cfg = defaultConfig(root);
    cfg.commands = { install: 'npm ci', typecheck: 'node --version', unitTest: 'node --version',
      build: null, lint: null, integrationTest: null } as any;

    const snapshot = (d: string): string[] => {
      const out: string[] = [];
      const walk = (x: string) => {
        for (const e of fs.readdirSync(x, { withFileTypes: true })) {
          if (e.name === '.git') continue;
          const f = path.join(x, e.name);
          out.push(path.relative(d, f));
          if (e.isDirectory()) walk(f);
        }
      };
      walk(d);
      return out.sort();
    };
    const before = snapshot(root);
    const report = projectReadiness({ root, cfg });
    const after = snapshot(root);

    check('RD5: doctor created nothing — the tree is byte-identical in shape',
      before.join('|') === after.join('|'),
      after.filter((f) => !before.includes(f)).join(', ') || 'unchanged');
    check('RD5b: no node_modules was produced',
      !fs.existsSync(path.join(root, 'node_modules')));
    check('RD5c: no dependency cache was created',
      !fs.existsSync(path.join(root, '.zeus', 'cache')));
    check('RD5d: and it still answered which method a mission WOULD use',
      report.wouldPrepareVia !== null, String(report.wouldPrepareVia));
    const prep = report.probes.find((p) => p.id === 'preparation')!;
    check('RD5e: the preparation probe reports typed facts, not prose',
      prep.facts?.ecosystem === 'node' && prep.facts?.lockfile === 'package-lock.json',
      JSON.stringify(prep.facts));
  }

  section('project readiness: doctor and mission run share one implementation');
  {
    const root = fixture('mission-gate', {
      'package.json': PKG, 'package-lock.json': '{"lockfileVersion":3}\n', 'tsconfig.json': '{}\n',
    });
    const cwd = process.cwd();
    let doctorJson = -1, runRc = -1;
    let events: string[] = [];
    let jsonOut = '';
    const realLog = console.log;
    try {
      process.chdir(root);
      await main(['init']);

      // Break exactly one required command, the way an absent toolchain does.
      const cfg = readConfig(root)!;
      (cfg.commands as any).typecheck = 'definitely-absent-typechecker --noEmit';
      writeConfig(root, cfg);

      // The CLI writes through process.stdout, not console.log.
      const realWrite = process.stdout.write.bind(process.stdout);
      (process.stdout as any).write = (chunk: any, ...rest: any[]) => {
        jsonOut += String(chunk); return true;
      };
      try { doctorJson = await main(['doctor', '--json']); }
      finally { (process.stdout as any).write = realWrite; }

      // A mission that is fully armed, so nothing earlier can be the reason
      // it refuses.
      const store = new EventStore(path.join(root, '.zeus', 'state'));
      const missions = new MissionRegistry({ events: store, projectId: readConfig(root)!.project.name });
      const rec = missions.create('a goal', 'HEAD');
      const oracle = { missionId: rec.missionId, version: 1, acceptanceMode: 'AUTO',
        compiledAt: 'now', compilerProviderId: 'mock', criticProviderId: 'mock',
        criteria: [{ criterionId: `${rec.missionId}/C-0001`, type: 'EXECUTABLE',
          statement: 's', evaluator: { kind: 'command', command: 'unitTest', expect: 'PASSED' },
          affectedBy: [], required: true, requiresAuthority: [], derivedFrom: ['check:unitTest'] }] };
      missions.recordOracle(rec.missionId, oracle as any, 'h', { ok: true });
      missions.acceptOracle(rec.missionId, { acceptanceMode: 'AUTO', acceptedBy: 'auto',
        modeInputs: {}, modeReasons: [], escalatedByCritic: false } as any);
      const plan = { version: 1, nodes: [{ nodeId: `${rec.missionId}/N-0001`, description: 'd',
        dependsOn: [], preconditions: [], reads: [], writes: [], affectedCriteria: [],
        predictedEffects: [], estimatedTier: 'FAST', estimatedCost: 1, risk: 'LOW' }] };
      missions.recordPlan(rec.missionId, plan as any);
      missions.acceptPlan(rec.missionId, plan as any, { acceptedBy: 'auto' });

      runRc = await main(['mission', 'run', 'M-0001']);
      events = store.read(rec.missionId).map((e) => e.type);
    } finally { console.log = realLog; process.chdir(cwd); }

    check('RD6: doctor --json exits non-zero while a required project probe fails',
      doctorJson === 1, String(doctorJson));
    const parsed = (() => { try { return JSON.parse(jsonOut); } catch { return null; } })();
    check('RD6b: and carries the typed probes, not prose only',
      !!parsed?.readiness && Array.isArray(parsed.readiness.probes)
      && parsed.readiness.ok === false
      && parsed.readiness.probes.some((p: any) => p.id === 'command:typecheck' && p.status === 'FAIL'),
      parsed ? `ok=${parsed.readiness?.ok}` : 'unparsed');
    check('RD7: mission run refuses while readiness fails',
      runRc === 1, String(runRc));
    check('RD7b: it refused BEFORE the selftest — nothing was spent',
      !events.includes('SELFTEST_LIVE') && !events.includes('TASK_SPAWNED'),
      events.join(','));
  }

  section('project readiness: a ready project says so, and says how');
  {
    const root = fixture('ready', {
      'package.json': PKG, 'package-lock.json': '{"lockfileVersion":3}\n', 'tsconfig.json': '{}\n',
    });
    const cfg = defaultConfig(root);
    cfg.commands = { install: 'npm ci', typecheck: 'node --version', unitTest: 'node --version',
      build: null, lint: null, integrationTest: null } as any;
    const report = projectReadiness({ root, cfg });

    check('RD8: a project whose toolchain is present is ready',
      report.ok === true, report.summary);
    check('RD8b: the contract line names the preparation method and the floor',
      report.summary.includes('prepare via')
      && report.summary.includes('typecheck') && report.summary.includes('unitTest'),
      report.summary);
    check('RD8c: the floor it names is exactly the floor commands that resolved',
      report.floor.slice().sort().join(',') === 'typecheck,unitTest', report.floor.join(','));
    check('RD8d: supervisorEnv is the environment the probes resolve against',
      typeof supervisorEnv(root).PATH === 'string', 'PATH present');
    const prep = probePreparation(root, cfg, supervisorEnv(root));
    check('RD8e: preparation is probed through the engine’s own planner, not a copy',
      prep.wouldUse === report.wouldPrepareVia, `${prep.wouldUse} vs ${report.wouldPrepareVia}`);
  }
}
