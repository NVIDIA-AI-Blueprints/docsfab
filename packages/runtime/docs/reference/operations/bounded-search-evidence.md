# Bounded-search and negative-evidence contracts

DocsFab's bounded-search schema records what a search meant, which finite probes
were required, what those probes established, what remained inaccessible, and
why the final disposition is justified. The schema is harness-neutral and lives
in `src/search/bounded-search-contracts.ts`.

The contract is an evidence format, not a search executor. A harness chooses and
runs only the declared probes, then submits their minimized results to the
decoder. The decoder derives coverage and rejects a disposition that claims
more than those results support.

For local production runs, common repository-discovery probes are supplied by
the revision-bound [governed repository inventory](repository-inventory.md).
Incomplete inventory state is a blocking limitation and can never authorize a
bounded-not-found disposition.

## Evidence chain

Each version-1 bundle has an exact, closed shape:

1. A **target** binds a semantic target and required probe plan to repository
   identity and immutable revision. Its stable finding ID omits only the
   revision, so the same semantic finding can be compared across revisions
   while every evidence bundle remains revision-bound.
2. A **probe** must match one declared ID, strategy, and location category. It
   records a scope digest, closed outcome, match count, evidence digest, and
   optional repository-relative citations.
3. A **limitation** records a closed category, affected probe IDs, and a detail
   digest. Access denial, hard ceilings, incomplete indexes, tool failure,
   unsupported operations, timeout, and missing evidence are always blocking.
   Each blocking limitation must bind one or more probes whose outcome is
   `blocked`, and every blocked probe must be covered before disclosure can be
   called complete.
4. **Coverage** is derived from the target, probes, limitations, and explicit
   blocker disclosure. Callers cannot set `sufficient` themselves.
5. **Confidence** binds coverage and a saturation observation to one closed
   disposition.
6. A **finding** projects the stable identity, exact revision, disposition,
   digests, and minimized citations.
7. The aggregate record binds every component by canonical SHA-256.

All decoders require inert plain JSON data, exact keys, canonical ordering,
closed enums, and valid digests. Validation rejects accessors without invoking
them, proxies, custom prototypes, symbol or hidden properties, sparse or extended
arrays, undefined values, controls, and oversized collections before reading
fields or hashing values. Accepted values are deeply frozen. Canonical
serialization and parsing provide deterministic round trips.

## Targets and claims

`artifact-existence` targets ask whether a concrete artifact class exists. The
target binds required-probe policy
`docsfab-bounded-search-required-probes@1.0.0`; callers may add probes but may
not replace these class-specific minimums:

| Artifact class | Required strategy/location pairs |
|---|---|
| `configuration` | `exact-path`/`repository-root`; `filename-index`/`tracked-files` |
| `dependency` | `dependency-manifest`/`dependency-manifests`; `tracked-text-index`/`tracked-files` |
| `script` | `script-manifest`/`script-manifests`; `tracked-text-index`/`tracked-files` |
| `ci-definition` | `ci-configuration`/`ci-configuration`; `filename-index`/`tracked-files` |
| `documentation-artifact` | `exact-path`/`documentation-tree`; `documentation-inventory`/`documentation-tree` |
| `navigation-entry` | `navigation-graph`/`navigation`; `documentation-inventory`/`documentation-tree` |

`rubric-coverage` targets are required for documentation quality or
completeness claims. They add a versioned rubric whose criteria have a closed
kind and name their required probes. Every kind requires an actual
`rubric-assessment` probe: `accuracy`, `completeness`, and `usability` assess the
documentation tree, while `navigation` assesses navigation. Completeness also
requires a documentation inventory; navigation also requires the navigation
graph. Every criterion must have evidence and every declared probe must belong
to exactly one criterion; coverage reports each criterion as `assessed`, `incomplete`, or
`blocked`. Filename or existence probes cannot be relabeled as evidence that
documentation is accurate, complete, findable, or usable.

The target's `subjectSha256` identifies the content-minimized query or rubric
subject. Raw queries and descriptions remain outside the shareable record.

## Closed dispositions

| Disposition | Minimum contract condition |
|---|---|
| `found` | At least one declared probe reports a match with a relative citation. |
| `not-found-after-bounded-search` | Every required probe completed with no match, criterion coverage is complete when applicable, blocker disclosure is complete with zero undisclosed blockers, no blocking limitation exists, and a saturation observation says the search saturated. |
| `search-still-productive` | A saturation observation says additional search remains productive. |
| `search-incomplete` | No match or blocker exists, and neither productivity nor saturation has been observed; this includes completed probes whose negative search has not saturated. |
| `search-blocked` | A blocking limitation exists and it is not a hard ceiling. |
| `stopped-no-progress` | Coverage remains insufficient, no blocking limitation exists, and the bounded strategy set is saturated. |
| `stopped-hard-ceiling` | A declared hard-ceiling limitation stopped the search. |

An access-denied or hard-ceiling result can never validate
`not-found-after-bounded-search`. Reaching a tool, turn, or time ceiling is
evidence about execution limits, not evidence that the target is absent.

Overlapping observations resolve by one deterministic precedence: a positive
match forces `found`; otherwise hard ceiling forces `stopped-hard-ceiling`;
otherwise any blocking limitation forces `search-blocked`; otherwise productive
search forces `search-still-productive`; otherwise saturated sufficient
no-match evidence produces `not-found-after-bounded-search`; otherwise
saturation produces `stopped-no-progress`; all remaining cases are
`search-incomplete`. A caller cannot select a lower-priority disposition.

## Content-minimization boundary

