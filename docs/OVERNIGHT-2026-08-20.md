# Overnight sequence — 2026-08-20

Five steps, run strictly in order. All five completed. Nothing was bypassed:
every commit passed the existing `pre-commit` gate, the final push passed
`pre-push`, and `--no-verify` was never used. No service-dependent, E2E or
real-provider suite was run at any point.

Starting state, verified before Step 1: branch `main`, HEAD `62c2516`, working
tree clean, `581 passed / 0 failed`, `main` level with `origin/main`.

| Step | Result | Commit(s) | Tests before → after |
|---|---|---|---|
| 1 — dependency preparation | **DONE** | `e310579` | 581 → 630 (+49) |
| 2 — real resource ceilings | **DONE** | `358fb1b` | 630 → 649 (+19) |
| 3 — redacting sink | **DONE** | `91d981e` | 649 → 665 (+16) |
| 4 — read-only git (G-U2) | **DONE** | `8a46f88`, `67a94d9` | 665 → 695 (+30) |
| 5 — unique check names | **DONE** | `c36d468` | 695 → 697 (+2) |

Failures at every step: **0**.

Step 2 finished DONE rather than DONE-WITH-LIMITATION: real tree-wide
enforcement exists on this host and the adversarial aggregate-memory test
passes. The closure is host-conditional, and that condition is stated in three
places rather than assumed — see Step 2 below.

---

## Step 1 — dependency preparation · DONE

**Commit** `e310579` · 581 → 630 tests, 0 failures.

### The finding

Zeus created a worktree per task and never ran `commands.install`. On any real
Node project the first check therefore died with `Cannot find module` — a
validation outcome that says nothing about the code. The latency baseline had
recorded this as open.

### What was built

Preparation runs **once per `(project, lockfile-hash)`**; later worktrees are
materialised from the result. Four properties are boundaries rather than
conventions:

* **Per project.** The cache is `<project>/.zeus/deps`. There is no machine-wide
  Zeus dependency cache, so two projects with byte-identical lockfiles cannot
  share one — enforced structurally by the path, and by config validation that
  refuses a `paths.deps` outside the project.
* **Keyed by content.** `v1-<pm>-<sha256(lockfile)[0:32]>`. Nothing expires on a
  timer: a TTL answers "is this old?" when the question is "is this the same?".
* **Published atomically.** Prepare into `<cacheRoot>/.tmp-*`, complete, write
  `.zeus-deps-complete.json`, then rename. A directory without its marker is
  not a cache, so an interrupted preparation can never be reused.
* **Contained.** Whatever lands at `<worktree>/node_modules` must resolve inside
  the worktree. Enforced when links are created, not audited afterwards.

### Methods

Attempted in the order the brief specified, and reported only when they
actually ran and succeeded:

1. **pnpm store** — `pnpm install --frozen-lockfile --offline --store-dir
   <cache>/store`, pnpm's native reuse mode.
2. **hardlink** — recursive `link` of the prepared tree, after a real link
   probe (write a file, link it, compare inodes). Cross-device or a filesystem
   without links fails the probe rather than the operation.
3. **copy** — works across devices.

Non-Node projects run `commands.install` through the supervisor with no cache.
**Per-ecosystem dependency caching beyond Node is explicitly deferred** and is
named as deferred in `planDependencies` itself.

### Safety

The install is arbitrary repository code — `postinstall` is a shell script a
stranger wrote — so it runs through `ProcessSupervisor` like any project
command: governed by the concurrency pool, filesystem-confined, resource-
capped, timeout-bounded, killable, and recorded in the run registry. A
preparation failure is `INFRASTRUCTURE_FAILURE`, never `TEST_FAILED`; the task
escalates with `MISSING_ENVIRONMENT` and the redacted install output, and no
checks are run.

Network is granted for the install and only for the install — a package manager
that cannot reach its registry cannot install anything. Reuse runs offline.

### Two defects found while building it

* **Every task re-downloaded its own package manager.** `pnpm` and `yarn` are
  corepack shims on most Node installs, and the supervisor redirects `HOME`
  into the worktree so confined commands have somewhere to write. Together
  those meant corepack's cache was created and discarded per task — and on this
  host it resolved pnpm 11, which Node 18.16.1 cannot run at all. `COREPACK_HOME`
  now points at the project's dependency cache.
