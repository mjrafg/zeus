/**
 * Project adapters.
 *
 * The engine was born inside one Node monorepo and hard-coded its layout, its
 * test commands and its paths. An adapter is the seam that replaces those
 * assumptions: it says how to detect a project, what its build/test commands
 * are, and which paths are protected.
 *
 * Detection is passive by design. It reads manifest files and never executes
 * anything from the repository — running a stranger's `package.json` scripts to
 * find out what kind of project it is would be a remote-code-execution hole in
 * the first command a new user types.
 */

import * as fs from 'fs';
import * as path from 'path';

export interface Commands {
  install: string | null;
  build: string | null;
  /** Fast, cheap gate. Run often. */
  unitTest: string | null;
  /** Heavier suite. Serialized by the resource governor. */
  integrationTest: string | null;
  typecheck: string | null;
  lint: string | null;
}

export interface ProjectAdapter {
  id: string;
  name: string;
  /** Files whose presence identifies this project type. */
  markers: string[];
  /** More specific adapters win; ties break on marker count. */
  priority: number;
  detect(root: string): boolean;
  commands(root: string): Commands;
  /** Paths an autonomous change must never touch without human approval. */
  protectedPaths(root: string): string[];
  sourceGlobs(): string[];
  testGlobs(): string[];
}

