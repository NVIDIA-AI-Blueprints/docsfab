# Versioned documentation-intelligence artifacts

DocsFab represents semantic and information-architecture results as strict,
content-addressed artifacts. These contracts live outside the Pi harness so
workflows, evaluations, approvals, and future APIs can exchange the same data
without depending on a model provider or site generator.

## Envelope and repository identity

Every v1 artifact has this envelope:

```json
{
  "schemaVersion": 1,
  "kind": "ontology",
  "repository": {
    "revision": "<full Git object ID>",
    "contentDigest": "<Content IR source digest>"
  },
  "digest": "<canonical artifact SHA-256>",
  "payload": {}
}
```

Validation requires exact equality with the revision and content digest in a
v1 structural Content IR. Every evidence item names a node and uses exactly
that node's repository-relative `sourcePath`; missing or mismatched paths,
absolute paths, traversal, backslashes, NUL, unresolved node IDs, and
unresolved ontology relationship endpoints fail closed. Unknown fields and
invalid closed-enum values fail at every nested object.

The eight initial kinds are:

| Kind | Purpose |
| --- | --- |
| `ontology` | Evidence-backed entities and relationships for actors, jobs, workflow stages, capabilities, concepts, components, resources, artifacts, configurations, constraints, failure modes, and outcomes. |
| `context-packet` | A task-specific structural neighborhood, page role, placement rules, active decisions, and structural pressure. |
| `ia-candidates` | Scored candidate organizations, groups, evidence, rejected alternatives, and open decisions. |
| `ia-evaluation` | Revision-bound diagnostic, scoring, topology, navigation-suite, retrieval-policy, and eligibility evidence for a candidate. |
| `ia-plan` | The selected structure bound to its exact candidate artifact, use cases, redirects, inbound-link consequences, navigation evidence, policy bindings, approval, expiry, supersession, and allowed output paths. |
| `impact-report` | Before/after repository and index identities, changed structural regions, ontology delta, affected nodes, and required response. |
| `healing-report` | Impact-bound repair, structural, or ontology-review recommendations and their approval level. |
| `navigation-evaluation` | Versioned known-answer tasks, ranked results, and recomputed retrieval metrics. |

The initial ontology relationship enum is exactly `is-a`, `part-of`,
`requires`, `precedes`, `operates-on`, `consumes`, `produces`, `configures`,
`validates`, `fails-with`, `resolved-by`, and `documented-by`. Adding an enum
member changes what validators accept and is therefore a breaking schema
change, not a documentation-only edit.

## Canonical bytes and digests

Canonical serialization rejects non-JSON values, cycles, non-plain objects,
and non-finite numbers. It sorts object keys and set-like arrays while
preserving arrays whose order carries meaning, such as ancestors, ranked
navigation results, and plan group order. Navigation tasks and their keyed
results are canonicalized as independent mappings, so input ordering cannot
change their bytes or digest. The artifact digest is SHA-256 over
the canonical envelope excluding only the top-level `digest` field. It does
not include a creation timestamp, so identical validated meaning at the same
repository identity has identical bytes and a stable digest.

Known-answer navigation tasks include the query that is evaluated. Navigation
outcomes are derived from each task's expected and acceptable nodes: an empty
ranking is `no-result`, more than one distinct accepted result is `ambiguous`,
one is `matched`, and none is `missed`. Supplied outcomes must match that
derivation. Metrics are derived from the tasks and ranked results. Supplied
metrics must match the deterministic recomputation; callers cannot claim a
better score by relabeling outcomes or editing aggregate fields. A recommended
IA candidate cannot also appear among the rejected alternatives, and an IA
plan cannot select a candidate that its own payload rejects.

## Approval, expiry, and supersession

IA plans use a closed approval state and canonical UTC timestamps. Approved
plans record the required approver evidence when policy requires it. Approval
cannot be recorded in the future or at or after plan expiry, and pending or
rejected plans cannot retain approval metadata. Supersession is a derived
lifecycle state, not an approval status: a fully validated active plan must
have the same scope and target and must explicitly reference the exact prior
plan in `supersedes`. Plan state is evaluated as `active`, `unapproved`,
`changes-requested`, `rejected`, `expired`, or `superseded`.
Validation callers should inject the evaluation time for reproducible expiry
decisions. An approved plan is not authorization to exceed its exact output
scope; later write workflows must still apply DocsFab's explicit write gate.