Shareable bounded-search evidence may contain only identifiers, closed enums,
counts, repository-relative paths, immutable revisions, and digests. It rejects
absolute host paths and credential-like strings. There are no fields for:

- prompts, raw queries, or model reasoning;
- matched text, surrounding excerpts, or repository content;
- credentials, environment values, or provider payloads;
- unrestricted commands, tool names, arguments, or results.

Positive findings cite a lexically bounded repository-relative path and
optionally an anchor digest. Citation paths allow only filename-safe ASCII path
characters; whitespace, controls, traversal, and host paths
are rejected. The content that produced the digest stays in private operator
storage.

## Integration seams

The schema deliberately does not import a harness, scheduler, lease, checkpoint,
or tool-call type. A later search executor can project its bounded progress into
these records:

- a saturation artifact contributes only its digest and the closed
  `saturated` or `productive` state to `confidence.saturation`;
- a lease or checkpoint record can carry the aggregate `evidenceSha256`, stable
  finding ID, and terminal disposition without becoming part of this schema;
- run records can reference the aggregate digest as minimized artifact evidence
  while retaining content-bearing search material privately.

The workflow runner now projects each completed finding into the revision-bound
documentation gap ledger described in [`run-record.md`](../contracts/run-record.md). The
stable finding ID provides cross-revision deduplication identity; the exact
target, coverage, confidence, limitation, bounded-evidence, and original-finding
digests preserve the observation identity. Observation identity also includes
`workspaceSnapshotSha256`. Same gap at the same Git revision with a different
workspace snapshot is history, not a contradiction. Distinct evidence at the
same snapshot still fails closed. `searchMode` on the workflow step selects
`observe`, `revalidate`, or `reuse`; the runner merges with prior ledgers
instead of flattening every step as one snapshot. The projection deliberately drops
citations as well as the original question, so downstream roadmap and scorecard
consumers cannot turn a safe summary into a host-path or content disclosure.
The local product coordinator uses the active disposable workspace capability
to build the authenticated tracked-tree, text, metadata, and Content IR graph
inventory. Production navigation probes consume only the graph artifact;
documentation presence is not navigation evidence. Semantic rubric probes are
recorded per probe as blocking `unsupported-operation` limitations and do not
discard supported results from the same batch. The legacy filesystem-only
coordinator has no graph capability and reports navigation as unsupported.
Every production runner supplies the governed workspace coordinator, while the
`Task -> Workflow -> Step` evidence contract remains independent of Pi.

These seams allow the execution contracts planned in later work to consume the
format without making negative-evidence semantics depend on one harness.

## Operator rule

Treat `not-found-after-bounded-search` literally: it means “not found by this
declared, sufficiently covered, saturated search at this revision.” It is not a
claim that the artifact can never exist, and it does not authorize a write or
publication step.

## Workflow integration

Discovery-oriented catalog steps declare a versioned search plan before any
search begins. Each declaration contains the product question, target type,
target key, and the exact target-specific probes required by this contract.
DocsFab hashes the question into `subjectSha256` and binds the resulting
`SearchTargetV1` to the selected repository identity and immutable revision.
The question itself is a static workflow instruction and is not copied into the
run record.

The integrated steps are source readiness, documentation audit on
`review-documentation`, the observation/search step of `update-documentation`,
and IA analysis/planning. Bootstrap, the write phase of `update-documentation`,
and site bootstrap do not acquire search or write authority from this
integration. Source readiness still asks whether the repository is usable
input for future documentation work; it is not the separate public
release-documentation readiness workflow or rubric.

A `WorkflowSearchCoordinator` is the harness-neutral seam for the governed
repository inventory, batched probes, and checkpointed execution coordinator.
It owns checkpoint/resume mechanics and returns only:

- a stable repository identity digest;
- complete bounded-search evidence from this contract; and
- the matching progress/saturation evidence from the search-progress contract.

The runner independently reconstructs every declared target and rejects missing
targets, revision or identity substitution, mismatched probe/limitation sets,
or different dispositions/saturation between the two contracts. A
`search-still-productive` recommendation is not a final result: it asks the
coordinator for the next bounded lease and is rejected at the runner boundary
until the coordinator returns terminal evidence. Consequently,
`not-found-after-bounded-search` reaches a workflow only after required
probes, coverage, blocker disclosure, and saturation all validate.

Catalog workflows, plans, targets, probe declarations, and rubrics are
recursively frozen. Before calling a coordinator, the runner validates and
deep-freezes a fresh plan/step/workflow snapshot; after the await, it normalizes
only against that original snapshot and a separately frozen coordinator-result
snapshot. A coordinator therefore cannot splice, relabel, or substitute search
authority during execution or affect a later replay.

Every workflow-search wrapper boundary first validates recursively through own
property descriptors. Proxies are rejected before reflection, and accessors are
rejected without invocation. Sparse or extended arrays, undefined or symbol
values, hidden or extra fields, cycles, and custom prototypes are also rejected
before contract fields are read.

Search disposition and workflow execution status remain separate.
`steps[].searchEvidence` does not turn a product gap into a harness failure
or a tool defect into product `not-ready`. The workflow-outcome envelope owns
that mapping; see [Workflow execution and product outcomes](../contracts/workflow-outcomes.md).
Until a workflow-specific projector and the governed inventory are configured,
the runner's coordinator option remains absent and historical executions
continue without `searchEvidence`; no model may manufacture the missing host
evidence.

The exported release-roadmap discovery plan covers revision-bound change
accounting only. It does not implement public release-documentation readiness,
does not change the roadmap adapter's exact input contract, and cannot perform
tracker or repository mutation.
