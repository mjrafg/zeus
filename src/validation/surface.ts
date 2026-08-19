/**
 * What a changed path *is*, and how much damage changing it can do.
 *
 * Everything downstream — tier selection, escalation, the reviewer's attention
 * — keys off this classification, so it is deliberately boring: ordered path
 * patterns, no heuristics that drift, no model in the loop. A surface Zeus
 * cannot recognise is `unknown`, which is treated as a reason for caution
 * rather than as permission to go fast.
 *
 * Two properties are independent of the primary label and are computed
 * separately, because a path can be both:
 *
 *   * `testSurface` — the change can alter what counts as passing;
 *   * `highRisk`    — the blast radius is wide even for a small edit.
 *
 * `test/auth.spec.ts` is both. Collapsing that into one label would lose
 * whichever half happened to lose the tie.
 */

export type Surface =
  | 'documentation'
  | 'ui-copy'
  | 'ui'
  | 'test'
  | 'test-config'
  | 'fixture'
  | 'snapshot'
  | 'auth-session'
  | 'schema-migration'
  | 'dependency-manifest'
  | 'ci-build'
  | 'shared-core'
  | 'application'
  | 'unknown';

/** Surfaces whose modification changes what "passing" means. */
export const TEST_SURFACES: Surface[] = ['test', 'test-config', 'fixture', 'snapshot'];

/** Surfaces where a small edit can have consequences far from the diff. */
export const HIGH_RISK_SURFACES: Surface[] = [
  'auth-session', 'schema-migration', 'dependency-manifest', 'ci-build', 'shared-core',
];

export interface SurfaceClassification {
  path: string;
  surface: Surface;
  /** True when the path can change the definition of success. */
  testSurface: boolean;
  /** True when the path is one of the known-dangerous surfaces. */
  highRisk: boolean;
  /** Why this classification was reached. Shown in telemetry, not inferred. */
  reason: string;
}

/** A path segment matcher, so `AUTHORS.md` is not read as authentication. */
function seg(...words: string[]): RegExp {
  return new RegExp(`(^|[\\/._-])(${words.join('|')})([\\/._-]|$)`, 'i');
}

interface Rule { surface: Surface; re: RegExp; reason: string }

/**
 * Ordered, most specific first. The first match wins for the primary label;
 * the test/high-risk flags are computed over ALL matches.
 */