* **The hardlink probe reported a linkless filesystem.** It used the same
  filename on both sides, so probing a directory against itself hit `EEXIST`.
  `zeus doctor` was reporting `copy` on a host where hardlinks work.

### Regression tests — all nine required cases

| # | Requirement | Tests |
|---|---|---|
| 1 | first prepares, second reuses, materially faster | `DEP1a`–`DEP1f` |
| 2 | changed lockfile → fresh preparation, old cache not consulted | `DEP2a`, `DEP2b` |
| 3 | identical lockfiles in two projects do NOT share | `DEP3a`–`DEP3d` |
| 4 | node_modules inside the worktree, `resolveWithin` holds | `DEP4a`–`DEP4d` |
| 5 | failure → INFRASTRUCTURE_FAILURE, output in escalation, no half-built cache | `DEP5a`–`DEP5g` |
| 6 | runs through the supervisor: registry, bounded, killable | `DEP6a`–`DEP6f` |
| 7 | no lockfile / no install → method `none`, pays nothing | `DEP7a`–`DEP7c` |
| 8 | a check that died with `Cannot find module` now gives a verdict | `DEP8a`–`DEP8c` |
| 9 | pnpm path and npm hardlink path, method in the WORKTREE event | `DEP9a`–`DEP9i` |

Plus `DEP-DOC1`, `DEP-DOC2` (doctor) and `DEP-CLEAN1`, `DEP-CLEAN2`
(`zeus clean --deps`). 49 checks in `test/dependencies.ts`.

`DEP8` is the original finding reproduced and fixed **inside one test**: the
same check is run against the same worktree before and after preparation.
Before: `FAILED`, `Cannot find module 'tinydep'`. After: `COMPLETED`, exit 0.
`DEP8c` records the part that made the finding dangerous — both states are
`productSignal: true`, so an absent dependency was indistinguishable from a
failing test.

### Measurement — observed, not modelled

Fixture: 5 dependencies × ~80 files each, installed from tarballs inside the
project, entirely offline. Measured through the real engine by reading the
`setup.dependencies` span out of the latency report.

| | `setup.dependencies` | method | reused |
|---|---|---|---|
| first task | **1182.5 ms** | `install` | false |
| second task | **31.7 ms** | `hardlink` | true |

**Absolute delta 1150.8 ms. Ratio 37.3×.**

The in-suite fixture (1 dependency) measures 785 ms → 2 ms on the same path.

One honest note on ordering: the brief fixes the method order as pnpm-store
first. On this host `pnpm install --offline` costs ~700 ms where hardlinking
the prepared tree costs single-digit milliseconds, so for pnpm projects the
specified order is measurably the slower one. The order was followed as
specified; the numbers are recorded here so the choice can be revisited with
evidence rather than argued.

---

## Step 2 — real resource ceilings · DONE

**Commit** `358fb1b` · 630 → 649 tests, 0 failures.

### Diagnosis, in the order the brief specified

| Mechanism | Detected | Probed working | What it genuinely provides here |
|---|---|---|---|
| rlimit (`ulimit -v`) | yes | yes | one process's address space. **Not** the tree |
| container / no-systemd | n/a | — | not a container: KVM guest, `systemd` is pid 1 |
| systemd (system) | yes | yes | systemd 255 (255.4-1ubuntu8.17) |
| cgroup v2 | yes | yes | mounted at `/sys/fs/cgroup`; controllers `cpuset cpu io memory hugetlb pids rdma misc` |
| lingering | was **disabled** | now enabled | see below |
| systemd **user** manager | was inactive | now active | user manager active; its slice delegates `cpu memory pids` |
| systemd-scope | yes | **yes — verified inside a live scope** | memory, CPU and PID ceilings on the whole tree |
| memory, tree-wide | — | yes | `memory.max` observed holding at the requested value |
| CPU, tree-wide | — | yes | `cpu.max` observed as `50000 100000` for `CPUQuota=50%` |
| PID / process count | — | yes | `pids.max` observed at the requested `TasksMax` |

