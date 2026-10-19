# Inventory-Only Output Contract

Use this contract only when the DocsFab runtime schedules
`verify-technical-accuracy` in inventory-only mode.
Do not write documentation, compare a candidate, grant authority, assign
documentation dispositions, draft findings, or claim factual completeness.

## Runtime pin

Runtime manifests name this skill on the Pin A inventory step
(`derive-source-obligations`) for:

- `create-documentation` (`schemaVersion` 3), after `plan-documentation` and
  before `write-documentation`, from the validated plan sources;
- `review-documentation`, after `audit-documentation`, from the frozen review
  scope and admitted repository sources;
- the authoring branch of `update-documentation`, after `plan-documentation`
  and before `write-documentation`, from admitted change evidence and plan sources;
- `restructure-documentation`, after `plan-documentation` and before
  `write-documentation`, from immutable plan sources and the retained content map.

The host-owned response contract wraps the model proposal. The model returns
only `completeness`, `dimensions`, and `limitations`. The host adds revision,
scope, source-evidence identity, kind, schema version, and digest. Do not
manufacture those host fields.

## Model proposal

Keep `completeness` equal to `bounded-not-proven`. Assess each of the six
dimensions exactly once. Give every obligation a stable unique ID, one
applicable dimension, complete specific source locators, one atomic statement,
an evidence class of `source-observation` or `source-inference`, and explicit
uncertainty.

The ledger is untrusted model evidence. It is not a factual oracle,
completeness proof, support decision, approval, source grant, write grant, or
publication authority.

Do not inspect or edit a documentation candidate, assign documentation
dispositions, draft findings, widen the bound source set, or escape the
host-granted read scope.
