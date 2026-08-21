# BC-2 re-run — the stop that BC-2 never got

The original run: an oracle criterion read over a whole source tree, an
accepted plan whose single node wrote one file, and an honest `FAILED` after
$4.87 for a mismatch that was visible in the plan before any task ran.

**This re-run never reached a task.** It stopped at plan time, with the
numbers on screen. That is the deliverable, not a shortfall: the whole point
of the change is to make this conversation happen before the money is spent.

## Provenance

| | |
|---|---|
| Goal | eliminate implicit-any type errors across the server source |
| Repository | a large pnpm workspace, operator-supervised |
| Base | `8122cfff04a6` |
| Zeus | `9628e83` plus the scope-extractor fix |
| Providers | compiler `claude`, critic `codex` |

## The chain, from the log

| seq | event | note |
|---|---|---|
| 1 | `MISSION_CREATED` | goal recorded |
| 2 | `ORACLE_COMPILED` | live model compiled the contract |
| 3 | `ORACLE_CRITIQUED` | independent live critic |
| 4 | `ORACLE_RECOMPILED` | critique sent back to the compiler |
| 5 | `ORACLE_COMPILED` | live model compiled the contract |
| 6 | `ORACLE_CRITIQUED` | independent live critic |
| 7 | `ORACLE_RECOMPILED` | critique sent back to the compiler |
| 8 | `ORACLE_COMPILED` | live model compiled the contract |
| 9 | `ORACLE_CRITIQUED` | independent live critic |
| 10 | `ORACLE_ACCEPTED` | accepted despite 8 finding(s) |
| 11 | `PLAN_RECORDED` | v1, 11 node(s), 9 scope finding(s) |
| 12 | `PLAN_CRITIQUED` | independent live plan critic |
| 13 | `PLAN_STOP_DECISION` | decision=STOPPED_BUDGET deferred=True |
| 14 | `PLAN_RECORDED` | v2, 14 node(s), 0 scope finding(s) |
| 15 | `PLAN_CRITIQUED` | independent live plan critic |
| 16 | `PLAN_STOP_DECISION` | decision=STOPPED_FINDINGS deferred=True |
| 17 | `PLAN_STOP_DECISION` | decision=REFUSED_NO_CONSENT deferred=True |

`PLAN_ACCEPTED` events: **0**. `TASK_SPAWNED` events: **0**. No task ran; no money was spent on one.

## The two stops, as rendered

**Plan v1 — budget.** The planner produced 11 nodes, roughly one per error
cluster (251 TS7016 vendor declarations; 444 in database/models; 194 in
financial statements; then sales, purchases, banking, ledger/inventory,
platform, core libs; a residual sweep; a final verification).

```
budget: the planner ESTIMATES ~$116.50 across 11 node(s), and the ceiling is
$5.00. Options: raise the budget for this mission, ask the planner to re-scope
smaller, or abort.
! this plan does not fit the mission budget
```

**Plan v2 — findings.** 14 nodes, ~$89.00 estimated, and four advisories from
the independent critic, including an integrity gap (a node that may modify
source after the node that audits it) and two unacknowledged interference
pairs the deterministic validator had already reported.

## The decision taken

**Neither raised nor re-scoped: stopped, and recorded.** `accept-plan` was run
without `--yes`, which records `PLAN_STOP_DECISION` carrying the full
rendering and `decision: REFUSED_NO_CONSENT`. The plan remains unaccepted, so
`spawnNode` would refuse every node in it.

Reason: ~$89 of real spend across 14 nodes modifying a production repository's
source is a decision for the repository's owner, not for the agent holding the
keyboard. The estimate is the planner's own claim, labelled as an estimate
throughout and never counted as spend.

## What this proves, and what it does not

Proven: the negotiation fires at plan time with both numbers; the stop is
recorded with what was on screen; a plan that does not fit cannot be accepted
by the flag that answers findings.

Not proven: that the plan would have achieved the goal. Nothing here
establishes that, and nothing here claims it.

## A gap this run exposed

The mission report reads `cost nothing reported` although several live model
calls were made. Provider cost is recovered from spawned TASK logs, and the
oracle and planner calls are made directly by the CLI rather than through a
task — so their spend reaches no log. Recorded as a finding rather than
estimated, since an estimated cost is exactly what this change refuses to
treat as an observation.
