# Branch inventory — Phase 1 (read-only)

Produced by inspection only. No merge, rebase, push, commit, or branch deletion
was performed. Two side effects of the inspection itself are disclosed in §7.

## 1. Starting state

| | |
|---|---|
| Repository | `mjrafg/zeus` (public) |
| Current branch | `audit/cycle-1` |
| HEAD | `cc1540b6a7d61708a6ea610927878e2650c0be58` |
| Working tree | **clean** — no uncommitted work |
| Stashes | **none** (`git stash list` empty) |
| Local branches | 2 — `main`, `audit/cycle-1` |
| Remote branches | 2 — `origin/main`, `origin/audit/cycle-1` (both in sync with local) |
| Tags | **none** |
| Worktrees | 1 — the checkout itself. No leftovers. |

There are **no leftover task worktrees**. `.git/worktrees` does not exist,
`.zeus/worktrees` does not exist, and `git worktree list` shows only the main
checkout. No `TASK-V2-*` worktree exists in this repository — that identifier
belongs to the earlier accounting project, which is a different repository and
was not inspected.

No detached-HEAD checkouts appear anywhere in the reflog.

## 2. Unreachable and dangling work

Two unreachable commits existed **before** this inspection. Both were examined
rather than assumed harmless.

| Commit | Author | Subject | Verdict |
|---|---|---|---|
| `bd72430` | `AI accounting autopilot service <…@srv697174…>` | Zeus 0.1.0-rc.1 | **Amend debris.** Tree is byte-identical to live commit `bd858c6`. This is the pre-amend initial commit, replaced when the author identity was corrected. Nothing unique. |
| `90599d6` + `9c45228` | mjrafg | `WIP on main: 7c48f78 …` / `index on main: …` | **A dropped stash**, 15 files / 2 593 insertions, created and popped at 14:11:44 during the self-audit work. |

The dropped stash was checked file by file against the commit made 27 seconds
later:

* 14 of its 15 files are byte-identical to `e5c50d1`;
* `src/cli.ts` differs by +9/−1 — and the commit is the **larger** side (it
  adds the "candidate does not contain audits/harness" guard).

`e5c50d1` is therefore a strict superset of the stash. **No work is lost, and
nothing needs recovering.**

## 3. Branches

| Branch | Tip | Ahead of main | Behind main | First commit | Last commit | Merged into main? |
|---|---|---:|---:|---|---|---|
| `main` | `7c48f78` | 0 | 0 | 2026-08-19 06:55 | 2026-08-19 07:36 | — (is main) |
| `audit/cycle-1` | `cc1540b` | **8** | **0** | 2026-08-19 06:55 | 2026-08-20 05:47 | **no** |

### `audit/cycle-1` — the eight commits

```
cc1540b  docs(audit): latency-gate self-audit record
e74986b  feat(telemetry): passive latency instrumentation and a measured baseline
b9c43e3  docs(audit): cycle-1 ending-SHA verification and release-gate record
4801642  docs(audit): record the cycle-1 final verdict
67da187  fix(providers): believe the provider when it says it failed
22e3c80  fix(audit): probes must exercise the product, not reimplement it
61e6d65  fix(audit): close the cycle-1 findings
e5c50d1  feat(audit): permanent self-audit harness and zeus self-audit
```

45 files changed, 10 465 insertions, 59 deletions. Principal areas:

* `audits/` — charter, harness lanes A–F, cycle records, next-cycle targets
* `src/selfaudit/` — disposable checkout, lane runner, report renderer
* `src/telemetry/spans.ts` — latency instrumentation
* `scripts/latency-baseline.ts`, `scripts/latency-subject.ts`
* `src/engine/{orchestrator,exec,providers,policy}.ts` — the cycle-1 fixes
* `test/audit.ts`, `test/boundary.ts`, `test/run.ts`
* `docs/LATENCY-BASELINE.md`

### Merge-clean test (performed without merging)