**Lingering was enabled tonight.** This is a persistent host configuration
change, so the exact command and result are on the record:

```
loginctl enable-linger "$USER"                 # run AS the service account; exit 0, no output
loginctl show-user "$USER" --property=Linger   # Linger=yes
systemctl start "user@$(id -u).service"        # then: active
```

It was run as the account itself, for that account only, per the brief. It was
attempted only after the read-only probes above returned unambiguous results;
no probe failed in a way that was not understood, so the probe-safety rule
never triggered.

### Why the host had been reporting "no systemd user manager"

Two separate causes, both real:

1. **No lingering**, so no user manager for a non-interactive account.
2. **`XDG_RUNTIME_DIR` is set by `pam_systemd` for interactive logins and by
   nothing else.** Zeus is normally started by a service manager, a cron entry
   or `su`. The variable is now derived when absent (`/run/user/<uid>`) and then
   *proved* by the probe — deriving it is not assuming it works.

### Backend truthfulness

`systemd-scope` is advertised only after a probe **creates a real transient
scope and reads `memory.max`, `pids.max` and `cpu.max` back from inside it**.
`enforces[]` is the list the kernel was seen holding, not the list the
mechanism supports. A scope that comes up **without** a memory ceiling makes
the backend *unavailable*: something that looks like containment and is not is
worse than nothing.

A second defect was fixed to make any of this reach the spawn: `systemd-run
--user` needs the user bus, and `buildEnv` filters by the **project's** policy
allowlist, so the variable was being stripped from the one command that needed
it. Wrapper environment is now applied after the allowlist, because it is
Zeus's own and not the project's. The same fix applies to stopping a unit.

### The adversarial aggregate-memory test

Six processes of ~80 MB inside a 256 MB scope. No single process is anywhere
near the ceiling; together they are at roughly 480 MB. This is precisely the
case per-process rlimit cannot honestly satisfy.

Result: contained in **~250 ms**, classified `RESOURCE_LIMIT_EXCEEDED`,
`productSignal: false`, backend `systemd-scope`, `isolationFallback: false`,
host responsive immediately afterwards (24.4 GB free), and `leader-finished`
never printed. `CG9`–`CG14`.

**Containment is classified by elimination, not by signal.** Measured: the same
overrun was contained twice with different signatures — `SIGKILL` when the
kernel OOM killer fired first, `SIGTERM` when systemd stopped the unit first.
Classifying on the signal alone reported containment as a *failing test* about
half the time, which surfaced as a flaky test under full-suite load rather than
in isolation. Under a scope, cancellation and the wall clock are both excluded
earlier, so a tree that goes down as a unit is a resource event.
`OOMPolicy=kill` was added so the tree goes down together rather than leaving
survivors behind a dead leader.

### Other tests

* Detection honesty: `CG1`–`CG7`. No backend advertises an enforcement it was
  not probed to hold; an available backend names at least one real guarantee;
  the wrapper claims nothing detection did not establish; `doctor` reports the
  same reality the wrapper acts on.
* Cleanup: `CG15`–`CG20`. No transient unit survives a normal exit, an explicit
  kill, or a supervisor crash — the crash case starts a second OS process,
  `SIGKILL`s it, and shows the run registry lets recovery reap the scope.

### The limitation that remains, and where it is stated

Tree-wide enforcement requires a systemd user manager, which for a
non-interactive account requires lingering. Where that is unavailable — a
container without systemd, or a host where the probe fails — Zeus keeps the
rlimit ceiling and **aggregate exhaustion by many small processes remains
possible**. Stated in `zeus doctor` (with `loginctl enable-linger` as the
remedy), in the README, and in `docs/AUDIT.md` under P0-1.

---

## Step 3 — redacting sink · DONE

**Commit** `91d981e` · 649 → 665 tests, 0 failures.

### The boundary, and why it covers every producer

**`EventStore.append()`.** It is the single function through which every event
in the product reaches disk: `Engine.record()`, the CLI's direct appends in
`revalidate`, the audit harness, and anything added later. `Engine.record()`
would have been the narrower-looking choice and the wrong one — it covers the
engine's own path only, and the CLI already appends around it.

