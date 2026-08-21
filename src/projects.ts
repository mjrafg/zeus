/**
 * A directory of Zeus projects, as an engine capability.
 *
 * The console was single-project because the CLI is: it runs where you stand.
 * Serving several needs a notion of "the projects root", and that notion
 * belongs in the engine rather than in the HTTP layer — the web calls it, the
 * CLI can call it, and neither owns it.
 *
 * A project is a directory containing `.zeus/config.yaml`. Nothing is
 * registered, indexed or cached: the filesystem is the registry, so a project
 * moved or deleted outside Zeus cannot leave a stale entry behind claiming it
 * still exists.
 */

import * as fs from 'fs';
import * as path from 'path';
import { PROJECT_DIR, ProjectConfig, readConfig } from './config';
import { EventStore } from './engine/events';
import { isMissionId } from './mission/types';

export interface ProjectSummary {
  projectId: string;
  /** Directory name under the root — what the API addresses it by. */
  slug: string;
  root: string;
  adapter: string;
  missions: number;
  tasks: number;
  /** ISO timestamp of the newest event in any of its logs, or null. */
  lastActivity: string | null;
  configProblems: number;
}

/** Where the projects root lives, unless the operator names another. */
export function defaultProjectsRoot(): string {
  return process.env.ZEUS_PROJECTS_ROOT
    ?? path.join(process.env.HOME ?? process.cwd(), 'zeus-projects');
}

/** Whether a directory is an initialised Zeus project. */
export function isProject(dir: string): boolean {
  try { return fs.statSync(path.join(dir, PROJECT_DIR, 'config.yaml')).isFile(); }
  catch { return false; }
}

function summarize(root: string, slug: string): ProjectSummary | null {
  const dir = path.join(root, slug);
  if (!isProject(dir)) return null;
  let cfg: ProjectConfig | null = null;
  try { cfg = readConfig(dir); } catch { cfg = null; }
  if (!cfg) return null;

  const stateRoot = path.resolve(dir, cfg.paths?.state ?? `${PROJECT_DIR}/state`);
  let missions = 0;
  let tasks = 0;
  let lastActivity: string | null = null;
  try {
    const store = new EventStore(stateRoot);
    for (const id of store.listTasks()) {
      if (isMissionId(id)) missions += 1; else tasks += 1;
      try {
        const events = store.read(id);
        const last = events.length ? events[events.length - 1].ts : null;
        if (last && (!lastActivity || last > lastActivity)) lastActivity = last;
      } catch { /* an unreadable log contributes nothing rather than throwing */ }
    }
  } catch { /* a project with no state yet is still a project */ }

  return {
    projectId: cfg.project?.name ?? slug,
    slug, root: dir,
    adapter: cfg.project?.adapter ?? 'unknown',
    missions, tasks, lastActivity,
    configProblems: 0,
  };
}

/**
 * Every initialised project directly under the root.
 *
 * One level deep on purpose. Recursing would wander into node_modules, task
 * worktrees and the projects of projects, and "how deep does it look" is
 * exactly the kind of question a directory listing should not have.
 */
export function listProjects(root: string): ProjectSummary[] {
  let names: string[] = [];
  try {
    names = fs.readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => e.name);
  } catch { return []; }
  return names
    .map((n) => summarize(root, n))
    .filter((p): p is ProjectSummary => !!p)
    .sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
}

export function projectBySlug(root: string, slug: string): ProjectSummary | null {
  // The slug addresses a directory, so it is checked as one: a slug containing
  // a separator or a parent reference is not a project name, it is an attempt
  // to leave the root.
  if (!slug || slug.includes('/') || slug.includes('\\') || slug.includes('..')) return null;
  return summarize(root, slug);
}

/** A directory name derived from a git URL, and safe to create. */
export function slugForUrl(url: string): string {
  const tail = url.replace(/\.git$/, '').replace(/\/+$/, '').split(/[/:]/).pop() ?? 'project';
  return slugify(tail);
}

export function slugify(raw: string): string {
  const s = raw.trim().toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 64);
  return s || 'project';
}

/** A slug not already taken under the root. */
export function freeSlug(root: string, desired: string): string {
  const base = slugify(desired);
  if (!fs.existsSync(path.join(root, base))) return base;
  for (let i = 2; i < 1000; i += 1) {
    const candidate = `${base}-${i}`;
    if (!fs.existsSync(path.join(root, candidate))) return candidate;
  }
  return `${base}-${Date.now()}`;
}
