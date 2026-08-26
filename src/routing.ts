/**
 * Which model answers for which part of the pipeline, and how hard it thinks.
 *
 * Zeus used to choose neither. It shelled out to `claude -p …` and `codex exec
 * …` with no `--model` and no effort flag, so every call ran on whatever those
 * CLIs happened to be configured with — outside Zeus, invisible to the log, and
 * different on another machine. A mission could not say which model wrote its
 * plan, and an audit of "why did this go wrong" had nowhere to start.
 *
 * Worse, the three provider roles collapsed seven pipeline stages onto three
 * settings: the oracle and the planner shared one, the oracle critic and the
 * plan critic shared another. Wanting a cheaper model for one and not the other
 * was not expressible.
 *
 * THE CATALOGUE IS NOT WRITTEN DOWN HERE. Model names and the effort levels
 * each model accepts come from the providers themselves — Codex publishes both
 * in its own cache, Claude documents its effort levels in its own help output.
 * A hardcoded list is a list that is wrong the week after it is written, and
 * offering an operator a reasoning level their model cannot use is offering
 * them a failed call.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';

/**
 * The stages of the pipeline that call a model.
 *
 * Distinct from the provider-facing `Role`, which is about what a call may DO
 * (read only, write, review) and drives the tool allowlist. Two stages can
 * share a role and still deserve different models: the oracle critic and the
 * plan critic are both reviewers, and they are reviewing very different things.
 */
export const PIPELINE_STAGES = [
  // The chat front door runs before any mission exists, so it is first. It is
  // in this table rather than hard-wired because "which model reads my
  // messages" is exactly the kind of thing an operator should be able to see
  // and change in the same place as every other stage.
  'front-door',
  'oracle', 'oracle-critic', 'planner', 'plan-critic',
  'implementer', 'reviewer', 'repair',
  // LITE. One agent that plans AND writes, in place of design-then-implement.
  // In the table rather than hard-wired for the same reason as every other
  // stage: "which model builds my change" is a thing an operator should be
  // able to see and set in one place.
  'builder',
] as const;

export type PipelineStage = typeof PIPELINE_STAGES[number];

/** What a stage is allowed to do, which is a separate question from who does it. */
export const STAGE_ROLE: Record<PipelineStage, 'planner' | 'implementer' | 'reviewer'> = {
  'front-door': 'reviewer',
  oracle: 'planner',
  'oracle-critic': 'reviewer',
  planner: 'planner',
  'plan-critic': 'reviewer',
  implementer: 'implementer',
  reviewer: 'reviewer',
  repair: 'implementer',
  builder: 'implementer',
};

/** Human wording for a settings screen, so the UI does not invent its own. */
export const STAGE_LABEL: Record<PipelineStage, string> = {
  'front-door': 'Front Door',
  oracle: 'Oracle',
  'oracle-critic': 'Oracle Critic',
  planner: 'Planner',
  'plan-critic': 'Plan Critic',
  implementer: 'Implementer',
  reviewer: 'Reviewer',
  repair: 'Repair',
  builder: 'Builder',
};

export const STAGE_DESCRIPTION: Record<PipelineStage, string> = {
  'front-door': 'reads your chat messages and decides what you are asking for',
  oracle: 'turns the goal into a contract of checkable criteria',
  'oracle-critic': 'reviews that contract as an independent second opinion',
  planner: 'proposes the task graph',
  'plan-critic': 'reviews the plan before any task is spawned',
  implementer: 'writes the change inside an isolated worktree',
  reviewer: 'reviews the change against current source',
  repair: 'retries a node that failed, with the failure in hand',
  builder: 'plans and writes the change in one turn, for the lite pipeline',
};

/* ------------------------------------------------------------------------ *
 * Capabilities — asked of the provider, never asserted here
 * ------------------------------------------------------------------------ */

export interface ModelCapability {
  id: string;
  display: string;
  description?: string;
  /** Effort levels THIS model accepts. Empty when the provider does not say. */
  reasoning: string[];
  defaultReasoning: string | null;
}

export interface ProviderCapability {
  provider: string;
  /** Where the answer came from, so a stale catalogue is diagnosable. */
  source: string;
  /**
   * Whether the model list is exhaustive.
   *
   * Codex publishes a catalogue, so its list is closed and a name outside it
   * is a mistake worth refusing. Claude documents aliases and accepts any full
   * model name, so its list is open: the names below are offered, and anything
   * else is passed through rather than rejected on a guess.
   */
  closed: boolean;
  models: ModelCapability[];
  /** Levels the provider accepts when a model does not narrow them further. */
  reasoning: string[];
  detail: string;
}

const CODEX_CACHE = () => path.join(
  process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex'), 'models_cache.json',
);

/**
 * Codex publishes its own catalogue, refreshed by the CLI.
 *
 * Each entry carries the effort levels that model actually supports, which is
 * exactly what a settings screen needs in order not to offer an impossible
 * combination: gpt-5.6-sol takes `ultra`, gpt-5.5 stops at `xhigh`.
 */
