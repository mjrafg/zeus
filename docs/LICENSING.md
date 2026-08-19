# Licensing

Zeus is licensed **AGPL-3.0-only**. The full text is in [`LICENSE`](../LICENSE),
and `package.json` declares `"license": "AGPL-3.0-only"`.

## Why AGPL

Zeus is infrastructure that can be run as a service. The AGPL's network clause
is the point: if someone offers Zeus to others over a network, the people using
it are entitled to the source of the version they are using. A permissive
licence would not carry that.

## What this means for you

* **Using Zeus on your own projects** places no obligation on the code Zeus
  writes for you. Your repository is your work; Zeus is a tool that ran on it.
  The AGPL covers Zeus itself, not its output.
* **Modifying Zeus and running it privately** is fine and requires nothing.
* **Modifying Zeus and offering it to others** — as a hosted service or a
  distributed binary — obliges you to offer those users the corresponding
  source of your modified version, under the same licence.
* **Contributions** are accepted under AGPL-3.0-only. See
  [`CONTRIBUTING.md`](../CONTRIBUTING.md).

## Third-party code

The runtime has **zero third-party npm dependencies** and imports only Node
built-ins, so no third-party terms attach to what ships. Development
dependencies (TypeScript, ts-node, `@types/node`) are not distributed in the
release artifact.

Anything added later that carries its own terms must be recorded here with
those terms preserved.

## External programs

Zeus invokes provider CLIs and optional tools as **separate processes** — it
does not link their code, and their own terms govern their use. Zeus never
embeds, redistributes or wraps a provider's credentials.
