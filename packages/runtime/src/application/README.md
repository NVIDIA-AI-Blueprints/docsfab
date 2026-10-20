# Application execution

This directory is the presentation-free entry point for executing one workflow
that a caller has already admitted. It accepts the runtime's existing
`RunRequest`, combines it with injected execution services, delegates to the
sole `WorkflowRunner`, and returns the resulting `RunRecord`.

Start with the [runtime source map](../README.md). The
[host-invoker guide](../host-invoker/README.md) explains the hosted adapter and
its additional trust checks.

## Read order

1. [`contracts.ts`](contracts.ts) defines the application input and service
   composition without creating another request or result schema.
2. [`execute-workflow.ts`](execute-workflow.ts) is the small execution seam. It
   constructs `WorkflowRunner` and calls `run` once.
3. [`dependencies.ts`](dependencies.ts) assembles the local CLI's concrete
   stores, scanners, context, search, quality, and outcome services.
4. [`editorial-admission.ts`](editorial-admission.ts) assembles the local
   UPDATE editorial admission control after reader-task observation.
5. [`index.ts`](index.ts) exposes these internal runtime entry points.

## Inputs and outputs

`executeWorkflowApplication` receives:

- `request`: an already-admitted `RunRequest`, including the selected workflow,
  workspace, repository revision, instruction or task context, cancellation
  signal, and write flag where applicable;
- `services`: the harness, run store, repository scanner, and optional runner
  ports such as context preflight, search, quality validation, host operations,
  evidence collection, outcome projection, retry policy, and progress events;
- `firstPassTargetControl`: an optional, explicitly bound control used by the
  supported first-pass documentation path.

The function returns the real terminal or stopped `RunRecord` produced by
`WorkflowRunner`. It does not wrap that record in an application-specific
envelope.

`createLocalWorkflowApplicationServices` is the concrete local assembly used by
the CLI path. Given validated runtime configuration, the request, workflow,
workspace, repository evidence collector, and base harness, it verifies the
quality pack and creates the local run store, artifact store, scanner, context
preflight, search coordinator, optional quality validator, and workflow outcome
projector. For documentation review it also derives the local review scope and
context target.

`assembleEditorialAdmissionControlV1` builds the local UPDATE
`editorialAdmission` control from already observed reader-task evidence. It
calls `assembleEditorialEvidenceFromAdmissionV1` for the initial evidence host
and again when planned pages refresh. The helper does not parse CLI flags or
change admission schema. Callers still observe reader-task context and pass
the bound workspace, index, and source hints.

## Ownership boundary

This layer owns dependency composition, editorial admission assembly from
already observed reader evidence, and the call into the scheduler. It does
not parse CLI arguments, render terminal output, set process exit status, select
or admit a workflow, acquire credentials, grant host authority, materialize a
workspace, or publish a result. Callers must complete those responsibilities
before invoking it or after receiving its record.

The application helper is intentionally thin: workflow sequencing, evidence,
artifact validation, and stop behavior remain in
[`../workflow-execution/`](../workflow-execution/README.md). Model execution and
confined tools remain in [`../harness/`](../harness/README.md).

The workflow CLI and bounded workflows invoked by the
[local live agent](../live-agent/README.md) use this application seam today.
The live agent's ordinary conversation and direct tools run outside it.
The current hosted implementation
in [`../host-invoker/workflow-runner.ts`](../host-invoker/workflow-runner.ts)
still constructs `WorkflowRunner` directly while retaining its host-specific
catalog, tool, tree, and read-only checks. Treat convergence described in the
shared execution design as planned work until that adapter actually calls this
helper.

## Common changes

| Task                                 | Source                                                                       | Focused evidence                                                            |
| ------------------------------------ | ---------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Change the application call contract | [`contracts.ts`](contracts.ts), [`execute-workflow.ts`](execute-workflow.ts) | [`application-execution.test.ts`](../../test/application-execution.test.ts) |
| Change local service assembly        | [`dependencies.ts`](dependencies.ts)                                         | [`application-execution.test.ts`](../../test/application-execution.test.ts) |
| Assemble editorial admission         | [`editorial-admission.ts`](editorial-admission.ts)                           | [`application-editorial-admission.test.ts`](../../test/application-editorial-admission.test.ts) |
| Change scheduling or run records     | [`../workflow-execution/runner.ts`](../workflow-execution/runner.ts)         | [`runner.test.ts`](../../test/runner.test.ts)                               |
| Change hosted execution              | [`../host-invoker/workflow-runner.ts`](../host-invoker/workflow-runner.ts)   | [`host-invoker.test.ts`](../../test/host-invoker.test.ts)                   |

Keep application changes in terms of the existing execution and record
contracts. A new transport envelope, admission rule, credential path, or UI
policy belongs with the caller that owns it.

The [CLI guide](../cli/README.md) traces the local caller. The
[context guide](../context/README.md) and [records guide](../records/README.md)
describe two of the services assembled here.
