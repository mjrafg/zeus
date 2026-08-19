# Security policy

Zeus executes model-generated changes and project commands on a developer's
machine. A security defect here is not theoretical, so please report one
privately rather than in a public issue.

## Reporting

Use GitHub's private reporting — **Security → Report a vulnerability** on
<https://github.com/mjrafg/zeus> — or email <mjrafg2@gmail.com>.

Please include: what you did, what happened, what you expected, and the commit
or release you tested. A proof of concept helps enormously; a minimal one that
demonstrates the boundary being crossed is ideal.

You should get an acknowledgement within 72 hours and an assessment within
seven days. Please give a fix a reasonable window before disclosing publicly.
Credit is given by default; tell us if you would rather stay anonymous.

## Supported versions

Pre-release. Fixes land on `main`; there is no maintained release branch yet.

## What counts

Especially interesting:

* escaping the worktree — path traversal, symlink tricks, anything that lets a
  project command write outside its own worktree
* escaping filesystem or network confinement
* a credential reaching a project command's environment, a log, an event
  payload, a review payload, or the setup state file
* defeating resource governance, so one task can exhaust the host
* forging, silently rewriting or truncating the hash-chained event log
* smuggling forbidden context past the reviewer-independence gate
* privilege escalation from the installer or the setup wizard, including any
  path that reaches `sudo` without an explicit yes

Out of scope: findings that require the attacker to already control the machine
Zeus runs on, or that only affect an external provider CLI. Report those to the
relevant vendor.

## What Zeus assumes

Zeus trusts the machine it runs on and the person who ran it. It does **not**
trust the repository it is working in, the output of a model, or a project's
own build and test scripts — those run under policy and confinement.
