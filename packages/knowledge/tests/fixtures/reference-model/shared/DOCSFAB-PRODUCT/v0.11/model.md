# Example product reference model v0.11

```yaml
merge_id: MERGE-EXAMPLE-0-11
model_id: DOCSFAB-PRODUCT
model_version: v0.11
prior_model_version: v0.10
created_at: 2026-08-18T00:00:02Z
model_region: synthetic example
target_release: test
audience: test
documentation_targets: [docs/about/page.md]
source_items:
  - source_thread_id: SRC-EXAMPLE-A
    item_id: ITEM-EXAMPLE-A-001
    version: "sha256:1ff68730190e3f3289f2bcf62bb2f39d576bc8c6e6ba80c4b36d3f9c29c7141c"
    representation_id: original
    member_id: none
    integrity: "sha256:1ff68730190e3f3289f2bcf62bb2f39d576bc8c6e6ba80c4b36d3f9c29c7141c"
    thread_head_event_ids: [EVT-EXAMPLE-A-002]
reviewers: [test]
approval_state: candidate
```

## Claim Decisions

### CLM-EXAMPLE-004: A configured pilot channel may reply without an explicit mention

```yaml
claim_id: CLM-EXAMPLE-004
source_claims: ["ITEM-EXAMPLE-A-001:notes"]
relationship: behavior-conflict
action: variant
statement: "A configured pilot channel may reply without an explicit mention."
scope: {component: "pilot channel"}
exact_evidence: ["ITEM-EXAMPLE-A-001 states the example behavior."]
agent_inferences: []
behavior_verification: not-checked
representation_state: confirmed
intent_approval: not-requested
model_state: candidate
decision_basis: "Synthetic example evidence."
resolution_owner: "Example owner"
blocks_targets: []
unblocks_targets: []
```

### CLM-EXAMPLE-005: Pilot channels are listed in deployment configuration

```yaml
claim_id: CLM-EXAMPLE-005
source_claims: ["ITEM-EXAMPLE-A-001:notes"]
relationship: compatible
action: added
statement: "Pilot channels are listed in deployment configuration."
scope: {component: "pilot configuration"}
exact_evidence: ["ITEM-EXAMPLE-A-001 states the example behavior."]
agent_inferences: []
behavior_verification: not-checked
representation_state: confirmed
intent_approval: not-requested
model_state: candidate
decision_basis: "Synthetic example evidence."
resolution_owner: "Example owner"
blocks_targets: []
unblocks_targets: []
```
