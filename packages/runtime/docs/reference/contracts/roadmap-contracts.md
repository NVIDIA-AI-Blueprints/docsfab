# Roadmap ledger and mutation contracts

DocsFab represents a rolling documentation roadmap as durable, content-free,
harness-neutral contracts. The contracts live in `src/roadmap/` and do not
depend on Pi, `glab`, a queue, or a hosted transport.

The contract boundary is deliberately two phase:

1. discovery produces a revision- and tracker-bound `roadmap-ledger`;
2. planning produces a schema-v2, digest-bound `roadmap-mutation-plan` without
   changing GitLab;
3. a host-trusted operator authorizes an exact subset of the planned operation
   keys;
4. a future tracker adapter records attempts in a resumable mutation receipt.

Possessing local GitLab credentials is not authorization. A plan and an
unexpired authorization must both validate before an operation can be applied.

## Ledger

Schema v1 binds each ledger to:

- the immutable repository revision and sorted-manifest content digest from the
  Content IR contract;
- a GitLab host, full project path, and numeric project ID;
- a release or documentation-health discovery boundary and query digest;
- the observation timestamp and content-free identity digest for every issue
  used in deduplication;
- material finding evidence, workstream dependencies and collisions, lifecycle
  transitions, supplemental sweeps, and closeout decisions.

Finding fingerprints exclude display wording. They hash the discovery
boundary, category, severity, affected repository-relative paths, evidence
identities, and material-evidence digest. Renaming or rephrasing a finding does
not open a duplicate issue, while changed evidence or scope produces a new
fingerprint.

Lifecycle transitions are closed and validated as a chain:

```text
observed → proposed → filed → selected → in-progress → fixed → verified → closed
```

`blocked`, `duplicate`, and `superseded` are explicit dispositions. Resuming a
blocked item and reopening a closed, duplicate, or superseded item returns it
to `observed`; no MR, commit, or successful mutation implicitly verifies or
closes work. A closeout names its exact finding set and cannot propose closure
until every named finding is verified or already terminal, its evidence is
present, and a complete clean supplemental sweep has observed current tracker
state.

## Mutation plan and authorization v2

Every operation has a stable key, one of the closed operation kinds (`saga`,
`issue`, `update`, `comment`, `link`, `milestone`, `label`, or `closure`), a
content-free typed proposal, target identity, finding references, dependency
keys, private mutation-material digest, and byte count. The proposal digest
records only the operation kind, intent, and expected effect kind. Raw titles,
issue bodies, labels, and comments remain outside the content-minimized plan
and are supplied only through private host material whose digest and exact byte
count must match at the operation boundary.

An existing-object target can bind either the immutable ledger observation or
the verified typed effect of a dependency operation. Links bind both subject
and related issue targets; milestone assignment binds the issue and the typed
milestone effect. Every non-project target has a matching precondition. Stable
idempotency keys cover the ledger, repository, project, target identities,
proposal digest, and private-material identity, so a rehashed operation cannot
move authority to another project or observation boundary.

Project identities carry a closed, credential-safe provider identifier rather
than a GitLab-only discriminator. A project-target creation or reconciliation
must also return a provider-neutral proof digest bound to the exact operation
key, idempotency key, proposal, private material identity, target, and expected
effect kind. An unrelated open issue or active milestone therefore cannot be
claimed as the operation's effect.

Updates to existing tracker objects carry the exact observed timestamp and
identity digest. Drift invalidates the plan before mutation. The plan also
expires and is bound to the ledger digest, repository, project, and tracker
observation boundary.

Authorization records an exact, non-empty, dependency-closed subset of schema
v2 operation keys from one plan. Every authorization check first revalidates
that plan against the full ledger, so a caller cannot retain an old plan digest
while changing a target, material, or dependency.

The initial operation validates the complete tracker observation boundary.
After progress exists, `assertRoadmapOperationStartableV2` validates only the
ledger or dependency-effect observations material to the next operation. This
allows a dependency to update an issue without invalidating the rest of the
plan, while same-timestamp identity drift, a stale dependency result, or an
unobserved related target still fails closed. The boundary rejects:

