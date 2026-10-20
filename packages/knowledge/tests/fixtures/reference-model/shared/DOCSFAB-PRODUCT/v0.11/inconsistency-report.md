# Inconsistency report v0.11

## CONFLICT-EXAMPLE-001: Pilot Channel Mention Rule Remains Open

```yaml
conflict_id: CONFLICT-EXAMPLE-001
status: open
classification: behavior-conflict
summary: "The pilot-channel variant differs from the ordinary mention rule."
source_variants:
  - source_claim_ids: ["CLM-EXAMPLE-001"]
    statement: "Ordinary channel messages require an explicit mention."
    scope: {component: "ordinary channels"}
    exact_evidence: ["ITEM-EXAMPLE-A-001 states the ordinary rule."]
  - source_claim_ids: ["CLM-EXAMPLE-004"]
    statement: "A configured pilot channel may reply without an explicit mention."
    scope: {component: "pilot channel"}
    exact_evidence: ["ITEM-EXAMPLE-A-001 states the pilot variant."]
why_inconsistent: "The two statements prescribe different reply behavior for ordinary messages."
consequence_if_unresolved: "Readers cannot tell which reply rule applies in a pilot channel."
resolution_owner: "Example owner"
blocks_targets: ["pilot channel documentation"]
adjudication:
  adjudicator: none
  authority_basis: none
  decided_at: none
  disposition: none
  rationale: Accountable product disposition is pending.
  decision_evidence:
  - ITEM-EXAMPLE-A-001
  resulting_claim_ids:
  - CLM-EXAMPLE-004
```