Redaction runs on the **whole payload, recursively**, and **before `hashOf`**,
so the chain seals the redacted representation. That ordering is the point:
hash-then-redact would make every redaction a chain break, which is exactly why
the original leak had no clean remediation.

The three per-producer calls in `orchestrator.ts` were deleted. What remains
there is a re-export, not an application — `RS11` asserts statically that no
event producer calls `redactSecrets(` any more.

Not adopted from the proposal: the `Redacted<string>` type. It is a second,
weaker copy of a guarantee that runtime enforcement already gives
unconditionally — the compiler cannot see a payload assembled from `unknown`.
Optional in the brief; skipped deliberately, not overlooked.

### Coverage

**29 event types**, discovered from the candidate's own source by
`discoverEventTypes()` rather than declared. A hand-maintained list is a promise
about the code; this is a reading of it, and it fails when someone adds a type.

Found by running the discovery against itself: the first version picked up the
example in its **own doc comment** and reported an event type no producer
emits. Block comments are now stripped before scanning, and `RS1b` asserts every
discovered type traces to real code.

### Tests

`RS1`–`RS15` in `test/redaction.ts`. Load-bearing ones:

* `RS2` — no secret survives in any of the 29 types.
* `RS3` — coverage is complete: one event per discovered type, asserted by count.
* `RS5` — a type invented *after the test was written* is redacted anyway.
* `RS6` — **the hash chain verifies on a log freshly produced through the new
  sink**, not against a fixture written under the old per-site scheme.
* `RS7`/`RS9` — the sealed payload is the redacted one.
* `RS8` — every redaction is counted on the record; a silent redaction is
  indistinguishable from output that never contained anything.
* `RS13` — the assertion fails against a pass-through substitute.
* `RS15` — redaction returns a new structure and does not mutate the producer's.

**Probe `C-C7`** puts the same question in the release gate, deriving the type
list from the candidate's source, so an artifact is refused if any type leaks.
Lane C is now 7/7.

Static verification performed: `src/engine/orchestrator.ts`, `src/cli.ts` and
`src/engine/dependencies.ts` were searched for `redactSecrets(` calls; none
remain. `RS11` keeps it that way.

Target 9 closed in `audits/next-cycle-targets.md` and recorded as **P0-7** in
`docs/AUDIT.md`.

---

## Step 4 — read-only git · DONE (G-U2 closed)

**Commits** `8a46f88`, `67a94d9` · 665 → 695 tests, 0 failures.

### The boundary

`src/engine/gitro.ts`. A **strict allowlist**, refused before spawning, with
the stable code `GIT_WRITE_REFUSED_READONLY` and the attempted verb.

The audit entry had proposed listing the object-writing invocations. That would
have been a denylist, and git gains subcommands: such a list is wrong every
time it does, silently. `RO7` is the difference — an unknown or future
subcommand is refused *by default*.

### The allowed set, in full

`rev-parse`, `log`, `show`, `diff`, `status`, `ls-tree`, `ls-files`,
`cat-file`, `for-each-ref`, `branch --list`, `worktree list`, and `merge-tree`
without `--write-tree`.

`for-each-ref` is beyond the brief's list and was added deliberately: asking
"did the refs change?" is itself an inspection, and a read-only mode that
cannot answer it pushes callers back out to a raw git.

The allowlist is on the **form**, not the first word. Refused for every verb:
`--output` / `-o`, `--output-directory`, `--git-dir`, `--work-tree`,
`--namespace`, `--exec-path`, `-c`, `--config-env`, `-C`, `--ext-diff`,
`--textconv`, `--upload-pack`, `--receive-pack`, `--write-tree`.
`--no-optional-locks` is added by the context, because `git status` will
otherwise refresh and rewrite the index — a write nobody asked for in a mode
that promises none.

### Where it is applied

The self-audit's reads of the repository under audit, `revalidate`'s reads of
the project, and the engine's read of project HEAD. **Task worktree mutation is
deliberately not routed through it** (`RO29`) — that is where work is supposed
to happen. Read-only is a property of a *context*, not of git.

The probe the audit entry asked for was worth doing and answered yes:
`revalidate` read the project repository through the same callable it used to
rebase a worktree. Those are now two callables.

