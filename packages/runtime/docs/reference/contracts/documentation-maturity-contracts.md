# Documentation maturity gates, findings, and work units

DocsFab evaluates documentation through a versioned, provider-neutral G0–G5
contract. A maturity gate is not an issue priority: gates describe which layer
of documentation capability is being evaluated, while `P0`, `P1`, and `P2`
describe tracker urgency. The two closed vocabularies are carried in separate
fields and cannot be substituted for each other.

## Gate catalog

The production catalog is
`docsfab-documentation-maturity-gate-catalog@1.0.0`:

| Gate | Stage | Applicability | Prerequisites |
| --- | --- | --- | --- |
| `G0` | foundations | every selected repository | none |
| `G1` | coverage | repositories with a documentation surface | `G0` |
| `G2` | structure | repositories with a documentation surface | `G0`, `G1` |
| `G3` | content | repositories with a documentation surface | `G0`–`G2` |
| `G4` | polish | repositories with a documentation surface | `G0`–`G3` |
| `G5` | maintenance | repositories with a documentation surface | `G0`–`G4` |

Downstream evaluators must preserve prerequisite results. A failed or unknown
prerequisite does not prove a later gate failed; it normally makes that later
evaluation `blocked` or `unknown`. Conditional applicability is evidence, not
an inference from the absence of documentation.

Every gate uses the same six dispositions:

| Disposition | Meaning and required authority |
| --- | --- |
| `observed-absence` | An independent exact repository observation records absence. |
| `bounded-not-found` | Authenticated #72/#74 evidence reached `not-found-after-bounded-search`. It cannot be relabeled observed absence. |
| `unknown` | Admitted evidence is inconclusive, or an authenticated #81 outcome requires input/is inconclusive. |
| `not-applicable` | Independent provided policy, ownership, or support input establishes non-applicability. Missing input cannot be treated as this disposition. |
| `blocked` | Search evidence is blocked or an authenticated #81 product outcome is blocked. |
| `satisfied` | Independent repository/search evidence positively observes the requirement. |

## Material findings

A v1 material finding is bound to an independently selected repository identity
and immutable revision. It records a gate, exact requirement ID and subject
digest, observation-scope digest, `issuePriority`, severity, confidence,
audience impact, repository-relative affected paths, dependency
fingerprints, required human input, an exact catalog workflow and step,
acceptance criteria, verification methods, and content-free evidence
references.

Every finding must cite repository evidence. An authenticated bounded negative
observation is accepted only as `bounded-not-found`; #72 coverage, limitation,
and saturation semantics are decoded again through the exact catalog search
plan, workflow, and step. Before any candidate target is selected, every finding
in that complete #72 envelope is projected and must exactly equal the
independently supplied, current-revision #74 gap ledger. A ledger containing
only the selected target is not authority. Same gap at the same Git revision
with a different workspace snapshot is history, not a contradiction this
equality check can collapse. Distinct evidence at the same snapshot still
fails closed. Optional product evidence is decoded
from the complete #81 run and outcome, so successful execution cannot be
substituted for product readiness. Product outcomes are also checked against
the claimed maturity disposition: the same `blocked` outcome and positive
repository observation cannot seal both `blocked` and `satisfied`.

Disposition precedence is deterministic. An exact, bound, provided
`not-applicable` applicability decision excludes every other disposition. An
exact, bound, missing product-policy, ownership, or support-commitment input
forces `unknown` before positive-presence or other disposition checks. If that
missing semantic authority is combined with incompatible exact absence or
product-outcome authority, the evidence set is contradictory and admits no
disposition. An
exact repository absence observation outranks a bounded-search inference for
the same material binding, so `bounded-not-found` is available only when no
exact absence observation exists. Exact absence also excludes all product
outcome dispositions before outcome compatibility is evaluated. A compatible
`not-ready` outcome may accompany `observed-absence`; a `blocked`, `ready`,
`needs-input`, or `inconclusive` outcome makes that mixed evidence set
contradictory and admits no disposition. A positive observation can be
`satisfied` only when there is no bound `not-applicable` decision. The caller
cannot choose among otherwise compatible labels for the same authority set.

Checksums on findings, observations, or outcomes protect transport integrity;
they are not authority. Callers must use `validateDocumentationMaturityFinding`
and supply repository observations, workflow-search envelopes, product run
records, and human inputs from independent sources.

Unknown product policy, ownership, and support commitments have no free-text
claim field. A separate independent requirement authority first declares the
exact repository, revision, gate, requirement subject, paths, scope, input kind,
and claim. The result is either a `missing` typed input with null decision/value
or a `provided` typed input whose closed decision and digest exactly match a
second authority. `support-required`, for example, can never authorize
`not-applicable`; that disposition requires an applicability claim whose exact
decision is `not-applicable`.
This prevents a model or serialized finding from manufacturing policy merely
by recomputing its checksum.

The stable finding fingerprint contains only schema version, repository
identity, gate, stable finding key, requirement ID/subject digest, observation
scope digest, and canonical affected paths. It excludes
the finding ID, revision, priority, severity, confidence, evidence checksum,
and wording. Equivalent unchanged findings therefore reconcile across
revisions, while a different repository, rule, gate, or affected path produces
a different fingerprint.

## Executable work units

A work unit copies the validated finding's disposition, priority, severity,
confidence, audience impact, affected paths, dependencies, human inputs,
workflow, acceptance criteria, and verification plan. It never authorizes a
tracker mutation (`trackerMutation` is exactly `not-authorized`).
MEA / campaign admission additionally requires a bound
[work-unit machine contract](work-unit-machine-contract.md) envelope (#255);
cascade fixtures remain valid without it.

Workflow inputs follow the same two-authority pattern: an independent typed
requirement binds an input ID to repository, revision, gate, requirement,
workflow, step, and finding fingerprint; an available governed-input authority
then binds the exact value digest. Missing governed workflow input controls
whether the resulting work unit can execute; unlike missing product policy,
ownership, or support input, it does not rewrite an evidence-backed maturity
disposition. Its execution state is closed:

- `ready` carries the complete canonical set of governed input IDs/digests,
  each of which must resolve through independent input authority, and it permits
  no missing human or workflow inputs;
- `missing-input` carries no governed input and explicitly enumerates every
  authenticated missing human and workflow requirement. The list must equal
  that declared set exactly; subsets and invented blockers fail.

Thus the contract is either executable by the named catalog workflow/step from
its admitted governed inputs, or it states exactly what prevents execution. A
self-rehashed change from missing to ready, workflow substitution, dependency
expansion, or tracker authorization fails validation.

## Canonical, sanitized, and migration rules

Decoders accept only exact, inert, canonical v1 JSON shapes. Unknown fields,
noncanonical collection order, proxies, accessors, custom prototypes, cycles,
sparse arrays, host paths, traversal/path-like IDs, requested-revision controls,
backslashes, credentials, duplicate IDs,
invalid digests, and rehashed authority substitutions fail closed. Accepted
records are deeply frozen.

Sanitized finding projections digest affected paths and omit repository source
paths, revisions, human-input IDs and value digests, governed-input IDs, and
content. Work-unit projections retain only stable fingerprints, gate/priority,
execution state, missing-input count, workflow identity, and the explicit
non-authorization state.

Schema v1 has an identity-only migration. Unknown source versions are rejected
with `migration-required`; there is no best-effort widening or downgrade. Any
future enum, required meaning, authority source, or execution-state change
requires an explicit version and migration rule. The checked-in compatibility
fixture is
`test/fixtures/runtime-evaluation/maturity/gate-catalog-v1.json`.
