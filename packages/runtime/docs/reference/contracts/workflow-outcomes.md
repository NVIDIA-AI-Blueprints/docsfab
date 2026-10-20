# Workflow execution and product outcomes

DocsFab records two independent questions:

1. **Did the governed workflow execute correctly?** `RunRecord.status` and
   `steps[].status` answer this harness question.
2. **What does the admitted evidence say about the product?** The optional
   versioned `RunRecord.workflowOutcome` envelope answers this product question.

Consequently, a completed documentation audit may be
`status: succeeded` with `workflowOutcome.disposition: not-ready`. Provider,
scanner, contract, persistence, or patch-capture failures remain execution
failures; they cannot be encoded as product gaps. A fully accounted tool failure
in an otherwise completed audit limits the evidence instead: the audit remains
`status: succeeded` and records `workflowOutcome.disposition: inconclusive`
with `audit-tool-evidence-limited` bound to the affected step evidence.

## Version 1 envelope

The outcome envelope supports these closed dispositions:

| Disposition | Required structure |
|---|---|
| `ready` | No findings, limitations, or open decisions |
| `not-ready` | At least one blocking product or roadmap gap |
| `needs-input` | Every typed missing-input finding is bound one-to-one to the exact governed input ID and the same admitted evidence |
| `inconclusive` | An evidence-limitation finding and one or more limitation codes |
| `blocked` | A blocking dependency finding and a dependency, policy, or human decision |

Execution and evidence precedence is closed. A `succeeded` run must contain only
succeeded steps and no run error. Failed provider attempts, scanner denial, tool
defects, denied paths, unknown tools, and governance stops cannot be relabelled
`ready`, and a `not-ready` outcome admits them only as this paragraph
describes. The `expected-withheld-tool` limitation of an explicitly withheld
read-only tool licenses its denied paths, unknown tools, and governance stops.
A `ready` outcome also refuses every recorded model tool miss. Model tool
misses that changed nothing and crossed no grant do not fail a `not-ready`
outcome, so it keeps its findings and patch: `recoverable-miss` (edit text that
is absent, ambiguous, empty, overlapping, or unchanged, an edit of a missing
file, a read past the end of a file, or a directory where a file was expected
or the reverse), uncorrected `malformed-arguments`, `unsupported-pattern`
(including a `grep` pattern or glob that ripgrep cannot parse), and
`citation-refused`. On a read-only step, which holds no edit or write tool, no
failed call can change the patch. Its `denied-path` (a refused read), its
`unknown-tool` (a call to a tool the step was not offered), and its
`tool-defect` (a read or search that failed, such as a `grep` over a file the
host cannot read) are recorded misses too. The runner
records them on the outcome as the `tool-misses-recorded` limitation, whose
`evidence-limitation` finding cites every step that recorded one. Admission
refuses a `not-ready` outcome that omits it and any outcome that claims it
without recorded misses. On a write step, a `tool-defect` stays material
because an internal or unattributed failure can be a write that failed
part-way, and a `denied-path` stays material because it can be a write refused
outside the plan. A `governance-stop` that `expected-withheld-tool` does not
license stays material on every step. Search
evidence cited by `ready` must be `found`; incomplete/no-progress evidence
belongs to `inconclusive`, and blocked or hard-ceiling evidence belongs to
`blocked`. A `roadmap-gap` finding must cite an admitted `roadmap-ledger`
artifact rather than a prose or step-only claim.

Every finding and open decision references admitted content-free evidence. Step
references bind the repository revision, workflow/step identity, execution
status, summary digest, search-envelope digest, and artifact references. Search
references bind an exact target-level bounded-search evidence digest. Artifact
references must already occur in the run with the same step and input/output
role. Produced artifacts must be admitted run outputs.

The envelope is recursively closed and canonically sealed. Unknown or hidden
fields, proxies, accessors, sparse arrays, duplicate identities, orphaned
evidence, substituted digests, illegal execution/disposition pairs, and
self-rehashed contradictory reports fail validation. Codes and identities are
content-free; searched content, tool arguments, credentials, and host paths do
not enter the outcome envelope. Outcome identifiers reject absolute-path and
URL-shaped segments rather than treating them as opaque IDs.