### Tests — `RO1`–`RO29` in `test/gitro.ts`

| Requirement | Test |
|---|---|
| write refusal — `git fetch` refused before spawning | `RO8`, **`RO9`** |
| repository immutability, before and after | **`RO14`**, `RO15`, **`RO17`** |
| allowed verbs still function | `RO18`–`RO25` |
| refusal names the attempted verb | `RO10` |
| stable refusal code | `RO11`, `RO12` |

`RO9` proves *before spawning* rather than asserting it: the runner takes a
spawn seam that records every attempt, and the list is empty. `RO14`/`RO17`
compare refs, HEAD, object count and `.git` directory contents before and after
**six real mutation attempts against a live repository** — `gc --aggressive`,
`fsck --lost-found`, `checkout -b`, `config`, `worktree add`, `reflog expire` —
because a refusal that fires while the write still lands is the failure worth
fearing.

### The gate caught a gap in this step

The `pre-push` gate **refused `8a46f88`**: probe `B-B1` reported `gitro.ts`
spawning outside the supervisor. It was right to. The suite invariant `N1` and
the audit probe `B1` ask the same question with two separate exemption lists,
and only one had been updated. `67a94d9` fixes the probe and additionally makes
`B1` report an exemption that no longer applies — a listed file that has
disappeared or stopped spawning is a hole nobody is watching, and the next file
to take that name inherits it silently.

**G-U2 final status in `docs/AUDIT.md`: closed**, with the test names above.

---

## Step 5 — unique check names · DONE

**Commit** `c36d468` · 695 → 697 tests, 0 failures.

### Why it matters

The gates refuse **by name**: `zeus self-check` parses `FAIL <name>` and puts
that name in front of the operator, and `docs/AUDIT-STATUS.json` maps each
finding to the tests that hold it closed.

### Measured and repaired

* **59 tokens** were claimed by checks in more than one file (a static count
  over 677 `check(` sites; an earlier rough count from a transcript said ~75).
* **171 checks renamed.** A token used in several files takes its suite prefix
  (`EN-`, `CLI-`, `VAL-`, `SEL-`, `SET-`); a token repeated inside one file
  keeps its first use and the rest take a deterministic ordinal. No description
  was touched and no semantics changed.
* `docs/AUDIT-STATUS.json` was rewritten by **exact-string replacement**, not by
  guessing, which is possible because that file records the whole name.

### The invariant — `UNIQ1`

Runs last, because it asserts about every check before it. It prints every
collision with the names that share the token. It immediately found **three
collisions no static reading could see**: `RI4` (8 checks), `BR17` (6) and
`R-C1` (5) are emitted from loops, so each literal appears once in the source
and several times in the run. Those loops now index their names.

**Final collision count: 0.** `UNIQ1: 695 checks, all distinct`.

### `UNIQ2`, and what it found

The other half of the same promise: a finding whose named regression test does
not exist is a closure nobody can verify. It found **10 unresolvable references
out of 93**:

* **2 were mine**, from this rename — the extraction saw a TypeScript escape
  where the JSON had the character, and one name was truncated at an em-dash.
* **8 were already stale.** `test/brand.ts` had been renumbered underneath
  them, and two entries (`RI4: forbidden kinds are refused (8 kinds)` and its
  `RI5` counterpart) were summary labels that were never check names at all.

Each was re-pointed at the check that makes the same assertion today, resolved
against the current suite rather than guessed. `UNIQ2: 97 reference(s) resolve`.

---

## Final repository state

* Initial SHA: `62c2516`
* Last work commit: `c36d468`
* Final SHA on `main`: the commit that adds this report, one after `c36d468`.
  A report cannot state its own hash; `git log -1` is the authority, and
  `git log c36d468..HEAD` should show exactly this file and nothing else.
* Remote branch pushed: `origin/main`
* Everything pushed: yes, through `pre-push` (self-check + all six audit lanes)

Overnight commits, in order:

```
e310579  prepare dependencies once per lockfile, not once per task
358fb1b  bound the process tree, not just one process
91d981e  redact at the sink, so a producer cannot forget
8a46f88  read-only git is an allowlist, not a promise (closes G-U2)
67a94d9  gate the harness the way the suite is gated
c36d468  one name, one check
<this>   overnight report: 2026-08-20
```

