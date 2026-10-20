---
title: "Update Documentation Workflow in DocsFab"
description: Run the fixed DocsFab workflow that authors a bounded update or independently verifies that current guidance needs no change.
status: draft
content.type: reference
---

`update-documentation` is a DocsFab runtime workflow, not a skill. It uses
change-scoped context to assess the smallest documentation set affected by an
approved product, API, configuration, or behavior change. After planning, the
runtime selects one fixed path from admitted evidence. For more information,
refer to [Workflow Contracts in DocsFab](index.md).

## Contract at a Glance

The following table summarizes the contract.

| Field | Contract |
| --- | --- |
| Use it when | Existing documentation might need to change for an approved product or interface change. |
| Mutation | The author path has one bounded `write-documentation` step. The no-change path is read-only. |
| Required authority | The author path requires explicit runtime write authorization. A no-change assessment does not require a writer grant. |
| Result | A local, review-ready patch or a verified editorial no-change result, with separate planning, verification, review, audience, and evaluation evidence. |
| Excluded workflow actions | Change unrelated pages, publish, commit, push, open a merge request, or merge. |

## Workflow Sequence

The workflow first runs `plan-documentation`. The host admits the planner's
proposal against the current reader context, comparison, source, and plan
evidence. A missing, invalid, unknown, or insufficient basis stops after
planning with an explicit limitation. It never selects authoring by default.

The host automatically admits planned page paths as `current-documentation` before branch selection, after the instruction bytes and first-pass named targets. This closes admission without authorizing unsupported writing.

Host-bind of a directed update is closing admission, not default authoring.
The run's declared structure decides it, not the words of the request. When
write is granted, the admitted plan changes at least one page, and comparison
scope is unknown, the host binds `update` for the planned pages. The request
can say "update," "bring up to date," or "assess whether"; the outcome is the
same. A run without write authorization is an assessment: it still asks for
the input it lacks and does not author. With write granted and a plan that
changes no page, the planner's candidate decides. Text cannot certify
no-change.

When branch selection refuses the planner's candidate, the run stops after
planning with `needs-input`, and the stop code appears in `Product findings:`
and in `product.findings` in `--json` output. `no-change-unsupported` means
the admitted evidence does not support a no-change candidate, for example
because a kept page was not admitted as current documentation, or a commit
comparison lacks its public-contract evidence. `host-failure` means selection failed for
a reason that is not a typed evidence refusal. Any other code is the typed
refusal that selection raised, such as `identity-mismatch` or
`evidence-unavailable`. None of these codes means an independent reviewer
rejected the candidate, because no reviewer runs before selection.

An admitted update follows this fixed path:

1. `plan-documentation`
2. `derive-source-obligations` (`verify-technical-accuracy` in
   inventory-only mode)
3. `write-documentation` in update mode
4. `lint-documentation`
5. `verify-technical-accuracy`
6. `review-documentation`
7. `test-audience-understanding`
8. `evaluate-document-quality`

An admitted no-change candidate follows this fixed read-only path:

1. `plan-documentation`
2. `verify-technical-accuracy`
3. `review-documentation`
4. `test-audience-understanding`
5. `evaluate-document-quality`

The no-change result requires independent technical verification and
non-author editorial review, and both must accept the candidate. The quality
evaluator then assesses the retained evidence. It accepts the candidate or
answers `not-applicable`, because a no-change changes no page whose quality it
could judge. DocsFab admits that answer and records it as the limitation
`quality-evaluation-not-applicable`, so a verified no-change never hides an
evaluation that did not happen. The audience check also runs on both paths.
Unavailable or failed audience evidence remains a separate limitation and does
not become an editorial approval. Missing evidence for the selected no-change
basis, conflicting sources, or rejected independent findings, including a
rejection from the evaluator, cannot produce a final no-change result.

Planning starts from the requested change, affected pages, and supplied source
locators. Before writing, the author path derives a bounded source-obligation
ledger from those admitted sources. Authoring uses the bound plan and that
untrusted ledger. Neither stage repeats a repository-wide inventory for a
bounded update. Missing material sources or decisions stop the workflow
before writing.

The inventory-only step returns a source-obligation ledger. It does not return
an independent editorial assessment or require an editorial candidate. The
later verification step retains its independent assessment contract.

Planning and authoring use change-scoped context. The verifier checks the
consequential claims against the selected revision and requested change.
Correct unrelated content remains outside the mutation boundary.