export function codexCapability(cachePath = CODEX_CACHE()): ProviderCapability {
  const empty: ProviderCapability = {
    provider: 'codex', source: cachePath, closed: false, models: [], reasoning: [],
    detail: 'no model catalogue on disk — run the codex CLI once to populate it',
  };
  let raw: any;
  try { raw = JSON.parse(fs.readFileSync(cachePath, 'utf8')); } catch { return empty; }
  const list = Array.isArray(raw?.models) ? raw.models : [];
  if (!list.length) return empty;

  const models: ModelCapability[] = list
    .filter((m: any) => m && typeof m.slug === 'string')
    // `visibility` is the provider's own word on whether a model is offerable.
    .filter((m: any) => m.visibility !== 'hidden')
    .map((m: any) => ({
      id: String(m.slug),
      display: String(m.display_name ?? m.slug),
      ...(m.description ? { description: String(m.description) } : {}),
      reasoning: (Array.isArray(m.supported_reasoning_levels) ? m.supported_reasoning_levels : [])
        .map((r: any) => String(r?.effort ?? ''))
        .filter(Boolean),
      defaultReasoning: typeof m.default_reasoning_level === 'string'
        ? m.default_reasoning_level : null,
    }));

  const union = [...new Set(models.flatMap((m) => m.reasoning))];
  return {
    provider: 'codex', source: cachePath, closed: true, models, reasoning: union,
    detail: `${models.length} model(s) from the provider's own catalogue, fetched `
      + `${String(raw.fetched_at ?? 'at an unrecorded time')}`,
  };
}

/**
 * Claude documents its effort levels in its own help output, and its model
 * names as aliases plus "a model's full name".
 *
 * So the levels are READ rather than guessed, and the model list is open: the
 * documented aliases are offered as a starting point and any full name is
 * accepted. Refusing an unknown name here would mean a Zeus release could stop
 * an operator using a model that shipped yesterday.
 */
export function claudeCapability(bin = process.env.ZEUS_CLAUDE_BIN ?? 'claude'):
ProviderCapability {
  const r = spawnSync(bin, ['--help'], { encoding: 'utf8', timeout: 20_000 });
  const help = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  if (r.error || !help) {
    return {
      provider: 'claude', source: bin, closed: false, models: [], reasoning: [],
      detail: `${bin} did not answer --help, so its capabilities are unknown`,
    };
  }
  // "--effort <level>   Effort level for the current session (low, medium, high, xhigh, max)"
  const effort = /--effort\s+<level>[\s\S]{0,200}?\(([^)]+)\)/.exec(help);
  const reasoning = effort
    ? effort[1].split(',').map((s) => s.trim()).filter((s) => /^[a-z]+$/.test(s))
    : [];
  // "Provide an alias for the latest model (e.g. 'fable', 'opus', or 'sonnet')"
  const aliasBlock = /--model\s+<model>[\s\S]{0,400}/.exec(help)?.[0] ?? '';
  const aliases = [...aliasBlock.matchAll(/'([a-z][a-z0-9.\-]*)'/g)]
    .map((m) => m[1])
    .filter((a) => !a.includes('-'));   // 'claude-fable-5' is an example, not an alias
  const models: ModelCapability[] = [...new Set(aliases)].map((a) => ({
    id: a,
    display: a,
    description: 'alias for the latest model in that family',
    reasoning,
    defaultReasoning: null,
  }));
  return {
    provider: 'claude', source: `${bin} --help`, closed: false, models, reasoning,
    detail: models.length
      ? `${models.length} documented alias(es); any full model name is also accepted`
      : 'no aliases documented; any model name is accepted',
  };
}

export function providerCapabilities(): ProviderCapability[] {
  return [claudeCapability(), codexCapability()];
}

export function capabilityFor(provider: string,
  all = providerCapabilities()): ProviderCapability | null {
  return all.find((c) => c.provider === provider) ?? null;
}

/* ------------------------------------------------------------------------ *
 * The routing table
 * ------------------------------------------------------------------------ */

export interface RouteChoice {
  provider?: string;
  model?: string | null;
  reasoning?: string | null;
}

export type RoutingTable = Partial<Record<PipelineStage, RouteChoice>>;

export interface ResolvedRoute {
  stage: PipelineStage;
  role: 'planner' | 'implementer' | 'reviewer';
  provider: string;
  /** Null means "whatever the provider CLI defaults to" — stated, never implied. */
  model: string | null;
  reasoning: string | null;
  /** Which tier won, per field, so the screen can say why. */
  source: { provider: RouteSource; model: RouteSource; reasoning: RouteSource };
}

export type RouteSource = 'project' | 'global' | 'zeus-default' | 'provider-default';

/**
 * Where a stage lands when nobody has said otherwise.
 *
 * Providers only. NO MODEL AND NO REASONING: Zeus does not know which models a
 * host has access to, and inventing a default would mean an upgrade silently
 * changing what an operator's missions run on. A null here means the provider
 * CLI decides, and the resolved table says so in as many words.
 */