Two-phase plans additionally bind their mode, exact IA-evaluation reference,
planned pages, and migration dispositions. These four fields are present or
absent as one versioned set. Set-like planned-page and migration collections,
destination paths, and related-node IDs are canonicalized independently of
input order. Pending plans and non-approved review successors may be stored and
inspected only through the explicit structural-validation option; apply callers
retain active-plan validation by default. See
[two-phase-ia.md](../../plan-doc-structure/two-phase-ia.md) for the signed successor workflow.

## Operator input packages

IA input packages are host-owned lifecycle state, not model-authored artifacts.
Their canonical v1 envelope binds the closed IA task key, a content-free local
repository identity, exact Git revision, repository content digest, structural
index digest, canonical UTC expiry, and package digest. Analysis packages carry
only DocsFab's fixed query inputs; planning packages carry the already
validated analysis and deterministic evaluation inputs. They never carry SCM
credentials, reviewer keys, package-root authority, or write authorization.

Validation classifies repository identity mismatch, revision mismatch, changed
content/index state, expiry, structural invalidity, and digest tampering
separately. Identical provisioning is an immutable replay. A different package
cannot replace the task slot, so unrelated or attacker-created state is never
silently overwritten.

## Run-record references

Run records do not embed artifact payloads or local artifact paths. Steps may
return only this content-free reference:

```json
{
  "role": "input",
  "stepId": "assess-readiness",
  "reference": {
    "kind": "context-packet",
    "schemaVersion": 1,
    "digest": "<artifact SHA-256>",
    "repositoryRevision": "<full Git object ID>",
    "repositoryContentDigest": "<Content IR source digest>"
  }
}
```

The runner overwrites an untrusted step identifier with the catalog step ID,
copies only the fields above, sorts them deterministically, and deduplicates
the step and run aggregates.

## Schema migration policy

The low-level migration registry permits only adjacent integer versions. Each migration
declares `additive` or `breaking`; breaking migration requires explicit caller
opt-in. Future versions and missing migrations fail closed, and downgrade is
unsupported. The current compatibility fixture demonstrates a deterministic
v0-to-v1 additive envelope migration with digest recomputation. Breaking
fixtures use an isolated registry and preserve the requirement for explicit
authorization rather than silently widening the production registry. The
public `migrateArtifact` API requires current Content IR validation options and
strictly validates the migrated result before returning it.

Changing required meaning, removing or renaming fields, or extending a closed
enum is breaking. A deterministic default that preserves all existing meaning
may be additive. Migrated output is rehashed and passes the current strict
validator before it can be consumed.

Impact reports require both indexes during validation. `beforeRepository` and
`beforeIndexDigest` must match the supplied prior index exactly; the after
identity and digest must match the current index.

The #25 impact coordinator validates the before and after ontology envelopes
against those same indexes, derives ontology and classification signals, and
creates a standalone content-addressed `ImpactAnalysis`. The artifact adapter
then projects that analysis and a freshly recomputed healing-policy decision
into the existing `impact-report` envelope. Affected node IDs may resolve in
either the before or after index so deletions remain representable; evidence
entries still resolve in the current after index.

`HealingPlan` is the strict patch-only delivery contract for grouped repair
tasks, decision memory, and complete move evidence. Its constructor recomputes
policy inputs, binds task actions/targets/outputs to the evaluated proposal,
and requires an approved matching decision record before it can record a move.
It does not replace the smaller `healing-report` artifact; a later workflow may
reference the plan from that envelope without embedding patch bytes or model
output.

Validated examples for every kind live under
`test/fixtures/runtime-evaluation/artifacts/v1/`; negative and migration
fixtures live under `test/fixtures/runtime-evaluation/artifacts/invalid/`.
