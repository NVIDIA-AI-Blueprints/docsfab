# Documentation maturity cascade and one-work-unit selection

DocsFab's internal cascade turns the independent G0–G5 evaluators into one
bounded decision for a future automatic consumer. It is not yet a supported CLI
or package API. The current internal record contract is
`docsfab-documentation-maturity-cascade-selection@1` with deterministic
algorithm version `1.0.0`.

## Authority and binding

`assessDocumentationMaturityCascade` accepts exactly six evaluator inputs in
G0–G5 order and runs the existing evaluators itself. It does not accept a set of
decoded evaluation records. The resulting assessment is bound to both maturity
catalogs, one repository identity and immutable revision, every exact gate
evaluation, and an assessment digest. Serialized or self-rehashed assessments
remain review evidence; validation reruns all six evaluator inputs before
restoring authority.

Tracker state is acquired separately through
`observeDocumentationMaturityCascadeTracker`. Its only inputs are the original
authenticated assessment and the exact active repository workspace. The host
requires exact `DOCSFAB_ROADMAP_GITLAB_HOST`, `_FULL_PATH`, `_PROJECT_ID`,
`_SSH_PORT`, and `DOCSFAB_ROADMAP_GLAB_PATH` configuration captured before
module initialization. The `glab` path must be absolute, canonical, a regular
file owned by the current user or root, and not writable by group or world. Its
filesystem identity is captured privately and rechecked before every invocation;
`PATH` is never used to select the executable. The repository's single GitLab
fetch remote must match that configuration. The host verifies exact project
metadata and the assessment commit through a private byte-, page-, and
time-bounded `glab api --hostname` edge and uses private monotonic time for
freshness. Repository, project, reader, fetch, executable, and clock cannot be
supplied by the workflow caller. The boundary records only sanitized
issue identity, finding, and material-evidence markers and issues a five-minute
observation backed by private process-local provenance.

The focused host-edge fixture proves this local authorization and binding
contract with an explicit test executable. It is not evidence of live GitLab
network conformance. Genuine live conformance requires a separately opted-in
environment with real credentials and the same explicitly authorized absolute
`glab` executable; it is never a mandatory unit-test network dependency.

Selection accepts only the original opaque assessment and production tracker
observation, requires their exact repository, workspace, project, revision, and
private state to agree, and binds both public evidence digests into the selection
digest. Freshness is rechecked after every asynchronous policy or evidence
operation and immediately before constructing the selection. The exported
inspection helpers are explicitly `non-authoritative`; they support
credential-free explanation and hostile-input tests, but their outputs are never
accepted by production selection. A later execution layer must reobserve the
tracker; decoding a selection does not authorize a tracker or repository
mutation.

Every cascade record keeps `trackerMutation` equal to `not-authorized`.

## Prerequisite traversal and exceptions

The controller reads prerequisite edges from the versioned G0–G5 gate catalog.
`satisfied` and evidence-backed `not-applicable` clear a prerequisite.
`not-ready`, `unknown`, and `blocked` prevent later work by default.

A later work unit can cross an unresolved edge only when the selected repository
revision contains the exact canonical cascade policy file that
`DOCUMENTATION_MATURITY_CASCADE_POLICY_PATH` in `src/maturity/cascade/dialect.ts`
names. Each exception binds:

- the prerequisite and target gates;
- the target work-unit fingerprint and exact scope digest;
- a repository-relative tracked evidence file and its exact digest; and
- the closed rationale `independent-scope`.

The resulting selection binds the policy decision to the exact assessment and
therefore to the blocking evaluation digest without creating a self-referential
Git revision. G3 modularity target identity uses the evaluator, check, and
effective threshold semantics; the revision-bound host-policy receipt remains
evaluation evidence, so adding only this tracked exception policy does not
rename the target while changing a threshold does. The exception is rejected if its evidence file is missing or
changed, the scopes overlap, the target depends on the
blocked finding or work unit, the gate has already cleared, the record is unused,
or any repository, revision, evaluation, scope, or evidence binding has changed.
Missing workflow input, inconclusive evidence, and unresolved dependencies stay
ineligible even when a prerequisite exception is valid.

