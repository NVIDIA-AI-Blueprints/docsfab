---
title: DocsFab Knowledge CLI
description: Look up commands and options for the local DocsFab knowledge-gathering control plane.
status: draft
---

The DocsFab knowledge command-line interface (CLI) operates the local,
single-process control plane. For more information, refer to [Knowledge
Contracts in DocsFab](index.md).

Run the knowledge CLI from the DocsFab repository root.

```bash
node packages/knowledge/src/cli.mjs <command> [options]
```

The server binds only to loopback. It is not an authenticated production
service. Every mutation requires the exact current stream version.

## Choose a Command

| Need | Command |
| --- | --- |
| Inspect usage and the control-plane boundary. | `help` |
| Start the loopback control plane. | `serve` |
| Inspect reconstructed state or the underlying ledger. | `state` or `events` |
| Submit one optimistic-concurrency mutation. | `command` |
| Produce a deterministic Markdown projection. | `export` |

## Commands

| Command | Required options | Optional options | Purpose |
| --- | --- | --- | --- |
| `help` | None | None | Display command usage and the control-plane boundary. |
| `serve` | `--data PATH` | `--port PORT` | Start the loopback HTTP server. The default port is `4310`. |
| `state` | `--data PATH` | None | Print the reconstructed canonical state as JSON. |
| `events` | `--data PATH` | None | Print the append-only event stream as JSON. |
| `command` | `--data PATH`, `--name NAME`, `--expected-version N`, `--actor NAME`, `--input JSON` | None | Submit one version-bound state mutation. |
| `export` | `--data PATH`, `--kind KIND`, `--id ID` | `--version ID` | Render a deterministic Markdown projection. |

## Export Kinds

The `--kind` option accepts the following values:

| Value | Output |
| --- | --- |
| `shared-model` | A selected shared model and optional version |
| `documentation-brief` | A documentation-readiness and planning brief |
| `workflow` | A workflow record |

An unknown export kind fails instead of returning an empty projection.

## Versioned Mutations

Before you submit `command`, read the current state and use its `version` as
`--expected-version`. If another accepted command advances the stream first,
the stale command fails. Reload the state, review the intervening event, and
reconstruct the mutation only if it remains valid.

## Data Directory

The `--data` path contains control-plane runtime state. Choose an explicit,
access-controlled directory. Do not place provider credentials in that
directory, command input, event records, or exported artifacts.

## Authoritative Sources

- [Knowledge CLI implementation](../../../../packages/knowledge/src/cli.mjs)
- [Local server implementation](../../../../packages/knowledge/src/server.mjs)
- [Knowledge event-store tests](../../../../packages/knowledge/tests/store-backend.test.mjs)

## Related Topics

- [Gather Product Knowledge](../../../workflows/index.md#gather-product-knowledge)