export const ZEUS_DEFAULT_ROUTING: Record<PipelineStage, RouteChoice> = {
  // claude, because the front door needs MCP tools and codex cancels MCP tool
  // calls in non-interactive runs. A front door without its tools is the
  // keyword table again, wearing a model's clothes.
  'front-door': { provider: 'claude' },
  oracle: { provider: 'claude' },
  'oracle-critic': { provider: 'codex' },
  planner: { provider: 'claude' },
  'plan-critic': { provider: 'codex' },
  implementer: { provider: 'claude' },
  reviewer: { provider: 'codex' },
  repair: { provider: 'claude' },
  // Same provider as the implementer it replaces: the lite pipeline changes
  // how many calls a change costs, not who is trusted to write code.
  builder: { provider: 'claude' },
};

/**
 * Project over global over Zeus default, FIELD BY FIELD.
 *
 * Per field rather than per stage on purpose: an operator who sets only the
 * reasoning level for the planner in one project should keep the global choice
 * of model, not silently fall back to the Zeus default for it.
 */
export function resolveRouting(input: {
  project?: RoutingTable | null;
  global?: RoutingTable | null;
}): ResolvedRoute[] {
  return PIPELINE_STAGES.map((stage) => {
    const p = input.project?.[stage] ?? {};
    const g = input.global?.[stage] ?? {};
    const z = ZEUS_DEFAULT_ROUTING[stage];

    const pick = <K extends keyof RouteChoice>(key: K):
    { value: RouteChoice[K]; source: RouteSource } => {
      if (p[key] !== undefined && p[key] !== null) return { value: p[key], source: 'project' };
      if (g[key] !== undefined && g[key] !== null) return { value: g[key], source: 'global' };
      if (z[key] !== undefined && z[key] !== null) return { value: z[key], source: 'zeus-default' };
      return { value: undefined, source: 'provider-default' };
    };

    const provider = pick('provider');
    const model = pick('model');
    const reasoning = pick('reasoning');
    return {
      stage,
      role: STAGE_ROLE[stage],
      provider: String(provider.value ?? 'claude'),
      model: (model.value as string | undefined) ?? null,
      reasoning: (reasoning.value as string | undefined) ?? null,
      source: {
        provider: provider.source, model: model.source, reasoning: reasoning.source,
      },
    };
  });
}

/* ------------------------------------------------------------------------ *
 * Validation — before a mission spends, not after
 * ------------------------------------------------------------------------ */

export interface RouteProblem {
  stage: PipelineStage;
  field: 'provider' | 'model' | 'reasoning';
  code: 'UNKNOWN_PROVIDER' | 'UNKNOWN_MODEL' | 'UNSUPPORTED_REASONING'
  | 'PROVIDER_UNAVAILABLE';
  detail: string;
  /** What the operator could pick instead, when the answer is knowable. */
  options?: string[];
}

/**
 * Checks a resolved table against what the providers actually offer.
 *
 * A reasoning level a model does not accept is a call that fails after the
 * money is committed, so it is refused here — before the mission starts —
 * with the levels that model does accept.
 */
export function validateRouting(routes: ResolvedRoute[],
  caps = providerCapabilities()): RouteProblem[] {
  const problems: RouteProblem[] = [];
  for (const r of routes) {
    const cap = capabilityFor(r.provider, caps);
    if (!cap) {
      problems.push({
        stage: r.stage, field: 'provider', code: 'UNKNOWN_PROVIDER',
        detail: `no provider called "${r.provider}"`,
        options: caps.map((c) => c.provider),
      });
      continue;
    }
    const model = r.model ? cap.models.find((m) => m.id === r.model) : null;
    if (r.model && !model && cap.closed) {
      problems.push({
        stage: r.stage, field: 'model', code: 'UNKNOWN_MODEL',
        detail: `${cap.provider} publishes a catalogue and "${r.model}" is not in it`,
        options: cap.models.map((m) => m.id),
      });
      continue;
    }
    if (!r.reasoning) continue;
    // A model's own list wins over the provider-wide union: gpt-5.5 stops at
    // xhigh even though a sibling model accepts ultra.
    const allowed = model?.reasoning.length ? model.reasoning : cap.reasoning;
    if (allowed.length && !allowed.includes(r.reasoning)) {
      problems.push({
        stage: r.stage, field: 'reasoning', code: 'UNSUPPORTED_REASONING',
        detail: model
          ? `${model.display} does not accept "${r.reasoning}"`
          : `${cap.provider} does not accept "${r.reasoning}"`,
        options: allowed,
      });
    }
  }
  return problems;
}

/** The table as an operator reads it, one line per stage. */
export function renderRouting(routes: ResolvedRoute[]): string[] {
  const width = Math.max(...routes.map((r) => STAGE_LABEL[r.stage].length));
  return routes.map((r) => {
    const model = r.model ?? `${r.provider} default`;
    const reasoning = r.reasoning ?? 'provider default';
    return `${STAGE_LABEL[r.stage].padEnd(width)}  →  ${r.provider} · ${model} · ${reasoning}`;
  });
}