function has(root: string, ...rel: string[]): boolean {
  return rel.every((r) => fs.existsSync(path.join(root, r)));
}
function hasAny(root: string, ...rel: string[]): boolean {
  return rel.some((r) => fs.existsSync(path.join(root, r)));
}
function readJson(file: string): any {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

/** Which Node package manager the lockfile says to use. Never guessed. */
export function nodePackageManager(root: string): 'pnpm' | 'yarn' | 'npm' {
  if (has(root, 'pnpm-lock.yaml')) return 'pnpm';
  if (has(root, 'yarn.lock')) return 'yarn';
  return 'npm';
}

const nodeAdapter: ProjectAdapter = {
  id: 'node', name: 'Node / JavaScript / TypeScript', priority: 50,
  markers: ['package.json', 'pnpm-lock.yaml', 'yarn.lock', 'package-lock.json'],
  detect: (root) => has(root, 'package.json'),
  commands: (root) => {
    const pm = nodePackageManager(root);
    const pkg = readJson(path.join(root, 'package.json')) ?? {};
    const scripts: Record<string, string> = pkg.scripts ?? {};
    const run = (s: string) => (pm === 'npm' ? `npm run ${s}` : `${pm} ${s}`);
    // Only offer a script the project actually declares.
    const pick = (...names: string[]) => {
      const hit = names.find((n) => typeof scripts[n] === 'string');
      return hit ? run(hit) : null;
    };
    const tsconfig = has(root, 'tsconfig.json');
    return {
      install: pm === 'npm' ? 'npm ci' : `${pm} install --frozen-lockfile`,
      build: pick('build'),
      unitTest: pick('test:unit', 'test'),
      integrationTest: pick('test:e2e', 'test:integration'),
      typecheck: pick('typecheck', 'tsc') ?? (tsconfig ? 'npx --no-install tsc --noEmit' : null),
      lint: pick('lint'),
    };
  },
  protectedPaths: () => ['package.json', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', '.github/', '.gitignore'],
  sourceGlobs: () => ['src/**', 'lib/**', 'packages/**'],
  testGlobs: () => ['**/*.test.*', '**/*.spec.*', 'test/**', 'tests/**', '__tests__/**'],
};

const pythonAdapter: ProjectAdapter = {
  id: 'python', name: 'Python', priority: 50,
  markers: ['pyproject.toml', 'requirements.txt', 'setup.py', 'Pipfile'],
  detect: (root) => hasAny(root, 'pyproject.toml', 'requirements.txt', 'setup.py', 'Pipfile'),
  commands: (root) => {
    const poetry = has(root, 'poetry.lock');
    const prefix = poetry ? 'poetry run ' : '';
    return {
      install: poetry ? 'poetry install' : has(root, 'requirements.txt') ? 'pip install -r requirements.txt' : 'pip install -e .',
      build: null,
      unitTest: `${prefix}pytest -q`,
      integrationTest: null,
      typecheck: has(root, 'mypy.ini') || /mypy/.test(safeRead(path.join(root, 'pyproject.toml'))) ? `${prefix}mypy .` : null,
      lint: /ruff/.test(safeRead(path.join(root, 'pyproject.toml'))) ? `${prefix}ruff check .` : null,
    };
  },
  protectedPaths: () => ['pyproject.toml', 'poetry.lock', 'requirements.txt', '.github/', 'alembic/versions/'],
  sourceGlobs: () => ['src/**', '**/*.py'],
  testGlobs: () => ['tests/**', 'test/**', '**/test_*.py', '**/*_test.py'],
};

const mavenAdapter: ProjectAdapter = {
  id: 'maven', name: 'Java (Maven)', priority: 60,
  markers: ['pom.xml'],
  detect: (root) => has(root, 'pom.xml'),
  commands: (root) => {
    const mvn = has(root, 'mvnw') ? './mvnw' : 'mvn';
    return { install: `${mvn} -q -B dependency:go-offline`, build: `${mvn} -q -B compile`,
      unitTest: `${mvn} -q -B test`, integrationTest: `${mvn} -q -B verify`,
      typecheck: `${mvn} -q -B compile`, lint: null };
  },
  protectedPaths: () => ['pom.xml', '.github/', 'src/main/resources/db/'],
  sourceGlobs: () => ['src/main/**'],
  testGlobs: () => ['src/test/**'],
};

const gradleAdapter: ProjectAdapter = {
  id: 'gradle', name: 'Java / Kotlin (Gradle)', priority: 60,
  markers: ['build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts'],
  detect: (root) => hasAny(root, 'build.gradle', 'build.gradle.kts'),
  commands: (root) => {
    const g = has(root, 'gradlew') ? './gradlew' : 'gradle';
    return { install: null, build: `${g} assemble`, unitTest: `${g} test`,
      integrationTest: `${g} check`, typecheck: `${g} compileJava`, lint: null };
  },
  protectedPaths: () => ['build.gradle', 'build.gradle.kts', 'gradle/wrapper/', '.github/'],
  sourceGlobs: () => ['src/main/**'],
  testGlobs: () => ['src/test/**'],
};

const goAdapter: ProjectAdapter = {
  id: 'go', name: 'Go', priority: 60,
  markers: ['go.mod'],
  detect: (root) => has(root, 'go.mod'),
  commands: () => ({ install: 'go mod download', build: 'go build ./...', unitTest: 'go test ./...',
    integrationTest: 'go test -tags=integration ./...', typecheck: 'go vet ./...', lint: null }),
  protectedPaths: () => ['go.mod', 'go.sum', '.github/'],
  sourceGlobs: () => ['**/*.go'],
  testGlobs: () => ['**/*_test.go'],
};

const rustAdapter: ProjectAdapter = {
  id: 'rust', name: 'Rust (Cargo)', priority: 60,
  markers: ['Cargo.toml'],
  detect: (root) => has(root, 'Cargo.toml'),
  commands: () => ({ install: 'cargo fetch', build: 'cargo build', unitTest: 'cargo test',
    integrationTest: 'cargo test --tests', typecheck: 'cargo check', lint: 'cargo clippy -- -D warnings' }),
  protectedPaths: () => ['Cargo.toml', 'Cargo.lock', '.github/'],
  sourceGlobs: () => ['src/**'],
  testGlobs: () => ['tests/**', 'src/**/*test*'],
};

/** The fallback: a git repository we can still operate on, with no test story. */
const genericAdapter: ProjectAdapter = {
  id: 'generic', name: 'Generic Git repository', priority: 0,
  markers: ['.git'],
  detect: (root) => fs.existsSync(path.join(root, '.git')),
  commands: () => ({ install: null, build: null, unitTest: null, integrationTest: null, typecheck: null, lint: null }),
  protectedPaths: () => ['.github/', '.gitignore'],
  sourceGlobs: () => ['**'],
  testGlobs: () => [],
};

function safeRead(f: string): string {
  try { return fs.readFileSync(f, 'utf8'); } catch { return ''; }
}

export const ADAPTERS: ProjectAdapter[] = [
  mavenAdapter, gradleAdapter, goAdapter, rustAdapter, nodeAdapter, pythonAdapter, genericAdapter,
];

export interface Detection {
  primary: ProjectAdapter;
  all: ProjectAdapter[];
  markersFound: string[];
  isGitRepo: boolean;
  packageManager?: string;
}

/**
 * Detects the project type without executing anything from the repository.
 * Polyglot repositories are normal, so every match is reported and the highest
 * priority one becomes primary.
 */
export function detectProject(root: string): Detection {
  const all = ADAPTERS.filter((a) => a.id !== 'generic' && a.detect(root))
    .sort((a, b) => b.priority - a.priority);
  const markersFound: string[] = [];
  for (const a of ADAPTERS) for (const m of a.markers) {
    if (fs.existsSync(path.join(root, m)) && !markersFound.includes(m)) markersFound.push(m);
  }
  const primary = all[0] ?? genericAdapter;
  return {
    primary, all: all.length ? all : [genericAdapter], markersFound,
    isGitRepo: fs.existsSync(path.join(root, '.git')),
    ...(primary.id === 'node' ? { packageManager: nodePackageManager(root) } : {}),
  };
}

export function adapterById(id: string): ProjectAdapter | null {
  return ADAPTERS.find((a) => a.id === id) ?? null;
}