Exact final non-service test command:

```
node_modules/.bin/ts-node --transpile-only test/run.ts
```

Exact final result: **`zeus tests: 697 passed, 0 failed`** — 697 total, 0
failures, exit 0. `git status --short` is empty.

Test-count ledger: 581 before → 116 checks added → 697 after → 0 failures.

---

## Human Decisions / Escalations

Three items. None blocks anything; each is a decision that is the operator's
rather than mine.

### 1 — Lingering is now enabled on this host, permanently

**Context.** Step 2 required tree-wide resource enforcement. The host had
everything needed and was reporting none of it, because the service account
Zeus runs as had no lingering and therefore no systemd user manager.

**Current state.** `loginctl enable-linger` was run as that account, for that
account only, as the brief authorised. `Linger=yes`; the user manager is
active; Zeus now selects `systemd-scope` and gets real cgroup ceilings.

**The limitation this creates.** A lingering user manager persists across
reboots and logouts, which is the point, but it is a standing service the
operator did not previously have. It survives until `loginctl disable-linger` is run for that account.

**Decision needed.** Whether to keep it. **Options:** keep it (tree-wide
enforcement stays real); disable it (Zeus falls back to rlimit and says so in
`doctor`, README and `AUDIT.md` — aggregate exhaustion by many small processes
becomes possible again). **Recommendation, from evidence:** keep it. The
aggregate-memory shape is the one that took this host down, and `CG10` shows it
contained in ~250 ms only because the scope exists.

### 2 — Method order for pnpm projects is measurably the slower one

**Context.** The brief fixed the reuse order as pnpm-store, then hardlink, then
copy. It was implemented and followed as specified.

**Current state.** On this host `pnpm install --offline` from a warm store
costs ~700 ms; hardlinking the already-prepared tree costs single-digit
milliseconds. For pnpm projects Zeus therefore takes the slower of two correct
paths on every task after the first.

**Decision needed.** Whether to keep the specified order. **Options:** keep it
(pnpm's own mechanism, arguably more faithful to how a pnpm project expects its
`node_modules` to be built); or prefer hardlink for pnpm too and keep
pnpm-store as the fallback. **Recommendation:** measure once on a real
project — the fixture here has five dependencies, and the gap may narrow or
widen with a realistic tree. I did not change the order, because the brief set
it and the difference is a preference about faithfulness versus speed.

### 3 — `docs/AUDIT-STATUS.json` had rotted, and only now has a check

**Context.** `UNIQ2` found 8 pre-existing references naming tests that did not
exist — `test/brand.ts` had been renumbered underneath the file, and two
entries were summary labels rather than check names.

**Current state.** All 97 references resolve, and `UNIQ2` fails the suite if
that stops being true. The eight repairs were resolved against the current
suite by matching each entry's description to the check making the same
assertion.

**The risk.** Those mappings are my reading of intent, not a record of it. If
any is wrong, a finding in `docs/AUDIT.md` now points at a test that does not
actually hold it closed — which looks exactly like a correct closure.

**Decision needed.** Whether to spot-check the eight re-pointed references
against what those findings meant. **Options:** accept them (the descriptions
matched closely, and `UNIQ2` prevents recurrence); or review the P3-8 branding
entries in particular, which are where six of the eight were. **Recommendation:**
review P3-8's list once. It is ten minutes of reading, and it is the only place
in the night's work where I substituted judgement for a mechanical rule.

---

# Morning decisions — resolutions (2026-08-20)

The three decisions this report escalated were answered, plus a scoping check
on the Step 2 classification fix. Test count across all four: **697 → 704**, 0 failures.

## 1 — Lingering: KEEP

Recorded as a decision, not just a command, in `docs/AUDIT.md` beside the P0-1
aggregate-memory entry. The short version: the failure shape that took a host
down is contained *only while the user manager exists*, so disabling lingering
does not degrade Zeus gracefully — it silently returns the host to the state
the outage happened in. Reversal is a decision to accept that failure mode, not
cleanup.

