/**
 * Choosing how a project gets created — deterministically.
 *
 * THE MODEL NEVER PICKS THE ROUTE. An attachment is a zip; a message matching a
 * git-URL shape is a clone; anything else is a description. When the text is
 * URL-ISH but not a URL, the answer is a card that asks, not a guess — the same
 * fixed error direction the chat classifier follows, for the same reason: a
 * wrong guess here clones from somewhere unintended or spends a mission's
 * budget on a misreading.
 */

import { canonicalDigest, costExpectationLine, CardAction } from './mission/chat';
import { slugForUrl, slugify } from './projects';

export type CreationRoute = 'ZIP' | 'CLONE' | 'DESCRIPTION' | 'ASK';

export interface RouteDecision {
  route: CreationRoute;
  matched: string[];
  reason: string;
}

/** Shapes that are unambiguously a git remote. */
const URL_PATTERNS: Array<{ id: string; re: RegExp }> = [
  { id: 'https', re: /^https?:\/\/[^\s]+\/[^\s]+?(\.git)?\/?$/i },
  { id: 'ssh', re: /^(ssh:\/\/)?git@[^\s:]+:[^\s]+?(\.git)?\/?$/i },
  { id: 'git-proto', re: /^git:\/\/[^\s]+$/i },
  { id: 'gh-shorthand', re: /^(gh:)?[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/ },
];

/** Text that mentions a URL without being one. */
const URLISH = /(https?:\/\/|git@|\.git\b|github\.com|gitlab\.com|bitbucket\.org)/i;

/**
 * A URL carrying a credential.
 *
 * Refused outright rather than redacted-and-used: a token in a URL ends up in
 * process listings, in the run registry and in anything that logs a command
 * line, and the archaeology of removing it later is worse than saying no now.
 */
export function carriesCredentials(url: string): boolean {
  return /^[a-z+]+:\/\/[^/@\s]*:[^/@\s]*@/i.test(url) || /^[a-z+]+:\/\/[^/@\s]+@/i.test(url.replace(/^ssh:\/\/git@/i, 'ssh://'));
}

export function routeFor(input: { message: string; hasAttachment: boolean }): RouteDecision {
  if (input.hasAttachment) {
    return { route: 'ZIP', matched: ['attachment'], reason: 'an archive was attached, so it is the source' };
  }
  const text = (input.message ?? '').trim();
  if (!text) {
    return { route: 'ASK', matched: [], reason: 'there is nothing to route on' };
  }
  const single = !/\s/.test(text);
  const hit = URL_PATTERNS.find((p) => p.re.test(text));
  if (hit && single) {
    return { route: 'CLONE', matched: [`url:${hit.id}`], reason: `the message is a git URL (${hit.id})` };
  }
  if (URLISH.test(text)) {
    // URL-ISH BUT NOT A URL. This is the case that must not be guessed: it
    // might be "clone this" or it might be a sentence about a repository.
    return {
      route: 'ASK', matched: ['url-ish'],
      reason: 'the message mentions a repository without being a bare URL, so which route was meant is a question, not an inference',
    };
  }
  return { route: 'DESCRIPTION', matched: [], reason: 'no attachment and no URL, so the text is a description of what to build' };
}

/* ------------------------------------------------------------------------ *
 * Cards
 * ------------------------------------------------------------------------ */

export interface CreationCard {
  route: CreationRoute;
  source: string;
  /** Where it will land, shown before it is created. */
  targetSlug: string;
  targetPath: string;
  whatHappensNext: string[];
  warnings: string[];
  costExpectation: string;
  actions: CardAction[];
  digest: string;
}

export function draftCreationCard(input: {
  route: CreationRoute; source: string; projectsRoot: string; targetSlug: string;
  shallow?: boolean; limits?: { maxEntries: number; maxTotalBytes: number };
}): CreationCard {
  const warnings: string[] = [];
  let whatHappensNext: string[] = [];

  if (input.route === 'CLONE') {
    whatHappensNext = [
      `clone ${input.source}${input.shallow === false ? '' : ' (shallow: --depth 1)'} — through the supervisor, so it is bounded, killable and in the run registry`,
      'zeus init — write .zeus/config.yaml for the detected adapter',
      'doctor — probe this host for what a mission on this project would actually need',
    ];
    warnings.push('This needs network access.');
    if (carriesCredentials(input.source)) {
      warnings.push('This URL carries a credential and will be REFUSED. '
        + 'Use an SSH agent or a public URL — V1 does not accept secrets in a URL, '
        + 'because a URL ends up in process listings and the run registry.');
    }
  } else if (input.route === 'ZIP') {
    const lim = input.limits ?? { maxEntries: 20_000, maxTotalBytes: 500 * 1024 * 1024 };
    whatHappensNext = [
      `extract the archive — every destination checked against the target directory, `
        + `link entries skipped, capped at ${lim.maxEntries} entries and `
        + `${Math.round(lim.maxTotalBytes / 1024 / 1024)}MB uncompressed`,
      'zeus init — write .zeus/config.yaml for the detected adapter',
      'doctor — probe this host for what a mission on this project would actually need',
    ];
    warnings.push('Extraction is atomic: if any entry is refused, nothing is left on disk.');
    warnings.push('Not checked in V1: compression-ratio analysis, content scanning, rate limiting.');
  } else if (input.route === 'DESCRIPTION') {
    whatHappensNext = [
      'create an empty project — git init, then zeus init',
      'doctor — probe what this host can actually do',
      'draft a MISSION with your description as its goal',
      'then the normal chain: compile, critic, consent, plan, budget, run',
    ];
    warnings.push('There is no scaffolding shortcut. Building this is a mission, '
      + 'which means it goes through every consent stop and costs what a mission costs.');
  } else {
    whatHappensNext = ['nothing yet — say which you meant'];
  }

  const card: Omit<CreationCard, 'digest'> = {
    route: input.route,
    source: input.source,
    targetSlug: input.targetSlug,
    targetPath: `${input.projectsRoot}/${input.targetSlug}`,
    whatHappensNext,
    warnings,
    costExpectation: input.route === 'DESCRIPTION' ? costExpectationLine()
      : 'Creating the project costs nothing; any mission you then run costs what a mission costs.',
    actions: input.route === 'ASK'
      ? [
        { id: 'clone', label: 'Clone a repository' },
        { id: 'describe', label: 'Build something new from this description' },
        { id: 'cancel', label: 'Cancel' },
      ]
      : [
        { id: 'create', label: input.route === 'DESCRIPTION' ? 'Create project and draft the mission' : 'Create project' },
        { id: 'rename', label: 'Change the directory name' },
        { id: 'cancel', label: 'Cancel' },
      ],
  };
  return { ...card, digest: canonicalDigest(card) };
}

export { slugForUrl, slugify };
