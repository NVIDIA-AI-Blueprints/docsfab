---
title: Knowledge Contracts in DocsFab
description: Look up DocsFab knowledge commands, source-thread records, and reference-model artifacts.
status: draft
---

Use these references when you need an exact local DocsFab knowledge command,
evidence lineage record, or immutable synthesized model package. Executable
schemas and validators remain authoritative when they differ from the prose.
For more information, refer to [DocsFab Knowledge and Delivery
Reference](../index.md).

## Reference Topics

| Topic | Use it to | Canonical artifact |
| --- | --- | --- |
| [DocsFab Knowledge CLI](knowledge-cli.md) | Operate the local, single-process control plane. | Event-store state and deterministic Markdown exports. |
| [Source-Thread Registry in DocsFab](source-thread-registry.md) | Preserve one origin's items, representations, lineage, and event history. | Versioned JSON records plus an append-only JSON Lines ledger. |
| [Reference-Model Package in DocsFab](reference-model-package.md) | Inspect one synthesis result and its decision history. | Immutable version directory plus append-only `history.md`. |

Use the source-thread registry before synthesis. A generated source-thread
view is not a reference-model version, and neither artifact grants release
approval.
