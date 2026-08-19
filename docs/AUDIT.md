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
| **P0** | **0** | 0 | 0 | 4 | 2 |
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
