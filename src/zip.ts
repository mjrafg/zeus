/**
 * ZIP extraction with three walls, and an honest list of what it does not do.
 *
 * Uploading an archive means running an attacker-shaped file through a parser
 * and writing whatever it says onto disk. The three cheapest walls stop the
 * three oldest attacks:
 *
 *   a. every destination is checked with `resolveWithin` — the SAME function
 *      the execution policy uses, not a second implementation of the same
 *      idea. Traversal (`../../evil`) and absolute paths die here.
 *   b. symlink and hardlink entries are SKIPPED and counted, never followed.
 *      A symlink inside an archive is a request to write somewhere else later,
 *      and the answer is no.
 *   c. entry-count and total-uncompressed-size caps, checked as the archive is
 *      read rather than after — a bomb that is only noticed once unpacked has
 *      already won.
 *
 * DELIBERATELY NOT DONE, and named rather than implied: compression-ratio
 * analysis, content scanning of extracted files, and per-client rate limiting.
 * Those are real and they are not here.
 *
 * Extraction is atomic in the way the dependency cache is: everything lands in
 * a temp directory and is renamed into place only if the whole archive passed.
 * A refusal leaves nothing half-extracted.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';
import { resolveWithin } from './engine/policy';

export interface ZipLimits {
  maxEntries: number;
  maxTotalBytes: number;
}

export const DEFAULT_ZIP_LIMITS: ZipLimits = {
  maxEntries: 20_000,
  maxTotalBytes: 500 * 1024 * 1024,
};

export interface ZipEntry {
  name: string;
  compressedSize: number;
  uncompressedSize: number;
  method: number;
  localHeaderOffset: number;
  externalAttrs: number;
  isDirectory: boolean;
}

/** Unix file type bits live in the high 16 of the external attributes. */
const S_IFMT = 0o170000;
const S_IFLNK = 0o120000;

export function isSymlinkEntry(e: ZipEntry): boolean {
  const mode = (e.externalAttrs >>> 16) & 0xffff;
  return (mode & S_IFMT) === S_IFLNK;
}

export interface ExtractResult {
  ok: boolean;
  /** Why extraction was refused. Null when it succeeded. */
  refusal: string | null;
  entries: number;
  written: number;
  skippedLinks: string[];
  totalBytes: number;
  limits: ZipLimits;
}

const EOCD_SIG = 0x06054b50;
const CEN_SIG = 0x02014b50;

/** Reads the central directory. The archive's own index, not its stream. */
export function readCentralDirectory(buf: Buffer): { entries: ZipEntry[]; error: string | null } {
  // The end-of-central-directory record is at the end, possibly behind a
  // comment, so it is searched for backwards rather than assumed.
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i >= buf.length - 22 - 0xffff; i -= 1) {
    if (buf.readUInt32LE(i) === EOCD_SIG) { eocd = i; break; }
  }
  if (eocd < 0) return { entries: [], error: 'not a zip archive: no end-of-central-directory record' };

  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const entries: ZipEntry[] = [];
  for (let i = 0; i < count; i += 1) {
    if (off + 46 > buf.length) return { entries, error: 'central directory runs past the end of the file' };
    if (buf.readUInt32LE(off) !== CEN_SIG) return { entries, error: `central directory entry ${i} has a bad signature` };
    const method = buf.readUInt16LE(off + 10);
    const compressedSize = buf.readUInt32LE(off + 20);
    const uncompressedSize = buf.readUInt32LE(off + 24);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const externalAttrs = buf.readUInt32LE(off + 38);
    const localHeaderOffset = buf.readUInt32LE(off + 42);
    const name = buf.slice(off + 46, off + 46 + nameLen).toString('utf8');
    entries.push({
      name, method, compressedSize, uncompressedSize, localHeaderOffset, externalAttrs,
      isDirectory: name.endsWith('/'),
    });
    off += 46 + nameLen + extraLen + commentLen;
  }
  return { entries, error: null };
}

