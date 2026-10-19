# Workflow execution

This directory contains DocsFab's scheduler: the code that turns one selected
workflow manifest and one admitted run request into an inspectable run record.
A workflow manifest declares an ordered set of steps; `WorkflowRunner` executes
that sequence while applying context, search, tool, write, evidence, and
artifact rules at each boundary.

This is the lifecycle of a workflow run. A [live-agent session](../live-agent/README.md)
can span many turns, use direct tools, and invoke separate workflow runs as
needed; the scheduler does not own that conversation loop.

Start with the [runtime source map](../README.md). Application composition is
described in [`../application/`](../application/README.md), and hosted admission
around this scheduler is described in the
[host-invoker guide](../host-invoker/README.md).

## Read order

1. [`runner.ts`](runner.ts) owns step sequencing, status transitions, and
   policy gates. It remains the composition root for admission, schedule,
   editorial bind, and terminal phase.
2. [`runner-admission.ts`](runner-admission.ts) admits one run request before
   anything is saved: request, knowledge resume and continuation, run id,
   composition and source bindings, source-read and write grant refusals, and
   the queued run record.
3. [`runner-step-loop.ts`](runner-step-loop.ts) executes one governed step:
   skill resolve, context and search, harness dispatch, and artifact or
   source-obligation bookkeeping.
4. [`runner-editorial.ts`](runner-editorial.ts) binds V2 editorial evidence:
   host-directed update, candidate admission, and selected suffix.
5. [`runner-terminal.ts`](runner-terminal.ts) finalizes a run after its last
   step, and records whatever the runner's `try` threw: it returns the saved
   failed record, or rethrows when no terminal record was saved.
6. [`runner-evidence.ts`](runner-evidence.ts) handles context preflight, search,
   repository scanning, change capture, and outcome projection.
7. [`runner-schedule.ts`](runner-schedule.ts) contains request checks, timing,
   persistence helpers, and terminal error messages.
8. [`runner-step.ts`](runner-step.ts) aggregates model, skill, token, tool, and
   validated artifact evidence.
9. Read a focused helper only for the behavior being changed, such as
   [`workflow-checks.ts`](workflow-checks.ts),
   [`search-participation.ts`](search-participation.ts),
   [`plan-binding.ts`](plan-binding.ts), or
   [`verification-result.ts`](verification-result.ts).

## Execution flow

`WorkflowRunner.run` receives a `RunRequest` and resolves its workflow from the
installed catalog. It creates and saves a queued record whose step list comes
from the manifest. A version 2 branching manifest begins with its declared
prefix and later selects its bound branch; a conventional manifest uses its
ordered `steps` directly.

Before and during the sequence, the runner:

1. validates request and task bindings and saves the initial record;
2. records the repository credential scan as advisory diagnostics;
3. resolves each governed skill and checks its identity;
4. compiles the step's revision-bound context and applies its context policy;
5. observes, reuses, or revalidates declared workflow search evidence;
6. dispatches the step to the model harness or the injected host-operation
   executor according to `kind`;
7. aggregates usage, tools, models, skills, search findings, and artifacts;
8. captures authorized repository changes and runs configured postflight or
   outcome projection before persisting the final record.

Item 1's request checks and queued record run through
[`runner-admission.ts`](runner-admission.ts). Items 3-7 for each catalog step
run through [`runner-step-loop.ts`](runner-step-loop.ts). After the V2 prefix,
[`runner-editorial.ts`](runner-editorial.ts) binds host-directed update and
admits the editorial candidate. Item 8's finalization, and the record a thrown
failure leaves, run through [`runner-terminal.ts`](runner-terminal.ts).
`WorkflowRunner` remains the composition root for the schedule and its
`try`/`catch`.

Step `mode` controls authority. `read-only` steps cannot mutate the workspace.
`write` steps require the request and path-specific controls expected by that
workflow. Step `kind` selects execution: `inference` uses the agent harness,
`host-operation` uses a host-owned executor, and `evaluate` is read-only and
cannot mint authority or decide acceptance by itself.

