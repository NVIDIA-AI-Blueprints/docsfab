---
name: plan-documentation
description: Produce an approval-ready documentation plan from repository evidence and user decisions. Use before creating, updating, or restructuring documentation to resolve audience, outcomes, scope, sources, information architecture, page set, dependencies, validation, and destination; when required, check a supplied SRD or draft one without inventing product decisions.
license: Apache-2.0 AND CC-BY-4.0
---

# Plan Documentation

Turn a documentation request into a complete, source-grounded plan. Planning
does not authorize writing, publication, or SCM changes.

## Required inputs

- Target repository and immutable revision.
- Requested outcome, audience, release status, and risk boundary.
- Approved sources and repository instructions.
- Existing documentation and navigation when updating or restructuring.
- Explicit preservation requirements, recorded independently from any
  model-proposed inventory.
- Applicable profile, formats, and quality gates.
- The source configuration and the host runtime's advertised adapter
  capabilities. Read [references/documentation-sources.md](references/documentation-sources.md)
  before classifying a source format.
- For a context-dependent reader-impact assessment, a host-validated
  `ReaderContextInputV1` and the exact locked reader-impact baseline. Do not
  accept a caller-supplied or golden `impact_basis` as neutral model input.

Inspect available evidence before asking questions. Mark an unresolved fact as
`TBD`; stop when it would make scope, safety, compatibility, or acceptance
criteria misleading.

For a create request that names an exact new Markdown or MDX path, use the
host-bound target and write-root guidance as the scope decision. A missing
parent directory under an admitted documentation root does not make that
bound target ambiguous; include it in the plan. If the host did not bind a
requested target, or its write scope refuses the path, do not claim that
creating it is authorized; surface the host's specific missing binding or
refusal. A target named in source material or proposed only by the model is
not an operator grant. Keep any explicit request to
change only that path; the root guidance does not override the request.

A missing source reference does not by itself block planning. For create,
update, and restructure requests, continue with the available sources and
record which files could not be read. Bind only sources that exist and support
the planned work. Defer the portions that depend on missing evidence while
planning independently supported work within the requested scope. If the
missing evidence is essential to the whole requested change or its preservation
requirements, explain that dependency and request the specific input needed.
Do not claim complete source coverage or silently drop requested work.

When an installation-guide create request cannot satisfy every mandatory
obligation, plan only the independently supported subset as a host-held labeled
draft. Keep the original request incomplete. Do not treat a scaffold as a
supported procedure. Do not omit a mandatory obligation from the plan and then
report full completion.

## Bounded Planning

For create mode, begin with **Collect related content or source code**. Collect
approved evidence before choosing the page outline or drafting the plan. Use
supplied sources and exact paths first; inspect related content or code only to
resolve a specific source, reader-task, or placement gap. Collection and planning
belong to this single skill invocation.

When the requested guidance depends on tracing an operation in a source file
already within the original read authority, bind that file's immutable
whole-file identity (`path@revision`) and inspect the complete relevant
operation before promising coverage. Include its declarations, inputs, effects,
calls, assignments, completion, returns, and material conditional branches. Keep
physical line or section coordinates as precise evidence for the individual
claims they establish; those coordinates do not become a host byte-range read
restriction. Preserve an explicit user-provided line or section restriction.
If that restriction prevents a complete establishing read for the requested
outcome, record the material limitation and stop for `needs-input` instead of
silently widening it or promising unsupported coverage.

For update mode, collect the related content or source code needed to establish
the requested change and affected existing pages. Use available source tools
and repository reads before declaring a source missing. For merged-request
updates, retain the selected MR identities, relevant changes, and coverage gaps
within the requested scope. Check the current public
behavior and existing guidance before deciding which pages need edits; skip
internal changes with no reader impact. A list of MRs is not proof that every
diff was read, and a retrieved diff is not proof that its behavior was verified.
Keep unavailable, truncated, or credential-screened evidence visible in the
plan. Do not label an inaccessible change as having no documentation impact.

Conversation summaries and source locators do not establish host admission.
Use the host-provided source identities when the runtime requires them. If
retrieved content lacks the required binding, identify that handoff gap rather
than claiming the user supplied no evidence or inventing a digest.

