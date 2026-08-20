/**
 * Product-boundary regression test.
 *
 * Zeus is an independent product. Nothing user-facing — documentation, source,
 * CLI output, configuration defaults or the release artifact — may carry
 * identifiers from earlier, unrelated work.
 *
 * The list of identifiers is deliberately **not in this repository**. Writing
 * the strings down here would put back exactly what the check exists to keep
 * out. A maintainer points `ZEUS_BOUNDARY_RULES` at a private JSON file; without
 * it the identifier scan reports itself as not configured rather than passing
 * silently, and every structural check still runs.
 *
 * Rule file shape:
 *   { "identifiers": ["..."], "productFacingPaths": ["..."], "excludedFromScan": ["..."] }
 */
import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { check, section } from './harness';

const REPO = path.resolve(__dirname, '..');
const RULES_ENV = 'ZEUS_BOUNDARY_RULES';

interface Rules { identifiers: string[]; productFacingPaths: string[]; excludedFromScan: string[] }

function rules(): Rules | null {
  const p = process.env[RULES_ENV];
  if (!p) return null;
  try {
    const r = JSON.parse(fs.readFileSync(p, 'utf8')) as Rules;
    return Array.isArray(r.identifiers) && r.identifiers.length ? r : null;
  } catch { return null; }
}

function walk(dir: string, exclude: string[], out: string[] = []): string[] {
  let entries: fs.Dirent[] = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (exclude.includes(e.name)) continue;
    const f = path.join(dir, e.name);
    if (e.isDirectory()) walk(f, exclude, out);
    else if (/\.(ts|js|json|md|sh|ya?ml|html)$/.test(e.name) || !path.extname(e.name)) out.push(f);
  }
  return out;
}

/** Files the product ships or shows to a user. */
function productFiles(r: Rules): string[] {
  const files: string[] = [];
  for (const p of r.productFacingPaths) {
    const abs = path.join(REPO, p);
    if (!fs.existsSync(abs)) continue;
    if (fs.statSync(abs).isDirectory()) files.push(...walk(abs, r.excludedFromScan));
    else files.push(abs);
  }
  return files;
}

function scan(files: string[], identifiers: string[], base = REPO): Array<{ file: string; id: string; line: number }> {
  const hits: Array<{ file: string; id: string; line: number }> = [];
  for (const f of files) {
    let text: string;
    try { text = fs.readFileSync(f, 'utf8'); } catch { continue; }
    const lower = text.toLowerCase();
    for (const id of identifiers) {
      if (!lower.includes(id.toLowerCase())) continue;
      const line = text.split('\n').findIndex((l) => l.toLowerCase().includes(id.toLowerCase())) + 1;
      hits.push({ file: path.relative(base, f), id, line });
    }
  }
  return hits;
}

