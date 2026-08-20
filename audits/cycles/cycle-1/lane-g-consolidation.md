# Lane G — consolidation, arbitration, dogfood

Audit Cycle 1 · candidate branch `audit/cycle-1` · starting SHA `7c48f78`

Lane G is where lanes stop being allowed to mark their own homework. Every
finding below carries a dispute outcome, and three of them were rejected —
against the lane that raised them — because the probe was wrong rather than the
product.

## Consolidated inventory

| # | Finding | Sev | Raised | Outcome | Disposition |
|---|---|---|---|---|---|
| 1 | Added files invisible to validation, integrity and review | P0 | D-D1 | CONFIRMED | fixed + regression |
| 2 | A committing implementer makes the whole change invisible | P0 | D-D2 | CONFIRMED | fixed + regression |
| 3 | The reviewer's diff is silently truncated | P1 | D-D3 | CONFIRMED | fixed + regression |
| 4 | Cancel kills any group whose number matches a stale record | P1 | B-B6 | CONFIRMED | fixed + regression |
| 5 | Command output copied verbatim into the permanent log | P1 | C-C5 | CONFIRMED | fixed + regression |
| 6 | Recursive chmod/chown on a system path not detected | P2 | C-C3 | CONFIRMED | fixed + regression |
| 7 | Empty-repo fallback clones .git and node_modules | P2 | F-F3 | CONFIRMED | fixed + regression |
| 8 | `zeus revalidate` mutates the worktree without saying so | P3 | F-F5 | CONFIRMED | fixed |
| 9 | A provider failure is reported as a task failure | P1 | G-dogfood | CONFIRMED | fixed + regression |
| 10 | The wall clock does not stop a hung command | P0 | B-B3 | **REJECTED_WITH_EVIDENCE** | probe defect |
| 11 | Repository contains instruction-shaped text | P2 | C-C6 | **REJECTED_WITH_EVIDENCE** | probe defect |
| 12 | Task state visible inside the task worktree | P1 | F-F2 | **REJECTED_WITH_EVIDENCE** | probe defect |

**CONFIRMED: 9. SUSPECTED: 0.** Counted separately and never summed. No finding
was recorded without a probe that ran and captured output, and nothing was
promoted on the strength of an argument.

## Disputes arbitrated

**#10 — "the wall clock does not stop a hung command" (P0 → rejected).**
Lane B observed `outcome=TIMEOUT` after 300 025 ms against a requested 2 000 ms
and concluded the wall clock was broken. It was not: the request field is
`timeoutSeconds`, the probe passed `timeoutMs`, and the supervisor correctly
applied its configured 300 s default for a light job. The wall clock fired, the
process tree died, nothing leaked. *Evidence:* the same probe with
`timeoutSeconds: 2` now completes in under 15 s and holds. The probe was
corrected; the product was not changed.

**#11 — "repository contains instruction-shaped text" (P2 → rejected).**
Lane C reported 13 injection-surface hits. Every one was its own regex: the
pattern `/SYSTEM:/i` fires on `operating system:`, `system: report.system` and
`confineFilesystem:`. A first correction anchored it with `^\s*…` and it still
matched indented object keys. *Evidence:* after requiring role markers to be
uppercase at column zero, and excluding the harness's own source, the scan
returns zero hits across 67 files. No injection surface exists in the
repository under the corrected detector.

**#12 — "task state visible inside the task worktree" (P1 → rejected).**
Lane F built a fixture that committed `.zeus/state` to git and then reported
that the worktree contained it. `zeus init` never creates that shape: it writes
`.zeus/.gitignore` containing `state/`, `logs/` and `worktrees/`, so state is
untracked and cannot appear in a worktree. *Evidence:* with a fixture modelled
on what `init` actually writes, the probe holds.

That three of twelve findings were defects in the auditor is itself the most
useful result of this cycle, and it is recorded as target 7 in
`next-cycle-targets.md`. Two of the three survived a first round of fixes. The
most dangerous shape was D1/D2 in their original form: they called `git diff`
directly instead of `Engine.diff()`, so they kept reporting the P0 after it was
fixed. A probe that reimplements the product tests nothing about the product.

## §36 — Zeus on Zeus

Run on a disposable clone of candidate `22e3c80`, never on the live runtime.

**Task.** Add and export `formatDuration(ms)` to `src/validation/telemetry.ts`
with tests — a small, real, independently checkable change.

