<!-- Thanks for contributing to Zeus. -->

## What this changes

<!-- One or two sentences. The diff says what; say why. -->

## Why

<!-- The problem this solves. Link the issue if there is one. -->

## Evidence

<!-- Paste the relevant output, not just an assertion that it passed. -->

- [ ] `npm run build` typechecks clean
- [ ] `npm test` is green, with no test removed, skipped or loosened
- [ ] `npm run package` passes the artifact scan
- [ ] a regression test is included that would have failed before this change

## Safety

- [ ] no resource budget, spawn point, execution policy, confinement,
      reviewer-independence or event-log guarantee was weakened
- [ ] nothing is installed, elevated or authenticated without explicit consent
- [ ] no credential is stored, logged, echoed or written into a project

<!-- If you ticked a box you had to think about, say why here. -->
