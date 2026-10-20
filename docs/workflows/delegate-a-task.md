---
title: "Delegate a Local Task in DocsFab"
description: "Use the explicit delegated pilot for one finite local documentation task."
status: draft
content.type: how-to
---

Use the explicit delegated pilot for one finite local documentation task.

## Prerequisites

Use the explicitly enabled delegated pilot and an owner-private state directory. Choose one finite local documentation task; remote publication is unsupported.

## Delegated Do Pilot

`docsfab do --delegate "<outcome request>"` starts one fresh finite
delegated task. Bare `do` keeps catalog workflow routing. `--delegate` is
not a staging switch toward a new default.

Pass `--repo` for the local checkout. The task uses the current committed
HEAD. `--check`, `--json`, `--quiet`, and `--no-input` are supported.
`--no-input` never prints a `You:` prompt.

`--check <npm-script>` names one check; repeat it per script. The pilot
runs `npm run <npm-script>` in the repository after the driver, and the
script must be an entry under `scripts` in the repository's root
`package.json`. The request text never chooses a check. An undeclared
script, a missing or malformed `package.json`, or a duplicated name
refuses with code `cli-usage` before the task starts. The script runs with
`CI=1` and without DocsFab's keys and tokens in its environment; refer to
[Check Scripts](../reference/security-and-trust.md#check-scripts). Resume only that
exact task, and pass the paused run's `--check` flags again:

```bash
docsfab do --resume <task-id> --answers /absolute/path/to/answers.json
```

`--resume` records the answers and continues the delegated driver for
that same task id. The task stays `needs-input` until that driver finishes.
There is no most-recent lookup, TTY requirement,
trailing prompt, silent catalog fallback, or inherited historical grant.
`--allow-write` requests local documentation changes. Until issues #758
and #779 land, that flag fail-closes with a typed nonzero stop instead of
completing a read-only run. Remote publication is unsupported.
`--revision`, `--patch-only`, `--draft-mr`, `--comment-mr`, `--remote`,
and `--instruction` reject on the delegated path until their exact
meaning is preserved. `--route-only` and `--dry-run` keep catalog
no-agent behavior and cannot combine with `--delegate`.

A complete finished task exits 0. `needs-input` exits 2. Other incomplete
terminals are typed and nonzero.

Mechanical task reconciliation on the delegated and live-agent paths is
internal. It does not add a public SDK, store, or scheduler. The host
admits inspect and recount through existing tools. A model-stated page
count or an incomplete canonical inventory is not inventory evidence. A
succeeded child workflow does not complete the task while a required check
is still `not-run`. When the optional trusted continuation and process facts are
supplied, a latest continuation without process evidence has unknown effect
certainty and the helper refuses dispatch, continue, or replay; inspection
remains available. Current production assemblies do not yet supply those
optional facts, so this composition remains unfinished under #938. Root task budget, task scope, and interactive-operation
fields stay unknown until issue #779 releases those APIs; a child run cannot
invent a nested budget owner.
