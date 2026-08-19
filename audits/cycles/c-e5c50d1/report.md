# Zeus self-audit — cycle c-e5c50d1

Candidate `e5c50d17c3c6229f3771f455d3ad2167a03ab79d` · started 2026-08-19T14:12:13.375Z · finished 2026-08-19T14:12:14.460Z

## Verdict

**FINDINGS_OPEN**

The verdict is a statement about what was tested, not about what exists:

- 1 lane(s) ran 14 probe(s) against e5c50d17c3c6
- 11 probe(s) observed the invariant holding
- 3 finding(s) CONFIRMED by executable reproduction; 0 SUSPECTED (not reproduced)
- 3 unfixed P0/P1 finding(s) remain open
- 0 charter section(s) untested with no stated reason
- 0 lane(s) failed to complete
- the candidate has open findings or coverage gaps and is not cleared for installation

## Findings

| Severity | CONFIRMED | SUSPECTED | UNRESOLVED | REJECTED |
|----------|-----------|-----------|------------|----------|
| P0       | 2         | 0         | 0          | 0        |
| P1       | 1         | 0         | 0          | 0        |
| P2       | 0         | 0         | 0          | 0        |
| P3       | 0         | 0         | 0          | 0        |

CONFIRMED and SUSPECTED are counted separately and never added together: a CONFIRMED finding has an executable reproduction, a SUSPECTED one has an argument.

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

#### D-D3 — The reviewer's diff is silently truncated
**P1 · CONFIRMED** — sections §12, §10
The review payload contains diff.slice(0, 20000) with no marker saying the diff was cut. A change larger than that limit is reviewed on its first portion only, and the reviewer has no way to know it is looking at a fragment.
*Impact.* On any large change the reviewer can report "no findings" having seen a fraction of it, and that verdict is recorded as an independent review of the whole change. Reviewer independence is preserved while reviewer sufficiency is not, which is arguably worse: the result looks corroborated.
*Reproduction.* `audits/harness/lane-d.ts :: probe D3`
```
  reviewer diff section                : diff.slice(0, 20000)
  truncation announced to the reviewer : false
```

## Coverage matrix

| Lane | Section | Area                                             | Status | Probes / reason |
|------|---------|--------------------------------------------------|--------|-----------------|
| D    | §8      | Validation tier selection integrity              | TESTED | D4, D5, D14     |
| D    | §9      | Deterministic floor authority                    | TESTED | D6              |
| D    | §10     | Change visibility — what actually gets validated | TESTED | D1, D2          |
| D    | §11     | Evidence-chain integrity (anti-gaming)           | TESTED | D7, D8, D13     |
| D    | §12     | Reviewer independence enforcement                | TESTED | D3, D9          |
| D    | §13     | Acceptance semantics and outcome vocabulary      | TESTED | D10             |
| D    | §31     | Telemetry honesty                                | TESTED | D11             |
| D    | §35     | Escalation completeness                          | TESTED | D12             |

## Lanes

| Lane | Area                                           | Probes | Held | Findings | Duration | Complete |
|------|------------------------------------------------|--------|------|----------|----------|----------|
| D    | Validation / false-green / review independence | 14     | 11   | 3        | 0.9s     | true     |

