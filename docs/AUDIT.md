# Audit

Reconciled against the current source. The machine-readable version — every
finding, its status and the named regression tests that hold it closed — is
`docs/AUDIT-STATUS.json`, which is the file to read programmatically. This
document explains the reasoning.

**Scope.** Findings apply to `src/`, the shipped runtime — which is all this
repository contains. Some findings were raised against an earlier prototype
that is not part of Zeus and is not in this repository; where the defect cannot
occur in the current design, the finding is marked OBSOLETE with the reason
rather than quietly dropped.

## Status

| Severity | OPEN | ACCEPTED_RISK | PARTIALLY_FIXED | FIXED | OBSOLETE |
|---|---|---|---|---|---|
| **P0** | **0** | 0 | 0 | 5 | 2 |
| **P1** | **0** | 1 | 0 | 5 | 4 |
| P3 | **0** | 0 | 0 | 3 | 0 |

Every FIXED item names the regression tests that would fail if the defect
returned; they are listed per finding in `docs/AUDIT-STATUS.json`.

## P0 — all closed

**P0-1 host exhaustion** (*observed in production*) → budgets derived from the
host with a control-plane reservation, per-execution memory/CPU/PID caps,
worker caps pushed into the environment and argv, wall clocks, process-group
and cgroup termination. A command that forks 100 children is bounded, all
descendants die, and the control plane keeps working.

*Aggregate memory, closed 2026-08-20.* The claim above was only ever true of a
single process while this host ran without a cgroup: `ulimit -v` bounds one
address space, so N workers each comfortably inside the ceiling could still
exhaust the machine together — the exact shape of the original outage. Three
things closed it:

  * **Detection now means operational capability.** `systemd-scope` is
    advertised only after a probe creates a real transient scope and reads
    `memory.max`, `pids.max` and `cpu.max` back from inside it. A scope that
    comes up without a memory ceiling makes the backend *unavailable*, because
    a backend that looks like containment and is not is worse than none.
    `XDG_RUNTIME_DIR` is derived when absent (`su`, cron and service managers
    do not set it) and then proved, never assumed — that alone was why this
    host reported "no systemd user manager" while having one.
  * **Containment is classified by elimination, not by signal.** The same
    256 MB aggregate overrun was contained twice with different signatures:
    SIGKILL when the kernel OOM killer fired first, SIGTERM when systemd
    stopped the unit first. Under a scope, cancellation and the wall clock are
    both excluded earlier, so a tree that goes down as a unit is a resource
    event. Classifying on the signal alone reported containment as a failing
    test about half the time.
  * **`OOMPolicy=kill`** takes the whole tree down when any member is
    OOM-killed, rather than leaving survivors behind a dead leader.

Held by `CG9`–`CG14` in `test/cgroup.ts`: six processes of ~80 MB inside a
256 MB scope, no single one near the ceiling, contained in ~250 ms, classified
`RESOURCE_LIMIT_EXCEEDED`, `productSignal` false, host responsive. Lifecycle by
`CG15`–`CG20`: no transient unit survives a normal exit, an explicit kill or a
supervisor crash. Detection honesty by `CG1`–`CG7`.

**This closure is host-conditional and says so.** Tree-wide enforcement
requires a systemd user manager, which requires lingering for a non-interactive
account (`loginctl enable-linger`). Where that is unavailable — a container
without systemd, a host where the probe fails — Zeus keeps the rlimit ceiling
and **aggregate exhaustion by many small processes remains possible**. That is
stated in `zeus doctor`, in the README, and here, rather than being left to the
reader to discover.

**P0-7 secret redaction is a boundary, not a habit** (*escaped to a public
remote before it was caught*) → the log is hash-chained and append-only, so a
secret written into it cannot be removed without breaking the chain. Redaction
used to live at each producer: `CHECK_RESULT` redacted its command and output,
a `CHECK_REFUSED` path added months later did not, and the leak was found by
the release audit one step DOWNSTREAM of the push. Nothing had failed — the
suite was green and both commit gates held — because the guarantee was opt-in
and the set of places that had to opt in grew with every event type.

