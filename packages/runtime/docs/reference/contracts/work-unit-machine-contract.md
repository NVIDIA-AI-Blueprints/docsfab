# Work-unit machine contract (v1)

Closed field list for the sealed MEA / campaign admission envelope frozen in
investigation #255 (option 3). Durable decision record:
[work-unit machine contract plan](../../plan/work-unit-machine-contract.md).
This envelope does **not** rewrite
[DocumentationMaturityWorkUnitV1](documentation-maturity-contracts.md).

## Envelope identity

| Field | Closed value / rule |
| --- | --- |
| `kind` | Exactly `"docsfab-work-unit-machine-contract"` |
| `schemaVersion` | Exactly `1` |
| `workUnitFingerprint` | Required; binds to an existing maturity work unit |
| `repositoryIdentitySha256` | Required; same repository identity as the bound unit |

Missing fingerprint binding fails closed. The envelope never embeds work-unit
body fields, host paths, credentials, or free-form shell.

## Machine checks

`machineChecks` is required and **non-empty**. Empty arrays reject.

Each element is an inert plain object with:

| Field | Closed value / rule |
| --- | --- |
| `checkKind` | `"npm-script"` \| `"vitest-file"` \| `"cli-smoke"` \| `"fixture-key"` \| `"inventory-probe"` |
| Identity (exactly one, by kind) | Content-free: `commandId` (npm-script / cli-smoke), Vitest path id (`vitest-file`), `fixtureKey`, or `inventoryProbeId` |
| `expectedOutcomeClass` | `"pass"` \| `"fail-closed"` |

Identities are content-free. Host paths, traversal-like IDs, credentials, and
free-form shell strings are not authority and fail closed at decode.

## Acceptance authority and tracker stance

| Field | Closed value / rule |
| --- | --- |
| `acceptanceAuthority` | `"host-deterministic"` \| `"evaluate-step-plus-host"` |
| `trackerMutation` | Exactly `"not-authorized"` |

Catalog `evaluate` alone cannot flip Acceptance to passed. When
`acceptanceAuthority` is `"evaluate-step-plus-host"`, evaluate evidence is
advisory under host / decoder / machine-check ownership. Cite investigation
#256 and Task #260 (evaluate WorkflowStepKind decision record).

## Fail-closed decode

Reject unknown fields, noncanonical collection order, empty `machineChecks`,
missing `workUnitFingerprint` / `repositoryIdentitySha256`, open `checkKind`
values, open `expectedOutcomeClass` / `acceptanceAuthority`, any
`trackerMutation` other than `"not-authorized"`, proxies, accessors,
custom prototypes, cycles, sparse arrays, and credential- or path-shaped identities.
Accepted records are deeply frozen. Schema v1 uses identity-only migration;
unknown versions fail closed.

## Admission vs cascade

| Surface | Envelope |
| --- | --- |
| Maturity cascade selection; existing `test/fixtures/runtime-evaluation/maturity/*` fixtures | Valid **without** this envelope |
| MEA / multi-unit campaign admission | Requires a valid bound envelope; absent or invalid → fail closed |

## Non-overlap

- **#226** owns candidate keep/discard, plateau, and experiment-ledger budgets
  inside foundation-to-patch. This contract does not redefine that ledger.
- **#256** owns catalog `evaluate` Acceptance-flip rules cited above; this
  contract does not re-decide the evaluate step kind.

## Implementation note

Prefer a dedicated sealed decoder module (for example
`src/maturity/work-unit-machine-contract.ts`) rather than rewriting the maturity
work-unit megafile. Product code is out of scope for the docs land Task (#263).
