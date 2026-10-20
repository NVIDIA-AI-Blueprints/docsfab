# Interview Artifact Contract

Create one directory per participant interview:

```text
interviews/YYYY-MM-DD-<participant>-<topic>/
├── plan.md
├── transcript.md
├── claims.md
└── model-snapshot.md
```

The transcript is canonical evidence for what was said. The other files are
derived views and must link back to transcript headings or timestamps.

These files are interview representations, not the source-thread registry.
Register the interview as a canonical JSON source item under the participant's
stable thread, with each retained transcript, recording, claim extraction, and
model snapshot represented by an immutable locator and integrity value. The
thread's `events.jsonl` ledger records registration, correction, and
supersession. Never embed audio or other binary bytes in the JSON item; retain
authorized bytes under the thread's content-addressed `artifacts/` directory or
use their governed external locator.

## `plan.md`

Record:

- Product, version, model region, and interview objective.
- Stable `source_thread_id` and distinct interview `item_id`.
- Participant identity, role, product relationship, and authority hypotheses.
- Interviewer and capture channel.
- Consent, transcript, audio-retention, and citation boundaries.
- Registered sources, known gaps, and provisional claims kept hidden during
  free recall.
- Intended challenge scenarios and stop conditions.

## `transcript.md`

Use append-only interview events. A conventional interviewer question can use:

```markdown
## Q01 — <question verbatim>

**Time:** <timestamp or sequence>
**Answer type:** verbatim | participant-edited | paraphrase

> <answer; use blockquote only for verbatim or participant-edited wording>

**Interviewer note:** <clearly separated observation, never part of quote>
```

Participant-initiated or otherwise non-question events must use:

```markdown
## E<sequence> — <short interaction label>

**Time:** <timestamp or sequence>
**Actor:** participant | interviewer | agent | reviewer | system
**Direction:** <actor-to-recipient>
**Interaction kind:** addition | correction | challenge | request | approval | refusal | observation | other
**Content type:** verbatim | participant-edited | paraphrase
**Related claims:** <claim IDs or none>

> <content; use blockquote only for verbatim or participant-edited wording>

**Capture note:** <schema gap, transcription limitation, or none>
```

Record reflection prompts and corrections as later events. Never rewrite an
earlier answer to match the derived model. Never fabricate a question to
explain a participant-initiated event.

## `claims.md`

Use one record per independent claim:

```yaml
id: PM-<participant>-001
kind: behavior | intent | decision | rationale | hypothesis | non-goal | term | constraint | experience | open-question
statement: <normalized atomic statement>
verbatim_evidence:
  - transcript.md#q01
speaker: <identity>
speaker_role: <role>
scope:
  product_version: <value or unknown>
  deployment: <value or unknown>
  audience: <value or unknown>
  time_period: <value or unknown>
directness: observed | decided | recalled | inferred | hearsay | mixed
self_reported_confidence: high | medium | low | unspecified
supporting_sources: []
contradicting_sources: []
speaker_confirmation: unreviewed | confirmed | corrected | declined
behavior_verification: not-checked | supported | contradicted | inconclusive | not-applicable
intent_approval: not-requested | approved | rejected | participant-not-authorized | not-applicable
model_state: participant-only | candidate | disputed | unresolved | superseded
supersedes: []
diagram_elements: []
notes: <limits, exceptions, or follow-up>
```

Use `unknown`, not an invented value. A status applies only to its own field.
Use `directness: decided` only when the participant directly made or owns the
decision being reported. Tentative wording such as “might” or “may,” a forecast,
or a secondhand decision is not made direct merely by appearing in an
interview; classify the claim kind and directness from the evidence.

## `model-snapshot.md`

Include:

1. Interview boundary and participant attribution.
2. Concepts and relationships the participant used.
3. Supported workflows, states, and boundaries.
4. Intent, rationale, non-goals, and exceptions.
5. Reflection checkpoints with the prose or diagram shown.
6. Corrections and the claim IDs affected.
7. Participant-confirmed representation and unconfirmed regions.
8. Behavioral verification, intent approval, and reconciliation needed next.

Label the entire snapshot `participant-only`. It is not the shared model.

## Receipt

End `model-snapshot.md` with:

- Files created or updated.
- Source thread and interview item IDs.
- Model region covered.
- Number of provisional claims and reflection checkpoints.
- Participant time when measured.
- Manual interventions and capture limitations.
- Open evidence checks, decisions, and follow-up interviews.

## Attributed needs-input answer

When a `knowledge-accepted-snapshot` still has conflicts or unresolved or
disputed claims, the accountable product owner records **one** attributed
answer as JSON. Knowledge emits a new snapshot version. It does not rewrite the
prior snapshot bytes, and it does not copy interview JSON into the snapshot
envelope or into runtime `src/canon/`.

```json
{
  "schemaVersion": 1,
  "kind": "knowledge-attributed-answer",
  "actor": "<accountable product owner>",
  "authority": "product-decision-owner",
  "token": "<claim id or conflict id>",
  "statement": "<normalized atomic statement>",
  "winningClaimId": "<required when token is a conflict id>"
}
```

`authority` must be `product-decision-owner`. `token` names the answered claim
or conflict. When `token` is a conflict id, `winningClaimId` selects the claim
that remains. The new snapshot keeps the `knowledge-accepted-snapshot`
envelope, uses a new `modelVersionId` and `snapshotSha256`, sets the answered
claim `modelState` to `candidate`, and marks competing claims in a resolved
conflict `superseded`.