The runtime validates plans and independent assessments before reporting their
model attempts as successful. A malformed response can use the configured
read-only retry. If validation still fails, the workflow stops and reports the
response contract failure. It does not treat an invalid plan as missing user
input, accept an invalid assessment as approval, or repeat the writing step.
One of DocsFab's own configured credentials stops the workflow without a
retry, so DocsFab does not prompt the model again. This applies to any field of
a completed plan, to an editorial assessment, to a review or verification
result, and to a source-obligation ledger. Text that only looks like a
credential does not stop the workflow. Refer to
[Credential-Like Content](../security-and-trust.md#credential-like-content). A path in any of these results is ordinary text and
does not stop the workflow, whether or not a cited source contains it. Before
DocsFab publishes the result, it replaces this host's undeclared roots, as
described in
[Host Paths in Published Output](../../configure/public-output-roots.md#host-paths-in-published-output).
An explicit planner request for unavailable evidence or a required decision
still returns `needs-input`.

## Update One Existing RST Page

Refer to [Update One RST Page](../../workflows/update-rst-page.md).

## Reach a Verified No-Change Result

Refer to [Verify That Documentation Needs No Change](../../workflows/verify-no-change.md).

## Supply Named Work Products After the Job Starts

Refer to [Supply Requested Work Products](../../workflows/supply-work-products.md).

## Bind Tracked Source Files to an Update

Refer to [Select Source Evidence](../../workflows/select-sources.md).

## Comparison and Reader Evidence

An update assessment keeps the Git comparison and the current workspace
observation separate. To request an exact commit comparison, provide two full
Git object IDs:

```bash
docsfab run update-documentation \
  --instruction "Assess the documentation for this change" \
  --revision <head-object-id> \
  --comparison-base <base-object-id>
```

Use `--comparison-workspace` to request comparison against the current
workspace snapshot instead. This flag carries intent only. The host binds the
request to the actual inventory SHA after it observes the workspace. The two
comparison forms are mutually exclusive. If neither is present, comparison
scope remains unknown; the runtime does not substitute `HEAD` or invent a Git
object ID.

The read-only impact observer verifies admitted current-documentation,
public-contract, and changed-source bytes inside the selected workspace. It
uses the existing documentation inventory, navigation observation, talk tree,
and section fetch. A generic configuration file can nominate a relevant page
through bounded shared source/document terms even when filenames differ.
Filename and lexical matches nominate candidates; they do not prove impact or
adequacy.

Reader admission accepts at most 128 source nominations, reads at most 1 MiB
from each source, and retains at most 8 MiB across source and request evidence.
It rejects an oversized request before presenting any partial set as complete.
Use fewer `--reader-source` flags and nominate the smallest tracked files that
contain the relevant public contract, current documentation, and changed
source evidence. If those bounded files cannot establish the required roles,
the result remains an explicit evidence limitation. `--reader-source` is a
`docsfab run update-documentation` flag. `docsfab do` does not grow it.

Each returned section binds its repository revision, workspace snapshot,
section coordinates, content digest, and evidence digest. Reuse requires the
same snapshot. A changed snapshot invalidates dependent observations and
requires revalidation; contradictory results under the same snapshot fail.
The observer reads at most 1 MiB from a documentation source and returns at
most 64 KiB for one section. It reports `size-limit-exceeded` instead of
silently truncating a section or presenting partial bytes as complete. When a
large page has smaller child headings, request the narrower heading from the
talk tree. Otherwise the bounded observation remains incomplete until the page
is split or the run supplies another admitted, bounded evidence source.
An empty candidate list is recorded as candidate absence, not as a no-change
decision. Missing source roles for the selected no-change basis, or incomplete
inventory or navigation evidence, remains `insufficient-evidence`. Without a
comparison, only the kept-page basis described in
[Reach a Verified No-Change Result](../../workflows/verify-no-change.md#reach-a-verified-no-change-result) can
support no-change. A final no-change result requires the separately validated
reader/editorial evidence and fixed read-only verification path.

The audience step tests the frozen candidate only when the run supplies a
target identity, a versioned scenario corpus and oracle, a representative
audience match, an independent participant, and run authority. The participant
does not receive author or reviewer context, expected answers, the scoring
oracle, or prior evaluation results. The audience protocol result is forwarded
byte-for-byte as an untrusted observed summary to the final evaluator. Create
and update outcomes remain `insufficient-evidence` until a separately
host-validated governed campaign supplies the required semantic validation
receipt and host-known documentation content identity. Missing inputs, malformed
or semantically invalid evidence, and candidate revision mismatch remain visibly
distinct in the observed summary sent to the final evaluator. A provider failure
remains visible in the failed step and run record and prevents the evaluator
from running. Deterministic tests verify evidence plumbing and do not qualify an
audience directly.

An `update-documentation` run does not receive that audience protocol, so the
audience step cannot test the candidate. The host records the step's editorial
assessment as `not-applicable`, with a rationale that says the host decided
it, whatever the step's reply proposes. The missing
protocol stays on the product outcome as the standing `insufficient-evidence`
limitation, bound to the audience step. It does not turn an executed update or
a verified no-change into an `insufficient-evidence` editorial outcome.

## Update a Multi-Page Set

Refer to [Update a Documentation Set](../../workflows/update-documentation-set.md).

## Navigation Evidence

Refer to [Update a Documentation Set](../../workflows/update-documentation-set.md).

## Bind a Local Commit Range to an Update

Refer to [Bind a Local Commit Range](../../workflows/bind-commit-range.md).

## Git History Evidence

When `docsfab run` materializes the workspace from a local checkout, the
planner and the writer can read that checkout's history with
`docsfab_history_diff`, `docsfab_history_show`, `docsfab_history_log`,
`docsfab_history_search`, and `docsfab_history_blame`. A planner can find the
commits that changed a path, diff an earlier commit against `head`, read the
old version of a changed file, find the commits that added or removed a
symbol, and find the commit that last changed each line of a documented range. Only the pinned
revision and its ancestors can be read. Each served page is recorded in the step's tool activity as a
`historyReads` citation with its full revisions, paths, ranges, labels, and
digest. A shallow or partial checkout is labelled, not guessed past. Refer to
[Git History Tools in DocsFab](../knowledge-and-delivery/git-history-tools.md) for the
arguments, refusal codes, and bounds.

## GitHub Change Sources

Refer to [Bind a GitHub Change](../../workflows/bind-github-change.md).

## Output and Authority Boundary

The CLI and live agent report editorial outcome separately from execution
status, product disposition, and quality.

Quality-report projection schema V2 also partitions limitations. The
`retainedGapEvidence` array contains at most two profile-backed entries, using
`experimental-profile-ceiling` or `audience-prerequisites-missing` with the
verified profile evidence. `unclassifiedLimitations` contains every remaining
limitation. A limitation cannot appear in both partitions or disappear from the
complete `limitations` array. These fields explain evidence gaps. They do not
change the quality decision or replace editorial, execution, product, or
release-readiness outcomes.

The editorial outcomes have the following meanings.

| Editorial outcome | Meaning |
| --- | --- |
| `executed-update` | The author path completed, the writer produced a non-empty retained patch, and the editorial decision was validated. |
| `update-recommended` | Evidence supports an update, but no qualifying author-path patch was executed. This can be returned from read-only work. |
| `verified-no-change` | The fixed read-only path completed and independently validated that the current guidance needs no change. The patch is null and no delivery is requested. |
| `insufficient-evidence` | The available evidence cannot support either an executed update or a verified no-change result. |
| `unavailable` | The run is historical or its retained editorial evidence cannot be resolved. Absence is not treated as a pass. |

Use `docsfab run update-documentation` for the direct CLI entry path. The live
agent can start the same bounded workflow from a natural-language update
request and reports the same outcome fields. Host jobs preserve the projection
when the runtime produced one; hosted update execution remains unavailable
until a separately authorized hosted write operation exists.

The author path returns a local patch and separate evidence streams. An
executed writer that produces an empty patch remains a failure. The no-change
path records the selected obligations and the omitted writer and lint steps. It
does not fabricate successful steps, create a patch, enqueue delivery, or
publish.

A verified editorial no-change run remains `inconclusive` for product and
release readiness. The editorial result and readiness are separate. Missing
quality or audience evidence stays visible as a limitation.

If an author run succeeds with a real patch, host delivery opens one draft merge request
unless you pass `--patch-only`. That projection is not part of the
fixed workflow and cannot merge or publish the documentation.
`--allow-write` and `--draft-mr` remain accepted.

## Authoritative Sources

This page is based on the following sources:

- [Workflow manifest](../../../packages/runtime/workflows/update-documentation.json)
- [Planning skill](../../../packages/skills/plan-documentation/SKILL.md)
- [Authoring skill](../../../packages/skills/write-documentation/SKILL.md)

## Related Topics

For more information, refer to the following topics:

- [Run a Documentation Workflow in DocsFab](../../workflows/run-a-documentation-workflow.md)
- [Troubleshooting DocsFab](../../troubleshooting.md)
- [Skill Behavior Contracts in DocsFab](../quality/skills/index.md)
- [Create Documentation Workflow in DocsFab](create-documentation.md)