* `git merge-tree --write-tree main audit/cycle-1` → **clean**, resulting tree
  `d1119ac`. No conflicts.
* `git merge-base --is-ancestor main audit/cycle-1` → **true**.

`main` is a direct ancestor of `audit/cycle-1`. Integration is a **fast-forward
with zero conflict risk**. There is no divergence to reconcile.

## 4. Themes

Grouped from commit content, not from commit-message claims.

| Theme | Where it lives | Status |
|---|---|---|
| FASTEST_SAFE adaptive validation | `main` @ `7c48f78` | already on main |
| Trusted-autonomy hardening | `main` @ `7c48f78` (same commit) | already on main |
| Self-audit harness + `zeus self-audit` | `audit/cycle-1` @ `e5c50d1` | unmerged |
| Cycle-1 defect fixes | `audit/cycle-1` @ `61e6d65`, `22e3c80`, `67da187` | unmerged |
| Latency instrumentation + baseline | `audit/cycle-1` @ `e74986b`, `cc1540b` | unmerged |

Nothing falls outside these themes. FASTEST_SAFE and trusted-autonomy hardening
arrived in a single commit and are **not** separate branches.

## 5. Feature status

"Verified" means executed evidence, not a commit message.

| Capability | Branch | Merged? | Tests? | Verified? | Notes |
|---|---|---|---|---|---|
| Portable engine + lifecycle | main | yes | yes | yes | 469 passing on main |
| Project adapters, config, CLI | main | yes | yes | yes | covered by `test/run.ts` |
| Setup wizard + provider auth | main | yes | yes (64) | yes | fake-probe suite; real dry-run recorded previously |
| Reviewer independence | main | yes | yes | yes | `RI1–RI9` |
| Resource governor / isolation | main | yes | yes | **PARTIAL** | process-group kill and wall clock verified; kernel memory enforcement **UNKNOWN** — this host selects bubblewrap, which has no memory accounting |
| FASTEST_SAFE adaptive validation | main | yes | yes (114) | yes | tiers observed FAST/NORMAL/DEEP in the latency runs |
| Trusted-autonomy hardening | main | yes | yes | yes | anti-gaming rules asserted in `test/validation.ts` |
| Self-audit harness (lanes A–F) | audit/cycle-1 | **no** | yes | yes | 49 probes, all holding at `cc1540b` |
| `zeus self-audit` command | audit/cycle-1 | **no** | indirect | yes | run end-to-end four times; gates `scripts/package.sh` |
| Cycle-1 fixes (change visibility P0, pid reuse, output redaction, chmod detection, worktree fallback, revalidate notice) | audit/cycle-1 | **no** | yes (44) | yes | `test/audit.ts`, each failing on the old behaviour |
| Provider error classification | audit/cycle-1 | **no** | yes (8) | yes | found by dogfood; `R-P1`–`R-P8` |
| Latency instrumentation | audit/cycle-1 | **no** | indirect | yes | 7 runs, reconciliation exact, overhead 1.0–1.6 ms |
| Integration revalidation (`zeus revalidate`) | main | yes | yes | yes | exercised against real git |
| Checkpoint attribution producer | — | — | — | **NOT BUILT** | `VALIDATION_MISS`/`SUSPECTED_FLAKE` logic exists and is tested, but nothing emits `REGRESSION_ATTRIBUTED` |
| Control Center UI | — | — | — | **NOT BUILT** | |
| Mission Mode | — | — | — | **NOT BUILT** | deliberately out of scope |

## 6. Test state per branch

Each branch checked out into a throwaway `git worktree`, suite run, worktree
removed. **Sequential — never two suites at once.**

| Branch | Tip | Passed | Failed | Exit | Result |
|---|---|---:|---:|---:|---|
| `main` | `7c48f78` | **469** | **0** | 0 | green |
| `audit/cycle-1` | `cc1540b` | **514** | **0** | 0 | green |

Delta: **+45 tests**, no regressions.