It now lives in `EventStore.append()`, the single function through which every
event reaches disk, applied to the whole payload recursively and **before** the
event is hashed, so the chain seals the redacted form. An event type invented
later is covered by an author who never read the redaction module. Held by
`RS1`–`RS15` in `test/redaction.ts` — including `RS5`, which writes through a
type that did not exist when the test was written — and by probe `C-C7`, which
derives the event-type inventory from the candidate's own source so the release
gate fails when a new type leaks.

**G-U2 a read-only phase that was not** (*found by re-checking by hand, after
the fact*) → a phase Zeus declared read-only mutated the repository anyway:
`git fetch` into a temporary ref imported fourteen commits and two tags, and
`git fsck --lost-found` wrote into `.git/`. Neither broke a stated prohibition,
because the prohibitions were a list of forbidden things and these were not on
it.

Read-only is now an execution context with a strict **allowlist**, not a
description. `src/engine/gitro.ts` refuses anything not known to be read-only
**before spawning**, with the stable code `GIT_WRITE_REFUSED_READONLY` and the
attempted verb. A denylist was rejected deliberately: git grows subcommands,
and a denylist is wrong every time it does — silently. The allowlist is on the
FORM rather than the first word, because several permitted verbs become writes
with one option: `branch` without `--list` creates refs, `log --output=FILE`
and `diff --output=FILE` write files, `merge-tree --write-tree` writes objects,
and `-c`, `--ext-diff`, `--textconv`, `--git-dir` and `--work-tree` either run
programs or retarget the repository.

Applied to the inspection paths — the self-audit's reads of the repository
under audit, `revalidate`'s reads of the project, and the engine's read of
project HEAD. Task worktree mutation is deliberately NOT routed through it:
that is where work is supposed to happen.

Held by `RO1`–`RO29` in `test/gitro.ts`. The ones that matter most:
`RO6`/`RO7` (unknown and future subcommands refused by default — the property a
denylist cannot have), `RO8`–`RO13` (fetch refused, named, coded, and reported
to the caller), `RO9` (refused *before* a process is started, proved with a
spawn seam that records every attempt), and `RO14`/`RO17` — refs, HEAD, object
count and `.git` contents compared before and after six real mutation attempts
against a live repository, because a refusal that fires while the write still
lands is the failure worth fearing.

**P0-2 shell and filesystem confinement** → policy evaluated before every
spawn: symlink-aware containment, traversal and absolute-path refusal,
destructive/fork-bomb/persistence/env-poisoning detection, environment
allowlist with an always-deny secret list, and bubblewrap confinement for
project commands. Path rules apply to arguments; `argv[0]` is ours and is
validated by existence instead.

**P0-3 multi-instance safety** → `O_EXCL` project lease with heartbeat, TTL and
PID liveness, plus an event store that refuses duplicates, verifies its chain,
detects tampering, fsyncs each append and quarantines a torn final line.

**P0-4 / P0-5** OBSOLETE — the heavyweight suite runner and the deploy path do
not exist in this engine. Every check runs through the supervisor, which owns
the timeout and the process-group kill; acceptance ends at COMPLETED and
shipping is a separate, explicitly enabled operation.

**P0-6 cross-process cancellation** (*found by running the CLI, not the tests*)
→ an on-disk run registry records every process group, so `cancel` reaches work
started by a different invocation.

## P1 — none open

**FIXED**

* **P1-1 acceptance without verification.** A required check that does not run
  yields `REQUIRED_TEST_NOT_RUN`; a project with no executable verification
  cannot claim acceptance unless `policy.allowUnverifiedAcceptance` is set.
* **P1-3 task-level budgets.** Wall clock, agent invocations, design attempts,
  review and repair cycles, provider time, and cost *only when a provider
  actually reports it* — no invented token pricing. Usage is recomputed from
  the log, so a restart cannot reset a budget, and waiting in a queue is never
  counted as working. A breach emits `TASK_BUDGET_EXCEEDED` and stops at
  `AWAITING_HUMAN`.
* **P1-5 event-store scalability.** A durable per-task cursor removes the full
  rescan from `append`; any byte-length mismatch invalidates it and falls back
  to a scan rather than trusting a stale number. Durability guarantees are
  unchanged and still tested.
