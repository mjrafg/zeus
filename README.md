# Zeus

**Autonomous Software Engineering Orchestrator**

[![License: AGPL v3](https://img.shields.io/badge/License-AGPL%20v3-blue.svg)](LICENSE)

A portable AI software-engineering orchestrator for arbitrary Git repositories.

Zeus takes a task description and runs it through a structured pipeline:
one model plans it, another implements it, a third **independently** reviews the
result against current source, deterministic checks verify it, and only then is
the work accepted. Every step is bounded, isolated and recorded in a
hash-chained log, so what happened is a matter of evidence rather than of trust.

```bash
curl -fsSL https://raw.githubusercontent.com/mjrafg/zeus/main/install.sh | bash
# → checks this machine, shows what is missing, asks what to install, signs you in

cd /path/to/any/project
zeus init
zeus run "Fix the login validation bug"
```

## What it does

**Structured lifecycle.** `NEW → DESIGN → IMPLEMENT → VERIFY → REVIEW →
FINAL_ACCEPTANCE`, ending in an explicit terminal state. A task that cannot be
verified does not quietly become a success.

**Independent review.** The reviewer never receives the planner's reasoning,
the implementer's transcript, or any previous verdict. That separation is
enforced in code: the review payload is assembled under policy, hashed section
by section, and recorded. If forbidden material reaches it — even smuggled
inside an allowed section — the review is *invalidated*, not annotated.

**Honest outcomes.** The engine keeps apart the things that are usually
collapsed into "failed":

| Outcome | Meaning | Says something about your code? |
|---|---|---|
| `PASSED` | the check ran and succeeded | yes |
| `TEST_FAILED` | the check ran and failed | yes |
| `TEST_TIMEOUT` | exceeded its wall clock | no |
| `RESOURCE_LIMIT_EXCEEDED` | out of memory, PID cap, cgroup kill | no |
| `REQUIRED_TEST_NOT_RUN` | declared but never executed | no |
| `INFRASTRUCTURE_FAILURE` | toolchain missing, spawn failed | no |

Only `PASSED` lets acceptance continue. A missing compiler is never reported as
a failing test.

**Resource safety that does not depend on the model.** Every process is spawned
by one supervisor. Budgets are derived from the host, a share is reserved for
the control plane, and each execution gets a bounded slice of the rest — memory,
CPU quota, process cap, wall clock, and test-worker limits pushed into the
environment so your own `npm test` is bounded without rewriting it. A task that
forks a hundred workers is contained; the machine stays usable.

**Confinement, not good intentions.** Project commands run under filesystem
confinement with a read-only host, a writable worktree and no network. Paths are
resolved through symlinks before they are trusted, and credentials are stripped
from the environment a project command receives.

## Installation

```bash
curl -fsSL https://raw.githubusercontent.com/mjrafg/zeus/main/install.sh | bash
```

One command. The installer puts the CLI in `~/.local/bin` and the runtime in
`~/.local/share/zeus` — no root and no `sudo` — and then hands over to
the setup wizard.

Requirements before you start: Linux (macOS works, untuned), Node.js 18+ and
`git`. Everything else the wizard will offer to install.

### Setup

```bash
zeus setup                 # the full wizard
zeus setup dependencies    # tools only
zeus setup providers       # install and sign in to the AI providers
zeus setup --dry-run       # report what would happen; change nothing
zeus setup --non-interactive --json    # for scripts and CI
```

The wizard detects your system, prints an inventory, and then **asks**:

```
Required
  ✓ Git            2.43.0
  ✓ Node.js        18.16.1
  ✓ npm            9.5.1

AI providers
  ✗ Claude Code    not installed — plans and implements changes
  ✓ OpenAI Codex   0.147.0
      ✗ not authenticated

Recommended
  ! ripgrep        not installed — fast source search for the agents
```

Rules it does not break:

* **Nothing is installed without a yes.** Every command — including the exact
  `sudo` line — is printed before it runs, and refusing is a first-class answer.
* **`sudo npm install -g` is never run.** If the global npm prefix is not
  writable, Zeus redirects to your own `~/.local` prefix and tells you.
* **Sign-in belongs to the provider.** Zeus runs `claude auth login` or
  `codex login` with your terminal attached, then asks the vendor whether it
  worked. It never prompts for your password, never touches an OAuth token,
  never renders a login screen of its own, and never copies a credential into
  your project. On a headless box the vendor prints its own URL and code, and
  you finish in a browser anywhere.
* **Only roles are stored.** `.zeus/config.yaml` records *which provider
  reviews and which implements*. Credentials stay where the provider's own CLI
  keeps them.
* **No terminal means no guessing.** Under `--non-interactive`, in CI, or with
  no tty, setup reports and stops. It does not install, does not attempt OAuth,
  and does not read silence as consent.
* **It resumes.** If Claude installs and the Codex sign-in is interrupted,
  running `zeus setup` again continues from there instead of starting over.

Failure codes, which `--json` also reports: `DEPENDENCY_MISSING`,
`DEPENDENCY_VERSION_UNSUPPORTED`, `DEPENDENCY_INSTALL_FAILED`,
`AUTHENTICATION_REQUIRED`, `AUTHENTICATION_FAILED`, `PERMISSION_REQUIRED`,
`NO_PACKAGE_MANAGER`, `UNSUPPORTED_PLATFORM`.

Package managers understood for system packages: apt, dnf, yum, pacman, zypper,
apk and Homebrew. `zeus doctor` reports each provider as installed /
version / authenticated / role, so a machine that is not ready says so.

## Initialising a project

```bash
cd /path/to/project
zeus init
```

Zeus inspects the repository — **without executing anything from it** —
and writes `.zeus/config.yaml` plus git-ignored `state/` and `logs/`
directories. Nothing else in your source tree is touched, and the program itself
is never vendored into your project.

Supported project types: Node/TypeScript, Python, Java (Maven), Java/Kotlin
(Gradle), Go, Rust, and a generic Git fallback for everything else. Commands are
only offered when your project actually declares them; an invented `npm test`
that does not exist is worse than none.

## CLI

| Command | Purpose |
|---|---|
| `zeus setup [dependencies\|providers]` | interactive bootstrap: check, install with consent, sign in |
| `zeus init` | inspect the repository and create `.zeus/config.yaml` |
| `zeus doctor` | report what this machine can actually do |
| `zeus run "<task>"` | run a task through the full lifecycle (`--mock` for a dry run) |
| `zeus status` | task states in the current project |
| `zeus cancel <taskId>` | stop a task and its process tree |
| `zeus logs [taskId]` | the task's event log (`--follow` to tail) |
| `zeus config` | show, `get` or `set` a value in this project's configuration |
| `zeus revalidate <taskId>` | recheck a verified task against a moved integration target |
| `zeus version` | installed version |

## Configuration

`.zeus/config.yaml` is written by `init`, safe to edit and safe to commit;
runtime state stays git-ignored. Highlights:

```yaml
policy:
  autoMerge: false            # off by default — merging is a decision
  autoDeploy: false
  allowUnverifiedAcceptance: false   # a project with no tests cannot claim acceptance
resources:
  globalHeavyTestConcurrency: 1
  heavyTestTimeoutSeconds: 180
  maxTestWorkers: 2
providers:
  billing: subscription-cli-only     # no paid API-key fallback
```

Task-level ceilings (wall clock, agent invocations, design attempts, review and
repair cycles, provider time) are recomputed from the event log, so restarting
the orchestrator cannot reset a budget. Cost is only enforced when a provider
actually reports one — no token pricing is invented.

## Adaptive validation

Not every change deserves the same scrutiny, and pretending otherwise is how
teams end up disabling the checks. Zeus classifies each change and validates it
at the depth it earns — **FAST**, **NORMAL** or **DEEP**.

The classification is deterministic: ordered path rules and unified-diff
parsing, no model anywhere in the safety floor. And it is per *hunk*, not per
file, because the file is the level a diff can be gamed at:

```
Hunk 1  src/components/Header.tsx   UI label      → FAST
Hunk 2  src/lib/session.ts          session core  → DEEP
                                         result:  → DEEP
```

**The tier is the maximum over every hunk.** FAST is not "the diff looks
small"; FAST means every single hunk independently qualified. Bundling a
session change with a typo fix buys nothing.

**The deterministic floor is not part of the negotiation.** Required tests and
typecheck run at *every* tier, FAST included. A tier decides what runs on top,
never how much runs at all.

### Trusted autonomy

The point of all this is unattended work. That only pays off if an unattended
"done" can be believed, so the rules that make lying difficult are not
configurable:

* **Test-surface changes are a risk signal.** Any diff touching tests,
  snapshots, fixtures, assertions, test config or skip annotations is at
  minimum NORMAL, and the reviewer gets a dedicated section: *TEST SURFACE
  CHANGED: verify the modification is justified.*
* **Required tests are immutable.** A required test declared in task design
  cannot be deleted or renamed by the implementation. Attempting it is
  `REQUIRED_TEST_TAMPERED`, and no justification clears it — the contract is
  the contract.
* **Deleting or weakening a test needs a stated reason.** Not a general
  apology: a justification naming that path, in the design output. Otherwise
  the task blocks.
* **`.skip`, `.only`, `xit`, `@pytest.mark.skip`, `t.Skip` and friends** added
  to a previously passing test are surfaced to the reviewer explicitly.
* **The acceptance report never merges two different claims.** "Tests passed"
  and "tests this task edited, which then passed" are reported separately.
* **Uncertainty on a dangerous surface goes straight to DEEP.** Unknown impact
  confidence plus auth, schema, lockfile, CI or shared-core is not walked up a
  tier at a time.
* **The generic adapter cannot claim FAST** for anything but documentation-only
  or comment-only diffs, because it cannot compute real impact.
* **Reviewer expansion is bounded.** A reviewer may ask for more validation, but
  must name a concrete affected behaviour; "run everything to be safe" is
  rejected and recorded. Each grant costs a review cycle.
* **Flakes never masquerade as misses, or the reverse.** A checkpoint failure
  attributed to an earlier task is re-run in a clean environment: consistent
  failure is `VALIDATION_MISS`, intermittent is `SUSPECTED_FLAKE`, recorded
  against the *test* and never used to make the analyzer more conservative.

### Integration revalidation

A task verified against HEAD X and merged onto HEAD Y was never verified
against what it lands on:

```bash
zeus revalidate <taskId> --into main
```

Rebases, recomputes impact on the **rebased** diff, and escalates one tier if
that diff overlaps anything that moved in between. It stops before integrating
— merging stays a separate, explicitly enabled operation.

### The number that matters

```
ZERO_TOUCH_CLEAN_RATE  92%  (46/50 completed tasks: 0 interventions, 0 attributed regressions)
```

Shown by `zeus status`. Both halves are deliberate: a task that finished
untouched but caused a regression next week is not a success, and counting it
as one is the self-deception the metric exists to prevent.

When Zeus does need a person, the interruption carries what is needed to
resolve it in minutes — reason code, what was already tried, evidence
references, the one specific thing required, and what resumes automatically:

```
T-0042 blocked: the migration cannot run because the staging database URL is not available
  Tried: environment discovery; adapter configuration; the project .env file
  Needed: the staging DATABASE_URL — set it in the environment Zeus runs in
  On receipt: validation resumes automatically from the migration step
  Reason code: MISSING_CREDENTIAL
```

A bare "task needs attention" fails Zeus's own tests.

### Configuring it

```yaml
validation:
  strategy: fastest-safe
  hardening:
    mixedDiffMaxTier: true          # not disableable in v1
    testSurfaceRisk: true           # not disableable in v1
    unknownPlusRiskDirectDeep: true
    genericAdapterFloor: normal
    reviewerExpansionBudget: 2
```

The first two are listed for visibility, not for choice. Setting either to
`false` is a configuration **error** rather than a silent no-op, because being
ignored quietly is worse than being told.

## Where Zeus keeps things

| Path | Contents |
|---|---|
| `~/.local/bin/zeus` | the CLI |
| `~/.local/share/zeus/` | runtime, versioned installs, setup state |
| `~/.config/zeus/` | per-user configuration, when you add any |
| `<project>/.zeus/` | that project's `config.yaml`, `state/`, `logs/` |

All four respect `XDG_DATA_HOME` / `XDG_CONFIG_HOME`, and `ZEUS_HOME`
overrides the runtime location outright.

### Coming from a pre-rename install

Zeus was previously called AI Autopilot. If you have `.autopilot/` in a project
or `~/.local/share/ai-autopilot/` on your machine, Zeus notices and offers to
move it:

```
! Legacy Zeus configuration detected.
    /path/to/project/.autopilot  (config.yaml, state, logs)
  Migrate to .zeus/? [Y/n]
```

Answering yes renames the directory and rewrites the `paths:` entries in
`config.yaml`. Configuration, task state and the hash-chained evidence log all
come across intact, because the directory is moved rather than copied.

Nothing is destroyed. If both the old and new directories exist, Zeus reports
the conflict and touches neither — you decide which is authoritative. Running
the migration twice does nothing the second time. To do it deliberately rather
than on a prompt:

```bash
zeus init --migrate
```

The old `autopilot` command still exists as a temporary alias. It prints
`autopilot has been renamed to zeus; use \`zeus\`.` and forwards. Delete
`~/.local/bin/autopilot` whenever you like; nothing depends on it.

## Safety model

* **One spawn point.** No module launches a process except the supervisor; a
  test walks the sources and fails the build if one tries.
* **One owner per project.** An `O_EXCL` lease with a heartbeat prevents two
  orchestrators from corrupting the same state; a crashed owner's lease is
  reclaimed only once it is demonstrably gone.
* **Append-only evidence.** Events are hash-chained and `fsync`ed. Tampering is
  detectable, a torn final line from a crash is quarantined rather than parsed
  as truth, and corruption in the middle of a log raises instead of guessing.
* **Cancellation reaches the tree.** Running process groups are recorded on
  disk, so `zeus cancel` works from a different terminal than `run`.

## Recovery

Zeus does not automatically resume a crashed task. `docs/RECOVERY.md`
classifies every phase and explains why the side-effecting ones must not be
replayed blindly: the dirty worktree is preserved, the log still verifies, and
reconciliation is a human decision.

## Status

Pre-release. The engine, CLI, adapters, installer, setup wizard and safety
layers are implemented and tested; the multi-project Control Center UI is not
built yet. `docs/AUDIT.md` carries the current defect status, finding by
finding, with the regression tests that hold each one closed.

## Contributing

Bug reports, ideas and pull requests are welcome.
[`CONTRIBUTING.md`](CONTRIBUTING.md) covers the ground rules — the short version
is that safety boundaries are not negotiable, the runtime takes no third-party
dependencies, and every change brings a regression test.

Security issues go to [`SECURITY.md`](SECURITY.md), not to a public issue.

## Licence

[AGPL-3.0-only](LICENSE). Using Zeus on your own projects places no obligation
on your code — the licence covers Zeus itself, not what it writes for you.
Offering a modified Zeus to others over a network obliges you to offer them its
source. [`docs/LICENSING.md`](docs/LICENSING.md) has the detail.
