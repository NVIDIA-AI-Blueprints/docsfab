# Reflection Packet Contract

Append each packet to the relevant participant `model-snapshot.md` or named
model-review record. Preserve prior checkpoints.

```markdown
## Reflection R<sequence> — <model region>

**State:** Provisional reflection for correction
**Participant/reviewer:** <identity and role>
**Based on:** <claim IDs and exact evidence links>
**Prior checkpoint:** <ID or none>
**Scope:** <product version, deployment, audience, workflow, or unknown>

### What I heard

<Short attributed explanation. Do not imply validation or approval.>

### Model delta

| Claim | Change | State |
| --- | --- | --- |
| <ID> | added | participant-only |
| <ID> | changed from <ID> | unresolved |

### Agent inferences and uncertainties

- <Inference or uncertainty; never merge into What I heard.>

### Projection

<Optional small table or Mermaid diagram. Omit when it would add no test.>

| Element | Claim evidence | Status |
| --- | --- | --- |
| <node/edge/row> | <claim IDs> | <supported for representation, uncertain, or disputed> |

### Correction prompt

What is wrong, missing, or misleading here?

<One targeted challenge question.>

### Response

> <Verbatim participant response>

**Response classification:** confirmed-representation | correction | addition | scope-change | uncertainty | declined | challenge-result

### Resulting changes

- <Claim or projection element changed and why.>

### Remaining validation

- Behavior verification: <needed, result, or not applicable>
- Intent approval: <owner and state, or not applicable>
- Reconciliation: <other participant/source needed, or none>
- Diagram syntax rendered: <yes, no, or not applicable; include renderer/version>
- Diagram visually legible: <confirmed, failed, pending, or not applicable; include reviewer/viewport>
- Diagram conceptually understood: <confirmed, failed, pending, or not applicable; include unfamiliar reader evidence>
```

Use a blockquote only for verbatim or participant-edited language. If the
response is reconstructed, label it as a paraphrase and do not treat it as
speaker-confirmed wording.