* **P1-7 provider and infrastructure failures** are classified apart from test
  failures, including a missing toolchain.
* **P1-10 reviewer independence is now mechanical.** The reviewer's payload is
  assembled under policy, hashed section by section and recorded. Forbidden
  *kinds* are refused, and a content scan catches forbidden material smuggled
  inside an allowed section — a diff containing `<thinking>`, a `PLAN:` block,
  an implementer transcript, a previous verdict or an adjudication. A violation
  **invalidates the review**: the prompt is never handed over. Self-report is
  reconciled against what was delivered, so a reviewer claiming context it
  never received is on the record.

**ACCEPTED_RISK**

* **P1-6 no automatic crash resume.** Classified per phase in
  `docs/RECOVERY.md`: DESIGN and REVIEW are read-only, VERIFY is repeatable,
  and IMPLEMENT/FIX/FINAL_ACCEPTANCE are side-effecting and must not be
  replayed blindly. Nothing auto-resumes. The cost is operator time after a
  crash; the alternative cost is duplicated side effects on a user's
  repository, which is worse. This is a decision, not an unfinished feature.

## P3

* **P3-5 task-id collisions — FIXED.** Ids carry the project
  (`project/T-0001`); the short label remains for humans.
* **P3-7 prototype code mistakable for runtime — FIXED.** The prototype is not
  in this repository at all. `PK3` fails if such a tree reappears, the package
  ships by allowlist rather than denylist, and `scripts/package.sh` inspects the
  artifact before it is written.
* **P3-3 no LICENSE — FIXED.** Zeus is AGPL-3.0-only. The full text is in
  `LICENSE`, `package.json` declares it, the release artifact ships it, and
  `docs/LICENSING.md` explains what it means for users, modifiers and
  contributors.

## Bootstrap and setup

`zeus setup` installs and authenticates the things Zeus depends on.
It is the one part of the product whose job is to change the user's machine, so
it is constrained more tightly than anything else:

* **Consent is explicit and per-action.** Detection is separated from action in
  code (`src/setup/deps.ts` detects, `src/setup/pkg.ts` acts), so the wizard can
  present a complete picture before asking. Every command — including the exact
  `sudo` line — is printed before it runs. Selecting a package is not consent to
  elevate; that is a second, separate question.
* **Privilege is never assumed.** `sudo npm install -g` is not executed under
  any circumstance. An unwritable global npm prefix is redirected to the user's
  own `~/.local` prefix rather than escalated, and the change is reported.
  Where root genuinely is needed and unavailable, the outcome is
  `PERMISSION_REQUIRED` with the command to run by hand — not a silent failure.
* **Credentials are the provider's, not ours.** Zeus runs the vendor's own
  login command with the terminal attached and then re-reads the vendor's own
  status command. It never prompts for a password, never parses or proxies an
  OAuth flow, never stores a token, and never renders a login screen. Only
  `loggedIn` and the authentication *method* are lifted out of the vendor's
  status output; the email address and organisation id it also returns are
  deliberately dropped. An API key, where a vendor supports one, is an explicit
  advanced choice, is read without echo, is passed on stdin only, and is never
  placed in an argument list, a log line or a file.
* **State holds configuration, never secrets.** `setup-state.json` (mode 0600)
  records which steps completed and which provider holds which role.
  `assertNoSecrets` refuses to write state matching a credential-shaped
  pattern, so a future edit that starts persisting one fails loudly.
* **Silence is not consent.** Without a terminal — CI, `--non-interactive`,
  `--json`, a pipe — setup reports and stops. It installs nothing, attempts no
  browser OAuth, and does not record an unasked question as a refusal.
* **It resumes.** Progress is recorded and detection re-runs from scratch, so an
  interrupted sign-in continues rather than reinstalling what is already there.

Every one of these is held by a test against a fake machine
(`test/setup.ts`, 64 checks). No test invokes a real provider login, so CI never
touches a paid or subscription authentication flow. Verified on a real host by
detection-only runs, which left both provider credential files byte-identical.