- an operation not present in the plan;
- a planned operation omitted from the authorization;
- a plan, repository, or project substitution;
- an expired plan or authorization;
- any later expansion of the operation set.

## Receipts and resumption v2

Mutation receipts preserve each attempt with an exact idempotency key,
`mutation` or `reconciliation` phase, before identity, typed issue/note/link/
milestone effect identity, timestamps, and content-free failure code. Existing
targets bind their before identity to the exact ledger observation or verified
dependency effect. Reuse is available for every operation kind only when its
typed effect matches the planned subject, related target, state, and effect
kind. Numeric components in issue, note, link, and milestone target keys must
also equal their external IDs and, for notes, the subject issue identity.
Ledger-bound before identities cannot carry creation-proof metadata. For a
successful mutation, creation-proof presence or removal never counts as a
tracker-state change; target, external ID, state, timestamp, identity digest,
and typed relations must change independently. Dependency authority checks
still retain and compare the exact proof.

A mutation must start while both plan and authorization are current. Its
response may complete after authorization expiry because the external effect
may already exist and must not be discarded. No new mutation may start after
expiry. An ambiguous response blocks blind replay; a later read-only
reconciliation may record the typed reused effect or `effect-confirmed-absent`,
including after authorization expiry. Only the confirmed-absent result permits
a later mutation retry, and that retry still requires current authority.

Terminal receipt states are:

- `complete`: every authorized operation succeeded, was reused, or was
  explicitly skipped with a reason;
- `partial`: at least one mutation succeeded or was reused and work remains;
- `failed`: every attempted operation failed;
- `ambiguous`: the latest response cannot yet prove whether its external effect
  exists, so only reconciliation may proceed.

Receipts also carry the exact last-confirmed operation key and sorted remaining
operation keys. This preserves partial filing, ambiguous responses, and every
restart boundary without repeating successful tracker mutations.

## Run-record references

`createRoadmapRunArtifactReferences` produces only ledger and optional plan
identity: kind, schema version, digest, repository revision, and repository
content digest. The two kinds are reference-only additions to the shared #20
`ArtifactReference` contract, so a roadmap workflow carries them directly in
`RunRecord.artifacts`/`ArtifactUse`. They remain invalid as full semantic
artifact envelopes and cannot acquire payloads. This links the run without
copying findings, issue content, repository content, or tracker payloads.

## Canonicalization and migration

Object keys and set-like collections use locale-independent code-unit ordering.
SHA-256 digests are repeatable across harmless input ordering changes, and validators reject
unknown fields and mismatched digests.

The ledger remains schema v1; executable plan, authorization, and receipt
contracts are schema v2. Historical v1 execution records remain readable by
their v1 validators, but `requireRoadmapExecutionV2` and the legacy execution
assertion return `replan-required`. No v1 plan or authorization is upgraded,
defaulted, or granted v2 authority.

General schema migration declarations remain explicit:

- an `additive` version requires a defaults digest and no custom migrator;
- a `breaking` version requires a named migrator and cannot claim additive
  defaults;
- versions advance one step at a time, and v1 validators reject unknown
  fields rather than silently accepting future semantics.

The contract tests additionally cover dependency-result chaining, restart after
each boundary, reuse for every operation kind, note/link reconciliation,
milestone assignment, in-flight completion after expiry, post-expiry read-only
reconciliation, same-timestamp drift, material substitution, ambiguous state,
non-inert input, and v1 replan-required migration fixtures.

All v2 array boundaries reject proxies before reflection, require `Object.getPrototypeOf` to return exactly
`Array.prototype`, and inspect only own data descriptors for `length`
and every dense element. Accessors, sparse arrays, custom prototypes, symbols,
and proxy traps are rejected without executing user code.

## Skill-pack host requests

Roadmap skill adapters surface unavailable observations and effects as
`roadmap-host-operation-request` references. These requests are deterministic,
deduplicated, repository- and pack-bound data. They cannot authorize an
operation: tracker writes still require the exact #45 plan and authorization,
child delivery requires its selection and delivery contracts, and
merge-request-description updates remain deferred until a dedicated adapter
exists. Write requests cannot use an automatic-confirmation policy. See
[roadmap-skill-packs.md](../operations/roadmap-skill-packs.md) for the provenance and behavior
mapping.
