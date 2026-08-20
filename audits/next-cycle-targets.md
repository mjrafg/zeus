# Next-cycle targets

Derived from Audit Cycle 1 (`cycle-1` → `cycle-1-final`, candidate
`22e3c808d1c5`). Ranked, not scored: a list a person can work down, which is
all the targeting a lane-depth decision needs.

Targets 9 and 10 were added after cycle 1, from the `b4274f8` incident — a
secret-redaction regression that reached `origin/main` and the probe defect that
made it visible only downstream of the push. Findings arriving between cycles are
recorded here as they happen rather than held for the next Lane G pass.

Targets 8 and 9 are CLOSED as of 2026-08-20; their entries are kept in place
with the evidence rather than deleted, so the reasoning survives the fix.

`zeus self-audit` in a future cycle should read this file to bias depth toward
the areas below, and Lane G regenerates it at the end of every cycle.

## 1 — §10 change visibility, beyond the three shapes now covered  · HIGH

Cycle 1's most serious finding was that created and committed work was
invisible to validation. The fix covers modified, staged, untracked and
committed changes. It does **not** yet cover:

- submodule pointer changes;
- files git refuses to index (permissions, name encoding);
- changes made outside the worktree that the task nonetheless depends on;
- a worktree whose index the agent has itself manipulated (`git reset`,
  `--assume-unchanged`, a hostile `.gitignore` added mid-task).

The last one deserves a probe first: `.gitignore` written by the implementer is
currently honoured by `--intent-to-add`, so an agent can still hide a new file
by ignoring it.

## 2 — §28 secret leakage beyond recognisable shapes  · HIGH

Redaction now covers API keys, GitHub/Slack tokens, AWS ids, JWTs,
credentialed URLs, private-key blocks and `NAME=value` pairs, in both the
recorded output tail and the command line. It is a net, not a guarantee. Worth
probing next:

- secrets in a shape the net does not know (bare high-entropy strings);
- other event payloads that carry project text (findings, design output,
  review payloads, escalation evidence) — only CHECK_RESULT is redacted today;
- whether redaction should apply before the reviewer sees the diff.

## 3 — §31 attribution has no producer  · HIGH

`VALIDATION_MISS` / `SUSPECTED_FLAKE` classification is implemented and tested,
but nothing emits `REGRESSION_ATTRIBUTED`: there is no checkpoint runner. Until
one exists, `attributedRegressions` is structurally always zero and
`ZERO_TOUCH_CLEAN_RATE` measures only the intervention half of its definition.
This was declared NOT_TESTED in Lane D and is the largest known gap between
what the metric claims and what it can currently observe.

## 4 — §4 kernel-enforced resource limits  · MEDIUM

Declared NOT_TESTED in Lane B: this host selects the bubblewrap backend, which
gives filesystem and network confinement but no memory accounting, so the
memory cap is advisory here. Needs a host with a systemd user manager, or a
container, to exercise a real cgroup OOM kill.

## 5 — §25 hostile release archive  · MEDIUM

Declared NOT_TESTED in Lane E: resistance to a tarball containing `../` entries
was not exercised, because writing such an archive risks escaping the audit
sandbox on a shared host. Needs a disposable container.

## 6 — §34 concurrent multi-process append  · LOW

Declared NOT_TESTED in Lane A: the project lease makes two engines reaching one
event store unreachable through any supported path. Revisit if the lease is
ever relaxed, or if a second writer (a checkpoint runner, a UI) is added.

## 7 — probe quality itself  · MEDIUM

Three of eleven cycle-1 findings were defects in the probes, not in Zeus: a
probe that passed the wrong field name, a detector whose regex matched ordinary
code, and a fixture that modelled a project shape Zeus never creates. Two of
them survived a first round of fixes. A probe that reimplements the product
instead of calling it (the original D1/D2) is the most dangerous shape, because
it keeps reporting a defect that no longer exists.

Cycle 2 should add a meta-probe: every probe must touch the product's own
exported API, and a probe whose observed output does not change when the
relevant module is stubbed is not testing that module.

## 8 — a read-only mode that is enforced rather than promised  · CLOSED

From finding G-U2. A phase declared read-only was mutated by a command that
broke none of the stated prohibitions: `git fetch` into a temporary ref, which
imported 14 commits and two tags. `git fsck --lost-found` also wrote into
`.git/`. Both were caught by a manual re-check, not by the system.

Worth building: an inspection context that refuses object-writing git
invocations outright — fetch, gc, fsck --lost-found, reflog expire, notes,
config set, anything writing under `.git/` — and records the refusal. Worth
probing first: whether any existing Zeus code path performs a repository write
while presenting itself as inspection. `zeus revalidate` is the obvious
candidate, since it already rebases a worktree as part of answering a question
(finding F-F5 in this cycle).

**CLOSED 2026-08-20**, and built the other way round from the sketch above.
Listing the object-writing invocations would have been a denylist, and git
gains subcommands: such a list is wrong every time it does, silently. What
shipped is an **allowlist** in `src/engine/gitro.ts` — refuse before spawning
unless the FORM is known to be read-only — with `GIT_WRITE_REFUSED_READONLY`
and the attempted verb in the refusal.

The probe the entry asked for was worth doing and answered yes: `revalidate`
did read the project repository through the same callable it used to rebase a
worktree. Those are now two different callables, so the inspection half cannot
reach a write even by mistake. Task worktree mutation stays unconstrained,
which is the point — read-only is a property of a CONTEXT, not of git.

Held by `RO1`–`RO29` in `test/gitro.ts`; see `docs/AUDIT.md` for which ones
carry which part of the closure.

