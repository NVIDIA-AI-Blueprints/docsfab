---
title: "Review Documentation Workflow in DocsFab"
description: Run the fixed read-only DocsFab workflow that audits, checks, verifies, reviews, tests, and evaluates a documentation set.
status: draft
content.type: reference
---

`review-documentation` is a read-only DocsFab runtime workflow, not a skill.
It binds one repository revision and keeps audit, deterministic, technical,
editorial, audience, and quality evidence separate. For more information,
refer to [Workflow Contracts in DocsFab](index.md).

## Contract at a Glance

The following table summarizes the contract.

| Field | Contract |
| --- | --- |
| Use it when | A frozen documentation set needs a comprehensive, evidence-backed review without mutation. |
| Mutation | None. Every step is read-only. |
| Scope | `documentation-set` by default. `focused-set` when the request names documentation targets. |
| Result | A revision-bound review with separate findings, gaps, limitations, and terminal quality evidence. |
| Excluded actions | Edit, publish, commit, push, open a merge request, merge, or claim release readiness without the required evidence. |

## Run the Workflow

Select the target repository and optional revision:

```bash
docsfab run review-documentation --repo <path> --revision <revision>
```

The fixed step sequence is:

1. `audit-documentation` in the declared scope (the Review Scope section below
   explains how the step prompt and a focused scope interact)
2. `derive-source-obligations` (`verify-technical-accuracy` inventory-only)
3. `lint-documentation`
4. `provisional-technical-verification`, using `verify-technical-accuracy`
5. `verify-technical-accuracy`, correcting the provisional evidence
6. `review-documentation`
7. `test-audience-understanding`
8. `evaluate-document-quality`

Audience testing requires a frozen scenario corpus, oracle, representative
audience, independence, and run authority. Without those inputs, the step
returns insufficient evidence and names the missing prerequisites.

## Check and Verification Evidence

Incomplete repository discovery does not invalidate the locked quality profile.
The review records discovery gaps, such as unindexed binary files, in its run
warnings and final report. Recognized documentation does not establish complete
repository coverage.

The lint step runs applicable repository-native documentation checks through
an isolated host executor. Its result records each command, exit status, and
output. Checks that cannot run remain unavailable, with their reasons and
untested scope. They do not count as passing checks.

Native command execution requires Linux with an available Bubblewrap sandbox.
On macOS, the step reports unavailable because the host cannot guarantee
cleanup of detached child processes. Run the repository checks separately and
retain their results when this limitation applies.

Technical verification must return findings and coverage for the declared
targets. Each verified target includes source evidence and the claims checked.
Unverified targets remain visible and require human review. A promise to
perform verification does not complete the step.

Coverage a judgment reply returns is degraded rather than refused in this
workflow. The host records exactly one entry per declared target: an entry for
a page outside the declared targets is removed, a declared target the reply
omitted is recorded unverified, an out-of-vocabulary status and a status that
claims verification without evidence become unverified, a declared target named
as a locator with line numbers or with a leading `./` is kept and rewritten to
the declared path, and an over-long reason or evidence list is truncated to the
stated answer budget. Each class of change adds one host limitation that names
what the reply said. The answer budget the
step states carries those coverage ceilings and a whole-answer character
budget, so the reply can be planned against them rather than refused after the
fact.

A review whose sealed source-obligation ledger admitted no source has no model
answer to ask for: no obligation exists to judge, no issue can cite one, and no
coverage claim can be compared with an admitted source. The host records every
declared target unverified with one limitation that says so, without spending a
model turn, for both the provisional step and the correction. The step record
still names the model profile the run is bound to, because a run's integrity
evidence binds every inference step to the installed composition; it records no
provider turn, token usage, or tool activity, because none was spent.

Source-obligation derivation first records proposed atomic source facts,
locations, and uncertainty. The ledger is untrusted evidence with
`bounded-not-proven` completeness. It cannot broaden the frozen review scope,
admit another source, or grant tool authority. The provisional technical step
then compares the documentation with the sources.