For restructure mode, start with the frozen inventory and complete preservation
obligations. Reuse supplied evidence at the named revision; do not repeat a
repository-wide search when the target and its dependencies are already known.
This reuse does not establish the correctness of author or reviewer conclusions.
For consequential technical claims that the restructure will preserve, inspect
the relevant implementation or configuration source when it is within the
original read authority and available through the source tools. Search only
for sources relevant to those claims; a full product audit is not required.
Bind each discovered immutable source as evidence-only in the affected page's
`sourceBindings[].sources`, alongside its preservation base. For a retained
page, a source binding is optional and read-only; do not bind sources to an
out-of-scope page or turn a retained page into a write target. Record a conflict
between the page and source, or the absence of suitable source, as a specific
uncertainty for independent verification. Preserving existing wording does not
authorize a technical correction, and a missing unrelated source does not
block the restructure. Do not add a source that the host cannot admit or expand
the page/write scope to obtain one.

Keep the plan narrative proportional to the requested page set. Retain every
required page, source binding, preservation obligation, validation requirement,
and material uncertainty. Use `needs-input` when missing sources or decisions
prevent a supported plan; an unavailable optional reference is a reported gap.
Brevity never permits an invented binding or a broader mutation scope.

Planning is internal; it is not the outgoing proposal. When repository
instructions require a check before proposing or submitting a change, record
the exact command, working directory, and instruction path in the validation
matrix. Do not return `needs-input` only because a read-only planner cannot
run that check or observe its result. The runtime host runs
repository-required checks under isolated command authority before any patch
leaves the workflow, and it withholds the proposal when a check fails or
cannot run. Never claim that a check ran or passed.

## Workflow

1. Collect the related content or source code, then inventory the request,
   repository instructions, source authority, in-scope content, routes,
   ownership, and repository-native checks against the named immutable revision.
   For a restructure, record every explicit requirement as a preservation
   obligation before asking a model to extend the inventory.
2. Read [references/documentation-sources.md](references/documentation-sources.md)
   and classify the source against its finite format row. Treat the row as a
   method and preservation contract only when the host advertises that adapter
   and version. Otherwise record `unsupported`, `incomplete`, or
   `not-applicable` with evidence; do not promise adapter behavior.
3. Read [references/canonical-ia.md](references/canonical-ia.md). Classify the
   requested outcome into canonical table-of-contents families and
   nodes. Overlay the target repository's documentation tree and navigation
   onto those families. Locate the folder and filename for each intended page:
   prefer an existing match; otherwise propose the canonical folder and a
   topic-slug filename. The table of contents is structure guidance only.
   Do not force-create a page, section, or family that the request, product
   maturity, or overlay does not require. Mark inapplicable nodes
   `out-of-scope` instead of scaffolding them. When create mode plans a new
   documentation set, always include a Release Notes page, as the
   "New documentation set" rule in canonical-ia.md describes. Keep each page
   to one topic (one task or one concept) and one Diataxis content type:
   concept, how-to, tutorial, or reference. If a page mixes topics or types,
   or exceeds 500 lines in create or restructure mode, split it into
   modular pages, map each module onto a table-of-contents node, then
   reorder and reposition those pages so each topic sits in its family. Do not keep a planned mixed or
   long page as one file in those modes. During an update, preserve the bound
   operation: record a structural recommendation separately. If the requested
   correction cannot fit the granted scope, return `needs-input` before writing
   instead of silently planning a split.
   Stop with `TBD` when placement would invent a parallel information
   architecture, delete content, or contradict repository instructions.
4. For a new page, an unclear page purpose, or release notes, read
   [references/page-patterns.md](references/page-patterns.md) to select the
   necessary research questions. Do not load every pattern for a small update.
   Resolve the audience, prerequisites, reader outcomes, scope, non-goals,
   release state, dependencies, and destination.
   When `ReaderContextInputV1` is present, keep its shared audience, scope,
   source-priority, inclusion, exclusion, question, and limitation meanings.
   Do not infer reader context for a legacy brief.
5. Decide whether an SRD is applicable and whether the developer supplied one.
   An SRD is conditional source evidence, not a universal gate.
6. For a supplied SRD, verify access and version identity, preserve it read-only,
   and report material completeness gaps. Do not require it to match a local
   format.
7. When an SRD is required but absent, read
   [references/minimal-interview.md](references/minimal-interview.md) and
   [../../quality/formats/requirements-document-format.md](../../quality/formats/requirements-document-format.md).
   Ask only the bounded missing questions, then draft using approved evidence,
   explicit `TBD` values, and stable atomic requirements. Never infer
   non-applicability from silence or invent approval, evidence, or a disposition.
