---
title: "Restructure a Documentation Set in DocsFab"
description: "Reorganize existing documentation while preserving its content, routes, anchors, and reader entry points."
status: draft
content.type: how-to
---

Reorganize existing documentation while preserving its content, routes, anchors, and reader entry points.

## Prerequisites

Identify the immutable base revision, in-scope page set, and preservation requirements.

## Steps

Complete the following steps for the selected task.

1. State the desired placement and required routes, anchors, and content preservation in the instruction.
2. Run `docsfab run restructure-documentation --repo /absolute/path/to/repository --instruction "Reorganize the documentation while preserving existing content and routes."`. Use `--patch-only` for local patch delivery.
3. Inspect the preservation review and retained patch. A completed writer does not independently prove preservation.

## Restructure a Multi-Page Set

State the target shape and compatibility requirements in one instruction:

```text
Split the current deployment guide into overview, procedure, and recovery
pages. Preserve routes, anchors, and inbound links.
```

The audit and plan build a source-to-target map for the three-page set. The
writer then applies only that map, while it can retrieve supporting references
from the repository for context. Copied, renamed, and navigation paths are
part of the planned evidence and are not hidden side effects. If a required
target falls outside the map, the planner returns `needs-input` with reason
`ambiguous-scope` before mutation. Its response names the unmet obligation and
the required page or route. The runtime retains a bounded diagnostic and does
not invoke the writer; the normalized run summary does not retain the model's
full response text.

## Related

Use these topics for the supporting contracts and next actions.

- [Restructure Workflow Contract](../reference/workflow-contracts/restructure-documentation.md)
