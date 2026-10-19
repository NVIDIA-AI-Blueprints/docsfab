# CLI routing and workflow kickoff

This directory owns command parsing, operator-facing routing, preflight
coordination, and the handoff into runtime execution. Start here when changing
what a `docsfab` command accepts or how a local run is prepared. Execution
services and workflow scheduling live behind the
[application](../application/README.md) and
[workflow-execution](../workflow-execution/README.md) seams.
The [runtime source map](../README.md) routes changes outside the CLI.

## Main routes

[`router.ts`](router.ts) dispatches top-level commands. The main documentation
paths are:

```text
run -> parseRunArguments -> executeRunRequest -> run/local-workflow
do  -> fixed outcome router -> optional admission model -> the same run path
live-agent -> persistent local conversation with optional workflow calls
```

`run` receives a named catalog workflow. `do` receives an outcome sentence and
admits at most one named workflow; classification itself grants no tools,
writes, external inputs, or publication authority. The routing sources are
[`outcome-router.ts`](outcome-router.ts),
[`admission-model.ts`](admission-model.ts), and
[`commands/do.ts`](commands/do.ts).

`live-agent` is a different lifecycle. It creates or resumes a persistent local
session that can converse, use its bounded direct tools, and invoke workflows.
Documentation edits are enabled by default. Host commands still require
terminal approval. Use `--read-only` to disable edits and host commands.
`--allow-write` remains a compatibility flag and is already the default.
Continue in the [live-agent guide](../live-agent/README.md).

## Public write and delivery defaults

For `run` and `do`, the public `create-documentation`,
`update-documentation`, and `restructure-documentation` workflows default to
write access and one draft merge request. `--allow-write` and `--draft-mr`
remain accepted, but are not required for those three public workflows.
`bootstrap` has a write step but requires the explicit `--allow-write` grant and
delivers only a local patch; it cannot open a draft merge request.

- `--patch-only` selects local patch delivery for workflows with a write step.
  It does not replace bootstrap's explicit write grant; pass both
  `--patch-only` and `--allow-write` to retain a bootstrap patch.
- `--dry-run` previews selection and delivery mode; it stops before target
  inspection, writes, or publication. Its only model call is `do`'s admission
  model after an eligible table miss.
- `--route-only` applies only to `do` and stops after deterministic
  classification. It asks no model: on an eligible table miss it names the
  workflows the run would offer the admission model. It refuses the delivery
  and publication conflicts the run refuses.
- On an eligible table miss, `do` verifies the installed quality pack before it
  asks the admission model, and so do both previews. It checks the pack the run
  would load: `host.yaml` `paths.*` first, then the environment, then the
  secrets or legacy `.env` file, then the packaged default. `do --delegate` and
  `do --resume` verify it before the driver's first model call.
- Under `--patch-only`, `do` offers its admission model workflows with a write
  step, including `bootstrap`; under `--draft-mr`, it offers only the three
  authoring workflows above. A review the table picks runs as
  `update-documentation`. `--allow-write` does not change the route.
- A request or `--instruction` that says not to publish refuses every delivery
  that would publish with `publication-prohibition-conflict`, in `run` and
  `do` alike, before any forge read or model call. The phrase guard both
  share is [`publication-prohibition.ts`](publication-prohibition.ts); a run
  also stops on its interpretation's `non-publication` constraint
  ([`run/publication-prohibition-stop.ts`](run/publication-prohibition-stop.ts)).

[`delivery-grants.ts`](delivery-grants.ts) is the source of these defaults and
of the coded flag-conflict refusals. This CLI policy chooses the requested delivery posture; it is
not generic publication authority. The [delivery layer](../delivery/README.md)
still verifies freshness, records, patches, host authority, and publication
preconditions.

## Local workflow lifecycle

[`run-request.ts`](run-request.ts) is the compatibility entry point. After
argument and dry-run handling, it delegates to these files:

