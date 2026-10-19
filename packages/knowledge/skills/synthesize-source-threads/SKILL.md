---
name: synthesize-source-threads
description: Compare versioned evidence and participant models from independently inspectable source threads, preserve scoped variants, identify and adjudicate inconsistencies, produce a reviewable candidate shared-model delta, and regenerate newly unblocked documentation. Use after source registration and claim extraction when reconciling source threads, updating a shared product model, resolving its conflict queue, or changing documentation readiness state.
license: Apache-2.0 AND CC-BY-4.0
---

# Synthesize Source Threads

Synthesis is a conflict-preserving merge, not a summary, vote, or declaration
of truth. The source branches survive every merge.

Read [synthesis-contract.md](references/synthesis-contract.md) before creating
or updating a candidate shared model.

## Require bounded inputs

Require:

- Model region, target release or version, audience, and documentation
  targets.
- Prior candidate or shared-model version, or an explicit first-version state.
- Exact source-thread IDs and item versions being considered.
- Atomic claims with exact evidence, inference labels, scope, and separate
  representation, behavior, intent, and model states.
- The authorized output and review boundary.

Stop if provenance is lost, an item cannot be traced to an identifiable
origin, or the claimed prior model version is missing. A source thread can
contain many items. A topic view across threads is not a new anonymous source.

## Compare without flattening

Compare the smallest independent claims and classify each relationship as:

- `compatible`
- `behavior-conflict`
- `intent-conflict`
- `terminology-conflict`
- `scope-conflict`
- `version-conflict`
- `representation-conflict`
- `documentation-quality-conflict`
- `unknown`

Preserve exact evidence and agent inferences. Do not resolve conflicts by
majority vote, source count, seniority, confidence, or prose fluency.

Route:

- Behavior conflicts to version-bound source, tests, or runtime observation.
- Intent and approved terminology to accountable product authority.
- Representation conflicts to the person or source represented.
- Documentation-quality conflicts to named criteria and a review owner.
- Scope and version differences to explicit variants when both can be valid.

If resolution evidence is absent, preserve the conflict and its consequence.

## Reconcile inconsistencies explicitly

Always produce an inconsistency report, including an explicit no-inconsistency
result when every compared claim is compatible. Assign every inconsistency a
stable conflict ID and record the exact source variants, classification, scope,
consequence, resolution owner, and affected documentation targets.

Treat adjudication like resolving a merge conflict:

1. Present the competing claims without silently choosing a winner.
2. Route the decision according to behavior, intent, representation, scope, or
   documentation-quality authority.
3. Record the adjudicator, authority, disposition, rationale, evidence, and
   resulting shared-model claim.
4. Retain rejected and superseded variants in history.
5. Carry unresolved conflicts into the candidate model and block only their
   dependent targets.

Do not mutate a previously issued model version or erase a conflict after it is
resolved. A later adjudication produces a new model version and merge receipt
that references the stable conflict ID.

## Continue into adjudication

Resolve inconsistencies expediently when the required evidence and authority
are already present. In particular, use version-bound behavior to resolve
behavior and version conflicts, and rescope compatible variants whose scopes
are explicit. Record those decisions in the report; do not send a user through
an adjudication that the evidence has already completed.

When open inconsistencies remain:

1. State the number of open conflicts and order them by dependency and impact.
2. If the user has not already asked to adjudicate, ask: "I found `<count>`
   open inconsistencies. Do you want to go through them one by one and
   adjudicate them now?"
3. If the user has already accepted or requested adjudication, start
   immediately instead of asking again.
4. Present only one conflict at a time. Explain the competing claims, why the
   distinction matters, the decision owner, and a recommended disposition with
   rationale. Do not make the user rediscover evidence already in the report.
5. Ask one bounded decision question. Accept a modified resolution, not only a
   binary acceptance of the recommendation.
6. Echo the resulting resolution and preserve the attributed decision in the
   appropriate source lineage before advancing to the next conflict.
7. After the selected conflicts are resolved, create a new immutable model
   version and merge receipt carrying each stable conflict ID and state
   transition. If the session stops earlier, retain the decisions already made
   so that adjudication can resume without repetition.

An adjudication queue is finite. Report progress as `<resolved>/<total>` and do
not introduce unrelated discovery questions into it. If no open conflict
remains, state that adjudication is unnecessary.

## Close governed visual targets

A governed visual artifact is not closed, current, or of record until its
post-adjudication representation exists directly in the new immutable Product
Reference Model. This rule covers diagrams, architecture views, state
machines, timelines, and equivalent rendered representations.

Before assigning any of those states, require all of the following in the new
model version:

- The exact final representation content, such as the fenced Mermaid content
  for a Mermaid diagram, rather than an indirect locator.
- A stable visual identifier and content checksum for the exact final
  representation bytes.
- An independent, retained source-thread closure manifest listing every
  required source representation and accepted governing decision. The
  merge-boundary target cites the manifest through `closure_manifest_source`
  and repeats its `required_source_representations` and
  `accepted_decision_ids` exactly.
- Exact references to those source representations and governing decisions in
  the direct closure record.
- A decision-coverage verification record that maps every accepted decision
  to the final representation and records a verified result.

