# Contributing to Zeus

Zeus runs models against other people's repositories with real resource
limits, real sandboxing and an append-only evidence log. That shapes what a
good contribution looks like more than any style rule does.

## Ground rules

**Never weaken a safety boundary to make something pass.** Resource budgets,
the single spawn point, execution policy, filesystem confinement, reviewer
independence and the hash-chained event log exist because each of them closed a
real defect. If one is in your way, say so in the issue — do not route around
it in a pull request.

**No third-party runtime dependencies.** `src/` imports Node built-ins and
nothing else. Development dependencies (TypeScript, ts-node) are fine.

**Outcomes stay honest.** A missing toolchain is `INFRASTRUCTURE_FAILURE`, not
a failing test. A task that verified nothing does not become a success. If you
add a code path that can end a task, decide deliberately which outcome it maps
to.

**Never install, elevate or authenticate without consent.** The setup wizard
prints every command before it runs, refuses to shell out to `sudo npm`, and
treats silence as a refusal. New setup behaviour must hold the same line.

**Never handle a credential.** Zeus launches a provider's own login flow and
reads that provider's own status command. It does not prompt for passwords,
store tokens, or copy credentials into a project.

## Getting set up

```bash
git clone https://github.com/mjrafg/zeus.git
cd zeus
npm install
npm test
```

The suite needs no network and calls no model. Every provider interaction in
the tests goes through an injectable probe against a fake machine.

## Before you open a pull request

```bash
npm run build     # must typecheck clean
npm test          # must be green, with no test removed or skipped
npm run package   # the artifact scan must pass
```

Add a regression test that would have failed before your change. For a defect,
name it after the failure, not the fix.

## Commit messages

Conventional-commit prefixes (`feat:`, `fix:`, `docs:`, `refactor:`, `test:`,
`chore:`). Explain *why* in the body — the diff already says what.

Commits carry a human author. A hook in `.githooks/commit-msg` rejects AI
attribution trailers; enable it with `git config core.hooksPath .githooks`.

The hooks gate commits (`pre-commit`), merge commits (`pre-merge-commit`) and
publication (`pre-push`). Never bypass one with `--no-verify`: if a gate is
wrong, fix the gate.

## History is append-only

**Force-push is never used on this repository.** Not `--force`, and not
`--force-with-lease` — including on commits you pushed yourself, minutes ago,
that nobody has pulled.

An incorrect commit is corrected by **a new commit**. A wrong number in a
document, a typo in a message, a file that should not have been included: all
of these are fixed forward. The published history is a record of what happened,
and a record that gets edited to look tidier is worth less than one that shows
a correction being made.

This applies to agents as much as to people. The rule exists because of a
specific incident: on 2026-08-20 an overnight report was committed stating
`Final SHA on main: c36d468`, which stopped being true the moment the report
itself was committed. The fix was an amend and a `--force-with-lease`, replacing
a commit that had been on the remote for a few minutes. Nothing was lost and
the gates ran in full both times — which is exactly why it is worth writing
down. The reasoning that permits it ("my own commit, just pushed, no one has
it") is available for every force-push anyone ever wants to do, and a rule that
holds only when the reasoning is inconvenient is not a rule.

What to do instead, for that case: state the last work commit and describe the
report's own commit relatively, or correct it in a follow-up commit.

## Reporting security issues

Do not open a public issue. See [SECURITY.md](SECURITY.md).

## Licence

Contributions are accepted under [AGPL-3.0-only](LICENSE), the licence this
project ships under.