## Evidence and stop behavior

The scheduler saves state throughout the run, so a record shows which step was
running, succeeded, failed, or remained pending. Cancellation is checked around
major boundaries. Missing context, unresolved skill identity, invalid search
inheritance, rejected plan or verification data, unavailable required host
operations, and artifact validation failures stop the run rather than producing
plausible success.

Artifact references returned by steps are normalized and validated in
[`runner-step.ts`](runner-step.ts) before they enter step or run evidence.
Write workflows also preserve repository changes as a reviewable patch artifact;
failure to preserve required patch evidence is terminal. Specialized quality
artifacts and verification responses receive their own schema and binding checks.

The `RunRecord` is the primary output. It carries status and timestamps plus
the selected repository, per-step evidence, aggregate usage and tool activity,
artifacts, warnings, and any bounded failure reason. Callers can project a
product outcome from it, but that projection does not rewrite execution history.

## Common changes

| Task                                      | Source                                                                                           | Focused evidence                                                                                                           |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| Change sequencing or terminal state       | [`runner.ts`](runner.ts), [`runner-terminal.ts`](runner-terminal.ts), [`runner-schedule.ts`](runner-schedule.ts) | [`runner.test.ts`](../../test/runner.test.ts), [`workflow-cancellation.test.ts`](../../test/workflow-cancellation.test.ts), [`authoring-runtime.test.ts`](../../test/authoring-runtime.test.ts) |
| Change run-request admission or the queued record | [`runner-admission.ts`](runner-admission.ts) | [`source-obligation-runtime.test.ts`](../../test/source-obligation-runtime.test.ts), [`source-citation-coverage.test.ts`](../../test/source-citation-coverage.test.ts), [`documentation-plan-binding.test.ts`](../../test/documentation-plan-binding.test.ts), [`cli-run-lineage.test.ts`](../../test/cli-run-lineage.test.ts) |
| Change one governed step's execution      | [`runner-step-loop.ts`](runner-step-loop.ts), [`runner-step.ts`](runner-step.ts)                  | [`runner-admission-continue.test.ts`](../../test/runner-admission-continue.test.ts), [`runner-artifacts.test.ts`](../../test/runner-artifacts.test.ts), [`runner-step-truncation.test.ts`](../../test/runner-step-truncation.test.ts) |
| Change V2 editorial bind or host-directed update | [`runner-editorial.ts`](runner-editorial.ts), [`runner.ts`](runner.ts)                     | [`runner-admission-continue.test.ts`](../../test/runner-admission-continue.test.ts), [`runner-artifacts.test.ts`](../../test/runner-artifacts.test.ts), [`runner-step-truncation.test.ts`](../../test/runner-step-truncation.test.ts) |
| Change context or search handling         | [`runner-evidence.ts`](runner-evidence.ts), [`search-participation.ts`](search-participation.ts) | [`workflow-search.test.ts`](../../test/workflow-search.test.ts)                                                            |
| Change host check execution               | [`workflow-checks.ts`](workflow-checks.ts)                                                       | [`workflow-checks.test.ts`](../../test/workflow-checks.test.ts)                                                            |
| Change artifact aggregation or validation | [`runner-step.ts`](runner-step.ts)                                                               | [`runner-artifacts.test.ts`](../../test/runner-artifacts.test.ts)                                                          |
| Change projected workflow outcomes        | [`runner-evidence.ts`](runner-evidence.ts), [`outcome-rejection.ts`](outcome-rejection.ts)       | [`workflow-outcome.test.ts`](../../test/workflow-outcome.test.ts), [`workflow-outcome-rejection.test.ts`](../../test/workflow-outcome-rejection.test.ts) |

Workflow definitions and portable contracts live outside this directory. Keep
this code focused on enforcing and recording the selected manifest, rather than
choosing which job a caller should run.