A fresh correction reads the sources again and checks the provisional findings
and their consistency with the fact inventory. It accounts for each obligation
as retained, refined, or rejected. Refinements and rejections retain the
original proposal and a source-backed reason. Accounting establishes
traceability, not factual correctness.

The current correction model returns a closed version 3 proposal containing the
verdict, coverage, complete fact inventory, obligation accounting, and bounded
issue judgments. Each judgment contains only its ID, severity, category, target
location, and fact links. The host rejects inconsistent links and out-of-target
locations. It derives the unchanged review issues from the exact linked fact
statements, dispositions, uncertainties, source locators, and bound repository
revision. The model does not provide a separate factual finding, evidence
narrative, action, or impact field. A sealed proposal that omits obligation
judgments fails `invalid-shape`. An applicable dimension with no admitted
facts fails `invalid-fact-inventory`.

Only the host-derived final technical result supplies current findings and
evaluation evidence. This correction protocol adds no workflow step or model
call. The private record retains provisional results for inspection. A failed
correction does not promote provisional findings to final evidence.

The added read-only phases can increase run time and model cost. Existing
provider, tool, and lease limits remain per step. Caller cancellation and any
stronger overall deadline cover the complete invocation without resetting at
either phase.

When technical verification fails its structured response contract, the failed
step records one fixed category after `Technical review response rejected:`
(`Technical correction response rejected:` when the judgment decoder raised
it). `invalid-coverage` no longer describes the outcome of a review-documentation
judgment reply, whose coverage is degraded as above; it still refuses a
create-documentation reply, whose coverage status the host cannot degrade.
The category is `invalid-json`, `invalid-shape`, `unsafe-disclosure`,
`invalid-review`, `invalid-coverage`, `invalid-fact-inventory`,
`inconsistent-verdict`, or `unknown`. These categories identify the rejected
contract boundary. They do not include the rejected response, field names,
values, repository paths, credentials, validator exceptions, or provider text.
The inference category remains `malformed-response`. Disclosure refusals and an
unavailable host review schema are not retried.

The terminal evaluator consumes these results with the other review evidence.
A quality report that fails host validation leaves the evaluation step failed,
even when the report is retained for inspection.

The final evaluation must trace each fact that is not documented. One finding
names the fact ID, every linked issue ID, and the exact uncertainty. The host
then adds the fact's admitted source locators that the finding does not cite
exactly. It adds one evidence entry for each locator before it stages and
validates the evaluation. Each entry has a fixed description that names the
fact and a host `provider_id`. The evaluator does not copy locators by hand.
An evidence `locator` field cites a locator when the locator fills one whole
`;`-separated entry. A locator whose label contains `;`, such as
`docs/a.md: Setup; Install`, counts as one locator. The check reads fact IDs,
issue IDs, and uncertainty only from evaluator-authored text, not from
host-added entries. A finding that lacks the fact ID, an issue ID, or the
uncertainty still fails the technical-trace check.

For the exact final `evaluate-document-quality` step in this read-only REVIEW
workflow, the host offers `validate_quality_candidate` when the run already has
a selected quality profile and uses the quality-artifact response contract.
Hosted runs without that profile retain their existing evaluator contract.
Under that contract, the evaluator's final answer starts with one strict JSON
object that holds `evaluation` and `qualityScore`. The report follows that
object as plain Markdown that opens with its heading line, and the host stores
it as `reportMarkdown`. The host refuses a report that carries answer JSON
outside fenced or inline code, or that leaves a code fence open before more
report text. A lone fence line that ends the report hides nothing, so the host
drops it from the stored report. The host still reads a three-member
`{evaluation, qualityScore, reportMarkdown}` JSON envelope exactly as before.
Both forms pass the same checks. The evaluator sends its current draft to the
tool as a bounded string. The tool checks envelope content and technical trace
for that submitted candidate digest and returns bounded, content-free
feedback. The evaluator can correct the draft in the same inference session.
Tool calls and subsequent turns use the existing cancellation, time, token,
turn, and tool-call limits. This does not add a workflow step, inference retry, or separate model
call.

