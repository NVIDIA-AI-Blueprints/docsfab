---
name: assess-documentation-readiness
description: Assess an immutable repository as documentation input, or interpret host-governed public release-documentation evidence. Preserve incomplete searches and unknown decisions. Return an evidence-backed assessment and non-mutating work recommendations; do not authorize publication or infer readiness from a successful model call.
license: Apache-2.0 AND CC-BY-4.0
allowed-tools: Read Grep Glob
metadata:
  author: DocsFab contributors
  version: 1.0.0
---

# Assess Documentation Readiness

Use the readiness surface selected by the workflow. Remain read-only. Report
what the bound revision and admitted evidence establish, what remains unknown,
and which concrete documentation work would address the gaps.

## Required Inputs

- The selected workflow: source `readiness` or
  `release-documentation-readiness`.
- The immutable repository revision and declared documentation scope.
- The host-provided search questions, bounded search evidence, and inventory.
- Applicable repository instructions, approved product evidence, audiences,
  and documentation goals when supplied.

Do not invent a missing audience, owner, support channel, product promise,
release policy, or human approval. Identify absent required inputs explicitly.

## Source Readiness

For `readiness`, assess whether agents can use the repository as input to
future documentation work. Apply each declared criterion to the requested
scope:

- **Source completeness:** the available sources cover the concepts, behavior,
  prerequisites, and evidence needed for the requested documentation work.
  Explain specific missing information; do not require an unstated artifact.
- **Source usability:** agents can locate and interpret those sources, resolve
  their relationships, and distinguish supported facts from unresolved claims.

Return the host response contract. Judge every declared criterion once as
`met`, `unmet`, or `unassessed`, with a specific reason. Read the passages a
`met` or `unmet` judgment rests on and cite them as the host contract states;
the host copies the cited text from immutable tracked bytes, so cite only what
you read. Use `unassessed` when a criterion cannot be judged because a relevant
goal, input, or observation is missing; name that input. Do not use a
free-form claim of readiness as a substitute for the contract.

The host combines these explicitly labeled model judgments with its own
presence and inventory observations. A cited passage proves the text exists;
the judgment about its adequacy remains a model assessment, not a human
approval.

Distinguish an observed artifact from sufficient coverage. A file's existence
alone does not establish correctness, completeness, usability, or release
readiness. Preserve the host's bounded-not-found and incomplete-search
qualifications. Do not broaden this assessment into a release decision.

## Public Release Documentation

For `release-documentation-readiness`, explain the supplied release rubric and
its admitted evidence. Retain the exact repository/default-branch binding and
host inventory. Separate missing documentation, an unsupported probe, and an
unknown human decision. Propose a non-mutating work plan with verifiable
outcomes and dependencies; leave owners or approvals unknown when absent.

The host derives the structured disposition and work-unit contracts from its
validated evidence. Do not replace that evidence with a model assertion, claim
that all release criteria passed because this invocation succeeded, or grant
publication authority.

## Output

For source readiness, put the complete readable assessment in the JSON
`summary` field and retain the criterion details alongside it. For release
readiness, return readable prose. Include:

1. The selected surface, revision, and scope.
2. Evidence-backed findings with exact paths and supplied evidence references.
3. Missing inputs, incomplete searches, unsupported checks, and uncertainty.
4. Prioritized next work with an observable completion condition for each item.

Keep source readiness and public release readiness distinct. A successful
assessment can truthfully report insufficient evidence or work still required.
Do not execute a documentation plan, modify files, invoke another skill,
change an issue, publish, merge, or use credentials.