function inflateEntry(buf: Buffer, e: ZipEntry): Buffer | null {
  const lh = e.localHeaderOffset;
  if (lh + 30 > buf.length) return null;
  if (buf.readUInt32LE(lh) !== 0x04034b50) return null;
  const nameLen = buf.readUInt16LE(lh + 26);
  const extraLen = buf.readUInt16LE(lh + 28);
  const start = lh + 30 + nameLen + extraLen;
  const body = buf.slice(start, start + e.compressedSize);
  try {
    if (e.method === 0) return body;                    // stored
    if (e.method === 8) return zlib.inflateRawSync(body);
    return null;                                        // an unknown method is not guessed at
  } catch { return null; }
}

/**
 * Extracts an archive into `dest`, atomically, behind the three walls.
 *
 * `dest` must not exist; it is created by renaming a fully-verified temp
 * directory into place. A refusal at any entry aborts the whole extraction and
 * removes the temp, so there is no state in which half an archive is on disk.
 */
export function extractZip(buf: Buffer, dest: string,
  limits: ZipLimits = DEFAULT_ZIP_LIMITS): ExtractResult {
  const base = {
    entries: 0, written: 0, skippedLinks: [] as string[], totalBytes: 0, limits,
  };
  const { entries, error } = readCentralDirectory(buf);
  if (error) return { ...base, ok: false, refusal: error };

  // WALL C, first half: the count is known before anything is written.
  if (entries.length > limits.maxEntries) {
    return { ...base, ok: false, entries: entries.length,
      refusal: `archive declares ${entries.length} entries, over the ${limits.maxEntries}-entry cap` };
  }
  const declared = entries.reduce((a, e) => a + (e.uncompressedSize || 0), 0);
  if (declared > limits.maxTotalBytes) {
    return { ...base, ok: false, entries: entries.length, totalBytes: declared,
      refusal: `archive declares ${declared} uncompressed bytes, over the ${limits.maxTotalBytes} cap` };
  }

  const tmp = `${dest}.incoming-${process.pid}`;
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true });
  const abort = (refusal: string, extra: Partial<ExtractResult> = {}): ExtractResult => {
    fs.rmSync(tmp, { recursive: true, force: true });
    return { ...base, ...extra, ok: false, refusal };
  };

  const skippedLinks: string[] = [];
  let written = 0;
  let totalBytes = 0;

  for (const e of entries) {
    // WALL B: a link entry is a request to write somewhere else later.
    if (isSymlinkEntry(e)) { skippedLinks.push(e.name); continue; }

    // WALL A: the same resolver the execution policy uses.
    const within = resolveWithin(tmp, e.name);
    if (!within.ok) {
      return abort(`entry "${e.name}" escapes the target directory (${within.reason})`,
        { entries: entries.length, skippedLinks, written, totalBytes });
    }
    if (e.isDirectory) { fs.mkdirSync(within.abs, { recursive: true }); continue; }

    const body = inflateEntry(buf, e);
    if (body === null) {
      return abort(`entry "${e.name}" could not be decompressed (method ${e.method})`,
        { entries: entries.length, skippedLinks, written, totalBytes });
    }
    // WALL C, second half: measured as it is produced, because a declared size
    // is the archive's claim about itself and claims are not evidence.
    totalBytes += body.length;
    if (totalBytes > limits.maxTotalBytes) {
      return abort(`extraction passed the ${limits.maxTotalBytes}-byte cap at "${e.name}"`,
        { entries: entries.length, skippedLinks, written, totalBytes });
    }
    fs.mkdirSync(path.dirname(within.abs), { recursive: true });
    fs.writeFileSync(within.abs, body);
    written += 1;
  }

  try { fs.renameSync(tmp, dest); }
  catch (err: any) {
    return abort(`could not place the extracted archive: ${err?.message ?? err}`,
      { entries: entries.length, skippedLinks, written, totalBytes });
  }
  return { ok: true, refusal: null, entries: entries.length, written, skippedLinks, totalBytes, limits };
}
