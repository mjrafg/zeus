/**
 * Product-identity and migration tests.
 *
 * Two things are held here. First, that the product calls itself Zeus
 * everywhere a user can see — the old name survives only in the migration code
 * and the deprecation shim, and nowhere else. Second, that moving a pre-rename
 * install across never loses configuration, task state or evidence.
 *
 * Migration touches directories that hold a hash-chained log, so the tests are
 * deliberately paranoid about what happens when both layouts exist at once.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';

import { check, section } from './harness';
import { PROJECT_DIR, LEGACY_PROJECT_DIR, userConfigDir, userDataDir } from '../src/config';
import { planMigration, applyMigration, rewriteConfigPaths, LEGACY_DATA_DIRNAME } from '../src/migrate';
import { main, VERSION } from '../src/cli';

const REPO = path.resolve(__dirname, '..');
const OLD_NAMES = [/ai-autopilot/i, /AI Autopilot/i, /\bautopilot\b/i];

/** Files that name the old identity on purpose, and the reason each one does. */
const BRANDING_EXCEPTIONS: Record<string, string> = {
  'src/migrate.ts': 'detects the legacy layout so it can be migrated',
  'src/config.ts': 'exports LEGACY_PROJECT_DIR for the migration',
  'src/cli.ts': 'offers the migration and explains it',
  'bin/autopilot': 'the deprecation shim itself',
  'package.json': 'declares the deprecated alias as a bin entry',
  'install.sh': 'reports a legacy install and links the alias',
  'scripts/package.sh': 'scans the artifact for stale branding',
  'README.md': 'documents the migration and the alias for existing users',
};

function walk(dir: string, skip: string[], out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (skip.includes(e.name)) continue;
    const f = path.join(dir, e.name);
    if (e.isDirectory()) walk(f, skip, out);
    else out.push(f);
  }
  return out;
}

/** Captures stdout so a CLI command can be asserted on rather than eyeballed. */
async function capture(argv: string[], cwd?: string): Promise<{ code: number; text: string }> {
  const chunks: string[] = [];
  const realOut = process.stdout.write.bind(process.stdout);
  const realErr = process.stderr.write.bind(process.stderr);
  const grab = (c: any) => { chunks.push(String(c)); return true; };
  const prev = process.cwd();
  if (cwd) process.chdir(cwd);
  (process.stdout as any).write = grab;
  (process.stderr as any).write = grab;
  let code = -1;
  try { code = await main(argv); }
  finally {
    (process.stdout as any).write = realOut;
    (process.stderr as any).write = realErr;
    if (cwd) process.chdir(prev);
  }
  return { code, text: chunks.join('') };
}

function gitRepo(root: string, files: Record<string, string>): string {
  for (const [rel, body] of Object.entries(files)) {
    const f = path.join(root, rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, body);
  }
  execFileSync('git', ['init', '-q', '-b', 'main', root]);
  return root;
}

const LEGACY_CONFIG = `# Autopilot project configuration.
version: 1
project:
  name: legacy-app
  adapter: node
  root: "."
commands:
  unitTest: npm test
policy:
  protectedPaths:
    - package.json
  maxFilesChanged: 25
  requireHumanForProtectedPaths: true
  autoMerge: false
  autoDeploy: false
  allowUnverifiedAcceptance: false
resources:
  globalHeavyTestConcurrency: 1
  heavyTestTimeoutSeconds: 180
  maxTestWorkers: 2
  maxPlaywrightWorkers: 1
providers:
  planner: claude
  implementer: claude-code
  reviewer: codex
  billing: subscription-cli-only
integrations:
  graphify: auto
paths:
  state: .autopilot/state
  logs: .autopilot/logs
  worktrees: .autopilot/worktrees
`;