## 2 — Reuse order: hardlink → pnpm-store → copy

Inverted from pnpm-first on the measured evidence: hardlinking a prepared tree
costs 2 ms (1-dependency fixture) to 31.7 ms (5 deps, 400 files) where
`pnpm install --frozen-lockfile --offline` costs ~700 ms, and that difference
is paid on every task after the first.

pnpm-store is not dead code — it is the fallback wherever hardlinks are
impossible, still feature-detected by making a link and comparing inodes rather
than by assuming. **Regression test 9's pnpm coverage survives on a genuinely
cross-device fixture**, not a simulated one: the worktree is created on `tmpfs`
(`/dev/shm`) while the cache stays on the project's filesystem, so the kernel
returns `EXDEV` for real.

| Test | Asserts |
|---|---|
| `DEP9c` | same filesystem → `hardlink` (the reorder itself) |
| `DEP9c2-host` | the host offers a second filesystem, so the fallback *can* be exercised — fails loudly rather than skipping |
| `DEP9c2` | across filesystems the hardlink is attempted and genuinely fails (`hardlink unavailable: EXDEV`) |
| `DEP9c3` | and `pnpm-store` is what makes that worktree runnable |
| `DEP9c4` | the fallback result is contained too — no symlink escapes the worktree |

`zeus doctor`'s `wouldUse` was updated to match; doctor predicting a method the
engine would not choose is worse than doctor saying nothing. The order and its
justification are recorded on the `PrepMethod` type and at the `WORKTREE`
record site, alongside the full field semantics.

## 3 — AUDIT-STATUS re-points: independent verification

41 references changed in Step 5. **25 were mechanical** — suite prefix added,
description byte-identical, identity preserved by construction. The remaining
**16 were semantic** and were re-verified against the current check bodies, not
their titles.

| # | Old reference | New reference(s) | Same assertion? |
|---|---|---|---|
| 1 | `L5: a crashed owner's lease is reclaimed` | `L5: … , and the takeover is stated` | **Yes** — same check, name was truncated |
| 2 | `TB10: … asks a human` | `TB10: … , not silently continues` | **Yes** — truncation |
| 3 | `TB12: budget usage survives a process restart` | `TB12: … (recomputed from the log)` | **Yes** — truncation |
| 4 | `S4c: the same holds under filesystem confinement` | `EN-S4c: … , where the wrapper hides it` | **Yes** — truncation + prefix |
| 5 | `RI4: forbidden kinds are refused (8 kinds)` | `RI4-1` … `RI4-8` | **Yes** — was a summary label, never a check name; 8 kinds ↔ 8 checks, one per forbidden kind |
| 6 | `RI5: … smuggled inside an allowed section is caught (6 cases)` | `RI5-1` … `RI5-6` | **Yes** — same; 6 cases ↔ 6 checks |
| 7 | `BR6: the package declares AGPL-3.0-only and ships a LICENSE` | `BR16: … and ships the licence` | **Yes** — renumbered, assertion identical (`license === 'AGPL-3.0-only'`, `files` includes LICENSE) |
| 8 | `BR7: the artifact contains the licence text` | `PB15: the artifact ships the AGPL licence` | **Yes** — the artifact-side claim moved to the boundary suite |
| 9 | `BR2: the CLI identifies itself as zeus` | `BR2: the CLI executable is zeus` + `BR3: zeus --help works and identifies the product` | **Yes** — one old claim, now split across the bin name and the help banner |
| 10 | `BR3: init creates .zeus/ and never .autopilot/` | `BR6: zeus init creates .zeus/ and never .autopilot/` | **Yes** — verbatim, renumbered |
| 11 | `BR4: user data and config paths are the Zeus ones` | `BR5b: user data and config live under zeus, XDG-respecting` | **Yes** |
| 12 | `BR5: the deprecation alias forwards and says so once` | `BR15b: it forwards …` + `BR15c: it says once, on stderr, …` | **Yes** — exact, both halves |
| 13 | `BR8: migration moves a legacy layout without destroying anything` | ~~`BR11` + `BR13d`~~ → `BR11` + `BR11b` + `BR11c` + `BR11d` | **NO — mismatch, corrected** (below) |
| 14 | `BR9: migration is idempotent` | `BR12: migration is idempotent — a second run finds nothing to do` | **Yes** |
| 15 | `BR10: a conflicting destination is reported, never overwritten` | `BR13` + `BR13b` (+ `BR13c` added) | **Yes** |
| 16 | `PB12: the release artifact carries no stale branding` | `PB13: the artifact carries no stale product branding` | **Yes** |