Every accepted decision ID must resolve exactly once to a claim record in the
immutable model history. The validator enumerates every governed visual
heading, metadata marker, and direct representation block; rejects malformed,
duplicate, or undeclared blocks; and cross-checks open or deferred
representation conflicts in both directions.

Validate the complete candidate model package and retained source boundary
before issuing the version:

```bash
python3 packages/knowledge/skills/synthesize-source-threads/scripts/validate_visual_closure.py \
  <model-version>/model.md \
  <model-version>/inconsistency-report.md \
  <model-version>/merge-receipt.md \
  .docsfab/reference-model/source-threads \
  .docsfab/reference-model/shared/DOCSFAB-PRODUCT
```

The validator computes SHA-256 over the exact UTF-8 bytes after the opening
fence line through the final line ending before the closing fence. For
`artifact_kind: diagram`, the direct fence and `representation_format` must
both be `mermaid`. The current fail-closed Mermaid syntax gate supports the
flowchart family used by the governed D1–D8 and D6A views. It validates the
header, subgraph balance, directions, node delimiters and quotes, supported
node and edge statements, and complete edge endpoints. It consumes every
token, validates each semicolon-separated statement, and accepts only
well-formed `style` directives from the governed corpus. Prose, trailing
material, malformed flowcharts, other directives, and unsupported Mermaid
families fail rather than count as a representation.

Merge-receipt section 14 contains one
`docsfab.knowledge.visual-closure-receipt/v1` record. Its targets, manifest
references, representation IDs, checksums, sources, decisions, and coverage
verification must exactly match the model and inconsistency report. Prose is
not a receipt.

The validator enumerates every CommonMark fence in `## Governed Visuals` in
one pass, regardless of marker character or length. Each target heading has
exactly one three-backtick `yaml visual-closure` fence followed by exactly one
three-backtick direct-representation fence. Rogue standalone, longer-marker,
out-of-section, duplicate, or malformed fences fail closure.

The same pinned MarkdownIt index selects the top-level merge boundary, claim
records, conflict records, governed visual records, and section 14 receipt.
Headings or YAML that appear inside examples, outer fences, blockquotes, or
lists never become semantic records.

Resolved semantics without the final visual representation remain an open
`representation-conflict` and block the visual target. They do not block an
independent target whose own evidence is complete. A source-thread artifact,
external link, summary, prose closure statement, or list of resolved decisions
cannot substitute for the direct current representation in the immutable
model.

Retain source and derived representations and every superseded or rejected
visual in history, but never label a superseded or rejected visual current. If
the final visual is intentionally omitted, keep its representation conflict
open or deferred and do not call the visual target closed.

## Regenerate and expand documentation after convergence

When the selected conflict queue reaches zero, continue automatically:

1. Issue the new immutable model version and merge receipt before deriving
   documentation from it.
2. Determine which existing documentation targets depend on changed claims
   and regenerate or update those targets from the new model.
3. Rescan every family in the repository's configured information
   architecture. Identify missing targets whose evidence and intent readiness
   changed from blocked to ready.
4. Generate newly ready missing targets. Do not create a page merely to fill a
   family; retain a missing-evidence entry for targets that are still blocked.
5. Apply the configured writer, editorial, technical, audience, and
   deterministic gates. An agent author must use a clean subagent for the
   minimum adversarial review. Human-authored output requires a different
   human or clean agent reviewer. Self-review never satisfies that gate.
6. Rerun documentation builds and applicable repository checks, then update
   the readiness board with generated, reviewed, locally verified, and still
   blocked targets.
7. Add the exact documentation delta, review evidence, check results, and
   remaining acquisition work to the receipt or a linked generation receipt.

This continuation authorizes repository-local documentation changes implied by
the synthesis run. It does not authorize publication, merge, deployment, or a
broader mutation boundary. Stop on a failed generation, independent-review, or
documentation check rather than leaving partially refreshed output presented
as converged.

## Build the candidate delta

For every claim, record whether it is included unchanged, added, superseded,
excluded, rescoped, retained as a variant, or unresolved. State the evidence
and authority used for each consequential choice.

Use `$reflect-model-delta` for a consequential change that needs source or
owner correction. Preserve participant-initiated additions, challenges,
corrections, requests, and approvals with their original actor and direction.
Never invent an interviewer prompt to make the event fit a question-answer
schema.

Update documentation readiness only for targets whose load-bearing gaps the
delta actually changes. An unresolved terminology conflict can block an About
page while leaving a behavior-complete CLI Reference page ready.

## Produce the reconciliation artifacts

Write an immutable model version, inconsistency report, and merge receipt using
the contract. Record the exact delta from the prior model and all targets
blocked or unblocked. Keep the inconsistency report distinct from the model:
the report is the adjudication queue and audit trail; the model is the current
candidate result.

The source threads and prior shared-model versions remain inspectable. A claim
is not true merely because it was merged. Do not promote a candidate model to
approved shared state without the required behavioral evidence and accountable
intent authority.

## Close with review state

Separate:

- Agent self-check.
- Source review of faithful representation.
- Behavior verification.
- Independent-reader model-transfer evidence.
- Accountable intent or release approval.

Stop on an artifact-write failure, provenance mismatch, missing prior version,
or attempted conflict erasure. Surface the incomplete merge rather than
publishing a polished narrative with hidden disagreement.
