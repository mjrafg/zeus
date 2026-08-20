/**
 * The durable self-audit harness.
 *
 * These suites are permanent and are part of release gating. A lane is a
 * bounded set of adversarial probes against one area of Zeus, each of which
 * either observes a defect or demonstrates that an invariant held.
 *
 * Adding a lane here is how a new area enters the audit. Removing a probe
 * because it started failing is how an audit becomes theatre; fix the defect
 * or record the finding as UNRESOLVED with an impact statement instead.
 */

import { LaneSpec } from './types';
import { laneA } from './lane-a';
import { laneB } from './lane-b';
import { laneC } from './lane-c';
import { laneD } from './lane-d';
import { laneE } from './lane-e';
import { laneF } from './lane-f';

export const LANES: LaneSpec[] = [laneA, laneB, laneC, laneD, laneE, laneF];

export function laneById(id: string): LaneSpec | undefined {
  return LANES.find((l) => l.lane.toUpperCase() === id.toUpperCase());
}

export * from './types';