const RULES: Rule[] = [
  // --- dependency manifests and lockfiles ---------------------------------
  { surface: 'dependency-manifest', reason: 'dependency manifest or lockfile',
    re: /(^|\/)(package(-lock)?\.json|pnpm-lock\.yaml|yarn\.lock|npm-shrinkwrap\.json|Cargo\.(toml|lock)|go\.(mod|sum)|requirements[^/]*\.txt|Pipfile(\.lock)?|poetry\.lock|pyproject\.toml|Gemfile(\.lock)?|pom\.xml|build\.gradle(\.kts)?|composer\.(json|lock)|mix\.exs)$/i },

  // --- CI, build and deployment configuration ------------------------------
  // Two shapes, kept apart on purpose: directory prefixes must NOT be anchored
  // at the end, or a workflow file inside .github/workflows/ matches nothing.
  { surface: 'ci-build', reason: 'CI, build or deployment configuration',
    re: /(^|\/)(\.github\/workflows|\.circleci|\.buildkite|\.gitlab|k8s|kubernetes|helm|terraform|deploy)\/|(^|\/)(\.gitlab-ci\.ya?ml|Jenkinsfile|azure-pipelines[^/]*\.ya?ml|Dockerfile[^/]*|docker-compose[^/]*\.ya?ml|Makefile|CMakeLists\.txt)$|\.tf$/i },

  // --- schema and data migrations ------------------------------------------
  { surface: 'schema-migration', reason: 'database schema or migration',
    re: /(^|\/)(migrations?|migrate|alembic|liquibase|flyway)\/|(^|\/)schema\.(prisma|sql|rb)$|\.sql$/i },

  // --- test configuration ---------------------------------------------------
  { surface: 'test-config', reason: 'test runner configuration',
    re: /(^|\/)(jest|vitest|playwright|cypress|karma|ava|wdio)\.config\.[cm]?[jt]s$|(^|\/)(pytest\.ini|tox\.ini|conftest\.py|\.mocharc[^/]*|phpunit\.xml(\.dist)?|jest\.setup\.[cm]?[jt]s)$/i },

  // --- snapshots and fixtures ----------------------------------------------
  { surface: 'snapshot', reason: 'test snapshot',
    re: /(^|\/)__snapshots__\/|\.snap$|\.approved\.[a-z]+$/i },
  { surface: 'fixture', reason: 'test fixture data',
    re: /(^|\/)(fixtures?|__fixtures__|testdata|test-data|golden)\//i },

  // --- tests ----------------------------------------------------------------
  { surface: 'test', reason: 'test source',
    re: /(^|\/)(tests?|specs?|__tests__|e2e|it)\/|(\.|_|-)(test|spec)\.[a-z]+$|(^|\/)test_[^/]+\.py$|[^/]+_test\.(go|py|rb)$|[^/]+Test(s)?\.(java|kt|cs)$/i },

  // --- authentication, session and secrets ----------------------------------
  { surface: 'auth-session', reason: 'authentication, session or credential handling',
    re: seg('auth', 'authn', 'authz', 'authentication', 'authorization', 'session', 'sessions',
      'login', 'logout', 'signin', 'signup', 'oauth', 'oidc', 'saml', 'jwt', 'token', 'tokens',
      'credential', 'credentials', 'password', 'passwd', 'secret', 'secrets',
      'rbac', 'acl', 'permission', 'permissions', 'crypto', 'cipher', 'keystore') },

  // --- widely depended-upon modules -----------------------------------------
  { surface: 'shared-core', reason: 'shared or core module many things depend on',
    re: /(^|\/)(core|shared|common|lib|base|kernel|platform|infra|infrastructure)\//i },

  // --- documentation ---------------------------------------------------------
  { surface: 'documentation', reason: 'documentation',
    re: /(^|\/)(docs?|documentation)\/|\.(md|mdx|rst|adoc|txt)$|(^|\/)(LICENSE|NOTICE|CHANGELOG|AUTHORS|CONTRIBUTING|CODE_OF_CONDUCT|SECURITY)(\.[a-z]+)?$/i },

  // --- user-visible copy and translations -----------------------------------
  { surface: 'ui-copy', reason: 'user-facing copy or translation',
    re: /(^|\/)(locales?|i18n|intl|translations?|lang)\/|\.(po|pot|xliff|arb)$/i },

  // --- presentation ----------------------------------------------------------
  { surface: 'ui', reason: 'presentation layer',
    re: /(^|\/)(components?|views?|pages?|templates?|styles?|assets?|public|static)\/|\.(css|scss|sass|less|html|svg|vue|svelte)$/i },
];

/**
 * Classifies one path.
 *
 * An empty or obviously non-path string is `unknown` rather than
 * `application`: guessing is what this module exists to avoid.
 */
export function classifyPath(p: string): SurfaceClassification {
  const path = p.trim().replace(/^\.\//, '');
  if (!path) {
    return { path: p, surface: 'unknown', testSurface: false, highRisk: false, reason: 'empty path' };
  }

  const matched = RULES.filter((r) => r.re.test(path));
  const primary = matched[0];

  // Both flags consider every match, not just the winner: a test file under an
  // auth module is a test surface AND high risk, and must be treated as both.
  const testSurface = matched.some((m) => TEST_SURFACES.includes(m.surface));
  const highRisk = matched.some((m) => HIGH_RISK_SURFACES.includes(m.surface));

  if (!primary) {
    // A recognisable source file with no special meaning is ordinary
    // application code; anything else is genuinely unknown.
    const looksLikeSource = /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|rb|java|kt|cs|php|swift|scala|ex|c|h|cc|cpp|hpp)$/i.test(path);
    return {
      path, surface: looksLikeSource ? 'application' : 'unknown',
      testSurface: false, highRisk: false,
      reason: looksLikeSource ? 'application source' : 'unrecognised path',
    };
  }

  const extra = matched.slice(1).map((m) => m.surface);
  return {
    path, surface: primary.surface, testSurface, highRisk,
    reason: extra.length ? `${primary.reason} (also: ${extra.join(', ')})` : primary.reason,
  };
}
