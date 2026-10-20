---
title: Check Documentation Freshness in DocsFab
description: Run the advisory evidence-freshness check and inspect its retained report.
status: draft
content.type: how-to
---

Check whether the documentation still matches its registered evidence without rewriting canonical content.

## Prerequisites

Use a DocsFab source checkout and its registered source/model evidence. Strict mode requires a workflow that explicitly adopts freshness as a blocking gate.

## Steps

Run the advisory check from the DocsFab repository root:

```bash
python3 -m pip install -r packages/knowledge/skills/converge-documentation/requirements.txt
python3 packages/knowledge/skills/converge-documentation/scripts/check_freshness.py check
```

The `documentation:freshness` GitLab job runs the same check for relevant merge
requests, default-branch changes, and scheduled pipelines. It retains its JSON
report under `.docsfab/reports/` for fresh, stale, blocked, and malformed-input
results. That report is a machine-readable work queue for a subsequent agentic
convergence cycle; CI does not silently rewrite canonical evidence or invent an
approval. Receipt and report paths are constrained to checker-owned namespaces
so the command cannot overwrite product, documentation, or canonical evidence.
The top-level workflow and job use the same watched path families, including
all of `packages/`, so a runtime-only change cannot be filtered out before the
freshness job runs.

Set `DOCSFAB_FRESHNESS_STRICT=1` only for a workflow that has explicitly
adopted freshness as a blocking gate.


## Related

For watched paths, receipt fields, result states, and lineage rules, refer to [Documentation Convergence and Freshness](../reference/knowledge-and-delivery/delivery/documentation-convergence.md).
