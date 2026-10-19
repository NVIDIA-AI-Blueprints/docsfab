# Agent Runtime Adapter Contract

The DocsFab knowledge control plane is the system of record. An agent runtime
is a replaceable executor that receives one claimed, versioned work packet and
returns proposed outputs. Runtime memory, sessions, schedules, and tool state
are never canonical knowledge state.

## Adapter lifecycle

1. The control plane queues a work packet against an exact stream version.
2. An operator or dispatcher atomically claims the task.
3. The adapter checks the runtime's liveness and machine-readable
   capabilities.
4. It starts a bounded run with the work packet and its exact canonical input
   context.
5. The dispatcher observes the run and stops on an approval request,
   uncertainty, missing input, policy boundary, or runtime failure.
6. Proposed artifacts are registered in the control plane before a matching
   agent receipt can complete the task.
7. Shared-model approval, publication, merge, credentials, and policy remain
   outside runtime authority.

The contract version is `1`. An adapter provides `initialize()`,
`startRun()`, `getRun()`, and `stopRun()`. Capability detection is mandatory;
the adapter must fail when a required endpoint is absent rather than silently
falling back to a different execution path.

## Product implementation

`src/adapters/docsfab.mjs` is the product adapter. It invokes the `docsfab`
CLI without a shell, verifies that the configured runtime workflow is listed,
starts one bounded `docsfab run ... --json` child process, and tracks that
process for status and stop requests. The knowledge control plane remains the
canonical task and artifact owner; the child process is only an executor.

Initialization binds an immutable executable, workflow, repository, and
revision to the probed capabilities. JSON-mode success requires one valid
`docsfab-run-result` v1 envelope; process exit zero with malformed output is a
failed run.

Run status and stop are adapter process-group capabilities on Linux and macOS.
The adapter launches a dedicated group, signals that group, escalates from
`SIGTERM` to `SIGKILL`, and records a terminal failure when closure cannot be
confirmed. It does not claim authority over a descendant that deliberately
escapes the executor process group, a second runtime service, or a remote
cancellation protocol.

The default child environment is a closed set of ordinary process variables.
An embedding host must explicitly name any additional variable it grants;
model or SCM credentials are not inherited implicitly. The adapter keeps
Hermes-specific sessions, HTTP endpoints, and authentication out of the
product path.

The adapter passes the work packet to the local CLI as the explicit
`--instruction` value only when the canonical context is classified as public
or NVIDIA-internal and explicitly approved for process-visible argv. It rejects
recognized credential-like material before spawning. Callers must not place
credentials in work packets, instructions, run records, or repository files.
A future stdin or owner-private file protocol requires a separately versioned
runtime contract rather than an implicit fallback.

The adapter versions the current human-readable `docsfab list` grammar as
catalog grammar `1` and rejects any line that does not match it. A future
machine-readable catalog should replace that narrow compatibility grammar.

## Hermes test double

`src/adapters/hermes.mjs` implements the contract against the Hermes Runs API.
It remains as a deterministic fake/double for exercising a replaceable remote
executor boundary. It is not the DocsFab product path. The adapter requires
bearer authentication, accepts only a loopback HTTP endpoint, and checks
`run_submission`, `run_status`, and `run_stop` before use.

```text
DocsFab dispatcher -> localhost:8642 -> secure tunnel -> Hermes gateway
```

Compatibility with a particular hosted Hermes version or deployment must be
established by an integration test in that environment and does not replace
the `docsfab` CLI adapter.
