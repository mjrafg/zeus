# Latency baseline — raw run evidence

The per-run evidence behind [`docs/LATENCY-BASELINE.md`](../../docs/LATENCY-BASELINE.md).
Preserved here because it originally lived in `/tmp`, which does not survive a
reboot.

## What each run directory holds

| File | What it is |
|---|---|
| `events/<task>.jsonl` | the task's complete hash-chained event log, including the `LATENCY_SPANS` record with every span (name, parent, startNs, endNs) |
| `config.yaml` | the `.zeus/config.yaml` in force for that run, including the validation profile |
| `change.diff` | the change the implementer actually made, against the subject's base commit |

`subject/` is the subject repository's source at `978456e8d7ab`, so the diffs
can be read against what they modified.

## Runs

Seven measured runs across six clone directories. **T1-3 contains two tasks**:
`T-0001` is T1's third run, and `T-0002` is T5 — T5 deliberately reused T1's
clone to expose warm-versus-cold effects, so it has no directory of its own.

| Directory | Task | Tier |
|---|---|---|
| `T1-1`, `T1-2`, `T1-3/…T-0001` | T1 — trivial text change | FAST |
| `T2-1` | T2 — stylesheet-only change | FAST |
| `T3-1` | T3 — local behaviour change | NORMAL |
| `T4-1` | T4 — session module change | DEEP |
| `T1-3/…T-0002` | T5 — warm repeat of T1 | FAST |

## What was NOT copied, and why

This is a curated bundle, not a verbatim move. The original `/tmp` directories
could not be committed as they stood:

* **`node_modules`** was a symlink to the toolchain outside the directory.
  Copying it would commit a dangling symlink; following it would commit a
  dependency tree that has nothing to do with the measurement.
* **`.git`** — each run directory was itself a clone of the subject. Nesting
  those would have created gitlinks pointing at commits this repository does
  not contain.
* **`dist/`** — build output, regenerable from `subject/`.
* **`.zeus-cache/`** — npm debug logs written by the confined HOME. They appear
  in the raw `git diff` of each worktree and are excluded from `change.diff`,
  which is why that file shows only the source change.

Everything that constitutes evidence — the event logs, the configuration in
force, and the change that was measured — is here in full and unmodified. The
event logs were checked for machine-specific absolute paths before committing;
there were none.

## Reproducing

```bash
npx ts-node --transpile-only scripts/latency-baseline.ts --providers codex
```

The subject repository is regenerated from `scripts/latency-subject.ts` on each
invocation, so its commit SHA differs per run; the content is identical.
