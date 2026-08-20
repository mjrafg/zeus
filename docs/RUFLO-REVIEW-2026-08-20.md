# Ruflo-derived patterns review — 2026-08-20

A review of the overnight sequence (`e310579`…`c36d468`), the morning
decisions (`bcfc14d`, `505c6d0`, `9b194e2`) and the code they touched, against
ten orchestration principles.

**This is not a parity exercise.** The principles were reviewed as principles;
no Ruflo source was read, nothing was cloned or fetched, and no Ruflo
infrastructure — MCP, AgentDB, swarm topology, consensus, neural training —
was introduced or considered. Several principles were expected to already hold
in Zeus; confirming that with named evidence is the point, not a formality.

**Starting state, verified before review.** HEAD `9b194e2`, `git status
--short` empty, `704 passed / 0 failed`, level with `origin/main`. The state
and the overnight report agree; there is no discrepancy to report as a finding.

## Ruflo-Derived Patterns

| Pattern | Zeus relevance | Action | Evidence |
|---|---|---|---|
| **R1** bounded concurrency | every execution is a spawned process; unbounded fan-out is the outage shape Zeus exists to prevent | **already present** | **Zero** `Promise.all`/`race`/`allSettled` anywhere in `src/`. Every spawn passes `acquire()` (`exec.ts:345`) capped by `cap()` (`exec.ts:295`) from `budgets.globalHeavy/LightConcurrency`. Dependency preparation runs `cls: 'heavy'` (`dependencies.ts:479`), the most restrictive pool. Held by `EN-A-*` ("five heavy jobs never overlap (max concurrency 1)", `test/engine.ts`) and `CG13` (the ceiling that stopped the hog is the one Zeus asked for). |
| **R2** one writer per worktree | per-task worktrees; planner and reviewer run `readOnly` | **IMPLEMENTED** (violation found and fixed) | Reproduced: hardlink reuse shares an inode, so an in-place write in worktree A changed the cache *and* worktree B. Fixed at `dependencies.ts:598` (publish `{ readOnlyFiles: true }`) / `:310`. Held by `DEP4e`–`DEP4h`. See below. |
| **R3** cancel dependents after terminal failure | task-level only; Zeus has no inter-task DAG | **already present** for what exists; **deferred** for the rest | Preparation failure escalates before any check runs — `orchestrator.ts:553`, asserted by `DEP5d` (*no* `CHECK_RESULT` events at all). Cancellation is absorbing and breaks both check loops (`orchestrator.ts:591`); owned trees die through the supervisor (`DEP6c`, `CG17`, `CG20`). One deliberate exception documented below. |
| **R4** event-driven completion over polling | waiting is where latency and flakiness hide | **already present** | **Zero** `setTimeout`/`setInterval` in all four new modules (`dependencies.ts`, `gitro.ts`, `redact.ts`, `eventtypes.ts` — 0/0/0/0). Preparation completes on the supervisor's process-exit promise; cache readiness is file publication (`renameSync`, `dependencies.ts:605`); scope stop arrives as a signal on the child. The only timers in `src/` predate this work and are deadlines or UI refresh, not completion polling. |
| **R5** resumable / idempotent operations | an interrupted preparation must never look finished | **already present** | temp → marker → atomic rename as merged: `isCompleteCache()` (`dependencies.ts:170`) requires the marker *and* `node_modules`; `renameSync(tmp, cacheDir)` (`:605`); a lost race discards its own tmp and adopts the winner. Held by `DEP5b` (no half-built cache reusable), `DEP5c` (no `.tmp-*` debris), `DEP1c` (reuse), `DEP2b` (hash keying). |
| **R6** deterministic fast paths | "no model in the safety floor" | **already present** | **Zero** provider/agent references in `dependencies.ts`, `gitro.ts`, `redact.ts`, `eventtypes.ts`, `isolation.ts`. Cache-hit detection, lockfile hashing, backend probing (`isolation.ts:110`), git classification (`gitro.ts:124`), duplicate-name detection (`UNIQ1`), event-type enumeration (`RS1`), and containment classification (`exec.ts:489`) are all pure code. |
| **R7** structured, validated internal results | later stages must consume typed state | **already present** | Every new boundary returns a type, not a string: `PreparationOutcome` (`dependencies.ts:112`), `ScopeProbe` (`isolation.ts:90`), `BackendCapability.enforces[]`, `GitRefusal` with `code`/`verb` (`gitro.ts:39`), `EventTypeSite[]`, `redactPayload → {payload, redactions}`. Strings are diagnostics beside typed fields — `GitRefusal.message` sits next to `code`; `PreparationOutcome.output` next to `ok`/`method`/`attempts`. `RO11`/`RO12` assert the code, not the prose. |
| **R8** preserve valid work on failure | cache validity comes from the lockfile, not the task | **already present** | Both halves. Valid work survives: the cache is published as soon as the install succeeds (`dependencies.ts:620`), keyed by content, so a later REVIEW or acceptance failure cannot invalidate it — `DEP2b` shows an older cache intact beside a new one. Invalid work does not: a failed preparation leaves no reusable cache (`DEP5b`) and no debris (`DEP5c`); a publish that fails still lets the task proceed but does **not** claim a cache (`dependencies.ts`, "installed, but the cache could not be published"). |
| **R9** pipeline independent work, barrier only when required | lifecycle gate semantics are untouchable | **already present**; one opportunity **evaluated and rejected** | Required checks run before REVIEW (`orchestrator.ts:787`); FINAL_ACCEPTANCE keeps its full gate; commit and push are strictly serialised by `pre-commit`/`pre-merge-commit`/`pre-push`, proved end-to-end by `PG4`–`PG7` and `S10d`–`S10h`. Nothing in the night's work moved a barrier. The one opportunity found is declined below. |
| **R10** performance measured, not assumed | numbers or no claim | **already present**; applied to this review's fix | The reorder in `bcfc14d` was made *because* of measurement (hardlink 2–32 ms vs `pnpm --offline` ~700 ms), not because a technique looked better. This review's own fix carries before/after evidence below. |