## Product identity

The product is **Zeus**. The rename from the earlier working name is complete
in every product-facing surface: CLI, installer, setup wizard, doctor output,
configuration, documentation, package metadata and the release artifact. Two
places name the old identity on purpose, and only those two:

* `src/migrate.ts`, which detects `.autopilot/` and
  `~/.local/share/ai-autopilot/` so a development install can be moved across;
* `bin/autopilot`, a deprecation shim that prints one line and forwards.

Both are covered by a scan in `scripts/package.sh` and by regression tests, so
stale branding anywhere else fails the build rather than reaching a user. Git
history was **not** rewritten: earlier commits keep their original wording.

Migration never destroys anything. A legacy directory is moved only when the
destination does not exist; if both exist, the conflict is reported and neither
copy is touched. Nothing is merged, overwritten or deleted, and running
migration twice is a no-op.

## Trusted autonomy

Adaptive validation exists to make unattended work affordable. Everything in
this section exists so that it does not also make unattended work
*untrustworthy*: each rule closes a path by which a green result could be
produced without the code actually being correct.

**The tier cannot be lowered by bundling.** Classification is per hunk and the
result is the maximum. A high-risk change packaged with a documentation edit
does not inherit the documentation edit's cheapness.

**The floor is outside the tier system.** Required checks run at FAST, NORMAL
and DEEP alike. `planFor` can only add; there is no code path by which a tier
decision removes a required check, and `F4` asserts it.

**The measuring instrument is protected.** Required tests declared in design
are immutable during implementation; test deletion and assertion weakening
need a per-path justification in the design output; disabling annotations are
surfaced to the reviewer; and the acceptance report separates "passed" from
"passed after this task edited the tests". These rules are deliberately outside
user configuration — a config that tries to disable one is a validation error,
not a preference.

**Uncertainty is not optimism.** An unparseable diff, a diff with no readable
hunks, and the generic adapter all produce UNKNOWN confidence, and UNKNOWN on a
high-risk surface goes directly to DEEP rather than climbing one tier at a
time.

**Feedback cannot be poisoned.** A post-acceptance failure is re-run in a clean
environment before it is attributed. Consistent failure is a VALIDATION_MISS
and counts against the task; intermittent failure is a SUSPECTED_FLAKE recorded
against the test, explicitly barred from influencing the impact analyzer. An
inconclusive retry leaves the original attribution standing, because "we could
not reproduce it" is not evidence of innocence.

**The reviewer strengthens evidence without an unbounded loop.** Expansion
requires a named behaviour, is deterministically assessed, costs a review
cycle, and is refused past budget. Repeated expansion producing no findings is
itself recorded.

**Integration is revalidated, not assumed.** `zeus revalidate` rebases,
recomputes impact on the rebased diff, and escalates one tier when that diff
overlaps what moved underneath it.

**Asking a human is treated as a cost.** Every human-attention exit carries a
structured payload — reason code, attempts, evidence references, the single
specific need, and the resume behaviour. An incomplete payload records
`ESCALATION_INCOMPLETE` against Zeus itself, and a bare "needs attention" fails
the test suite.

Two defects were found by writing these tests rather than by reasoning about
them: a CI-configuration path rule that was anchored so that nothing *inside*
`.github/workflows/` ever matched, and a generic-adapter floor that applied
silently when the tier already met it, making it invisible to anyone auditing
why the fast path was never taken. Both are fixed and covered.

## Outcome vocabulary

The engine keeps these apart on purpose, because collapsing them is how a tool
starts lying about the code it is testing:

| Outcome | Meaning | Product signal? |
|---|---|---|
| `PASSED` | the check ran and succeeded | yes |
| `TEST_FAILED` | the check ran and failed | yes |
| `TEST_TIMEOUT` | exceeded its wall clock | no |
| `RESOURCE_LIMIT_EXCEEDED` | OOM, PID cap, cgroup kill | no |
| `REQUIRED_TEST_NOT_RUN` | declared but never executed | no |
| `INFRASTRUCTURE_FAILURE` | toolchain missing, spawn failed | no |

Only `PASSED` allows acceptance to continue.