export async function boundarySuite(): Promise<void> {
  section('product boundary: this repository is only the product');

  // Structural checks. These hold whether or not a private rule set is present,
  // because they are about what is here rather than about what it is called.
  const strays = ['internal', 'reference', 'tools', 'legacy', 'prototype']
    .filter((d) => fs.existsSync(path.join(REPO, d)));
  check('PB1: the repository carries no archive, prototype or legacy tree',
    strays.length === 0, strays.join(', '));

  const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'));
  check('PB2: the package ships by allowlist, and only runtime paths are on it',
    Array.isArray(pkg.files) &&
    pkg.files.every((f: string) => ['bin/', 'dist/', 'src/', 'install.sh', 'README.md', 'LICENSE'].includes(f)),
    JSON.stringify(pkg.files));

  // Resolve each relative import rather than pattern-matching it: `../config`
  // from src/engine/ is fine, `../../anything` is not, and only resolution
  // tells them apart.
  const srcRoot = path.join(REPO, 'src');
  const escaping: string[] = [];
  for (const f of walk(srcRoot, [])) {
    const text = fs.readFileSync(f, 'utf8');
    for (const m of text.matchAll(/(?:from|require\()\s*['"](\.[^'"]*)['"]/g)) {
      const target = path.resolve(path.dirname(f), m[1]);
      if (!target.startsWith(`${srcRoot}${path.sep}`)) {
        escaping.push(`${path.relative(REPO, f)} → ${m[1]}`);
      }
    }
  }
  check('PB3: no runtime source imports anything outside src/',
    escaping.length === 0, escaping.slice(0, 5).join(', '));

  // Configuration defaults must be generic or adapter-derived — never a path,
  // host or project from the machine this was written on.
  const cfgSrc = fs.readFileSync(path.join(REPO, 'src', 'config.ts'), 'utf8');
  check('PB4: configuration defaults name no specific project, path or domain',
    !/\/srv\/|\/home\/[a-z]/.test(cfgSrc));

  const everything = walk(REPO, ['.git', 'node_modules', 'dist', 'dist-release']);
  const absolutePaths = everything
    .filter((f) => !/test\/(boundary|brand)\.ts$/.test(f))
    .filter((f) => /(^|[^\w])\/(srv|home\/[a-z])\//.test(fs.readFileSync(f, 'utf8')))
    .map((f) => path.relative(REPO, f));
  check('PB5: no file hard-codes a machine-specific absolute path',
    absolutePaths.length === 0, absolutePaths.slice(0, 5).join(', '));

  // Files that legitimately contain credential SHAPES: the detectors themselves
  // and the fixtures that prove they fire. Each is listed rather than pattern-
  // matched, so adding one is a decision somebody made on purpose.
  const CREDENTIAL_FIXTURES = [
    'scripts/package.sh',            // the artifact scanner's own patterns
    'test/boundary.ts',              // this file
    'src/engine/orchestrator.ts',    // redactSecrets(): the shapes it removes
    'audits/harness/lane-c.ts',      // probes that plant synthetic secrets
    'test/audit.ts',                 // regression fixtures for redaction
  ];
  const credentialish = everything
    .filter((f) => !CREDENTIAL_FIXTURES.includes(path.relative(REPO, f)))
    .filter((f) => /BEGIN (RSA |OPENSSH |EC )?PRIVATE KEY|gh[pousr]_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}/
      .test(fs.readFileSync(f, 'utf8')))
    .map((f) => path.relative(REPO, f));
  check('PB6: the working tree carries no credential-shaped content outside the detectors',
    credentialish.length === 0, credentialish.join(', '));
  // The exceptions must earn their place: a listed file that no longer exists,
  // or that stopped being about credentials, is a stale hole in the check.
  const staleExceptions = CREDENTIAL_FIXTURES.filter((f) => {
    const abs = path.join(REPO, f);
    if (!fs.existsSync(abs)) return true;
    return !/redact|credential|secret|PRIVATE KEY|sk-|ghp_|AKIA/i.test(fs.readFileSync(abs, 'utf8'));
  });
  check('PB6b: every credential-fixture exception is still needed',
    staleExceptions.length === 0, staleExceptions.join(', '));

  // Identifier scan. Only runs when a maintainer supplies the private list.
  const r = rules();
  if (!r) {
    check(`PB7: historical-identifier scan (set ${RULES_ENV} to a private rule file to enable)`,
      true, 'not configured — structural checks above still ran');
  } else {
    const files = productFiles(r);
    check('PB7: product-facing files were actually scanned', files.length > 20, `${files.length} files`);
    const hits = scan(files, r.identifiers);
    check('PB8: no product-facing file contains a historical identifier',
      hits.length === 0, hits.slice(0, 5).map((h) => `${h.file}:${h.line} (${h.id})`).join(' | '));
    const runtimeHits = hits.filter((h) => h.file.startsWith('src/') || h.file.startsWith('bin/'));
    check('PB9: the runtime has zero historical coupling', runtimeHits.length === 0);
  }

  // And the built artifact, which is what a user actually receives.
  const relDir = path.join(REPO, 'dist-release');
  const tarball = fs.existsSync(relDir)
    ? fs.readdirSync(relDir).find((f) => f.endsWith('.tar.gz')) : undefined;
  if (!tarball) {
    check('PB10: release artifact scanned (build it with scripts/package.sh to include this check)',
      true, 'skipped — no artifact present');
    return;
  }

  const listing = execFileSync('tar', ['tzf', path.join(relDir, tarball)], { encoding: 'utf8' });
  check('PB10: the artifact contains no archive, prototype or state paths',
    !/internal\/|reference\/|tools\/|\.zeus\/|worktrees\/|node_modules/.test(listing),
    listing.split('\n').filter((l) => /internal|reference|tools/.test(l)).join());

  const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'artifact-scan-'));
  try {
    execFileSync('tar', ['xzf', path.join(relDir, tarball), '-C', tmp]);
    const extracted = walk(tmp, ['node_modules']);

    if (r) {
      const artifactHits = scan(extracted, r.identifiers, tmp);
      check('PB11: no file inside the artifact contains a historical identifier',
        artifactHits.length === 0, artifactHits.slice(0, 5).map((h) => `${h.file} (${h.id})`).join(' | '));
    }

    const secrets = extracted.filter((f) =>
      /BEGIN (RSA |OPENSSH |EC )?PRIVATE KEY|gh[pousr]_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9]{16,}/
        .test(fs.readFileSync(f, 'utf8')));
    check('PB12: the artifact carries no credentials', secrets.length === 0);

    // Stale product branding. Migration and the deprecation shim name the old
    // identity on purpose; everything else must not.
    const brandAllowed = /(src|dist)\/(migrate|config|cli)\.(ts|js)$|bin\/autopilot$|README\.md$|install\.sh$/;
    const stale = extracted
      .filter((f) => !brandAllowed.test(f))
      .filter((f) => /ai-autopilot|AI Autopilot/i.test(fs.readFileSync(f, 'utf8')))
      .map((f) => path.relative(tmp, f));
    check('PB13: the artifact carries no stale product branding', stale.length === 0, stale.slice(0, 5).join(', '));

    check('PB14: the artifact is branded Zeus',
      extracted.filter((f) => /README\.md$|package\.json$/.test(f))
        .every((f) => /zeus/i.test(fs.readFileSync(f, 'utf8'))));
    check('PB15: the artifact ships the AGPL licence',
      extracted.some((f) => path.basename(f) === 'LICENSE'
        && fs.readFileSync(f, 'utf8').includes('GNU AFFERO GENERAL PUBLIC LICENSE')));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
