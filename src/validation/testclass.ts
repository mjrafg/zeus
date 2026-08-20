/**
 * What a check actually starts when you run it.
 *
 * Zeus knew a check was "heavy" or "light" — a scheduling hint about CPU, not a
 * statement about what the command does to the machine. So a tier could select
 * a suite that boots a database and a job runner, and nothing in the system
 * could tell that apart from a fast unit run.
 *
 * Classification is deterministic: the command line, the runner's config file,
 * and the setup files that config points at. No model, no guessing at runtime.
 *
 * The default matters more than the detection. A suite we cannot classify is
 * treated as SERVICE_DEPENDENT, which means a FAST task will not select it.
 * That is conservative about **cost** — we may skip something cheap — and never
 * about **safety**, because the deterministic floor is chosen separately and is
 * not subject to this exclusion.
 */

import * as fs from 'fs';
import * as path from 'path';

export type TestClass =
  /** In-process, no external dependency. */
  | 'UNIT'
  /** Touches the filesystem or spawns child processes, but starts no service. */
  | 'INTEGRATION'
  /** Starts a database, broker, server, container, or binds a port. */
  | 'SERVICE_DEPENDENT'
  /** Drives a browser. */
  | 'E2E'
  /** Could not be determined. Treated as SERVICE_DEPENDENT for selection. */
  | 'UNKNOWN';

export interface Classification {
  check: string;
  command: string;
  klass: TestClass;
  /** Why — the literal signals found, so the verdict can be argued with. */
  signals: string[];
  /** Files inspected to reach it. */
  inspected: string[];
  /** True when selection must treat this as service-dependent. */
  treatAsService: boolean;
}