A valid tool result is advisory and applies only to the submitted draft. It
does not establish schema or profile validity, semantic truth, overall document
quality, or permission. The host still decodes and validates the evaluator's
actual final response through the normal schema, profile, technical-trace, and
report-binding checks. A changed or invalid final response still fails those
checks. The tool is not offered to CREATE, UPDATE, writer, technical,
editorial, or audience steps, so their behavior remains unchanged.

The contract also restates, from the locked evaluation schema and profile that
the prompt already carries, the required keys of each evaluation object (for
example, the five keys every layer must contain), the keys or entries that a
single-value condition adds (such as a verified finding's
`verification_evidence`, or the `conditions` entry a conditional pass needs),
the allowed values, pattern, or format of each constrained evaluation field,
and the `dimension_id` that each `constraints` key takes. The host fills the
quality evaluation's run identity, timestamp, profile, evaluator metadata,
contract version (`1.0`), target scope and revisions, constraint IDs, finding
IDs and disposition defaults, and rule-derived confidence and decisions.
Dimension IDs remain in the evaluator's response as correlation keys so the
host can preserve each judgment's association while canonicalizing order.
Other host-written fields are omitted from the evaluator's requested keys,
including in a focused review's scope block. The evaluator still owns the
judgments attached to those dimension IDs, including each dimension's
confidence. The host derives layer and overall confidence and decisions from
the judgments, counting required dimensions assessed `not-assessed`.

The host writes `outcomes.human` and `outcomes.agent` from an admitted audience
evaluation artifact only. When no such artifact is admitted, both arrays are
empty; model-authored outcome claims and placeholder attempt IDs are not
carried into the evaluation. The host records that evidence gap in the
limitations when the selected profile requires it.

The current EvaluateStepEvidence binding records evaluator, tool-policy, and
acceptance-policy digests, but no author-independence attestation. The host
therefore records `independent_of_authors: false` with that limitation; the
identity digest alone is not evidence of independence.

The current full-artifact schema has no separate reference-item array for
technical or editorial issue IDs. The host preserves the evaluator's evidence
and carries locators from admitted technical verification; it does not invent
issue-reference items. A future record assembly can resolve those references
from sealed earlier artifacts.

When the host replaces derived fields or supplies metadata, the report records
counts only. It does not repeat evaluator-provided values in the disclosure.

After a pattern or format refusal, the retry names the schema's pattern or
format at the refused location. After a shape refusal of the leading object,
the retry names the answer's two keys, which of them the object lacks, and
its undeclared keys. After a missing required key in an object that also has
an undeclared key, it names both. After a missing technical fact ID, it names
the not-documented facts of the admitted technical verification that no
finding names. A reply key is named only when it is a plain identifier, the
shared credential detector matches no part of it between separators, and no
segment of it is a long mix of letters and digits
(`inference.echoedKeySegmentRandomChars`); any other key is only counted.

When the evaluator's answer is cut at the output limit, continued, and still
refused, the step retries within its existing retry budget instead of
declining the attempt. Other steps still decline such an answer, because a
retry would pay the whole output budget again.

### Answer Through a Tool Call

On a route whose installed composition recorded an answer submission, the
evaluator answers through a tool call instead. It calls
`submit_quality_evaluation` once, with `evaluation` and `qualityScore` as its
two arguments. When the turn ends, the host decodes the call from the raw
argument text the serving stack forwarded, never from the harness's parsed object, so
the arguments meet the same strict JSON as the text answer: a duplicate key, a
raw line break inside a string, trailing text, and a third argument are each
refused with their own `quality-submission-*` code. Some serving stacks send
`evaluation` or `qualityScore` as one JSON string that holds the value. The
host decodes that string exactly once, with the same strict parser, and admits
only what the value itself would be admitted as: an object for `evaluation`,
an object or `null` for `qualityScore`. A string that holds another encoded
string is refused, and the attempt records how each member arrived. After it admits the submission, the host asks for
the report in a separate turn, with `tool_choice: "none"` when the route
recorded that it serves one. The report meets the same report rules as the text
answer, under `quality-submission-report` codes, and the host stores the same
candidate the text answer would store for the same evaluation, score, and
report. A reply with no submission call is refused as
`quality-submission-missing`, and a submission cut at the output limit is
refused as `quality-submission-cut`, never continued. On this path,
`validate_quality_candidate` takes the same two arguments and decodes them the
same way.