### The one mismatch — finding, not a silent re-fix

**Row 13.** `BR8: migration moves a legacy layout *without destroying
anything*` had been re-pointed at `BR11` (migration moves the directory) plus
`BR13d` (the legacy directory is never deleted).

`BR13d` is inside the **conflict** block. It asserts that the legacy directory
survives when migration is *refused* — which is the claim old `BR10` already
carried, and which says nothing about whether a migration that actually runs
preserves what it moves. The re-point named a real, passing check that verifies
a different property: precisely the shape that looks like a correct closure and
is not.

Corrected to `BR11b` (configuration survives), `BR11c` (the hash-chained event
log survives byte for byte) and `BR11d` (logs and evidence survive) — the
checks that assert nothing is destroyed. `BR13c` (neither copy is modified) was
also added beside `BR13`/`BR13b`, where it belongs.

**One mismatch in 16 semantic re-points.** It was in the P3-8 branding group,
which is where the review was directed and where six of the changes sat.

## 4 — Force-push: never

Added to `CONTRIBUTING.md` as **History is append-only**, and to the header of
`.githooks/pre-push` where an agent reading the gate will meet it. The rule
covers `--force-with-lease` on one's own just-pushed commits explicitly,
because that is the case with the persuasive excuse. The prior occurrence — the
overnight report amend of 2026-08-20 — is named as the incident that motivated
it, together with what should have been done instead.

No hook can enforce this; it is written in both places because it is a rule
people and agents keep rather than one a gate applies.

## Scoping check — the CG10 reclassification

**Question.** Step 2 reclassified `SIGTERM`/`143` under a systemd scope as
`RESOURCE_LIMIT_EXCEEDED`. Is that scoped to stops of the scope, or does a
project test that itself exits 143 get misclassified?

**Answer: it was mis-scoped, and it is fixed.** Reproduced before changing
anything — a script doing `echo bye; exit 143` under a scope was classified
`RESOURCE_LIMIT_EXCEEDED` with `productSignal: false`. Zeus refusing to believe
a test result the test had stated plainly. `128 + SIGTERM` is a common
convention for "I shut down on request", so this is not a contrived input.

**The fix.** The rule now keys on the **signal alone**: `code === 143` is gone.
An exit code is the program's own statement; a signal on our direct child is
something done *to* it.

**Nothing is lost, and this was measured rather than argued.** With
`OOMPolicy=kill` the whole scope goes down together, so real containment kills
our direct child too and arrives as `SIGKILL` or `SIGTERM` with a **null** exit
code — which is exactly what `CG10` observes. A 128+N exit code with a null
signal means a shell *survived* to report a child's death, which is not the
tree being stopped.

**Regression tests added** (none existed for this distinction):

* `CG21-143` — a project that exits 143 is `FAILED`, `productSignal: true`.
* `CG21-1` — the ordinary-failure control.
* `CG22` — the rule's shape: keys on the signal, and the `code === 143` clause
  cannot come back.

### One thing left open, and deliberately not changed

`code === 137` and `code === 139` are matched as `RESOURCE_LIMIT_EXCEEDED` for
**every** backend. That predates this work, and a project that chooses
`exit 137` is misclassified the same way `exit 143` was.

It was left alone because measurement says it is load-bearing, not vestigial:
an inner process killed by `SIGKILL` under a shell parent that does not `exec`
surfaces as **`code=137, signal=null` on all four backend combinations**
(scope±bwrap, rlimit±bwrap). That is the rlimit path's genuine OOM signature —
the kernel kills the runaway, its shell parent lives to report it. Removing the
clause would lose real OOM detection to fix a rarer misclassification, and
deciding that trade needs a discriminator neither exit codes nor signals
provide on their own. Recorded as next-cycle target 11 rather than guessed at
tonight.