---

## R2 — the violation, in detail

### What was found

Reuse materialises the cache by hardlink (first choice since `bcfc14d`). A
hardlink shares an **inode**, and file permissions live on the inode. Measured
against the merged code, before any change:

```
inode shared A<->cache : true
link count on cache    : 3
cache file mode        : 664

in-place write in worktree A: succeeded
  cache now reads      : "module.exports = \"PATCHED BY TASK A\";"
  worktree B now reads : "module.exports = \"PATCHED BY TASK A\";"
```

A single task writing in place inside its own `node_modules` mutated the
project's content-addressed cache and every other worktree materialised from
it. This is not exotic: `patch-package`, postinstall scripts and any tool that
rewrites a file in place all do exactly this. The corrupted content would then
be trusted by every later task, because the cache is keyed by lockfile hash and
the hash still matches.

It is a direct R2 violation — a worktree that is supposed to be private became
a write channel into shared state — and it is worse than an ordinary bug
because the poisoning is silent and durable until `zeus clean --deps`.

### The fix

Cache files are published **unwritable** (`dependencies.ts:598`, `:310`).
Because the inode is shared, the worktree's view is unwritable too, so an
in-place write fails with `EACCES` instead of succeeding invisibly.
Directories stay writable, so *replacing* a file — unlink then create, which
makes a new inode — still works and stays private to the worktree.

This is the same guarantee pnpm gives its own content-addressed store, for the
same reason. It was chosen over the alternatives deliberately: reflink
copy-on-write is unavailable on this filesystem (ext4), and copying instead of
linking would discard the measured 29–37× reuse win to solve a problem that
permissions solve directly.

### Measured effect

| | before fix | after fix |
|---|---|---|
| in-place write in a worktree | **succeeded**, cache and sibling worktree both changed | **refused (`EACCES`)**, cache byte-identical |
| replace file (unlink + create) | succeeded, private | succeeded, private (new inode) |
| `setup.dependencies`, first task | 1182.5 ms | 932.2 ms |
| `setup.dependencies`, reused | 31.7 ms | 32.1 ms |

