---
title: "Compare Completed Composition Runs in DocsFab"
description: "Compare retained composition-execution evidence without calling a provider."
status: draft
content.type: how-to
---

Compare retained composition-execution evidence without calling a provider.

## Compare Completed Composition Runs

After running the same write workflow against the same frozen fixture
with two or more compositions, compare their private run records without
another model request:

```bash
docsfab composition compare \
  --record /absolute/private/run-openai.json \
  --record /absolute/private/run-anthropic.json
```

The comparator accepts 2–8 successful composition-execution publication records. It
revalidates each record against the installed composition package and
requires the same workflow, repository revision, task or instruction,
quality pack, skills, context inputs, and budgets. It reports duration,
tokens, turns, tool activity, and product disposition. The current strict
publication-record slice does not carry comparable quality-efficacy
scores, so it reports efficacy as unavailable and never selects a winner.
Parked names such as `bootstrap`, `foundation`, and `ia` fail closed until
a catalog skill exists.

### Provider-Offline Run Comparison

`docsfab composition compare --record <absolute-path> --record
<absolute-path> [--record …] [--json]` compares 2–8 successful composition-execution
publication records. It requires identical fixture and budget bindings and
revalidates every composition against the installed package. The report is
credential-free and content-minimized. Performance metrics are available;
quality efficacy and a winner remain explicitly unavailable until a strict
general evaluation-record decoder supplies comparable quality evidence.

Technical profile approval verifies deployment facts and authority. Workflow
qualification separately measures suitability for writing, review, judge,
audit, or retrieval. Refer to [Model-Profile Approval in DocsFab](../reference/status-and-configuration/model-profile-approval.md).
