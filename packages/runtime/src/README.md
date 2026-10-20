# Runtime source map

This directory contains DocsFab's persistent live agent, workflow executor,
and hosted turn adapter.
Start from the task you are changing, then follow the narrower contracts and
README files at that boundary. The top-level package rules remain in
[`../AGENTS.md`](../AGENTS.md), and contributor commands are in
[`../CONTRIBUTING.md`](../CONTRIBUTING.md).

## Main execution paths

The local workflow CLI path is:

```text
cli admission and argument parsing
  -> cli/run orchestration
  -> application service assembly
  -> workflow-execution/WorkflowRunner
  -> harness model and tool adapter
  -> records and delivery result
```

The local live-agent path keeps a conversation open across turns:

```text
cli/commands/live-agent
  -> live-agent/host persistent Pi session
     -> direct checkout tools and installed skill instructions
     -> optional bounded workflow through cli/run
     -> saved run inspection and authorized delivery
  -> next conversational turn
```

Ordinary conversation and direct tool use do not pass through `WorkflowRunner`.
The [live-agent guide](live-agent/README.md) explains session persistence,
direct edits, and the workflow bridge.

The hosted path executes one request at a time:

```text
packages/host
  -> host-invoker request verification
  -> workflow-execution/WorkflowRunner
  -> hosted progress and terminal record
  -> host retention and settlement
```

For `live-agent-turn`, the host supplies a verified prior conversation window
and retains the next state returned by the child. A hosted session spans these
requests; it does not depend on keeping a child process or local Pi transcript
alive.

Today [`host-invoker/workflow-runner.ts`](host-invoker/workflow-runner.ts)
constructs `WorkflowRunner` directly. The application seam is used by the local
CLI; a proposed migration in design records should not be read as implemented
code.

## Find code by task

| Task | Start here | What it owns |
| --- | --- | --- |
| Add or change a CLI command | [`cli/`](cli/README.md) | Command dispatch, help, and command-specific handlers |
| Change `run` preparation or delivery | [CLI execution path](cli/README.md), [`cli/run/`](cli/run/) | Target preflight, workspace lifecycle, application invocation, and result delivery |
| Change `do` admission | [`cli/commands/do.ts`](cli/commands/do.ts), [`cli/outcome-router.ts`](cli/outcome-router.ts), [`cli/admission-model.ts`](cli/admission-model.ts) | Fixed classification, constrained model fallback, and conversion to a named run |
| Change interactive conversations | [`live-agent/`](live-agent/README.md), [`cli/commands/live-agent.ts`](cli/commands/live-agent.ts) | Persistent local sessions, direct tools, skill loading, workflow invocation, and delivery |
| Assemble the local application | [`application/`](application/README.md) | Dependency construction and the stable call into workflow execution |
| Change step scheduling or run outcomes | [`workflow-execution/`](workflow-execution/README.md) | `WorkflowRunner`, step policy, evidence, branching, and result aggregation |
| Change model or tool execution | [`harness/`](harness/README.md) | Pi sessions, confined tools, leases, usage, output caps, and canon tools |
| Change hosted child execution | [`host-invoker/`](host-invoker/README.md) | Closed hosted requests, exact-state checks, direct runner assembly, progress, and terminal records |
| Change workflow lookup | [`workflow-registry/`](workflow-registry/) and [`../workflows/`](../workflows/) | Validation and binding of named workflow manifests |
| Change repository confinement | [`repository/`](repository/README.md) | Workspace materialization, Git operations, evidence, and repository contracts |
| Change run persistence | [`records/`](records/README.md), [`artifacts/`](artifacts/) | Run records, durable stores, receipts, and artifact references |
| Change delivery or publication | [`delivery/`](delivery/README.md), [`publication/`](publication/) | Patch/draft-MR delivery and authority-gated publication seams |
| Change model requests or budgets | [`model/`](model/README.md) | Provider connections, credential separation, profiles, and turn accounting |
| Change context compiled for a step | [`context/`](context/README.md) | Context queries, compilation, caching, and preflight policy |

## Contracts and evidence

These neighborhoods define the data that crosses execution boundaries:

- [`workflow-contracts/`](workflow-contracts/) defines tasks, outcomes,
  branch coverage, and plan bindings used by the runner.
- [`execution/`](execution/) defines run requests, cancellation, task context,
  and execution leases.
- [`contract-kit/`](contract-kit/) provides the shared closed-schema,
  canonicalization, digest, and opaque-authority primitives. Do not create a
  local contract dialect when the kit already covers it.
- [`lineage/`](lineage/) records the authority and source chain for work.
- [`context/`](context/README.md), [`canon/`](canon/), [`inputs/`](inputs/), and
  [`content-ir/`](content-ir/) admit and normalize source context without
  turning it into execution authority.
- [`quality-pack/`](quality-pack/) verifies the runtime binding to generated
  skill and quality inputs; [`quality-evaluation/`](quality-evaluation/) owns
  evaluator mechanics rather than portable quality policy.
- [`security/`](security/) contains runtime security contracts and review
  evidence.

## Product capabilities

Higher-level capabilities build on the execution and contract layers:

| Area | Directories |
| --- | --- |
| Setup and first run | [`setup/`](setup/), [`init/`](init/), [`onboarding/`](onboarding/), [`config/`](config/) |
| Review and document improvement | [`review/`](review/), [`search/`](search/), [`impact/`](impact/), [`evaluation-report/`](evaluation-report/) |
| Interactive sessions and channels | [`live-agent/`](live-agent/README.md), [`channels/`](channels/) |
| Autonomous and multi-unit work | [`autonomy/`](autonomy/), [`roadmap/`](roadmap/), [`maturity/`](maturity/) |
| Model selection and compositions | [`model/`](model/README.md), [`model-composition/`](model-composition/), [`native-compositions/`](native-compositions/) |
| Site and information architecture | [`site-bootstrap/`](site-bootstrap/), [`ia/`](ia/), [`templates/`](templates/) |
| Qualification and readiness | [`harness-qualification/`](harness-qualification/), [`readiness/`](readiness/) |
| Operator projections | [`operator/`](operator/), [`foundation/`](foundation/) |

Not every directory is a public package boundary. Prefer its `index.ts` and
`contracts.ts` when one exists, and check imports before adding a new edge.
The enforced dependency rules and approved temporary exceptions are described
in [`../AGENTS.md`](../AGENTS.md) and checked by
`npm run check:soft-deps` and `npm run check:workflow-boundaries`.