The policy file is optional. Its absence means there are no exceptions. A
present file is read through an authentic active repository workspace, must be
byte-for-byte canonical, and is race-checked against the immutable Git export.
Current built-in observation producers seal both dependency collections empty.
Dependency-overlap rejection remains a defensive selection invariant and is
covered independently for finding fingerprints and work-unit identities.

## Executable eligibility

Only native, fully validated maturity work units can be selected by algorithm
version `1.0.0`. A unit must:

- have `execution.state=ready` and the complete governed input set;
- carry `confirmed` or authenticated `bounded` confidence;
- describe `observed-absence` or `bounded-not-found`, never an unsupported
  write inference;
- have no unresolved work-unit or finding dependencies; and
- retain its exact workflow, repository-relative scope, acceptance criteria,
  and verification plan from the authenticated finding.

The existing release-readiness compatibility unit does not expose a typed path
scope, confidence, or audience impact. It is therefore reported as an
investigation candidate rather than guessed into a write task. Low-confidence
absence is likewise investigation-only.

## Deterministic ranking

Eligibility is decided before ranking. Ready units are compared
lexicographically, without a weighted score that could trade away a stronger
dimension:

1. earlier maturity gate;
2. higher severity;
3. more blocked audiences, then more degraded audiences;
4. higher confidence;
5. greater dependency leverage;
6. fewer affected paths, then fewer acceptance criteria;
7. fewer exact-path collisions with other assessed units;
8. lower verification cost; and
9. lexical work-unit fingerprint.

Verification costs are fixed at repository observation 1, bounded search 2,
workflow outcome 3, and human attestation 4. Effort is a deliberately bounded
structural proxy because the work-unit contract has no caller-supplied effort
score. Equivalent authenticated inputs produce the same ordering before any
future optional semantic tie-breaker. Ranking admits at most 256 native units,
indexes tracker fingerprints and exact paths once, and memoizes dependency
descendants, preventing repeated full issue, path, and graph scans.

Candidate accounting has one aggregate ceiling of 1,856 decisions: at most 256
native ranked work units, 1,536 finding-only decisions (six gates times the
evaluator catalog's 256-finding ceiling), and 64 bounded compatibility/adapted
units. The builder rejects an over-budget authentic assessment before creating
any decisions, and the selection decoder applies the same aggregate ceiling.
Tracker observations admit at most 1,024 sanitized issues, at most 256 sorted
finding markers and 256 sorted material-evidence markers per issue, a 600,000
node issues budget, a separately bounded outer-record allowance, and depth 64.
The GitLab reader additionally enforces per-response and 16 MiB aggregate byte
ceilings before parsing or normalizing an observation.

Every finding, native unit, and compatibility unit is accounted for in the
selection record. Non-selected entries name prerequisite, input, dependency,
confidence, scope, collision, later-gate, or lower-rank reasons. One record can
contain exactly one selected unit and cannot aggregate unrelated findings.

## Terminal outcomes

The outcome is a closed union:

- `selected` embeds one exact native work unit;
- `needs-input` lists the complete known input IDs and the earliest affected
  gate;
- `investigation` identifies the earliest unresolved gate when evidence,
  dependencies, or scope cannot safely support a write; or
- `no-action` records that no applicable work remains.

The selected work unit itself names the workflow and step, affected paths,
acceptance criteria, and verification. No prose-only substitute can expand that
scope.

## Failure behavior

The cascade rejects proxies, accessors, custom prototypes, sparse or hidden
array elements, symbol keys, cycles, oversized sequences, reordered or missing
gates, cross-repository inputs, forged assessment or tracker objects, stale
tracker observations, noncanonical policy, and duplicate identities. Decoders
apply both total-node and depth budgets and reject invalid outer shells before
nested inert-data traversal. They verify strict transport integrity only; a structurally valid self-rehashed
selection remains non-authoritative and fails source revalidation. Original
source reauthentication is required before a decoded record can influence a
new selection.