The route's recorded capability comes from the qualification probe,
`docsfab doctor --live --answer-submission`. An unmatched endpoint that serves the same model at the
composition's proven origin borrows it; the same model behind another origin
does not. `DOCSFAB_ANSWER_SUBMISSION=text-final` keeps the text answer on every
route. Every evaluator attempt records which path it took and why. Refer to
[Runtime CLI and Configuration in DocsFab](../status-and-configuration/environment-variables.md#host-and-private-configuration).

## Review Scope

Two modes. The scope is frozen before any model turn and is recorded in the run
record, so a focused run and a baseline run are never confused for each other. The following table describes the two modes.

The following table describes each scope mode.

| Mode | When | Behaviour |
| --- | --- | --- |
| `documentation-set` | Every scheduled run, every baseline, and every request that names no target. | The whole declared documentation set. |
| `focused-set` | The request names documentation targets, **or** the run was triggered by a merge request. This is the default for every merge-request review; no project policy is needed to enable it. | Only the pages in scope are reviewed and reported. |

For hosted procedures, follow [Review Documentation From Slack](../../workflows/review-from-slack.md) or [Ask a Documentation Question From Slack](../../workflows/ask-from-slack.md).

In live-agent, name repository-relative Markdown paths in your instruction:

```text
Review exactly docs/get-started/live-agent-quickstart.md. Remain read-only.
```

For a one-off job, select a page with `--context-path`:

```bash
docsfab run review-documentation --repo <path> --context-path docs/get-started/live-agent-quickstart.md
```

An explicit `--context-path` takes precedence over paths mentioned in the
instruction. Without it, named Markdown paths select the review targets.
Missing or unrecognized targets stop the run before inference. Instructions
that mix named pages with supporting sources, exclusions, or whole-set scope
require an explicit page selection or a clearer target-only instruction.
The same page set binds every step and final quality validation. Supporting
source reads do not expand the reviewed set.

The final quality evaluation's target, `evaluation.target.paths`, belongs to the
host, focused or not. The host derives it once, before inference, from the
selected pages in the following ways:

- A focused run binds exactly the named pages.
- A run without named pages reviews every public tracked documentation page. It
  binds the shortest exact list that covers them. A directory such as `docs`
  stands for every page under it, but only when every documentation page under
  that directory is in scope and no tracked-entry gap could hide one there.
  The repository root is never an entry. A repository whose public pages sit
  under a few directories binds a few entries; pages beside out-of-scope
  documents stay individual entries.
- A target with more than `reviewScope.maxTargets` entries stops the run before
  inference with `review-scope-max-targets-bound`. Name pages in batches, or
  review one page with `--context-path`.
- A run whose host-written technical coverage, one entry per target page,
  alone exceeds `technicalCorrection.proposalMaxBytes` stops before inference
  with `technical-correction-proposal-max-bytes-bound`. This can happen to a run
  without named pages in a large repository. The message names the observed
  bytes and the number of pages. Review one directory or a named set of pages
  at a time. Each page costs its path's UTF-8 bytes plus 255 bytes, so a
  focused set of `reviewScope.maxTargets` pages passes this check when its
  paths average at most 768 UTF-8 bytes. Every ASCII path within
  `reviewScope.pathMaxChars` does. Long non-ASCII paths can still be refused,
  because `reviewScope.pathMaxChars` counts characters, not bytes.

The evaluator prompt states this target, with the page count of each directory
entry, and asks the evaluator to leave `evaluation.target.paths` out of its
answer. Before validation, the host writes the target into the evaluation, so
the evaluator never chooses or copies its scope.

When the evaluator writes a different, non-empty set anyway, the report records one host
limitation. It gives counts only: how many in-scope pages the evaluator's set
covered, and how many of its paths lay outside the scope.

The bound target labels what the evaluation covers. It does not show that the
evaluator read every page. Partial evidence appears in the evaluation's
dimensions and limitations.

The following rules apply to every focused run:

- Every named path must be a repository-relative Markdown file **tracked at the
  frozen revision**. The path is validated structurally, not as prose: a
  leading `/` or `~`, a backslash, an empty, `.` or `..` segment, a control
  character, whitespace or a comma anywhere in the path (the `target=` grammar
  splits on both), a URL-shaped or credential-shaped value, or a non-`.md`
  suffix is refused, while an ordinary tracked page whose path contains a `home/`,
  `root/` or `Users/` segment is accepted at every layer. A path that is not
  tracked fails the run before any model turn rather than quietly narrowing it,
  so a typo cannot produce a smaller review that still reports success; the
  reason is written as a `frozen-input` dispatcher failure line.
- Pages are reviewed in the order named.
- How many pages one run covers is decided by a budget derived from the
  measured page sizes, not by a fixed count. Pages the budget cannot cover are
  recorded as **deferred** in the run record and counted in the dispatcher
  receipt. The model is instructed to name them in its output, to state that
  the run reviewed N of M tracked Markdown pages, and to give the exact
  continuation command: the same `/docsfab run review-documentation` command
  with the registered canon digest, original `reviewRevision=`, and `target=`
  set to the deferred pages. Nothing is silently dropped. The GitLab summary
  and the project-bound Slack terminal projector render the same bounded line;
  Slack reads and digest-checks the retained run record before posting once to
  the originating thread.
- The scope is delivered to every workflow step as authoritative
  instruction, not as untrusted evidence, and the scope digest is bound into
  each step's execution lease identity. The host binds the resolved scope --
  reviewed paths, deferred paths, digest, and corpus count -- and refuses a
  terminal run record whose scope differs from it.
- A focused run with exactly one page uses `change-scoped` /
  `get-neighborhood` context for that page. The retained single-page fixture
  succeeded through all eight steps with 31,728 compiled context bytes, while
  repository discovery fell from six executions to one.
- A multi-page focused run keeps the catalog's `corpus` / `expand` context
  level. The context index covers only the selected pages plus the other
  pages and navigation files in each directory on a selected page's path, up
  to the repository root. Expansion starts from every selected page, and every selected
  page must appear in the compiled context, or the step's context preflight
  records `failed` with `target-not-applicable`. A documentation-set run keeps
  the unscoped `corpus` / `expand` context.
- Focused indexing classifies a symlink by what the selected pages need
  before it rejects anything. A symlink in a directory the pages do not need
  is never read. A symlinked page in a directory on a selected page's path is
  skipped. A symlinked or executable navigation file in such a directory
  records the step's context as `degraded` with
  `navigation-coverage-incomplete`, so the review continues but never claims
  complete navigation. A selected page, or a directory on its path, that is a
  symlink records `degraded` with `navigation-alias-refused` and a `cause`
  that names it. DocsFab does not follow the symlink, so the review steps run
  without a context packet, and the run's LIMITATIONS name the symlink. A
  navigation entry that names a page outside the selected set, or a skipped
  symlinked page, is left out of the context and is not reported as broken.
  A navigation entry that names a missing page the index would have read is
  named as a navigation limitation, and the step's context records
  `degraded` with `navigation-coverage-incomplete`; the review continues.
- The host still appends the authoritative scope block after the catalog
  prompt, and that block takes precedence over a contradictory instruction.

### Merge-request runs: the blast radius

A review triggered by a merge request names no targets, so the host computes
them. The computation is deterministic, git-only, and runs at dispatch from the
project mirror, before any model turn: it recomputes the merge base locally
between the target branch tip held in the project mirror and the frozen head,
takes a bounded `git diff --name-status`, and scans the tracked Markdown at the
head tree for links, navigation membership, transclusions, and cited source
paths. No revision reported by the forge enters the computation, and the host
does not call the forge's changes API.

The target tip is fetched into the mirror when the change is drained for
dispatch. If that fetch fails, the host uses the mirror's own copy of the
target branch, last refreshed by activation or by an earlier sync. A stale tip
can only move the merge base backwards along the target branch, which widens
the diff and the radius; it never narrows them. When no local merge base
exists, the diff is taken against the target tip itself, which also only
widens it. If neither ref resolves, or the diff itself cannot be read, no
changed page is known and the run stays at `documentation-set` with
`scan-unavailable`.

A page is in the radius for exactly one reason, the highest-ranked one that
applies. The following table lists the reasons.

| Reason | Rule |
| --- | --- |
| `changed-document` | The diff changed this page. |
| `anchor-index` | The `index.md` or `README.md` beside a changed page. |
| `inbound-link` | The page links to a changed page, **including one the change deleted**. |
| `outbound-link` | A changed page links to this page. |
| `navigation-sibling` | The page shares a navigation group with a changed page. |
| `snippet-sibling` | The page transcludes, or is transcluded by, a changed page. |
| `source-drift` | The page cites a repository path that a non-documentation part of the diff changed or deleted. Citation matching intersects the complete base-to-head diff, so a source deleted from the head tree still reaches its citing page. |
| `anchor-model` | The product reference model head. Always in the radius, reviewed last unless the diff changed it, and always listed: when the radius overflows the scope shape its slot is reserved by path, so a head that a changed page links to (recorded as `outbound-link`) keeps it (refer to the bounds below). A change that reaches no page, such as a code-only or navigation-only change, is reviewed against the head alone. |

Neighbour reasons are **one hop from the changed set only**, never transitive: a
two-hop closure reaches most of the corpus and would be documentation-set scope
wearing a focused-set label. Links inside code fences and code spans are
documentation *about* a link, not a link, and are ignored.

The reference model head is the one exception to ordering by reason. Unless the
diff changed the head itself, it is reviewed last however the change reached
it, because its size would otherwise displace the pages the change touched, and its recorded reason still says how
the change reached it: a change that links to the head records `outbound-link`
and does not reorder the budget. Its slot at the 256-page ceiling is reserved
by path for the same reason, and the continuation command names it first.

Size never widens a run, and neither does a structural change or a scan
failure. The whole diff is enumerated and every path kept; the whole radius is
computed and ranked; the job's budget decides how much of it this run covers,
and the rest is deferred. The scope reason records what shaped the radius, as the following table
shows.

| Scope reason | Meaning |
| --- | --- |
| `within-budget` | The radius was computed in full. |
| `navigation-changed` | The diff moved the navigation configuration. The run reviews the changed pages, their one-hop radius, and the reference model head. |
| `model-changed` | The diff moved the reference model, for example a new model version. The changed model pages are reviewed first, with their radius. |
| `config-changed` | The diff moved the project configuration that defines the documentation roots. The run reviews the same radius as `navigation-changed`. |
| `scan-unavailable` | Part of the scan failed. An unparseable navigation configuration leaves out navigation siblings, and a changed page the scan cannot read is counted as unreviewable. When the page graph cannot be read at all (a Git timeout, a failed blob read, or more pages than the scan bound), the run reviews the changed pages on their own. |

When no page and no reference model head is in reach, and when no changed page
is known, the run stays at `documentation-set` with `scan-unavailable`.

A reason other than `within-budget` does not mean the whole radius fit. Every
focused merge-request run is bounded by the job's budget, **not** guaranteed to
fit. Pages the budget could not cover are deferred and carry their own
`over-budget` reason, so `within-budget` alongside a non-empty deferred list is
the normal case.

#### Bounds that do exist, and what happens at each

The diff is never truncated and size never escalates, but the following three
structural bounds are real and each one is reported rather than hidden.

| Bound | Value | Behaviour |
| --- | --- | --- |
| Page size the scan can read | 1 MiB | A page above this is not listed, changed or not. It is counted as `reviewScopeUnreviewableNeighbourCount` on the dispatcher receipt and in the coverage line, and a changed one sets the reason to `scan-unavailable`. Widening to cover it is an explicit operator choice. |
| Path the scope shape cannot carry | Whitespace or a comma in the path, or any other refused shape | The page is never a target or a deferral. It is still read as a link source, so the radius sees it; it is counted as `reviewScopeUnreviewableNeighbourCount` and not listed, and a changed one sets the reason to `scan-unavailable`. Widening to cover it is an explicit operator choice. |
| Tracked documentation pages scanned | 4096 | Above this the run reviews the changed pages on their own, with `scan-unavailable`. |
| Pages one scope may name | 256 each for reviewed and deferred | The transport shape's hard ceiling, enforced on both sides. Project policy may select a smaller batch. The host retains the full ordered remainder, original base and head, completed set, anchors, canon, principal, project, epoch, policy, and accounting in project-bound CAS. Its compact locator drives the next focused batch. |

Merge-request blast-radius selection is always on. The optional sealed
`runtime.reviewScope` project policy only overrides its defaults, together:
131,072 page bytes, 300 tool calls, three calls per target,
19,000 milliseconds per provider turn, 2,500 basis points of fixed overhead,
256 listed paths, and a 2,048-character continuation. The byte value is the
128 KiB corpus capsule ceiling at four bytes per estimated token; 300 preserves
25% of the 400-call hard ceiling; three calls per page and 19 seconds per turn
come from the 2026-09-11 pilot; the overhead reserve covers startup, planning,
and summary work. Each field has a bounded operator override through
`amend-dispatcher-composition.sh`; list and command overrides may narrow the
protocol maximum but cannot widen it. Credential, authority, exact-revision,
and safety checks are not tunable.

For the retained remainder, follow [Continue a Hosted Documentation Review](../../workflows/continue-hosted-review.md). Escalation remains terminal; an escalated run is never retried at a narrower scope.

### What focused-set does not do

`focused-set` narrows what is **reviewed and reported**. It is not a filesystem
boundary, and the tools are not confined to the named pages. That is deliberate:
`verify-technical-accuracy` has to read the source a documentation claim depends
on, and `audit-documentation` has to read navigation and the reference model.
Confining reads to the named pages would break those steps rather than focus
them. The review reports findings only against the named pages, and the run
record carries the reviewed set, the deferred set, the scope digest, and the
corpus count so the coverage claim can be checked. The corpus count is every
tracked `*.md` file at the frozen revision -- skill pages, fixtures, and
planning notes included -- not only the pages under `docs/`, which is why the
coverage statement says "tracked Markdown pages" rather than "documentation
pages".

## Output and Authority Boundary

The terminal evaluator consumes the preceding evidence streams. It preserves
the layered vector, human and agent outcomes, hard failures, gaps, and
limitations separately. It produces the artifacts and locators required by the
[locked evaluation skill](../../../packages/skills/evaluate-document-quality/SKILL.md)
and validates the report summary against the canonical
[quality-report schema](../../../packages/quality/schemas/quality-report.schema.json).
The skill and schema own how the layered decision, hard failures, and rubric
availability interact. Missing inputs and unavailable evidence remain visible
in the report; do not infer the overall decision from rubric status alone.

The workflow does not edit source files or perform SCM, publication, merge, or
release-approval actions.

## JSON Result

Refer to [Review JSON Result Reference](review-json-result.md).

## Authoritative Sources

This page is based on the following sources:

- [Workflow manifest](../../../packages/runtime/workflows/review-documentation.json)
- [Inventory-only verification skill](../../../packages/skills/verify-technical-accuracy/SKILL.md)
- [Technical verification skill](../../../packages/skills/verify-technical-accuracy/SKILL.md)
- [Audit skill](../../../packages/skills/audit-documentation/SKILL.md)
- [Quality-evaluation skill](../../../packages/skills/evaluate-document-quality/SKILL.md)

## Related Topics

For more information, refer to the following topics:

- [Run a Documentation Workflow in DocsFab](../../workflows/run-a-documentation-workflow.md)
- [Skill Behavior Contracts in DocsFab](../quality/skills/index.md)
- [Documentation Constraint Evidence in DocsFab](../quality/documentation-constraint-evidence.md)

## Moved Topic Links

Earlier section bookmarks lead to the canonical topic below.

<a id="consume-the-json-result"></a>

Refer to [DocsFab Review JSON Result Reference](review-json-result.md#consume-the-json-result).
