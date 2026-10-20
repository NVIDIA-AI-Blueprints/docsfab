# Failure classification

Part of the [run records](run-records.md) family split (record family: failure
classification). See [run-records.md](run-records.md) for the schema overview.

## Failure classification

A failed run and each failed step carry `failure` (#1186): exactly one class
from the closed vocabulary in `src/operator/failure-class.ts`, the layer that
produced it (`workflow` or `inference` in a run record), and the catalogued
code the class was read from. For example, `{ "class": "model-content",
"layer": "inference", "code": "invalid-fact-link" }`. The field is absent on a
record or step that did not fail, and the publication gate refuses it on a
succeeded record.

The workflow runner attaches the classes on every save through one wrapped
store, so no failed record reaches disk without them:

When composition execution aggregate sealing refuses after all steps have
succeeded, the run records `failed` with the composition evidence error's
closed code at the `workflow` layer. A `subject-mismatch` refusal has class
`contract-shape`. If the failed terminal record cannot be saved, the runner
throws the completion error with the original refusal as its cause; it does not
return an unsaved record.

- A step reads, in order: cancellation, then the error a retry wrapped as
  `provider-terminal` only because it was not an inference error, then its
  terminal failed attempt, then the thrown error's code. The operator error
  envelope reads a wrapped error the same way, so both name the same class
  and code.
- An attempt's class comes from its recorded outcome, coded rejection, final
  provider finish reason, and `modelTelemetry.providerError`, in this order:
  - `host-runtime-failure` has an exact, content-free `hostFailureOrigin`
    pair for the execution-lease coordinator. The host origin wins over
    provider telemetry and maps to `infrastructure` at the `inference` layer
    with code `invalid-execution-lease-coordinator`.
  - Only a finish reason proves a reply was cut off at its allowance: a
    `modelTelemetry.finishReason` of `length`, which covers every transport's
    token for it (such as `max_output_tokens`), or, on a record without model
    telemetry, a last-turn raw token that the telemetry normalizer maps to
    `length` (`length`, `max_tokens`, `max_output_tokens`, or
    `incomplete.max_output_tokens`). The raw token set is derived from the
    normalizer's own table, so the two cannot drift. It is `bound`
    with code `output-limit-reached`, whatever shape the cut reply had. `json-unexpected-end` alone is
    `contract-shape`, because the parser also raises it for a reply that
    stopped normally unclosed and for empty text.
  - An attempt that stopped at an execution ceiling is `bound` with that
    ceiling's catalog refusal code, whatever category the stop was wrapped in
    (#1735). The ceiling is read from closed evidence: a last turn with
    `decision: "stop"` and reason `tool-call-limit`, `provider-turn-limit`, or
    `compaction-limit`, or an `executionLease.terminalReason` of
    `hard-tool-call-ceiling` or `provider-turn-limit`. The codes are
    `composition-execution-max-tool-calls-per-step-bound` for tool calls,
    `governance.maxCompactions`'s `compaction-limit` for compactions, and, for
    provider turns, `sealed-composition-execution-max-provider-turns-bound`
    when the step's turn budget is below the host's effective
    `compositionExecution.maxProviderTurns` (the composition's sealed budget
    bound it), else `composition-execution-max-provider-turns-bound` (the
    catalog value or a lowered operator override bound it). A lease that
    stops with one provider turn left has used its budget: it keeps that turn
    for the step's final answer. A stop whose counters do
    not support its reason keeps its category. Other governor stops
    (`context-exhausted`, `compaction-ineffective`,
    `evidence-preservation-required`, and `output-authority-exhausted`) and
    the cumulative lease stops keep their category, because their configured
    value depends on the execution mode and the record does not name it.
  - A coded rejection that no table names is `unknown` with that code, never
    the category's class.
  - A recorded provider error (#1185) that names a cause decides next. With
    an HTTP status, `auth` (401, 403, 407) is `auth`, and `rate-limit`,
    `server`, and `timeout` (408, 429, 5xx) are `flake`, because HTTP marks
    them repeatable; the code is `provider-http-<class>`, for example
    `provider-http-auth`. With no status, the request left the host and no
    failing status came back, so `network`, `unreachable` (a request that
    never connected), `timeout`, and `stream-incomplete` (a 2xx stream that
    closed before it finished, #1696) are `infrastructure`, and `auth` and `rate-limit` keep their classes; the
    code is `provider-<class>`, for example `provider-network` or
    `provider-stream-incomplete`. An
    `invalid-request` (any other 4xx, such as a 400 or 404), a
    `content-filter`, or an `unknown` provider error names no one cause, so
    the attempt keeps its category. A `context-exhausted` attempt is the
    host's own stop and stays `bound`.
  - Otherwise the category decides. `invalid-request`, `timeout`,
    `blank-response`, and `provider-terminal` are `unknown` with their
    category code; `throttled` and `provider-transient` are `flake`, and
    `context-exhausted` and `no-progress` are `bound`. A `no-progress`
    attempt written by the read-loop stop carries the coded rejection
    `execution-read-loop-withheld-reads-bound` or
    `execution-read-loop-unchanged-re-reads-bound`, so its code is that
    limit's refusal. A rejection code no exact table names, but that is a
    catalogued limit's `refusal` in `config/limits/`, is `bound`: the same
    catalog-derived set (`LIMIT_REFUSAL_CODES`) that classes a thrown limit
    refusal, read after every exact table.

  Attempts store no class of their own; readers derive it from those closed
  fields. The provider error class of a request with no HTTP status is the one
  #1185 chose from the provider's error text when it wrote the record; the
  classifier reads only that closed class.

  The category and the class are separate facts. The category is the retry
  vocabulary: it says whether the condition is eligible for a retry. The class
  says why the attempt failed. A sent request whose stream broke with no HTTP
  status can be retried as `provider-transient` (#1247), while an older record
  stores the same failure as `provider-terminal`. Both read their class from
  the same `providerError`, so both are `infrastructure` with code
  `provider-network`. The `provider-transient` category is `flake` only when no
  recorded provider error names a cause, for example on a record written before
  #1185.
- A quality step reads its `qualityValidationRejection` code, else the
  binding's `failureCode`. A quality refusal with no binding, such as a
  candidate admission guard or `validator-lock-entry-missing`, reads its
  `qualityValidationRejection` code alone. Every quality code has a class,
  as described after the quality-path code table below.
- Answer-record host validation failures keep the outer
  `candidate-staging-integrity-failed` rejection. Their step error also names
  a closed, content-free `host reason`; unrecognized internal codes become
  `unclassified`. The diagnostic does not include candidate values or raw
  exception messages.
- An attempt whose settled tool turn brings its executed calls to the hard
  tool-call ceiling ends there: the lease stops with `hard-tool-call-ceiling`,
  the attempt records `no-progress` with condition `tool-call-ceiling`, and no
  answer is asked for, because the step would refuse an answer given at the
  ceiling. The step correction policy retries it once (`retried-tool-call-ceiling`). Its code is
  `composition-execution-max-tool-calls-per-step-bound` at the `inference`
  layer, read from the lease. A step that still completes having used every
  tool call or provider turn its ceiling allows, as a record written before
  this stop shows, was cut off, not finished. It fails with the same ceiling
  code at the `workflow` layer, so a step that reached its tool-call ceiling
  records `composition-execution-max-tool-calls-per-step-bound` whether the
  governor refused its next turn, the host ended it at the ceiling, or it
  completed at the ceiling. The step
  `error` names the code, the observed value, the ceiling, the scope (one
  attempt of the step), and the remediation. When the governor stopped the
  step, that line follows the original message.
- A thrown error whose code is a catalogued limit's `refusal` in
  `config/limits/` is `bound` with that code; `refuseLimit()` throws one. A
  refusal code outside the failure-code grammar (camelCase or longer than
  64 characters) cannot be recorded and still reads as `uncoded-error`; the
  runtime tests pin that list so it can only shrink.
- A CREATE plan whose one existing target is a tracked regular file at that
  exact path is not a failure: plan admission converts it into an UPDATE of
  that page (`createConvertedToUpdate` in the sealed plan binding). Two or
  more such targets stop the run `needs-input` with the host-raised planner
  diagnostic `ambiguous-create-targets`. Any other existing target (a
  directory, a path under a file, a case variant, a link, a submodule, an
  excluded entry, or, for a hosted run, a page the write grant cannot modify)
  is refused at plan admission with code `create-target-exists`, class
  `planning-refusal`. No write step runs. The same code covers the
  candidate-reconstruction check that remains behind it.
- Every local documentation plan, create, update, or restructure, keeps
  inside the run's documentation write roots, whatever its request reading:
  every planned write, restructure navigation companions included, must pass
  the documentation write rule under the roots, directory roots and exact file
  roots. A restructure can also write `fern/docs.yml` and `fern/docs.yaml`
  when each is a regular file in the run's base workspace and a root covers
  it. The confined reader checks each supported path independently of site
  configuration precedence. Both existing files qualify; absent paths and
  links do not. Outside the roots, an existing Fern navigation file is refused
  with `plan-outside-write-roots`. The
  planner is told the roots and the page shape; plan admission is the check.
  Pages the request named are the least the plan addresses. A plan that
  writes a page a root could hold, outside the roots, such as
  `notes/guide.md`, is refused at plan admission with code
  `plan-outside-write-roots`; a plan that writes a file no
  root admits, such as `AGENTS.md`, `src/notes.md`, or an OpenAPI spec under
  `docs/`, with `plan-target-not-writable`. Both are class
  `planning-refusal`, and no write step runs. A run bound to named pages with
  no write roots writes only those pages. Older records name either refusal
  `advisory-plan-outside-write-roots`, class `planning-refusal`.
- A planned agent instruction file or hidden path that the write scope could
  admit but the operator's own request does not name is refused with
  `plan-target-not-named`, class `planning-refusal`, before any writer. This
  applies to local and hosted plan admission. Naming uses the exact
  repository-relative path in the original operator text or an explicit
  target input. A continuation carries the first request's input; an
  unverifiable chain names nothing. The NEXT action names each refused file
  in a new request and preserves the saved comparison and source nominations.
  Naming still requires the existing roots and protected-path rules.
- The run takes its first failed step's class. A finalize-time failure with
  no failed step records a run-level code such as `empty-write-result` or
  `patch-persistence-failed`.
- An error thrown outside every step, once a step has finished and none is
  still running, fails the run with the class the thrown error names, or
  `uncoded-error` when it names none. The run is saved and returned like any
  other failed run (#2078). `docsfab run --json` and `docsfab do --json` print
  it in `failures` at `scope: "run"`, with `layer: "workflow"`, and exit 1. The
  hosted runtime seals that saved record. The operator error envelope
  (`code: operator-error`, `layer: "cli"`) is left for a failure that leaves
  no terminal record: a throw before any step finished or while one runs,
  or a save of the failed record that the store did not complete. A store
  refusal with a recognized code keeps its own `run-store-*` code.
- A workflow product outcome refused after every step succeeded (#1268)
  records its inner reason as `workflowOutcomeRejection`, `{code, location}`,
  and takes that code as its `failure.code`. The `error` text stays
  "Workflow product outcome could not be validated or persisted.", and the
  release-readiness phase keeps its own message. The code is
  `workflow-outcome-<phase>-<producer code>`. The phase is `release-readiness`,
  `projection` (the workflow's outcome projector), or `admission`
  (`createWorkflowOutcome`). The producer code is the refusing error's own
  closed code, such as `invalid-outcome` or `invalid-record`, or
  `uncoded-error` when it has none. An admission refusal names the
  outcome-candidate member its rule read, with `[]` for array members:
  `workflow-outcome-admission-invalid-outcome` at `$.findings[].code` is a
  finding code outside the outcome code grammar. A projection refusal names
  the run-record member its projector rule read, when the projector names one
  (#1354). For example, the authoring projector's `invalid-record` is
  `$.status` for a status it cannot seal, and `$.steps[].planDiagnostic` for a
  needs-input stop with no admitted planner governed-input diagnostic.
  Otherwise, and always for release-readiness, the location is `$`. Every
  inner code is `contract-shape`,
  except `uncoded-error`, which is `unknown`. Records written before #1268 keep
  `workflow-outcome-persistence-failed` with no inner reason.
- A step whose governed workflow search could not complete (#1927) fails
  before its model call with a coded stop instead of `uncoded-error`. The
  search runs in four phases: `plan` (snapshot the catalog's search plan),
  `coordinator` (search the repository), `evidence` (admit the coordinator's
  result), and `release-authority` (validate the release readiness batch
  authority). The step's code is, in this order: the catalog refusal of a
  contract-kit decode bound the error crossed, read from the error the kit
  threw (`contractBoundExceededOf`), never from its message; else the error's
  own code when a failure table names a class other than `unknown` for it,
  such as a limit refusal (`bound`); else
  `workflow-search-<phase>-failed`. That code is `infrastructure` for the
  coordinator, like `impact-postflight-failed`, and `contract-shape` for the
  plan, evidence, and release-authority phases, which re-check host
  contracts. The `error` text is composed from closed facts only: the phase,
  the codes, the error's class name, a limit line rebuilt from the catalog,
  and a repository-relative `path` the error carries. It never copies the
  error's message, and a composed text that the credential detectors flag
  keeps only the code and phase. The thrown error keeps the original on
  `cause` for in-process callers. `docsfab why` reads a phase code as a stop
  before any model call: `workflow-search-coordinator-failed` as a host
  dependency, and the other phase codes as a DocsFab defect, never as a
  model's reply. A search that degraded past `repository.inventoryMaxEntries`
  does not fail: the run records the limit's refusal line in its evidence
  warnings, and LIMITATIONS prints it for every workflow. Records written
  before #1927 keep `uncoded-error` with "Governed workflow search could not
  be completed."
- A CREATE Manifest V3 run whose revision selection refused its admitted
  candidate-zero evidence after every prefix step succeeded (#1293) records
  its inner reason as `authoringCandidateRejection`, `{code, location}`, and
  takes that code as its `failure.code`. The `error` text is unchanged. The
  code is `authoring-candidate-<error code>`, from the closed
  `AuthoringCandidateContractError` codes. `authoring-candidate-unverified-coverage`
  at `$.coverage[].status` is a technical verification result whose
  model-authored coverage status is `unverified`, and its class is
  `model-content`. Since #1297 the runner stops an otherwise valid
  unverified-coverage context as `needs-input` before selection, so that code
  appears only where selection itself refuses. Every other code re-checks a
  host-built binding, records `$`, and is `contract-shape`. `docsfab runs show` prints the code and
  location on its FAILURE section. The local-workflows report shows them in
  the first-failed-step cell and the rejections list. Records written before
  #1293 keep the bare error code, classed `unknown`.
- An `update-documentation` run whose terminal editorial finalization refused
  the final decision after every step succeeded (#2042) records its inner
  reason as `editorialFinalizationRejection`, `{code, location}`, and takes
  that code as its `failure.code`. The `error` text stays "Final editorial
  evidence could not be admitted." The code is
  `editorial-finalization-<contract>-<error code>`, from the refusing
  contract's closed codes: `branch-coverage` (the selected path's coverage),
  `host` (the editorial evidence host), or `decision` (the final editorial
  decision). An error none of them coded is
  `editorial-finalization-uncoded-error`, classed `unknown`. Two codes judge
  model replies, so they are `model-content`:
  `editorial-finalization-decision-independent-rejection`, where the
  independent assessments do not support the final decision, and
  `editorial-finalization-host-conflicting-assessment`, where the evaluator's
  rationale repeats the planner's. Every other code is `contract-shape`. The
  location is the decision member the refusing rule read when the decision
  contract names one. A no-change whose technical verification or review did
  not answer `accepted` records `$.evidenceRefs[].producers[].assessment`;
  every other refusal records `$`. `docsfab runs show` prints the code and
  location on its FAILURE section, and NEXT names both. Records written
  before #2042 keep `editorial-evidence-inadmissible` with no inner reason.

Every class table is keyed by the closed code set it covers, and
`test/failure-classification.test.ts` requires a class for every situation
catalog row, inference category, rejection code, retry rule hint, quality
validator diagnostic, first-pass rule, and CLI refusal code. A code that no
table names reads as `unknown` with that code, and a failed run with no cause
records `unclassified-run-failure`. Neither guesses a plausible class.

Readers written for older records derive the class from the same closed
evidence when `failure` is absent. `docsfab runs show` and the `FAILURE`
footer print one `Failure class:` line, and `RunResultV1.failures` lists the
run, each failed step, and each failed attempt. The [run index](run-record.md#run-index)
does not derive a run or step class: it copies only a recorded `failure`, so
rows of records written before #1186 read `failureClass` as unavailable.
