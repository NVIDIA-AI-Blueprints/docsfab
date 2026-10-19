---
title: "Create Documentation Workflow in DocsFab"
description: Create source-grounded documentation with one bounded correction, independent checks, and retained local patches.
status: draft
content.type: reference
---

`create-documentation` is a DocsFab runtime workflow, not a skill. DocsFab
coordinates repository selection, revision binding, source-grounded planning,
explicit write authorization, linting, technical verification, peer review,
independent audience testing, quality evaluation, run records, and local
patches. For more information, refer to [Workflow Contracts in
DocsFab](index.md).

## Contract at a Glance

The following table summarizes the workflow contract.

| Field | Contract |
| --- | --- |
| Use it when | The approved outcome requires a new page or documentation set. |
| Mutation | An initial write and at most one correction, limited to the original planned paths. |
| Required authority | Explicit runtime write authorization for the selected repository and revision. |
| Result | A local, review-ready patch plus separate planning, check, verification, review, audience, and evaluation evidence. |
| Excluded workflow actions | Publish, commit, push, open a merge request, or merge. |

## Workflow Sequence

The workflow starts with these seven required steps:

1. Collect related content or source code, then plan with `plan-documentation`
2. `derive-source-obligations` (`verify-technical-accuracy` inventory-only)
3. `write-documentation` in create mode
4. `lint-documentation`
5. `provisional-technical-verification`, using `verify-technical-accuracy`
6. `review-documentation`
7. `verify-technical-accuracy`, reconciling source-backed factual objections

After those checks, the runtime selects one of the following two fixed paths.

| Initial Assessment | Remaining Steps | Total Steps |
| --- | --- | --- |
| No qualifying source-backed technical omissions or conflicts | Audience understanding, then quality evaluation of the first draft. | 9 |
| Source-backed omitted or conflicting facts linked to admitted technical issues | One revision, fresh lint, provisional and canonical technical verification, editorial review, audience understanding, and quality evaluation. | 14 |

The revision uses the original plan, source ledger, and admitted technical and
editorial findings. Only source-backed technical omissions and conflicts can
trigger it. Product defects, unsupported policy, missing evidence, and stylistic
preferences remain visible without independently authorizing another write.
The revision cannot add pages, change source files, replan the task, or start
another revision. Invalid or unavailable required evidence stops the
run; it does not select the path with fewer checks.

Collection is the first phase of the planning step, so it does not add another
model invocation. Planning starts from supplied sources and exact paths, then
fills material source or placement gaps. The plan binds those sources to each
proposed page before writing.

Before writing, source-obligation derivation identifies reader-relevant
behavior in the admitted sources. Its ledger records proposed atomic facts,
source locations, and uncertainty across the six technical dimensions. The
writer receives the exact canonical ledger bytes and checks the original
sources. The ledger cannot expand the approved sources, page set, tools, or
write authority. Its completeness remains `bounded-not-proven`.

After writing, the provisional technical check and independent editorial review
assess the same first candidate. A fresh canonical technical correction then
checks the candidate, original sources, obligation ledger, provisional result,
and exact candidate-bound editorial result. It independently checks factual
objections against their sources and expresses supported omissions or conflicts
through the existing technical fact inventory. Unsupported advice, style preferences,
missing policy, and product defects remain non-actionable evidence. The
canonical correction accounts for each obligation as retained, refined, or
rejected. A refinement or rejection preserves the original proposal and records
a source-backed reason.

The model returns judgment only: verdict, coverage, issue judgments, and one
obligation judgment for each sealed ledger row. The host fills identity,
locators, and accounting from that ledger. A sealed proposal that omits
obligation judgments fails `invalid-shape`. An applicable dimension with no
admitted facts fails `invalid-fact-inventory`. Each judgment contributes only
its ID, severity, category, target location, and fact links. The host rejects inconsistent links and out-of-target
locations, then derives the unchanged technical review issues from the exact
linked statements, dispositions, uncertainties, source locators, and bound
repository revision. The model does not supply a separate factual finding,
source-evidence narrative, action, or impact field.

Only the host-derived canonical technical result feeds the revision decision.
This protocol changes no workflow step, model call, branch count, or revision
limit.