**Zeus reported:** `FAILED` at DESIGN, reason `design failed`.

**Direct verification:** the identical planning prompt, run by hand in the same
worktree with the same CLI, returns a well-formed plan (`is_error: false`,
`subtype: success`). The task is plannable. Zeus's own event log recorded
`exitCode: 1`, `infrastructureFailure: null`, and — the telling part — a list of
the provider's response field *names* (`is_error`, `api_error_status`,
`subtype`, `terminal_reason`) with none of their values.

**Discrepancy triage.** This is the §36 case the charter is written for, in its
second-worst form: not a false COMPLETED, but a false attribution of blame.
`FAILED` is a product signal — it says the task could not be designed. The truth
was that Zeus could not run the planner. The classifier only pattern-matched
stdout for `429|529|overloaded|…` and ignored the structured error fields the
vendor CLI actually populates, so a provider-side failure was recorded as a
statement about the user's work. That contradicts the audit's own standing
claim (P1-7: provider failures never become task failures).

Fixed: `providerReportedError()` believes the provider's own verdict, and
`providerDiagnostics()` records the values rather than the key names, so the
next such failure is diagnosable without reproducing it. Eight regression tests
(`R-P1`–`R-P8`).

**Not resolved:** the underlying environmental cause of the planner's exit 1
inside the engine. The classification defect is fixed and tested; *why* the
confined invocation failed where the bare one succeeded is not established, and
is carried as an unresolved finding below rather than guessed at.

## Unresolved

**G-U1 — planner invocation fails inside the engine on a fresh clone (P1).**
*Impact:* real tasks on a newly cloned project may fail at DESIGN. After the
fix they now surface as `NEEDS_RECONCILIATION` with the provider's own error
fields attached, rather than as a false `FAILED` — so the operator is told the
truth and the diagnostics needed to chase it are recorded. The failure mode
itself remains open. *Next step:* re-run the dogfood with the diagnostics fix
in place and read `AGENT_FAILED.diagnostics`, which will now contain the values
that were missing this time. First target for Cycle 2.

**G-U2 — a read-only phase is enforced by instruction, not by policy (P2).**

Recorded because it was demonstrated, not theorised. A branch-inventory task was
declared read-only: no merge, rebase, push, commit, branch deletion. During it,
`git fetch <legacy-checkout> main:refs/tmp-legacy` was run to establish whether the
legacy repository shared history with this one. That command violated none of
the named prohibitions and was nevertheless a write: it copied 14 commits into
this repository's object store and created two tags (`extracted-baseline`,
`v0.0.0-extracted`) that this repository had never had. A second command,
`git fsck --lost-found`, wrote five files into `.git/lost-found/`.

Both were noticed and reverted — the tags deleted, the directory removed, the
starting state restored and verified — but only because the operator happened to
re-check the repository state afterwards. Nothing in Zeus noticed, refused, or
recorded any of it.

*Impact.* "Read-only" is currently a property of a prompt, not of the system.
The prohibition list enumerates the obvious mutations and misses everything
else: fetch, `fsck --lost-found`, `gc`, `reflog expire`, `notes add`,
`config set`, anything writing under `.git/`. An agent instructed to inspect a
repository can therefore mutate it while remaining literally compliant, and the
audit trail will show no sign. This is the same class of gap as the
change-visibility P0 from this cycle: the guarantee was believed because the
obvious paths were covered, and the unobvious one was not.

*Not fixed this cycle.* A real fix is a mode, not a rule — an inspection
context that refuses object-writing git invocations and fails loudly rather
than trusting the caller to have read the list. Carried as target 8 in
`next-cycle-targets.md`.

*Evidence.* The imported tags and their absence from `origin`
(`git ls-remote --tags origin` returned nothing for either), the 14 unreachable
legacy commits still resident in the object store, and the restored state
recorded in `docs/BRANCH-INVENTORY.md` §7.

## Verdict

`CANDIDATE_SAFE_TO_INSTALL` — 49 probes across six lanes, all holding, against
`22e3c80`; re-verified after every fix.

Stated as evidence, not confidence: **no additional defects were found under the
tested threat and failure model.** Five charter sections are recorded
`NOT_TESTED` with specific reasons and one `NOT_APPLICABLE`; those are holes in
the audit, not areas proved clean, and each is ranked in
`next-cycle-targets.md`. G-U1 remains open.
