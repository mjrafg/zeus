/**
 * What a model was actually given, recorded as it is assembled.
 *
 * The critics have had this since M2: `buildReviewPayload` takes labelled
 * sections, checks them against a policy, hashes each one and records what was
 * delivered. The compiler, the planner and the implementer had nothing — they
 * concatenated `--- section ---` blocks into one string and handed it over, so
 * the only durable trace of what a planner saw was the size and the hash of
 * the whole thing.
 *
 * That gap is why "did the critic's findings reach the next planner?" could
 * only be answered by reading the plan that came back and inferring. Two plans
 * in a row repeated the same mistake and it took a code read to establish that
 * nothing had ever passed `prior`. A manifest makes it a lookup.
 *
 * DERIVED, NEVER DECLARED. The manifest is built from the sections that were
 * assembled, in the same call, from the same array. A caller cannot state that
 * it included the findings and then not include them, because the statement IS
 * the inclusion.
 */

import { createHash } from 'crypto';

/** What a section IS, so a reader can ask "was there any repository evidence?" */
export type SectionKind =
  | 'header'
  | 'mission-goal'
  | 'accepted-criteria'
  | 'declared-commands'
  | 'failing-checks'
  | 'recorded-findings'
  | 'previous-oracle'
  | 'previous-plan'
  | 'blocking-findings'
  | 'advisory-findings'
  | 'validator-findings'
  | 'revision-instruction'
  | 'repo-evidence'
  | 'task-requirement'
  | 'other';

export interface Section {
  kind: SectionKind;
  label: string;
  content: string;
  /**
   * Why a section that COULD have been supplied was not.
   *
   * An absent section and a deliberately withheld one are different facts, and
   * only one of them is a bug. Recording the reason is what lets a reader tell
   * "the planner never got the findings" from "the findings were withheld
   * because the policy forbids them".
   */
  excludedReason?: string;
}

export interface ManifestEntry {
  kind: SectionKind;
  label: string;
  hash: string;
  bytes: number;
  included: boolean;
  excludedReason?: string;
}

export interface Assembled {
  prompt: string;
  manifest: ManifestEntry[];
  promptHash: string;
  promptBytes: number;
  /** The kinds actually delivered, for a checklist that needs no parsing. */
  delivered: SectionKind[];
}

export function hashOf(s: string): string {
  return `sha256:${createHash('sha256').update(s).digest('hex').slice(0, 32)}`;
}

/**
 * Builds the prompt and its manifest together, from one array.
 *
 * The section order is the order the model sees, and the manifest preserves it:
 * "the findings were included" is a weaker claim than "the findings were
 * included, third, after the goal and the criteria".
 */
export function assemble(header: string, sections: Section[]): Assembled {
  const manifest: ManifestEntry[] = [];
  const kept: Section[] = [];

  for (const s of sections) {
    const excluded = s.excludedReason !== undefined;
    const content = s.content ?? '';
    manifest.push({
      kind: s.kind, label: s.label,
      hash: hashOf(content), bytes: content.length,
      included: !excluded,
      ...(excluded ? { excludedReason: s.excludedReason } : {}),
    });
    if (!excluded && content.trim()) kept.push({ ...s, content });
  }

  const prompt = [header, '', ...kept.map((s) => `--- ${s.label} ---\n${s.content}`)]
    .join('\n');

  return {
    prompt,
    manifest,
    promptHash: hashOf(prompt),
    promptBytes: prompt.length,
    delivered: manifest.filter((m) => m.included).map((m) => m.kind),
  };
}

/**
 * The compact checklist a reader wants before opening anything.
 *
 * Present, absent, or withheld — three states, because collapsing withheld
 * into absent is what makes a deliberate exclusion look like a bug and a bug
 * look deliberate.
 */
export function checklist(manifest: ManifestEntry[]): Array<{
  kind: SectionKind; state: 'present' | 'absent' | 'withheld'; bytes: number;
}> {
  const out = new Map<SectionKind, { kind: SectionKind; state: 'present' | 'absent' | 'withheld'; bytes: number }>();
  for (const m of manifest) {
    const state = m.included ? (m.bytes > 0 ? 'present' : 'absent')
      : 'withheld';
    const prior = out.get(m.kind);
    // A kind supplied twice is present if either instance carried anything.
    if (!prior || (state === 'present' && prior.state !== 'present')) {
      out.set(m.kind, { kind: m.kind, state, bytes: m.bytes });
    }
  }
  return [...out.values()];
}