## 9 — redaction is per-path, so any new event path can silently lose it  · CLOSED

From the `b4274f8` incident. `CHECK_RESULT` redacts the command line it
records. The `CHECK_REFUSED` path, added days later in `80a362e`, recorded the
same command verbatim. Nothing failed: the suite was green, both commit gates
held, and the leak reached `origin/main`. Only lane C's probe found it, one
step downstream of publication.

The defect is not that one call site forgot `redactSecrets()`. It is that
forgetting is possible at all. Redaction lives at each call site, so the safe
behaviour is opt-in and the number of places that must opt in grows with every
event type. Target 2 already noted that only `CHECK_RESULT` is redacted; this
is the sharper version, with an incident behind it: the problem is not *which*
paths redact, it is that "which paths redact" is a question anyone can answer
wrongly by writing ordinary code.

**Proposed direction — one redacting sink.** Route every command and every
project-derived string through a single recording boundary, so that raw text
cannot reach the event store by any path:

- give the event store a typed payload boundary that accepts `Redacted<string>`
  for command lines, output tails, diffs and review payloads, and refuses a
  bare `string` at the type level;
- make `redactSecrets()` the only producer of that type, so the compiler names
  the omission instead of a probe finding it after publication;
- move redaction from the call sites to `record()`, and delete the per-site
  calls, so a new event path inherits the behaviour rather than re-declaring it;
- add a probe that writes a known secret through *every* event type the store
  accepts and asserts none of them reach `events.jsonl` — a check that scales
  with the schema rather than with the list someone remembered to write.

This was a design change to the recording boundary, not a patch, and it was
deliberately **not** applied as part of the fix that surfaced it. Constraining
a shape and repairing an instance are different work, and doing them in one
commit hides which one was verified.

**CLOSED 2026-08-20.** Redaction moved to `EventStore.append()` — the single
function through which every event in the product reaches disk: the engine's
`record()`, the CLI's direct appends, the audit harness, and anything added
later. It runs on the whole payload, recursively, **before** `hashOf`, so the
chain seals the redacted representation rather than requiring an edit that
would break it. The three per-producer calls in `orchestrator.ts` were deleted;
what remains there is a re-export, not an application.

What was NOT adopted from the proposal: the `Redacted<string>` type. It would
be a second, weaker copy of a guarantee that runtime enforcement already gives
unconditionally — the compiler cannot see a payload assembled from `unknown`,
and a type that is right most of the time next to a sink that is right always
is a maintenance cost with no coverage gain.

Held by, in `test/redaction.ts`:

| Test | What fails if it regresses |
|---|---|
| `RS1` / `RS1b` | the event-type inventory stops being read from the source (29 types found; the first version read its own doc comment and reported a type nobody emits) |
| `RS2` | any currently emitted event type persists a secret |
| `RS3` | coverage stops being complete — every discovered type must be exercised |
| `RS4` | redaction stops reaching nested objects and arrays |
| `RS5` | a NEWLY invented event type is not covered by default |
| `RS6` | the hash chain fails on a log freshly produced through the sink |
| `RS7` / `RS9` | the sealed payload is not the redacted one |
| `RS8` | a redaction becomes silent instead of counted |
| `RS10` | ordinary output is altered, or gains a spurious count |
| `RS11` | a producer starts redacting for itself again (static check) |
| `RS12` | the sink stops applying it |
| `RS13` | the assertion would pass against a pass-through substitute |
| `RS15` | redaction mutates the producer's own object |

And by probe **`C-C7`** in `audits/harness/lane-c.ts`, so the release gate
refuses an artifact in which any discovered event type leaks — the check that
would have caught the original regression before it was published rather than
after.

## 10 — probe C-C5 was measuring the wrong path  · HIGH

The same incident exposed a second defect, in the harness rather than the
product. Lane C's C-C5 probe called `engine.runCheck` directly to prove a
secret is redacted before it is recorded. Once the selection ledger landed,
that call was correctly *refused* — the check was not in the ledger — so the
probe was observing a `CHECK_REFUSED` record and asserting redaction against
it. It reported `secret present: true` for a real reason, but not the reason it
was written to test, and it would have reported the same thing had the
redaction it exists to guard been perfect.

A probe that still fails is the benign version. The dangerous version is the
same shape passing: a probe whose subject has moved underneath it, reporting
green about code it no longer reaches.

**Sweep, cycle 2.** Target 7 already asks for a meta-probe on probe quality;
this narrows it to a specific, checkable shape. Audit every probe in
`audits/harness/` for:

- calls into product internals that a policy, ledger or gate can now refuse —
  the probe must reach its subject through the same path a real task does, or
  assert explicitly that it is testing the refusal;
- assertions that pass or fail for more than one reason, where the probe cannot
  distinguish "the property holds" from "the property was never exercised";
- probes whose result does not change when the module under test is stubbed
  out — the stub test from target 7, applied to each probe individually rather
  than as a blanket rule.

Findings-so-far give the prior: three of eleven cycle-1 findings were probe
defects, and this makes four across two cycles. The harness needs the same
suspicion as the product, and it currently gets less, because nothing audits
the auditor.

## Telemetry inputs

No `VALIDATION_MISS`, `SUSPECTED_FLAKE` or `TEST_RELIABILITY` records existed at
the time of this cycle — see target 3 for why. No repeated escalation reasons
were available either: the escalation payload schema landed in the previous
change and no production task has since reached a human-attention state. Both
are stated here rather than omitted, so that a later reader can tell an empty
input apart from an input nobody looked at.