Before the revision decision, the host checks source support. A page whose
coverage stays `unverified`, or a technical dimension the obligation ledger
marks `unverified`, means the bound sources do not establish that behavior.
The run then stops with status `needs-input` instead of revising or
completing. It names one slot per page and dimension, for example `Source for
environment prerequisite on docs/cli-reference.md`, and prints one continue
command. Attach the repository file that establishes the behavior with
`docsfab do --continue <run-id> --attach <path>`, or reply with its path in
`docsfab live-agent`. The continued job keeps your instruction, plans again
with that file named as an approved source, and verifies the page again. The
retained first draft is not delivered. Refer to
[A Run Stops With needs-input](../../troubleshooting.md#a-run-stops-with-needs-input). After a revision, fresh canonical technical and editorial checks feed
current findings and quality evaluation. The private run record retains the
original assessments and provisional results for inspection. The revision
records which issues it applied or rejected. For each issue, the runtime lists
the admitted source locators that the revision can cite. The revision must copy
one or more locators from that issue's list verbatim. It cannot change a range,
combine citations, or use a locator listed only for another issue. It also
cannot claim an applied correction when the patch is unchanged.

The first draft remains intact while the revision runs in a separate private
workspace. A revision becomes the selected draft only after its source, path,
and retained-patch checks succeed. A failed revision keeps the first draft
selected and retains admissible partial work separately. Partial work is never
the selected patch. A later review failure can leave the revised draft selected,
with its incomplete assessment or remaining defects reported explicitly.

The ordinary final patch always describes the selected draft against the
original source revision. Findings and recovery inspection use that same draft.
A successful write or completed step sequence does not establish product
readiness, audience validation, or the absence of content defects.

The checks and optional revision use the selected model and can increase run
time and cost. Existing provider, tool, and lease limits remain per step. Caller
cancellation and any stronger overall deadline cover the complete invocation
without resetting at the revision boundary.

The instruction must name an actionable outcome, audience, and scope. Missing
material decisions remain unresolved. Clean non-author providers are required
for independent review or a gating decision; same-context results remain
self-review or proxy evidence.

The audience step tests the frozen candidate only when the run supplies a
target identity, a versioned scenario corpus and oracle, a representative
audience match, an independent participant, and run authority. The participant
does not receive author or reviewer context, expected answers, the scoring
oracle, or prior evaluation results. The audience protocol result is forwarded
byte-for-byte as an untrusted observed summary to the final evaluator. Create
and update outcomes stay `inconclusive` and carry the standing
`insufficient-evidence` limitation until a separately host-validated governed
campaign supplies the required semantic validation receipt and host-known
documentation content identity. Missing inputs, malformed
or semantically invalid evidence, and candidate revision mismatch remain visibly
distinct in the observed summary sent to the final evaluator. A provider failure
remains visible in the failed step and run record and prevents the evaluator
from running. Deterministic tests verify evidence plumbing and do not qualify an
audience directly.

## Create a Multi-Page Set

Refer to [Create a Documentation Set](../../workflows/create-documentation-set.md).

## Bind Tracked Source Evidence

Refer to [Source Evidence Reference](../status-and-configuration/source-evidence.md).

## Bind a Local Commit Range

Refer to [Bind a Local Commit Range](../../workflows/bind-commit-range.md).

## GitHub Change Sources

Refer to [Bind a GitHub Change](../../workflows/bind-github-change.md).

## Output and Authority Boundary

The workflow returns local review-ready artifacts. It does not publish or
perform SCM changes. `packages/quality/benchmarks/guided-demo/` remains its
synthetic fixture, not another public skill.

If the CLI run succeeds, host delivery opens one draft merge request
unless you pass `--patch-only`. That projection is not part of the
fixed workflow and cannot merge or publish the documentation.
`--allow-write` and `--draft-mr` remain accepted.

## Authoritative Sources

The following files are the authoritative sources for this page:

- [Workflow manifest](../../../packages/runtime/workflows/create-documentation.json)
- [Inventory-only verification skill](../../../packages/skills/verify-technical-accuracy/SKILL.md)
- [Technical verification skill](../../../packages/skills/verify-technical-accuracy/SKILL.md)
- [Authoring skill](../../../packages/skills/write-documentation/SKILL.md)
- [Shared skill execution contract](../../../packages/skills/EXECUTION_CONTRACT.md)

## Related Topics

The following pages provide related information:

- [Create and update procedure](../../workflows/run-a-documentation-workflow.md)
- [Skill Behavior Contracts in DocsFab](../quality/skills/index.md)
- [Restructure Documentation Workflow in DocsFab](restructure-documentation.md)
