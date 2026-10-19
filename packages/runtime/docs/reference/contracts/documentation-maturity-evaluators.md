# Documentation maturity evaluators

DocsFab maps existing documentation capabilities into six ordered, provider-neutral
evaluators. The evaluator layer does not rerun, imitate, or reinterpret those
capabilities. It authenticates their exact outputs, projects only supported facts,
and records where evidence is unavailable.

## Catalog

The production catalog is
`docsfab-documentation-maturity-evaluator-catalog@1.0.0`.

| Gate | Existing capability inputs | Deterministic scope | Optional semantic scope |
| --- | --- | --- | --- |
| `G0` | #82 inventory; source-readiness outcome | structure, text, documentation input surface, validation infrastructure | source readiness |
| `G1` | #83 release readiness; documentation audit | audience, site, journey, task/reference, trust/release coverage | audit outcome |
| `G2` | Content IR; #18 IA diagnostics; #79 self-service inputs; #83 navigation evidence | indexed structure, navigation/hierarchy, page boundaries/naming, input availability | IA outcome |
| `G3` | Content IR; audit; impact analysis | completeness, modularity, accuracy, freshness | audit outcome |
| `G4` | #83 release readiness; audit; polish | presentation, examples, accessibility, consistency | audit or polish outcome |
| `G5` | #83 governance/lifecycle; impact analysis; roadmap ledger v1 | ownership, validation lifecycle, freshness/review policy, roadmap maintenance | none |

Every evaluator declares its exact inputs, checks, semantic policy, and evidence
limits. Semantic review is optional and runs only after deterministic evidence; a
prompt claim or a successful harness step is never semantic authority. The
current serialized #81 workflow outcome is checksum-valid but has no opaque
producer receipt, so the public compatibility adapter rejects it instead of
minting semantic authority. A future host-authenticated outcome may be recorded
as a separately typed semantic overlay; such an overlay may degrade a gate
disposition, but can never populate or replace deterministic check results.

The checked-in known-answer catalog projection is
`test/fixtures/runtime-evaluation/maturity/evaluator-catalog-v1.json`.

## Independent and cascade use

`evaluateDocumentationMaturityGate` asynchronously evaluates one gate. The same
immutable result is the input boundary for the cascade controller: it includes the evaluator
identity, repository binding, applicability, per-check state, validated #101
findings and work units when the source supports them, original #83 work units
when bounded-search identity must be preserved, and the exact source mappings.
It never authorizes a tracker mutation.

Callers persist the returned evaluation but must reauthenticate it with
`validateDocumentationMaturityGateEvaluation` before selection or execution.
`decodeDocumentationMaturityGateEvaluation` checks the inert closed shape, exact
catalog check order and cardinality, deterministic/semantic layering, evidence
relationships, composed disposition, and checksums. Reauthentication reruns the evaluator against the original host-owned
source mappings, so a fully rehashed clone, changed check result, different
repository, or substituted work unit fails.

## Applicability is a product decision

Only `G0` is unconditional. `G1` through `G5` derive their product-need decision
inside the evaluator from the repository-root host policy file that
`DOCUMENTATION_MATURITY_HOST_POLICY_PATH` in
`src/maturity/evaluators/host-policy.ts` names, read from an authentic active
tracked repository workspace. The ledger must use the exact canonical v1 schema; the
workspace reader pins its bytes to the immutable Git tree. The derived decision
digest binds the ledger, source repository identity, exact revision, gate scope,
repository/documentation types, authority, evidence, timestamp, and predecessor
decision lineage. No exported function accepts or issues a caller-provided
decision or capability. The closed repository and documentation types are:

- repository: application, library, service, documentation-only, monorepo, or
  other;
- documentation: public product, developer reference, operator guide, internal,
  none, or unknown;
- need: required, not required, or unknown.

`not-required` requires an independently governed evidence digest and is the only route
to `not-applicable`. `unknown` remains unknown. A missing `docs/` folder, a
`README.md`, a site-generator name, or model prose cannot decide applicability.
Consequently, a repository without a docs folder may be a required documentation
product, an explicitly non-documentation product, or unresolved; the evaluator
does not collapse those cases.

Missing, noncanonical, structurally extended, duplicated, or changed ledger
state fails closed. A different product decision requires a different tracked Git
revision; changing an exported workspace in place invalidates its workspace
authority rather than changing the result.

## Evidence and defect boundaries

Source adapters admit only original host-produced objects:

- #82 inventories are checked through the non-serializable workspace authority;
- #83 artifacts are replayed against the exact run, expected repository, and
  authentic #82 inventory;
- #18 IA inputs require an authentic active repository workspace. The adapter
  snapshots them before its first await, rebuilds and exact-compares Content IR
  v2 through tracked, race-checked reads in that workspace, and verifies the
  exported tree. This authenticates the
  `content-structure-indexed` check only. Current ontology, candidate,
  projection, and semantic artifacts have no opaque producer receipt, so they
  cannot yet seal IA diagnostic satisfaction or findings;
- #79 self-service readiness is accepted only after inspecting the live,
  content-bound, unexpired package through the #79 inspection boundary; a receipt
  object or #18 diagnostic hash cannot stand in for that package;
- #81 outcomes remain unavailable as semantic authority until the harness
  exposes a non-serializable producer receipt. Structural decoding and a
  self-rehashed run record are deliberately insufficient.

G3 modularity thresholds come from the exact active entry in the same tracked,
versioned policy ledger. The adapter also rebuilds Content IR v2 from that
authentic workspace and requires canonical equality with the supplied index
before sealing a mapping. It has no threshold or policy override parameter.
Rehashing a laxer object, cloning a workspace, substituting ledger bytes, or
canonically rehashing fabricated Content IR cannot remint a result.

Impact analyses and `docsfab-roadmap-ledger@1` values are currently public,
serializable, self-rehashable contracts. Their compatibility adapters reject
them rather than minting even an `unknown` mapping that could collide with and
invalidate genuine evidence. They cannot satisfy, block, or degrade a gate until
their upstream producers expose authentic receipts. Roadmap execution records
remain the separate v2 contract and are not accepted by the ledger adapter.

Mapped packets use a private weak authority. Serialization preserves a record for
review, not authority; cloning and rehashing a packet cannot make it admissible.

Defects stay in five separate classes:

- `missing-infrastructure`;
- `missing-content`;
- `structural-defect`;
- `quality-defect`;
- `governance-defect`.

Unknown and blocked checks are not defects. Bounded #83 absence remains bounded
and retains the original #83 work unit; the adapter never upgrades it to exact
repository absence merely to fit a different contract. Exact #82 or IA
observations can produce fully validated #101 findings and executable work units.
All work remains `trackerMutation=not-authorized`.

## Failure behavior

Evaluators fail closed on proxies, accessors, custom prototypes, cycles, extra
fields, unknown enum values, hidden or sparse sequence elements, oversized
declared sequence lengths before allocation, credential-shaped input rejected by
the underlying source contract, cross-repository or cross-revision reuse,
duplicate checks, duplicate findings/work units, unsupported
capability-to-check mappings, evidence limits, and self-rehashed source
substitution. #79 task and target fields are primitive-decoded from descriptors
before the task-key implementation can perform coercion.

The TypeScript build clears `dist/` before compilation so a removed internal
issuer cannot survive as a stale deep-importable JavaScript file. The shipped
`maturity/index` and `maturity/evaluators` modules expose no product-need or
modularity authority creation or issuance function.
