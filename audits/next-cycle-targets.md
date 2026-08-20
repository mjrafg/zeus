# Next-cycle targets

Derived from Audit Cycle 1 (`cycle-1` → `cycle-1-final`, candidate
`22e3c808d1c5`). Ranked, not scored: a list a person can work down, which is
all the targeting a lane-depth decision needs.

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

## 8 — a read-only mode that is enforced rather than promised  · MEDIUM

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

## Telemetry inputs

No `VALIDATION_MISS`, `SUSPECTED_FLAKE` or `TEST_RELIABILITY` records existed at
the time of this cycle — see target 3 for why. No repeated escalation reasons
were available either: the escalation payload schema landed in the previous
change and no production task has since reached a human-attention state. Both
are stated here rather than omitted, so that a later reader can tell an empty
input apart from an input nobody looked at.
