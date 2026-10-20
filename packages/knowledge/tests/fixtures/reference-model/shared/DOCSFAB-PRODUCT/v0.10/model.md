# Example product reference model v0.10

```yaml
merge_id: MERGE-EXAMPLE-0-10
model_id: DOCSFAB-PRODUCT
model_version: v0.10
prior_model_version: none
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

### CLM-EXAMPLE-001: Ordinary channel messages require an explicit mention

```yaml
claim_id: CLM-EXAMPLE-001
source_claims: ["ITEM-EXAMPLE-A-001:notes"]
relationship: compatible
action: added
statement: "Ordinary channel messages require an explicit mention."
scope: {component: "ordinary channels"}
exact_evidence: ["ITEM-EXAMPLE-A-001 states the example behavior."]
agent_inferences: []
behavior_verification: not-checked
representation_state: confirmed
intent_approval: approved
model_state: approved
decision_basis: "Synthetic example evidence."
resolution_owner: "Example owner"
blocks_targets: []
unblocks_targets: []
```

### CLM-EXAMPLE-002: The service records every reply in the audit log

```yaml
claim_id: CLM-EXAMPLE-002
source_claims: ["ITEM-EXAMPLE-A-001:notes"]
relationship: compatible
action: added
statement: "The service records every reply in the audit log."
scope: {component: "audit log"}
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

### CLM-EXAMPLE-003: Documentation targets are projections of the model

```yaml
claim_id: CLM-EXAMPLE-003
source_claims: ["ITEM-EXAMPLE-A-001:notes"]
relationship: compatible
action: added
statement: "Documentation targets are projections of the model."
scope: {component: "projections"}
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