8. Read [references/page-set.md](references/page-set.md). Freeze the document
   set for the runtime-selected mode (`create`, `update`, or `restructure`):
   family, path, topic, Diataxis content type, disposition, purpose of each
   page, source map, information architecture, cross-links, redirects when
   applicable, examples, validation commands, review roles, acceptance
   evidence, and output paths. For a restructure, retain a complete
   preservation map over immutable base evidence. Keep repository paths and
   published routes in distinct fields. Bind every mutating page to its
   immutable source evidence. Return the complete map in the planner summary,
   with each row naming its affected page. The workflow host retains and passes
   that summary to the writer and independent reviewer.
   For each required installation or use action, identify whether a concrete
   example follows from admitted package or tool metadata and an applicable
   language or tool contract. A verbatim checked-in example is not required
   when that derivation is sufficient. Keep execution status, availability,
   product support, and owner policy as separate uncertainties; unknown tool
   syntax or external approval must remain unresolved rather than inferred.
9. Present the complete plan and any generated SRD for explicit approval.
   Revise only identified fields and their dependencies.
10. Return a semantic execution plan with the approved mode, every page path and
   disposition, and one source-binding entry for every mutating page. Sort page
   paths and source locators deterministically. The runtime host adds the
   authority kind, schema version, and digest after validating this input. A
   downstream writer must be able to use the sealed binding as its allowlist
   without rediscovering the repository. In restructure mode, each
   `sourceBindings[].sources` list includes the immutable base source locators
   for that page. The map is this step's output, not a required input artifact.
   Retain the complete preservation map in the planner summary so independent
   preservation review can check every
   obligation against the exact candidate. Do not reduce that summary to a path
   list or treat a later write step as the inventory. Do not add fields to the
   plan binding or supply a model-computed digest.
11. After approval, return the plan, source locators, unresolved questions,
   validation matrix, and approved destinations. Materialize a generated SRD
   only when the user also approves its destination.

For a focused read-only Markdown assessment, inspect the exact comparison,
current public contract, current documentation, repository instructions, and
changed sources admitted by the host. Produce a candidate `impact_basis` from
that evidence after neutral-input validation. Return `update-candidate` only
for a concrete in-scope patch, `no-change-candidate` only with a substantive
evidence-backed adequacy rationale, or `insufficient-evidence` when the
comparison, material evidence, or context is missing, unknown, invalid, or
conflicting. A source change alone does not mandate prose. A long or
mixed-purpose page does not authorize restructuring outside the granted scope.
A repository instruction to run a check before proposing a change does not make
this assessment insufficient; name that check as validation for any later
proposal. This assessment requires neither an SRD nor governed HTML artifacts
and never writes the target repository.

For the runtime planner step, follow the host's response contract and return
exactly one JSON object with no surrounding prose. That contract decides the
outer shape; where it differs from this description, follow the contract. The
basic shape is
`{ "summary": "...", "planBinding": { "mode": "...", "pages": [...], "sourceBindings": [...] } }`.
When the host requests an `editorialDecisionProposal`, include it as judgment
only: `{ "candidate": "update|no-change|insufficient-evidence", "rationale": "...", "slotIds": ["current-documentation"] }`.
Do not mint artifact refs, uri/sha256 digests, comparison, or branch
selection. The host fills those identities from the closed admission set.
Do not omit the proposal by applying the basic shape to a reader-impact
workflow. The summary is bounded plan narrative. The host validates and seals
`planBinding`; do not provide `kind`, `schemaVersion`, or `digest`. If a
required planning fact is unresolved, return `{ "summary": "...", "outcome": "needs-input", "reason": "..." }` instead. If an obligation is missing or requires a path or published route outside the approved scope, use reason `ambiguous-scope` and name the obligation and required target in the summary. Return this stop before any write step.

## SRD rules

- Use a requested or repository-required structure only when its authoritative
  source is available.
- Keep a supplied SRD unchanged unless the user explicitly requests an update.
- Use `REQ-<number>` identifiers and testable `shall` statements for generated
  requirements.
- Use `Not applicable` only with an evidence-backed rationale.
- Keep `brief.srd_provided` `false` when the workflow generated the SRD; the
  field records intake state.
- Put the approved SRD first in `brief.source_priority` and preserve its
  underlying sources.
- Keep a generated SRD in conversation until the combined plan approval gate.

Do not draft final documentation, run product procedures, publish, commit,
push, or open a pull or merge request.