/** A legacy project directory with something worth losing in it. */
function legacyProject(root: string): string {
  const dir = path.join(root, LEGACY_PROJECT_DIR);
  fs.mkdirSync(path.join(dir, 'state'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'logs'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.yaml'), LEGACY_CONFIG);
  fs.writeFileSync(path.join(dir, 'state', 'events.jsonl'),
    '{"seq":1,"type":"TASK_CREATED","hash":"abc"}\n{"seq":2,"type":"STATE_CHANGED","hash":"def"}\n');
  fs.writeFileSync(path.join(dir, 'logs', 'task.log'), 'evidence that must survive\n');
  return dir;
}

export async function brandSuite(): Promise<void> {
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'zeus-brand-'));

  // These tests drive the real CLI, which looks at the per-user data and config
  // directories. Point them somewhere disposable: a test must never migrate,
  // read or write the machine's actual installation.
  const realEnv = {
    data: process.env.XDG_DATA_HOME, config: process.env.XDG_CONFIG_HOME,
    home: process.env.ZEUS_HOME, cfgHome: process.env.ZEUS_CONFIG_HOME,
  };
  process.env.XDG_DATA_HOME = path.join(TMP, 'xdg-data');
  process.env.XDG_CONFIG_HOME = path.join(TMP, 'xdg-config');
  delete process.env.ZEUS_HOME;
  delete process.env.ZEUS_CONFIG_HOME;
  const restoreEnv = () => {
    for (const [k, v] of Object.entries({
      XDG_DATA_HOME: realEnv.data, XDG_CONFIG_HOME: realEnv.config,
      ZEUS_HOME: realEnv.home, ZEUS_CONFIG_HOME: realEnv.cfgHome,
    })) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  };

  section('product identity: the product is Zeus');
  {
    const files = walk(REPO, ['.git', 'node_modules', 'dist', 'dist-release', 'internal', 'test', 'docs', '.github'])
      .filter((f) => /\.(ts|js|json|md|sh)$/.test(f) || !path.extname(f));
    const offenders: string[] = [];
    for (const f of files) {
      const rel = path.relative(REPO, f);
      if (rel in BRANDING_EXCEPTIONS) continue;
      if (rel === 'package-lock.json' || rel === 'LICENSE') continue;
      const text = fs.readFileSync(f, 'utf8');
      if (OLD_NAMES.some((re) => re.test(text))) offenders.push(rel);
    }
    check('BR1: no product-facing source names the old product',
      offenders.length === 0, offenders.join(', '));
    check('BR1b: every documented exception exists and really does name the old identity',
      Object.entries(BRANDING_EXCEPTIONS).every(([f]) => {
        const abs = path.join(REPO, f);
        return fs.existsSync(abs) && OLD_NAMES.some((re) => re.test(fs.readFileSync(abs, 'utf8')));
      }));
    // An exception that stopped being needed should be deleted, not left to rot.
    // Prose files must say why nearby; package.json cannot carry a comment, so
    // it is held to a stricter rule instead — the alias entry and nothing else.
    const unexplained = Object.keys(BRANDING_EXCEPTIONS)
      .filter((f) => f !== 'package.json')
      .filter((f) => !/migrat|legacy|deprecat|renamed|stale/i.test(fs.readFileSync(path.join(REPO, f), 'utf8')));
    check('BR1c: each exception is there for migration or deprecation, not by accident',
      unexplained.length === 0, unexplained.join(', '));
    const pkgLines = fs.readFileSync(path.join(REPO, 'package.json'), 'utf8')
      .split('\n').filter((l) => OLD_NAMES.some((re) => re.test(l)));
    check('BR1d: package.json names the old identity only in the alias entry',
      pkgLines.length === 1 && /"autopilot":\s*"bin\/autopilot"/.test(pkgLines[0]),
      pkgLines.join(' | '));

    const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'));
    check('BR2: the CLI executable is zeus',
      pkg.bin.zeus === 'bin/zeus' && fs.existsSync(path.join(REPO, 'bin', 'zeus')));
    check('BR2b: the package name is scoped, because unscoped "zeus" is taken on npm',
      pkg.name === '@mjrafg/zeus');
    check('BR2c: the repository metadata points at mjrafg/zeus',
      /github\.com\/mjrafg\/zeus/.test(pkg.repository.url) && /mjrafg\/zeus/.test(pkg.homepage));

    const help = await capture(['help']);
    check('BR3: zeus --help works and identifies the product',
      help.code === 0 && /^zeus /m.test(help.text.replace(/\x1b\[[0-9;]*m/g, '')));
    check('BR3b: help documents every advertised command',
      ['init', 'setup', 'doctor', 'run', 'status', 'cancel', 'logs', 'config', 'version']
        .every((c) => help.text.includes(`zeus ${c}`)));
    check('BR3c: help never tells anyone to run the old command',
      !/\bautopilot\b/i.test(help.text));

    const v = await capture(['version']);
    check('BR4: zeus version works', v.code === 0 && v.text.trim() === VERSION);
  }

  section('product identity: paths belong to Zeus');
  {
    check('BR5: the project directory is .zeus', PROJECT_DIR === '.zeus');
    check('BR5b: user data and config live under zeus, XDG-respecting',
      /(^|\/)zeus$/.test(userDataDir()) && /(^|\/)zeus$/.test(userConfigDir()) &&
      !userDataDir().includes(LEGACY_DATA_DIRNAME));

    const root = gitRepo(path.join(TMP, 'fresh'), { 'package.json': '{"name":"fresh","scripts":{"test":"jest"}}' });
    const rc = await capture(['init'], root);
    check('BR6: zeus init creates .zeus/ and never .autopilot/',
      rc.code === 0 &&
      fs.existsSync(path.join(root, '.zeus', 'config.yaml')) &&
      !fs.existsSync(path.join(root, LEGACY_PROJECT_DIR)));
    const cfg = fs.readFileSync(path.join(root, '.zeus', 'config.yaml'), 'utf8');
    check('BR7: task state paths in a new config are the Zeus ones',
      /state: \.zeus\/state/.test(cfg) && /logs: \.zeus\/logs/.test(cfg) &&
      /worktrees: \.zeus\/worktrees/.test(cfg) && !/\.autopilot/.test(cfg));
    check('BR7b: the config header names Zeus', /# Zeus project configuration/.test(cfg));

    const shown = await capture(['config'], root);
    check('BR8: zeus config shows the project configuration',
      shown.code === 0 && shown.text.includes('.zeus/config.yaml') && shown.text.includes('adapter'));
    const got = await capture(['config', 'get', 'policy.autoMerge'], root);
    check('BR8b: zeus config get reads a value', got.code === 0 && got.text.trim() === 'false',
      JSON.stringify({ code: got.code, text: got.text }));
    const set = await capture(['config', 'set', 'policy.maxFilesChanged', '7'], root);
    check('BR8c: zeus config set writes a typed value',
      set.code === 0 && /maxFilesChanged: 7/.test(fs.readFileSync(path.join(root, '.zeus', 'config.yaml'), 'utf8')));
    const bad = await capture(['config', 'set', 'policy.nope', '1'], root);
    check('BR8d: an unknown key is refused rather than invented', bad.code === 2);
    const invalid = await capture(['config', 'set', 'providers.billing', 'pay-as-you-go'], root);
    check('BR8e: a change that would invalidate the config is refused before it is written',
      invalid.code === 2 &&
      /billing: subscription-cli-only/.test(fs.readFileSync(path.join(root, '.zeus', 'config.yaml'), 'utf8')));
  }

  section('migration: a pre-rename layout moves across intact');
  {
    const root = gitRepo(path.join(TMP, 'legacy'), { 'package.json': '{"name":"legacy-app"}' });
    legacyProject(root);

    const plan = planMigration(root);
    check('BR9: a legacy project directory is detected',
      plan.needed && plan.steps.some((s) => s.kind === 'project' && s.status === 'ready'));
    check('BR9b: the prompt can say what is actually in it',
      plan.steps[0].contains.includes('config.yaml') && plan.steps[0].contains.includes('state'));

    const dry = applyMigration(plan, { dryRun: true });
    check('BR10: a dry run moves nothing',
      !dry[0].moved && fs.existsSync(path.join(root, LEGACY_PROJECT_DIR)) &&
      !fs.existsSync(path.join(root, PROJECT_DIR)));

    const res = applyMigration(planMigration(root));
    const moved = res.find((r) => r.step.kind === 'project')!;
    check('BR11: migration moves the directory', moved.moved &&
      !fs.existsSync(path.join(root, LEGACY_PROJECT_DIR)) &&
      fs.existsSync(path.join(root, PROJECT_DIR)));
    check('BR11b: configuration survives',
      fs.readFileSync(path.join(root, PROJECT_DIR, 'config.yaml'), 'utf8').includes('name: legacy-app'));
    check('BR11c: the hash-chained event log survives byte for byte',
      fs.readFileSync(path.join(root, PROJECT_DIR, 'state', 'events.jsonl'), 'utf8')
        === '{"seq":1,"type":"TASK_CREATED","hash":"abc"}\n{"seq":2,"type":"STATE_CHANGED","hash":"def"}\n');
    check('BR11d: logs and evidence survive',
      fs.readFileSync(path.join(root, PROJECT_DIR, 'logs', 'task.log'), 'utf8')
        === 'evidence that must survive\n');
    check('BR11e: the paths recorded inside the config are rewritten',
      /state: \.zeus\/state/.test(fs.readFileSync(path.join(root, PROJECT_DIR, 'config.yaml'), 'utf8')));
    check('BR11f: the migrated project loads through the normal CLI path',
      (await capture(['config', 'get', 'project.name'], root)).text.trim() === 'legacy-app');

    check('BR12: migration is idempotent — a second run finds nothing to do',
      planMigration(root).needed === false && applyMigration(planMigration(root)).length === 0);
    check('BR12b: a project that was never on the old layout is left alone',
      planMigration(path.join(TMP, 'fresh')).steps.every((s) => s.kind !== 'project'));
  }

  section('migration: nothing is ever destroyed');
  {
    const root = gitRepo(path.join(TMP, 'both'), { 'package.json': '{"name":"both"}' });
    legacyProject(root);
    fs.mkdirSync(path.join(root, PROJECT_DIR, 'state'), { recursive: true });
    fs.writeFileSync(path.join(root, PROJECT_DIR, 'config.yaml'), '# the new one\nversion: 1\n');
    fs.writeFileSync(path.join(root, PROJECT_DIR, 'state', 'events.jsonl'), '{"seq":1,"new":true}\n');

    const plan = planMigration(root);
    const conflict = plan.steps.find((s) => s.kind === 'project')!;
    check('BR13: both layouts existing is a reported conflict, not a merge',
      conflict.status === 'conflict' && /already exists/.test(conflict.reason ?? ''));

    const res = applyMigration(plan);
    check('BR13b: nothing is moved when there is a conflict',
      res.every((r) => !r.moved) &&
      fs.existsSync(path.join(root, LEGACY_PROJECT_DIR, 'config.yaml')));
    check('BR13c: neither copy is modified',
      fs.readFileSync(path.join(root, PROJECT_DIR, 'state', 'events.jsonl'), 'utf8') === '{"seq":1,"new":true}\n' &&
      fs.readFileSync(path.join(root, LEGACY_PROJECT_DIR, 'state', 'events.jsonl'), 'utf8').includes('TASK_CREATED'));
    check('BR13d: the legacy directory is never deleted',
      fs.existsSync(path.join(root, LEGACY_PROJECT_DIR, 'logs', 'task.log')));

    // A config that was already migrated must not be rewritten again.
    const already = path.join(TMP, 'already.yaml');
    fs.writeFileSync(already, 'paths:\n  state: .zeus/state\n');
    check('BR14: rewriting an already-correct config is a no-op',
      rewriteConfigPaths(already) === false);
    const cmt = path.join(TMP, 'commented.yaml');
    fs.writeFileSync(cmt, '# hand-written note\npaths:\n  state: .autopilot/state\n');
    rewriteConfigPaths(cmt);
    check('BR14b: a hand-edited config keeps its comments',
      fs.readFileSync(cmt, 'utf8') === '# hand-written note\npaths:\n  state: .zeus/state\n');
  }

  section('the deprecation alias');
  {
    const shim = path.join(REPO, 'bin', 'autopilot');
    check('BR15: the alias exists and is executable',
      fs.existsSync(shim) && (fs.statSync(shim).mode & 0o111) !== 0);
    const r = execFileSync('bash', [shim, 'version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    check('BR15b: it forwards to zeus and produces the real answer', r.trim() === VERSION);
    const withNotice = require('child_process').spawnSync('bash', [shim, 'version'], { encoding: 'utf8' });
    check('BR15c: it says once, on stderr, that the command was renamed',
      /autopilot has been renamed to zeus; use `zeus`\./.test(withNotice.stderr) &&
      !/renamed/.test(withNotice.stdout));
    check('BR15d: removing it takes deleting one file and one package.json entry',
      fs.readFileSync(shim, 'utf8').includes('delete this file'));

    const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'));
    check('BR15e: the alias is declared as a bin, so an install creates it',
      pkg.bin.autopilot === 'bin/autopilot');
  }

  section('open-source identity');
  {
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'));
    const licence = fs.readFileSync(path.join(REPO, 'LICENSE'), 'utf8');
    check('BR16: the package declares AGPL-3.0-only and ships the licence',
      pkg.license === 'AGPL-3.0-only' && pkg.files.includes('LICENSE'));
    check('BR16b: LICENSE is the AGPL text, not a placeholder',
      licence.includes('GNU AFFERO GENERAL PUBLIC LICENSE') && licence.includes('Version 3, 19 November 2007'));
    // Indexed, because the gates refuse by name and six checks answering to
    // "BR17" make a refusal ambiguous. The filename stays in the description.
    for (const [i, f] of (['CONTRIBUTING.md', 'CODE_OF_CONDUCT.md', 'SECURITY.md',
      '.github/pull_request_template.md', '.github/ISSUE_TEMPLATE/bug_report.yml',
      '.github/ISSUE_TEMPLATE/feature_request.yml']).entries()) {
      const text = fs.existsSync(path.join(REPO, f)) ? fs.readFileSync(path.join(REPO, f), 'utf8') : '';
      check(`BR17-${i + 1}: ${f} exists and is branded Zeus`,
        text.length > 0 && /zeus/i.test(text) && !/\bautopilot\b/i.test(text));
    }
  }

  section('consent: an unanswered prompt is never a yes');
  {
    // Regression: readLine() used to return '' at end-of-stream, which confirm()
    // read as "pressed enter" and therefore as the default. A migration then ran
    // in a process nobody was watching. EOF must mean no.
    const src = fs.readFileSync(path.join(REPO, 'src', 'setup', 'prompt.ts'), 'utf8');
    check('BR18: readLine distinguishes end-of-stream from an empty line',
      /function readLine\(\): string \| null/.test(src) && /if \(!sawEnter && line === ''\) return null/.test(src));
    check('BR18b: confirm refuses on end-of-stream instead of taking the default',
      /if \(raw === null\) \{[^}]*return false/.test(src));
    check('BR18c: a multi-select selects nothing when nobody answers',
      /if \(raw === null\) return \[\]/.test(src));

    // And prove it end to end: the real CLI, a legacy layout, and no terminal.
    const root = gitRepo(path.join(TMP, 'unattended'), { 'package.json': '{"name":"unattended"}' });
    legacyProject(root);
    const r = await capture(['status'], root);
    check('BR19: an unattended run reports the legacy layout and moves nothing',
      fs.existsSync(path.join(root, LEGACY_PROJECT_DIR, 'config.yaml')) &&
      !fs.existsSync(path.join(root, PROJECT_DIR)) &&
      /Legacy Zeus configuration detected/.test(r.text));
    check('BR19b: it says exactly how to do it deliberately',
      /zeus init --migrate/.test(r.text));
  }

  restoreEnv();
  fs.rmSync(TMP, { recursive: true, force: true });
}