| File | Responsibility |
| --- | --- |
| [`run/request.ts`](run/request.ts) | Internal invocation, output, and delivery-outcome types |
| [`run/local-workflow.ts`](run/local-workflow.ts) | Configuration, exact workspace lifecycle, evidence collector, preflight, execution, and cleanup |
| [`run/preflight.ts`](run/preflight.ts) | Host-controlled workflow, project, content, and write-path validation before execution |
| [`run/pre-model-admission.ts`](run/pre-model-admission.ts) | The quality pack, style profile, and `--source` checks a run passes before its first model call, the request interpretation |
| [`run/execution.ts`](run/execution.ts) | Reader evidence and harness assembly, then the call through [`application`](../application/README.md) |
| [`run/delivery.ts`](run/delivery.ts) | Terminal rendering, persisted record checks, patch-only results, comments, and draft-MR handoff |
| [`run/host-operations.ts`](run/host-operations.ts) | Authority-gated host operations made available to the workflow |

`local-workflow.ts` owns the resource lifetime: prepare configuration and an
exact exported repository workspace, create patch evidence, run preflight,
execute once, consume the result, then dispose temporary resources. Repository
details are in the [repository guide](../repository/README.md). Persisted run
shapes are in the [records guide](../records/README.md).

## Other command neighborhoods

- [`commands/`](commands/) contains handlers for setup, configuration,
  profiles, diagnostics, saved runs, reports, evaluation, shipping, and other
  dedicated surfaces.
- [`usage.ts`](usage.ts) is the human-facing help text; keep it aligned with
  parsers and defaults.
- [`help.ts`](help.ts) answers `help <command> [<subcommand>]`, `--help`, `-h`,
  and a bare command group for every entry in
  [`command-registry.ts`](command-registry.ts). A new command or subcommand
  needs a registry entry and a `docsfab ...` synopsis in `usage()`;
  [`cli-help-routing.test.ts`](../../test/cli-help-routing.test.ts) fails
  until both exist.
- [`progress.ts`](progress.ts) and the operator package render progress and
  terminal output.
- `comment-existing-mr*.ts` binds and publishes an explicitly targeted review
  summary; it is separate from draft-MR creation.
- `first-pass*.ts`, `knowledge-resume.ts`, and `run/knowledge-continuation.ts`
  carry bounded first-run and continuation state.

## Common changes

| Task | Source | Focused evidence |
| --- | --- | --- |
| Change top-level routing or help | [`router.ts`](router.ts), [`help.ts`](help.ts), [`command-registry.ts`](command-registry.ts), [`usage.ts`](usage.ts) | [`router.test.ts`](router.test.ts), [`../../test/cli-help.test.ts`](../../test/cli-help.test.ts), [`../../test/cli-help-routing.test.ts`](../../test/cli-help-routing.test.ts) |
| Change run flags | [`run-arguments.ts`](run-arguments.ts), [`delivery-grants.ts`](delivery-grants.ts) | [`../../test/cli-arguments.test.ts`](../../test/cli-arguments.test.ts), [`../../test/delivery-grants.test.ts`](../../test/delivery-grants.test.ts) |
| Change `do` admission | [`commands/do.ts`](commands/do.ts), [`outcome-router.ts`](outcome-router.ts) | [`../../test/cli-outcome-router.test.ts`](../../test/cli-outcome-router.test.ts) |
| Change run lifecycle or preflight | [`run/local-workflow.ts`](run/local-workflow.ts), [`run/preflight.ts`](run/preflight.ts) | [`../../test/cli-run-output.test.ts`](../../test/cli-run-output.test.ts), [`../../test/cli-run-request-freshness.test.ts`](../../test/cli-run-request-freshness.test.ts) |
| Change local conversation startup | [`commands/live-agent.ts`](commands/live-agent.ts) | [`../../test/live-agent-cli.test.ts`](../../test/live-agent-cli.test.ts) |

Keep parsing and presentation in this directory. Workflow selection must finish
before the application seam, and scheduler policy must remain in
`workflow-execution`.