**Service-dependency screen.** No database, HTTP server, browser, or container
is started anywhere in `src/` or `test/`. The only `npm` scripts are `build`,
`test`, `cli`, `package`, `self-audit`. Nothing was recorded as
`SKIPPED_SERVICE_DEPENDENT` because nothing qualifies.

**Worker cap.** Zeus's runner is a single Node process that executes suites
sequentially in-process; there is no worker pool and therefore no
`--maxWorkers` equivalent to set. Host load stayed between 0.91 and 1.55 on
8 cores throughout. Suites that *do* spawn processes (lease, cancellation and
audit-lane probes) spawn one or two short-lived `sleep`/`ts-node` children at a
time.

**On 514 vs the 519 previously reported.** Both counts are correct and the
difference is fully explained: the boundary suite runs six artifact checks
(`PB10`–`PB15`) when `dist-release/` exists and one skip-notice when it does
not. A throwaway worktree has no built artifact, so both branches lose exactly
five checks — `main` reports 474 in the working repo and 469 here; `audit/cycle-1`
reports 519 and 514. Verified by reading `PB10: … skipped — no artifact present`
in both runs.

## 7. Two side effects of this inspection — disclosed

Phase 1 was to be read-only. Two things were written, both by me, both undone:

1. **`git fsck --lost-found` wrote `.git/lost-found/`** (5 files). Removed.
2. **A comparison fetch imported the legacy repository's objects and tags.** To
   establish whether `mjrafg/zeus-legacy` shares history with this repository I
   ran `git fetch /srv/zeus main:refs/tmp-legacy`. The temporary ref was
   deleted, but the fetch also brought in `extracted-baseline` and
   `v0.0.0-extracted` — two tags this repository never had. **I deleted both
   local tags to restore the documented starting state.** They were never
   pushed (`git ls-remote --tags origin` returns nothing for either), and they
   remain intact in `/srv/zeus` and on `mjrafg/zeus-legacy`, so nothing is lost.

The 14 legacy commits fetched are now unreachable objects in this repository's
object store. They are inert and invisible to every branch, but they are there
until someone runs `git gc --prune=now`. I have **not** run it; that is a
decision to take deliberately, not as a side effect of an inventory.

Current unreachable-commit count: **16** — the 14 imported legacy commits plus
the dropped-stash pair. `bd72430` also remains in the object store.

## 8. Conflicts, overlaps and merge order

* **Branches touching the same files:** none. There is only one unmerged
  branch.
* **Inter-branch dependencies:** none.
* **Abandoned or superseded branches:** none. Both branches are current.
* **Recommended merge order:** trivial — one branch.

```
main  ──▶  fast-forward to audit/cycle-1 (cc1540b)
```

`main` is an ancestor of `audit/cycle-1`, so an integration branch cut from
`main` and merged with `audit/cycle-1` produces exactly `cc1540b`'s tree with no
merge commit required. A `--no-ff` merge would preserve a visible integration
point at the cost of one extra commit; a fast-forward preserves all eight
commits' individual attribution either way, because nothing is being squashed.

### The legacy repository is not integrable

`/srv/zeus` → `mjrafg/zeus-legacy`, private, `main` @ `34cd441`, 14 commits,
2 tags, one untracked `package-lock.json`, no stashes, no unreachable work.

Its root commit is `67be99d`; this repository's root is `bd858c6`. **There is no
merge base** — the histories are unrelated by construction, because the public
repository was initialised fresh. It also still carries the 38-file `internal/`
archive that the public repository deliberately excludes. It should stay where
it is, as the private historical record.

## 9. Ending state

Identical to the starting state:

```
branch:  audit/cycle-1
HEAD:    cc1540b6a7d61708a6ea610927878e2650c0be58
tags:    0
branches: main, audit/cycle-1 (+ their two remotes)
worktrees: 1 (the checkout itself)
working tree: clean
```

Plus this file, uncommitted, as instructed.