The reuse path is unchanged — 0.4 ms apart, which is noise. The added work is
one `stat` + `chmod` per file at **publish** time only, which is the
once-per-lockfile path. The first-task numbers differ by more than the fix
could plausibly cost or save; that measurement is dominated by npm and varies
run to run on a shared host, so it is reported as "no regression", not as an
improvement.

### Regression tests

* `DEP4e` — a materialised dependency really is the cached inode (`nlink > 1`),
  so the test is exercising sharing rather than assuming it.
* `DEP4f` — an in-place write through that inode is refused.
* `DEP4g` — the shared cache is unchanged after the attempt.
* `DEP4h` — replacing the file still works, stays private, and yields a new
  inode.

`DEP4e` matters as much as `DEP4f`: without it, the suite would keep passing if
materialisation silently stopped hardlinking, and would then be asserting
nothing.

---

## R3 — the deliberate exception, and the deferred part

**What holds.** Terminal failures stop dependent work, with tests: a failed
preparation escalates before a single check runs (`DEP5d` asserts zero
`CHECK_RESULT` events); cancellation is absorbing and is re-checked between
every check (`orchestrator.ts:591`); owned process trees die through the
supervisor and are reaped even after a supervisor crash (`DEP6c`, `CG17`,
`CG18`, `CG20`).

**The exception, stated rather than hidden.** When a *required* check fails,
Zeus still runs the remaining required checks **and** the tier-added optional
ones. Under a strict reading of R3 the optional checks are work whose result
cannot change this phase's outcome.

It is left as it is, and that is a judgement call rather than an oversight. The
checks are not pointless: they are independent evidence, and a repair cycle
that sees every failure at once costs less than one that discovers them one at
a time. Changing it would alter validation-floor semantics — the part of Zeus
that has been most carefully protected — for a speed gain nobody has measured.
**Proposed fix if it is ever wanted:** stop only the *optional* checks once a
required outcome is non-`PASSED`, keep the full required floor, and record a
`VALIDATION_TRUNCATED` event so the missing evidence is visible rather than
absent. Estimated ~1 hour with tests. Risk of leaving it: none to correctness;
some wasted wall clock on already-failing tasks.

**Deferred, by instruction.** Cross-task dependency cancellation needs an
inter-task DAG, which Zeus does not have. Recorded here as **Mission Mode
design input**, not as tonight's gap.

---

## R9 — the pipelining opportunity, evaluated and rejected

`setup.dependencies` is a barrier before DESIGN. DESIGN is read-only inspection
of source and does not need `node_modules`, so the install could overlap it —
saving up to ~1.2 s of the measured first-task preparation.

**Rejected.** The install writes into the same worktree the planner is reading,
so the planner could inspect a half-populated `node_modules` and plan around a
dependency graph that does not exist yet. That trades a deterministic second
for a non-deterministic input to a model — the wrong direction for a system
whose whole argument is deterministic evidence first. It is also only paid once
per lockfile, which is exactly the cost the caching already removed.

Recorded as evaluated, not as a missed optimisation.

---

## Commits, suite, push

| SHA | What |
|---|---|
| *(this commit)* | R2: prepared dependency artifacts are immutable |

* Suite: **704 → 708 passed, 0 failed** (`DEP4e`–`DEP4h` added).
* Gated: `pre-commit` (boundary checks + full non-service suite), then
  `pre-push` (self-check + all six audit lanes). No `--no-verify`, no
  force-push, no service-dependent or E2E suites.
* Pushed to `origin/main`.

## Findings not fixed

One, recorded above rather than started: **R3's optional-checks-after-required-
failure exception**. It is a design judgement about validation semantics, not a
defect, and the fix is outside this review's budget. Everything else was either
already present with evidence, or fixed here.

No claim of parity with anything is made. The result of this review is one real
violation closed, one exception documented, one optimisation declined on
safety grounds, and eight principles confirmed with named evidence.