/** Signals in a command line or a config/setup file, most specific first. */
const RULES: Array<{ klass: TestClass; re: RegExp; what: string }> = [
  // --- browsers -------------------------------------------------------------
  { klass: 'E2E', re: /\b(playwright|cypress|puppeteer|webdriver|selenium|testcafe|nightwatch)\b/i, what: 'browser driver' },
  { klass: 'E2E', re: /\bchromium\b|\bheadless\b.*\bbrowser\b/i, what: 'headless browser' },

  // --- containers and orchestration ------------------------------------------
  { klass: 'SERVICE_DEPENDENT', re: /\bdocker(-compose)?\b|\bpodman\b|\bdocker\s+compose\b/i, what: 'container runtime' },
  { klass: 'SERVICE_DEPENDENT', re: /\btestcontainers\b/i, what: 'testcontainers' },

  // --- databases and brokers --------------------------------------------------
  { klass: 'SERVICE_DEPENDENT', re: /\b(postgres|postgresql|pg_ctl|mysql|mariadb|mongodb|mongod|redis|elasticsearch|opensearch|rabbitmq|kafka|clickhouse)\b/i, what: 'database or broker' },
  { klass: 'SERVICE_DEPENDENT', re: /\b(knex|prisma|typeorm|sequelize|drizzle)\b.*\b(migrate|migration|seed)\b/i, what: 'database migration in the test path' },
  { klass: 'SERVICE_DEPENDENT', re: /\bDATABASE_URL\b|\bDB_HOST\b|\bPG(HOST|PORT|USER|PASSWORD)\b/i, what: 'database connection settings' },

  // --- servers and ports -------------------------------------------------------
  { klass: 'SERVICE_DEPENDENT', re: /\.listen\s*\(|createServer\s*\(|\bapp\.listen\b|\bserve\b\s*\(/i, what: 'server bootstrap' },
  { klass: 'SERVICE_DEPENDENT', re: /\bstart-server-and-test\b|\bwait-on\b|\bwait-port\b/i, what: 'waits for a service to come up' },
  { klass: 'SERVICE_DEPENDENT', re: /\b(supertest|nock)\b.*\bserver\b/i, what: 'HTTP server under test' },
  { klass: 'SERVICE_DEPENDENT', re: /\bjob\s*runner\b|\bworker\b.*\bqueue\b|\bbull(mq)?\b|\bagenda\b|\bsidekiq\b/i, what: 'background job runner' },

  // --- integration-shaped but service-free -------------------------------------
  { klass: 'INTEGRATION', re: /\b(e2e|integration|acceptance|smoke)\b/i, what: 'named as an integration suite' },
  { klass: 'INTEGRATION', re: /\bglobalSetup\b|\bglobalTeardown\b|\bsetupFilesAfterEnv\b/i, what: 'global setup hooks' },
];

/** Runner config files worth reading, and the keys that point at setup code. */
const CONFIG_FILES = [
  'jest.config.js', 'jest.config.ts', 'jest.config.cjs', 'jest.config.mjs', 'jest.config.json',
  'vitest.config.ts', 'vitest.config.js', 'vite.config.ts',
  'playwright.config.ts', 'playwright.config.js',
  'cypress.config.ts', 'cypress.config.js', 'cypress.json',
  'karma.conf.js', '.mocharc.json', '.mocharc.yml', '.mocharc.js',
  'pytest.ini', 'tox.ini', 'conftest.py', 'phpunit.xml', 'phpunit.xml.dist',
  'docker-compose.yml', 'docker-compose.yaml', 'compose.yml',
];

const SETUP_REFERENCE = /['"`]([^'"`]*(?:setup|teardown|global-setup|globalSetup|bootstrap)[^'"`]*\.[cm]?[jt]s)['"`]/gi;

/**
 * Which config files speak for which commands.
 *
 * Explicit rather than inferred from the filename: a config is only evidence
 * about a check that actually invokes that runner.
 */
const CONFIG_RELEVANCE: Array<{ file: RegExp; when: RegExp }> = [
  { file: /^jest\./, when: /\bjest\b/i },
  { file: /^(vitest|vite)\./, when: /\bvitest\b/i },
  { file: /^playwright\./, when: /\bplaywright\b/i },
  { file: /^cypress[.]/, when: /\bcypress\b/i },
  { file: /^karma\./, when: /\bkarma\b/i },
  { file: /^\.mocharc/, when: /\bmocha\b/i },
  { file: /^(pytest\.ini|tox\.ini|conftest\.py)$/, when: /\b(pytest|python|tox)\b/i },
  { file: /^phpunit\.xml/, when: /\bphpunit\b/i },
  { file: /^(docker-compose|compose)\./, when: /\b(docker|compose|podman)\b/i },
];

function isRelevantConfig(cfg: string, command: string): boolean {
  const rule = CONFIG_RELEVANCE.find((r) => r.file.test(cfg));
  // A config nothing claims is not consulted: an unmatched file cannot be
  // evidence about a command it may have nothing to do with.
  return rule ? rule.when.test(command) : false;
}

function readIfPresent(root: string, rel: string): string | null {
  try {
    const p = path.resolve(root, rel);
    // Never follow a reference outside the project we were asked to inspect.
    if (!p.startsWith(path.resolve(root) + path.sep)) return null;
    const st = fs.statSync(p);
    if (!st.isFile() || st.size > 512 * 1024) return null;
    return fs.readFileSync(p, 'utf8');
  } catch { return null; }
}

const ORDER: TestClass[] = ['UNIT', 'INTEGRATION', 'SERVICE_DEPENDENT', 'E2E', 'UNKNOWN'];
function worse(a: TestClass, b: TestClass): TestClass {
  // UNKNOWN is not "worst" — it is unresolved. Any positive detection beats it.
  if (a === 'UNKNOWN') return b;
  if (b === 'UNKNOWN') return a;
  return ORDER.indexOf(a) >= ORDER.indexOf(b) ? a : b;
}

/**
 * Classifies one configured check.
 *
 * `projectRoot` is the repository the check runs in; config and setup files are
 * read from there. Absent files simply contribute no signal.
 */
export function classifyCheck(name: string, command: string, projectRoot: string): Classification {
  const signals: string[] = [];
  const inspected: string[] = [];
  // Held in an object rather than a `let`: the verdict is updated from inside a
  // closure, and a bare local would let the compiler narrow it to whatever the
  // straight-line code happened to assign.
  const state: { klass: TestClass } = { klass: 'UNKNOWN' };

  const consider = (text: string, where: string) => {
    for (const r of RULES) {
      if (!r.re.test(text)) continue;
      state.klass = worse(state.klass, r.klass);
      signals.push(`${r.what} (${where})`);
    }
  };

  consider(command, 'command');

  // A script name in the command usually resolves to a package.json script,
  // whose body is the thing that actually starts services.
  const pkg = readIfPresent(projectRoot, 'package.json');
  if (pkg) {
    inspected.push('package.json');
    try {
      const scripts = (JSON.parse(pkg).scripts ?? {}) as Record<string, string>;
      for (const [key, body] of Object.entries(scripts)) {
        if (!new RegExp(`(^|\\s)(run\\s+)?${key}(\\s|$)`).test(command)) continue;
        consider(body, `package.json script "${key}"`);
      }
    } catch { /* an unparseable manifest contributes nothing */ }
  }

  for (const cfg of CONFIG_FILES) {
    const text = readIfPresent(projectRoot, cfg);
    if (text === null) continue;
    // A config file is evidence about the check that USES it, not about every
    // check in the repository. Treating a repo-level docker-compose.yml as
    // relevant to all of them classified `tsc --noEmit` as service-dependent,
    // which would exclude every optional check in any dockerised project and
    // make the classification useless.
    if (!isRelevantConfig(cfg, command)) continue;
    inspected.push(cfg);
    consider(text, cfg);
    for (const m of text.matchAll(SETUP_REFERENCE)) {
      const setup = readIfPresent(projectRoot, m[1]);
      if (setup === null) continue;
      inspected.push(m[1]);
      consider(setup, m[1]);
    }
  }

  // Nothing matched anywhere, and we did look: that is a real UNIT signal only
  // if there was something to look at. Otherwise it stays UNKNOWN.
  if (state.klass === 'UNKNOWN'
      && /\b(test|spec|jest|vitest|mocha|tap|pytest|go test|cargo test)\b/i.test(command)) {
    state.klass = 'UNIT';
    signals.push('a recognised test runner with no service signal in command, manifest or config');
  }
  // Compilers, type checkers and linters read source and emit diagnostics. They
  // are not test runners, so the clause above never matched them and they fell
  // through as UNKNOWN — which, treated as service-dependent, put `tsc --noEmit`
  // in conflict with any task that said "do not start services".
  if (state.klass === 'UNKNOWN'
      && /(^|\s|\/)(tsc|eslint|prettier|mypy|ruff|flake8|pylint|gofmt|go vet|clippy|cargo check|cargo clippy|rustc|javac|stylelint|biome|swiftlint|ktlint)(\s|$)/i.test(command)) {
    state.klass = 'UNIT';
    signals.push('a compiler, type checker or linter: reads source and emits diagnostics, starts nothing');
  }

  const klass = state.klass;
  return {
    check: name, command, klass, signals, inspected,
    treatAsService: klass === 'SERVICE_DEPENDENT' || klass === 'E2E' || klass === 'UNKNOWN',
  };
}

export function classifyAll(
  checks: Array<{ name: string; command: string }>,
  projectRoot: string,
): Classification[] {
  return checks.map((c) => classifyCheck(c.name, c.command, projectRoot));
}
