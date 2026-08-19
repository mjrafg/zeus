# Crash recovery policy

What Zeus does after the orchestrator dies mid-task, and why it is
deliberately conservative.

## The rule

**Missing output is not evidence that nothing happened.** A phase that started
and never finished may have changed files, spawned processes, or produced work
we simply did not record. Re-running it because the log looks incomplete is how
an autonomous tool duplicates side effects.

So the engine records intent *before* acting: an `AGENT_STARTED` with no
matching `AGENT_FINISHED` is the signature of a crash, and it stays visible.

## Phase classification

| Phase | Class | Why |
|---|---|---|
| **DESIGN** | `SAFE_AUTO_RETRY` | Read-only. The planner inspects source and returns a plan; running it again costs a call and changes nothing on disk. |
| **IMPLEMENT** | `REQUIRES_RECONCILIATION` | Side-effecting by definition. A crash can leave a partially edited worktree; re-running an implementer against its own half-finished edits produces work nobody reviewed. |
| **VERIFY** | `SAFE_AUTO_RESUME` | Checks are pure with respect to the repository. A killed test run can simply be run again — and its result was never committed to anything. |
| **REVIEW** | `SAFE_AUTO_RETRY` | The reviewer is read-only by policy (`writablePaths: []`). Its payload is rebuilt deterministically from the diff, so a retry reviews exactly the same thing. |
| **FIX** | `REQUIRES_RECONCILIATION` | Same reasoning as IMPLEMENT: it edits the worktree. |
| **FINAL_ACCEPTANCE** | `REQUIRES_RECONCILIATION` | It is the gate that decides whether work is done. Re-deriving that verdict from an unknown mid-crash state is exactly where a false acceptance would come from. |
| *merge / deploy* | `NEVER_AUTO_RESUME` | Not implemented in the engine at all. When they exist they are irreversible and must be a human decision after a crash. |

## What the engine actually does today

It does **not** auto-resume anything. On a crash the task keeps its last
recorded state, the worktree is left exactly as the agent left it, the event
log still verifies, and reconciliation is a human action.

That is a deliberate policy, not an unfinished feature. The two phases that
would benefit most from automation (`IMPLEMENT`, `FIX`) are precisely the two
that must not be replayed blindly, and automating only the safe ones
(`DESIGN`, `VERIFY`, `REVIEW`) buys little while adding a resume path that must
itself be correct after every future change.

**P1-6 is therefore recorded as `ACCEPTED_RISK / DELIBERATE_POLICY`**, not as
fixed. The residual cost is operator time after a crash. The alternative cost
is duplicated side effects on someone's repository, which is worse.

## What is guaranteed after a crash

* the dirty worktree is preserved, never reset;
* the event log verifies, or names precisely where it does not;
* a torn final line is quarantined rather than parsed as truth;
* an unfinished phase is visible as started-without-finish;
* task budgets are recomputed from the log, so a restart cannot reset them;
* the project lease is reclaimed only once the previous owner is demonstrably
  gone (PID liveness on the same host, expiry otherwise).

Regression tests: `C7`–`C10` (crash visibility, worktree preservation, log
integrity), `V3`/`V5` (torn line, `SIGKILL` mid-append), `TB12` (budgets across
restart), `L5`/`L6` (lease reclaim).
