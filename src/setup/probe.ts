/**
 * The seam between setup logic and the machine.
 *
 * Everything the wizard learns about the host — which binaries exist, what
 * they print, which files are present — goes through this interface, so the
 * whole flow can be exercised against a fake machine. Setup code that shells
 * out directly cannot be tested for the cases that matter most: a missing
 * package manager, an unauthenticated provider, a failed install.
 */

export interface RunResult { code: number | null; stdout: string; stderr: string }

export interface SystemProbe {
  platform(): string;
  arch(): string;
  /** Distribution id from /etc/os-release, when there is one. */
  distro(): { id: string; name: string; version: string } | null;
  shell(): string;
  user(): string;
  homedir(): string;
  pathEntries(): string[];
  which(bin: string): string | null;
  exists(p: string): boolean;
  /** Bounded, non-interactive command execution. */
  run(cmd: string, args: string[], opts?: { timeoutMs?: number; input?: string }): RunResult;
  /** Interactive execution that inherits the terminal (provider login flows). */
  runInteractive(cmd: string, args: string[]): RunResult;
  isTTY(): boolean;
}

export class RealProbe implements SystemProbe {
  private os = require('os');
  private fs = require('fs');
  private cp = require('child_process');

  platform(): string { return process.platform; }
  arch(): string { return process.arch; }

  distro(): { id: string; name: string; version: string } | null {
    try {
      const txt = this.fs.readFileSync('/etc/os-release', 'utf8') as string;
      const get = (k: string) => (new RegExp(`^${k}=\"?([^\"\\n]+)\"?`, 'm').exec(txt)?.[1] ?? '');
      const id = get('ID');
      return id ? { id, name: get('NAME') || id, version: get('VERSION_ID') } : null;
    } catch { return null; }
  }

  shell(): string { return (process.env.SHELL ?? '').split('/').pop() || 'unknown'; }
  user(): string { try { return this.os.userInfo().username; } catch { return process.env.USER ?? 'unknown'; } }
  homedir(): string { return this.os.homedir(); }
  pathEntries(): string[] { return (process.env.PATH ?? '').split(':').filter(Boolean); }

  which(bin: string): string | null {
    const r = this.cp.spawnSync('sh', ['-c', `command -v ${bin}`], { encoding: 'utf8', timeout: 5_000 });
    return (r.stdout ?? '').trim() || null;
  }

  exists(p: string): boolean { try { return this.fs.existsSync(p); } catch { return false; } }

  run(cmd: string, args: string[], opts: { timeoutMs?: number; input?: string } = {}): RunResult {
    const r = this.cp.spawnSync(cmd, args, {
      encoding: 'utf8', timeout: opts.timeoutMs ?? 120_000, input: opts.input,
    });
    return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  }

  /**
   * Hands the terminal to the child. Provider sign-in flows print their own
   * URLs and codes; relaying them through a pipe is how headless logins get
   * mangled, so the child owns stdio for the duration.
   */
  runInteractive(cmd: string, args: string[]): RunResult {
    const r = this.cp.spawnSync(cmd, args, { stdio: 'inherit', timeout: 15 * 60_000 });
    return { code: r.status, stdout: '', stderr: '' };
  }

  isTTY(): boolean { return Boolean(process.stdin.isTTY && process.stdout.isTTY); }
}
