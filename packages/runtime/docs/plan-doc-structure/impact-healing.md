# Incremental impact analysis and tiered healing

DocsFab compares two revision-bound structural indexes before it recommends a
documentation repair. `analyzeDocumentationImpact` records changed structural
regions and the deterministic affected neighborhood. It supports:

- `incremental` analysis for each proposed write; and
- `full` analysis through a digest-bound, host-scheduled weekly policy seam.

Both modes return a content-addressed report. Full mode can discover global
sibling pressure, while its projection for the locally affected neighborhood
uses the same evaluator as incremental mode.

## Invalidation behavior

Body-only changes invalidate body and semantic context. Parents and siblings
can be reevaluated for semantic consistency without invalidating unrelated
navigation or graph state. Headings, metadata, navigation, graph, new reader
jobs, new concepts, new content types, duplicate knowledge, canonical homes,
navigation scenarios, and sibling-threshold crossings expand the neighborhood
with explicit reasons.

A 400-word delta is recorded as a growth signal. It is not material evidence
by itself and cannot trigger a split, move, or repair.

Ontology deltas are computed from the before and after ontology payloads. The
artifact adapter then binds that delta, the affected neighborhood, the healing
policy decision, and both indexes into DocsFab's versioned `impact-report`
envelope.

## Healing policy

The default versioned policy has four closed levels:

| Level | Result | Approval |
| --- | --- | --- |
| `observe` | Record the evidence only | none |
| `bounded-repair` | Produce a reviewable patch | maintainer |
| `structural-proposal` | Propose a split, merge, move, or navigation change | maintainer |
| `ontology-review` | Request a product vocabulary or top-level-axis decision | product owner |

Separate trigger and recovery thresholds provide hysteresis. Stable public URL
changes receive an explicit pressure penalty and require a minimum expected
benefit. Recently decided proposals enter cooldown, and a rejected proposal is
suppressed until its material-evidence digest changes. Higher-authority work is
never downgraded into a lower healing action.

Decision records, repair tasks, and move evidence are strict, revision-bound,
and content-addressed. Tasks are grouped by owner, source, section, and affected
output. A move record is incomplete without old and new paths, inbound links,
an old-to-new redirect, validation evidence, and rollback instructions.
The plan embeds the closed healing policy and verifies its content digest, so
changing both a task and its claimed requirement cannot bypass the policy.

## Write boundary

Only narrowly approved, preimage-bound repairs may mutate a disposable
repository workspace. A repair failure restores the original bytes and mode.
The source checkout remains unchanged, and the result contains content-free
patch metadata suitable for the existing patch evidence collector.
`bindPersistedGitPatchEvidence` then verifies the collector's durable patch
bytes, repository revision, and exact changed paths before binding that
SHA-256 and byte length into the bounded task. The host-only artifact path is
never copied into the healing plan.

Every healing plan has `patch-only` delivery. These APIs do not merge, publish,
push, or open a merge request. Structural proposals and ontology reviews remain
read-only until their configured approval is recorded by a separate workflow.

## Current limits

The full-corpus scheduler is an injected local seam, not a hosted durable
queue. Semantic changes enter through revision-bound ontology artifacts and
content-addressed classification diagnostics; live model evaluation and the
broader two-phase IA apply workflow are tracked by issues #27 and #26
respectively.