Every finding `code` and `limitations` entry matches one grammar,
`^[a-z0-9][a-z0-9.-]{0,127}$`: lowercase letters, digits, dots, and hyphens
only (`WORKFLOW_OUTCOME_CODE_GRAMMAR`). The editorial assessment contract uses
the same grammar for the limitation and recommendation codes that the
authoring projector copies into findings (#1268). A model code outside it,
such as `no_runtime_observation`, is refused as a coded retryable
`malformed-response` at the assessment step. It never reaches the outcome
admission after every step has succeeded.

A limitation must describe what the step's own evidence established. The
assessment contract shows a placeholder, not a code, and the harness refuses
an assessment that repeats a contract placeholder or the retired example
`bounded-code` as the coded, retryable `contract-placeholder-copied` (#1282).
Before that change, copied `bounded-code` limitations reached six recorded
update-documentation outcomes as `finding:authoring-quality:bounded-code`.
In the quality evaluator's answer form, a report that is only the contract's
placeholder is refused first as `quality-envelope-report`; see
[run records](run-records.md).

## Projection and compatibility

`WorkflowOutcomeProjector` is a harness-neutral seam. A configured workflow can
project typed findings after execution without coupling the `Task -> Workflow ->
Step` contract to Pi. Until a workflow-specific projector is configured, a new
successful run is recorded honestly as `inconclusive` with the limitation
`structured-product-evidence-unavailable`; DocsFab never infers `ready` from a
successful model call. Catalog `review-documentation` maps
admitted step/search evidence to findings and never projects `ready` from a
model call alone. Hard-blocked and incomplete search evidence retains precedence
over product-gap projection. Expected missing probes and explicitly withheld
read-only tools retain their existing governed treatment; other accounted tool
failures are visible as an inconclusive evidence limitation. Authoring jobs that
already run `evaluate-document-quality`
(`create-documentation`, `update-documentation`,
`restructure-documentation`) project that step into `inconclusive` with closed
limitation codes from admitted JSON keys. They never project `ready` while
the bound quality profile is experimental.

An `update-documentation` run projects its validated editorial decision
instead. When the decision keeps the planner's candidate, each of its
limitations becomes an `evidence-limitation` finding of the `inconclusive`
outcome. A verified no-change needs `accepted` from technical verification and
from review. The quality evaluator can accept it or answer `not-applicable`,
because a no-change changes no page whose quality it could judge. The decision
then carries `quality-evaluation-not-applicable`, and so does the outcome. The
decision merges the candidate's and every assessment's limitation codes once
each. Each list was bounded where it was admitted, so the merge adds no count
bound of its own.

The planner (`plan-documentation`) can stop an authoring job because the
request lacks a governed input (#1354), such as `ambiguous-scope`. The host
admits that stop as a content-free planner diagnostic. The run then records
`status: needs-input` with `workflowOutcome.disposition: needs-input`. The
outcome has one blocking `missing-governed-input` finding with the planner
code, bound one-to-one to a `governed-input` open decision. The input ID is
`documentation-plan:<code>`, and the evidence is the planner step. NEXT is a
retry with an amended instruction that names the input. It is not an
editorial InputAsk continuation.

Plan admission raises one stop of its own through the same diagnostic (#1739).
A CREATE plan whose one existing target is a tracked regular file at that exact
path is not a stop: the host converts that page into an UPDATE in the sealed
plan binding. A CREATE plan that targets two or more pages that already exist
stops with `ambiguous-create-targets`. The host writes that step's summary as
the question, which `NEXT` prints as `Question:`. A planner's stated reason
never maps to that code.

The writer can also stop an authoring job. On a write step bound to the
approved plan, an `edit` or `write` call that the confined tools refuse as
outside that plan stops the step `needs-input`, because the change needs a
wider plan. The step loop records the stop as the coded step field
`planScopeStop` (`code: writer-mutation-outside-plan`, with the count of refused
calls). The projector admits it only on the run's single `needs-input` step,
when that step is a write step bound to the planner's exact plan digest, its
last inference attempt succeeded, and its recorded `denied-path` and failed
edit/write counts account for every refused call. The outcome then has one
blocking `missing-governed-input` finding with input ID
`documentation-plan:writer-mutation-outside-plan`, bound to a `governed-input`
open decision, and the evidence is the write step. NEXT is the same amended
instruction retry, and its reason says to include, or drop, the path the change
needed. A stopped `create-documentation` writer seals no candidate. A stopped
reviser keeps candidate zero selected, with a non-deliverable partial. A
converted page is part of the approved plan, so a write to it is not outside
the plan.

The planned writer has a second stop. When the harness supplied a repository
instruction file to the `write-documentation` step, the plan has at least one
page to write, and the step completed no `edit` or `write` call, the step
stops `needs-input`: its prompt tells a writer that cannot satisfy the file
to change nothing and reply with the instruction and one question. The step
loop records the stop as the coded step field `writerNoChangeStop` (`code:
writer-made-no-change`, with the repository-relative path of each
instruction file the harness supplied, as the harness resolved it: through a
symbolic link, and in the file's own spelling on a case-insensitive file
system). A plan that retains every page never gets this stop, so a no-change
conclusion that the plan supports reaches the run's own no-change outcome. A
step that used its whole tool-call or provider-turn allowance keeps its
execution-limit failure instead. The projector admits the stop only on the
run's single `needs-input` step, when that step is the `write-documentation`
inference step in write mode, bound to the planner's exact plan digest with
at least one page to write, with a succeeded last attempt and no plan-scope
stop, and its recorded tool evidence offered `edit` or `write` and shows no
completed call to either. Each recorded path must be a repository-relative
path without a control character, so NEXT shows it on one line. The outcome then has one blocking
`missing-governed-input` finding with input ID
`documentation-plan:writer-made-no-change`, bound to a `governed-input` open
decision, and the evidence is the write step. The writer's reply stays the
step summary, which PRODUCT prints. NEXT is the amended instruction retry, and
its reason names the code and the instruction files. A writer that held no
instruction file keeps the `empty-write-result` run failure.

A `needs-input` record with no admitted stop is still refused as
`invalid-record`, at `$.steps[].planScopeStop` or
`$.steps[].writerNoChangeStop` when a step carries an unadmitted stop of that
kind, and at `$.steps[].planDiagnostic` otherwise. Comprehensive
`review-documentation` keeps its separate quality-report projection and
does not use this authoring projector.

Historical schema-v2 run records that predate the envelope remain readable as
the explicit state `legacy-no-product-disposition`. That state grants no product
readiness authority.

## CLI and exit policy

Interactive `docsfab run` prints the product disposition, finding codes,
limitation codes, open-decision identities, and evidence identities. Product
`not-ready`, `needs-input`, `inconclusive`, or `blocked` does not turn successful
execution into a crash and does not make the default interactive command fail.

Use `--release-gate` when the caller is a CI or release policy gate. Exit codes
are intentionally distinct:

- `0`: execution and the selected product policy passed;
- `1`: execution failed or did not reach a terminal state;
- `2`: execution completed, but the product disposition (or a legacy record
  without one) failed the release policy.

The record is persisted before the exit decision, so a nonzero release-gate
result does not erase successful execution evidence.

If product-outcome validation or persistence fails, inspect the saved evidence
with `docsfab runs show <run-id> --json`. The run summary and the JSON
`failures` entry name the recorded refusal code, such as
`workflow-outcome-admission-execution-product-mismatch`, and the retained patch
path. When that code is recorded at `$.findings`, a step's tool evidence
refused a `not-ready` result. NEXT then names each such step, the categories it
recorded that the result cannot carry, and the tools whose calls failed, and
asks you to review the retained patch before you use it. Correct the cause of
that failure, then start a new run. For any other refusal, preserve the failed
run unchanged, correct the outcome projector or tool-accounting producer, and
then start a new run. Repeating unchanged inference does not repair retained
evidence.

The final editorial decision of an `update-documentation` run is sealed before
its product outcome. When that finalization refuses the decision, the run fails
with no product outcome and records the refusal as
`editorialFinalizationRejection`, `{code, location}`, such as
`editorial-finalization-decision-independent-rejection` at
`$.evidenceRefs[].producers[].assessment`. The run summary, the JSON
`failures` entry, and NEXT name it. Refer to
[failure classification](failure-classification.md) for every code and its
class.

Operator-visible stops, including product-not-ready versus execution
failure, follow the stop-class handling record.
