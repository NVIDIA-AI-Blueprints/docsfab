---
title: "Create a Documentation Set in DocsFab"
description: "Create a new source-grounded page or coordinated page set and inspect the resulting documentation patch."
status: draft
content.type: how-to
---

Create a new source-grounded page or coordinated page set and inspect the resulting documentation patch.

## Prerequisites

Configure DocsFab, identify the target repository and audience, and retain source evidence for the requested behavior. For tracked files, follow [Select Source Evidence](select-sources.md).

## Steps

Complete the following steps for the selected task.

1. State the outcome, audience, and intended pages in the instruction.
2. Run `docsfab run create-documentation --repo /absolute/path/to/repository --instruction "Create a guide for the selected feature."`. Write workflows open a draft MR by default; add `--patch-only` for local patch delivery.
3. Inspect the saved run, patch, and quality findings before accepting the result. Follow [Supply Requested Work Products](supply-work-products.md) if source support is missing.

## Create a Multi-Page Set

Use one instruction when the approved outcome spans related pages. For example:

```text
Create a three-page onboarding set for the approved feature: an overview, a
setup procedure, and a troubleshooting page. Link the procedure from the
overview and use the approved API reference as the source.
```

The plan records three `create` dispositions and the source binding for each
page before the writer starts. The writer can retrieve the cited API reference
and other supporting evidence from the target checkout, but it can mutate only
those three planned pages (and an explicitly planned navigation path). A
request that needs a fourth page stops with a typed scope or input result
before patch creation. It does not broaden the prompt or the mutation set.

Each source in a page's binding is a repository-relative file path. The path
can be followed by a `:line`, `:start-end`, or `#section` coordinate and can end
with `@` and the run's exact repository revision, for example
`src/cli.ts:10-42@<revision>`. A coordinate is claim evidence: the host still
reads and verifies the whole file. The host also accepts the revision written
before the coordinate and records it after the coordinate. Any other form, or
another revision, is refused when the plan is admitted, and the planner is
asked for a corrected plan within the step's retry budget. The attempt records
`plan-source-locator-grammar` or `plan-source-locator-revision-mismatch`.
Source-obligation derivation reads the same grammar, so an admitted plan does
not fail later on its sources.

## Related

Use these topics for the supporting contracts and next actions.

- [Create Workflow Contract](../reference/workflow-contracts/create-documentation.md)
- [Bind a Local Commit Range](bind-commit-range.md)
- [Bind a GitHub Change](bind-github-change.md)
