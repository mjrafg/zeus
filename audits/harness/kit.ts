/**
 * Shared tooling for the audit probes.
 *
 * Probes have to build real repositories, run real processes and inspect real
 * state, because a probe that mocks the thing it is auditing proves nothing.
 * This module keeps that machinery in one place so a probe reads as the
 * question it is asking rather than as setup.
 */

import * as fs from 'fs';
import * as path from 'path';
import { execFileSync, spawnSync } from 'child_process';

export const GIT_ID = ['-c', 'user.email=audit@zeus.local', '-c', 'user.name=zeus-audit'];

export function git(cwd: string, args: string[]): string {
  try {
    return execFileSync('git', ['-C', cwd, ...GIT_ID, ...args], {
      encoding: 'utf8', timeout: 120_000, maxBuffer: 32 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e: any) {
    return `${String(e?.stdout ?? '')}${String(e?.stderr ?? '')}`;
  }
}

/** A throwaway git repository with a first commit. */
export function repo(root: string, files: Record<string, string>): string {
  fs.mkdirSync(root, { recursive: true });
  for (const [rel, body] of Object.entries(files)) {
    const f = path.join(root, rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, body);
  }
  git(root, ['init', '-q', '-b', 'main']);
  git(root, ['add', '-A']);
  git(root, ['commit', '-qm', 'base']);
  return root;
}

export function write(file: string, body: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
}

export function read(file: string): string {
  try { return fs.readFileSync(file, 'utf8'); } catch { return ''; }
}

/** Runs a command and captures everything, without throwing. */
export function run(cmd: string, args: string[], opts: { cwd?: string; timeoutMs?: number; env?: NodeJS.ProcessEnv } = {}) {
  const r = spawnSync(cmd, args, {
    cwd: opts.cwd, encoding: 'utf8', timeout: opts.timeoutMs ?? 120_000,
    env: opts.env, maxBuffer: 32 * 1024 * 1024,
  });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', signal: r.signal };
}

/** Truncates observed output so a report stays readable. */
export function evidence(s: string, max = 800): string {
  const t = s.replace(/\[[0-9;]*m/g, '').trimEnd();
  return t.length > max ? `${t.slice(0, max)}\n… (${t.length - max} more bytes)` : t;
}

/** A tiny table for observed-vs-expected evidence. */
export function compare(rows: Array<[string, string]>): string {
  const w = Math.max(...rows.map(([k]) => k.length));
  return rows.map(([k, v]) => `  ${k.padEnd(w)} : ${v}`).join('\n');
}

/**
 * Imports a module from the checkout under audit rather than from the running
 * runtime. The audit must reason about the candidate's code, not its own.
 */
export function fromAudit<T = any>(auditRoot: string, rel: string): T {
  // eslint-disable-next-line
  return require(path.join(auditRoot, 'src', rel)) as T;
}

export function exists(p: string): boolean {
  try { fs.statSync(p); return true; } catch { return false; }
}
