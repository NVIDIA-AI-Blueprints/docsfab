# Autonomous-cycle contracts

DocsFab's autonomous-cycle contract is a product protocol, not a Pi protocol.
It composes the existing `Task -> Workflow -> Step` catalog, workflow outcome,
documentation-maturity, and roadmap observations without granting any model a
new repository or tracker tool.

## Artifact chain

Every artifact is closed, schema-versioned, canonical JSON with a SHA-256 digest:

1. `AutoCycleRequestV1` binds a caller-selected repository identity and immutable
   revision, one tracker observation, the complete maturity-finding digest set,
   registered-workflow allowlist, path class and prefixes, target branch,
   delivery ceiling, exact validation set, exact per-workflow prerequisite IDs,
   and the canonical digest of each workflow's structured execution task. The
   task digest is produced by `normalizeWorkflowTaskInput`, the same exported
   repository-bound validator invoked by `WorkflowRunner`; autonomy does not
   maintain a weaker task lookalike parser.
   tracker binding is explicitly `observe-only`; v1 grants no tracker mutation.
2. `AutoAssessmentV1` binds the exact request and carries only content-free
   maturity references. Each candidate binds a content-free Task digest to the
   exact ordered Step IDs in its registered Workflow, preserving DocsFab's
   `Task -> Workflow -> Step` contract. Its evidence state is `sufficient`, `low-confidence`,
   `conflicting`, or `blocked`. Workflow candidates name catalog workflows and
   enumerate the complete request-bound prerequisite set as satisfied, missing,
   conflicting, or blocked. A candidate cannot omit an expected prerequisite or
   add a validation ID beyond the request ceiling.
3. `WorkflowDecisionV1` uses a product disposition—`execute`, `no-action`,
   `needs-input`, `blocked`, or `superseded`—that is separate from runner status.
   Execute is permitted only for a candidate whose prerequisites are all
   evidenced as satisfied. Low-confidence or conflicting assessments can only
   become `needs-input`; they cannot choose a workflow.
4. `AutoCycleAuthorizationV1` repeats the exact decision ceiling. It cannot add
   a workflow, repository, revision, tracker observation, path, target branch,
   delivery mode, or validation requirement.
5. `AutoCycleCheckpointV1` is an ambient-state-free resume record with monotonic
   sequence, phase, prior checkpoint digest, artifact digests, and (only while
   executing) workflow execution status. `validateAutoCycleCheckpointChain`
   checks exact predecessor digests, sequence continuity, fixed cycle/request
   identity, immutable once-introduced assessment/decision/authorization
   digests, monotonic execution status, and monotonic phase advancement.
6. `AutoCycleTerminalResultV1` retains the product decision separately from the
   workflow execution result. Non-execute decisions record `not-run`; execute
   decisions bind the exact authorization artifact, the validated final
   checkpoint chain, content-free run evidence, and the exact validation set.
   `succeeded` is accepted only when every required validation passed.

All arrays that represent sets are sorted and duplicate-free. Decoders reject
unknown fields, noncanonical encodings, custom prototypes, proxies, accessors,
cycles, unsupported schema versions, credential-shaped values, and digest
mismatches. The v1 migration is identity-only; every other source version needs
an explicit future migration.

## Authority boundary

The authorization JSON is durable evidence, but is intentionally inert. A
trusted DocsFab host adapter, intentionally absent from `autonomy/index`, first
registers its verifier and receives an opaque authority whose identity lives in
a private `WeakMap`. `mintAutoCycleHostCapability` accepts only that registered
authority—not a caller-supplied structural verifier. The registered verifier
must re-observe the repository, full observe-only tracker project/observation
binding, and maturity evidence named by a closed, digested challenge. DocsFab
records the verifier, challenge, authority, and capability only in private
in-memory state.
`assertAutoCycleAuthorized` repeats the host verification immediately before
execution, and requires both the canonical authorization artifact and the
original capability and the exact canonical `WorkflowTaskInput` that was bound
by the request and candidate. Creating an authorization privately binds its
exact digest, `authorizedAt`, and `expiresAt` to that capability and permits no
second issuance. The verifier supplies the host-owned clock at mint and execute
time. Caller timestamps are not accepted by the execution gate, so rehashing an
expired artifact with a future window cannot extend authority.

Consequently, parsing, copying, rehashing, or recreating an authorization does
not grant authority. Passing request/assessment/decision JSON and a verifier-
shaped object to the mint function also fails because the object was not
privately registered. A resumed process can
reconstruct checkpoints and terminal records without ambient capability state,
but must reacquire a fresh host verifier and capability after re-observing the
bound repository and tracker before executing. Checkpoint digests are progress
pointers only: neither a checkpoint nor any field copied from it is accepted as
an execution capability.

`projectAutoCycleAuthorization` is the durable run-record projection. It keeps
only digests, registered workflow identity, path class, delivery mode, and
validation IDs; path prefixes and the target branch are represented only by
canonical hashes. The full object and projection are scanned by DocsFab's
credential rules before they are returned.

## Tracker boundary

`tracker-write` is deliberately absent from the v1 path-class vocabulary.
Tracker project and observation digests establish freshness input only; they do
not name an operation, issue target, label, milestone, or other mutable tracker
surface. A future tracker-writing cycle must introduce its own closed operation
and target ceiling plus a host-authorized executor contract rather than treating
an observation digest as mutation authority.
