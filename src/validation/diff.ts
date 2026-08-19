/**
 * Unified-diff parsing, down to the hunk.
 *
 * Tier selection is per-hunk rather than per-file because that is the level a
 * diff can be gamed at: one file, one honest paragraph of documentation, one
 * quiet change to a session helper. A file-level view sees "one file touched"
 * and can be argued into the fast path. A hunk-level view cannot.
 *
 * The parser is intentionally forgiving about diff dialects and unforgiving
 * about ambiguity: anything it cannot read confidently is reported as such,
 * and the caller treats that as a reason to be careful.
 */

export type ChangeStatus = 'added' | 'modified' | 'deleted' | 'renamed';

export interface Hunk {
  /** Index within the file's hunk list, so telemetry can point at one. */
  index: number;
  header: string;
  added: string[];
  removed: string[];
  /** True when every changed line is a comment or blank, for this language. */
  commentOnly: boolean;
}

export interface FileDiff {
  path: string;
  /** Present for renames; the path the file had before. */
  oldPath?: string;
  status: ChangeStatus;
  binary: boolean;
  hunks: Hunk[];
}

export interface ParsedDiff {
  files: FileDiff[];
  /** True when the input could not be parsed as a unified diff at all. */
  unparsed: boolean;
}

interface CommentSyntax { line: string[]; blockOpen?: string; blockClose?: string }

const BY_EXTENSION: Array<{ re: RegExp; syntax: CommentSyntax }> = [
  { re: /\.(ts|tsx|js|jsx|mjs|cjs|java|kt|scala|go|rs|c|h|cc|cpp|hpp|cs|swift|php|dart)$/i,
    syntax: { line: ['//'], blockOpen: '/*', blockClose: '*/' } },
  { re: /\.(py|rb|sh|bash|zsh|ya?ml|toml|pl|r|tf|cfg|ini|conf)$/i, syntax: { line: ['#'] } },
  { re: /\.(sql|hs|lua|elm)$/i, syntax: { line: ['--'] } },
  { re: /\.(html|xml|md|mdx|vue|svelte)$/i, syntax: { line: [], blockOpen: '<!--', blockClose: '-->' } },
  { re: /\.(css|scss|less|sass)$/i, syntax: { line: ['//'], blockOpen: '/*', blockClose: '*/' } },
];

function syntaxFor(path: string): CommentSyntax | null {
  return BY_EXTENSION.find((e) => e.re.test(path))?.syntax ?? null;
}

/**
 * True when every changed line is blank or a comment.
 *
 * Deliberately conservative. Block comments are approximated by checking that
 * a line looks like comment continuation; an unrecognised language, a manifest,
 * or anything the check is unsure about returns false, because a wrong "yes"
 * here is what lets a real change take the fast path.
 */
export function isCommentOnly(path: string, lines: string[]): boolean {
  if (!lines.length) return false;
  const s = syntaxFor(path);
  if (!s) return false;
  return lines.every((raw) => {
    const t = raw.trim();
    if (!t) return true;
    if (s.line.some((p) => t.startsWith(p))) return true;
    if (s.blockOpen && (t.startsWith(s.blockOpen) || t.startsWith('*') || t === s.blockClose)) return true;
    if (s.blockClose && t.endsWith(s.blockClose) && s.blockOpen && t.includes(s.blockOpen)) return true;
    return false;
  });
}

const FILE_HEADER = /^diff --git a\/(.+?) b\/(.+)$/;
const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/;

/**
 * Parses `git diff` output.
 *
 * Accepts the `--stat -p` form the engine already produces: the stat preamble
 * is skipped, and parsing begins at the first `diff --git`.
 */
export function parseDiff(text: string): ParsedDiff {
  const files: FileDiff[] = [];
  if (!text || !/^diff --git /m.test(text)) {
    return { files, unparsed: !!text.trim() };
  }

  const lines = text.split('\n');
  let current: FileDiff | null = null;
  let hunk: Hunk | null = null;

  const closeHunk = () => {
    if (current && hunk) {
      hunk.commentOnly = isCommentOnly(current.path, [...hunk.added, ...hunk.removed]);
      current.hunks.push(hunk);
    }
    hunk = null;
  };
  const closeFile = () => { closeHunk(); if (current) files.push(current); current = null; };

  for (const line of lines) {
    const header = FILE_HEADER.exec(line);
    if (header) {
      closeFile();
      current = { path: header[2], status: 'modified', binary: false, hunks: [] };
      if (header[1] !== header[2]) { current.oldPath = header[1]; current.status = 'renamed'; }
      continue;
    }
    if (!current) continue;

    if (line.startsWith('new file mode')) { current.status = 'added'; continue; }
    if (line.startsWith('deleted file mode')) { current.status = 'deleted'; continue; }
    if (line.startsWith('rename from ')) { current.oldPath = line.slice('rename from '.length); current.status = 'renamed'; continue; }
    if (line.startsWith('rename to ')) { current.path = line.slice('rename to '.length); current.status = 'renamed'; continue; }
    if (line.startsWith('Binary files ') || line.startsWith('GIT binary patch')) { current.binary = true; continue; }
    if (line.startsWith('--- ') || line.startsWith('+++ ')) continue;

    if (HUNK_HEADER.test(line)) {
      closeHunk();
      hunk = { index: current.hunks.length, header: line, added: [], removed: [], commentOnly: false };
      continue;
    }
    if (!hunk) continue;
    if (line.startsWith('+')) hunk.added.push(line.slice(1));
    else if (line.startsWith('-')) hunk.removed.push(line.slice(1));
  }
  closeFile();

  return { files, unparsed: false };
}

/** Every path the diff touches, including the pre-rename name. */
export function touchedPaths(d: ParsedDiff): string[] {
  const out = new Set<string>();
  for (const f of d.files) { out.add(f.path); if (f.oldPath) out.add(f.oldPath); }
  return [...out];
}

/**
 * A file with no readable hunks still counts as a change.
 *
 * Binary files, mode-only changes and diffs elided by size have nothing to
 * classify line by line, so they get one synthetic hunk. Treating them as
 * "zero hunks, therefore nothing risky" is exactly the gap worth closing.
 */
export function hunksOf(f: FileDiff): Hunk[] {
  if (f.hunks.length) return f.hunks;
  return [{
    index: 0,
    header: f.binary ? '(binary change)' : `(${f.status}, no textual hunks)`,
    added: [], removed: [], commentOnly: false,
  }];
}
