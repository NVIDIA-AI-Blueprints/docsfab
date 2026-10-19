# Transcript Evidence Contract

## Boundary

An agent session transcript is a mixed event log, not a human-authored
document. It can contain human messages, system instructions, agent prose,
tool calls and results, injected skills, inter-agent messages, command output,
credentials, and unrelated private material. Mining creates a reviewed derived
representation; it does not change the identity or custody of the raw source.

The raw session stays outside the project repository unless retention of the
complete session is explicitly authorized. Its stable evidence identity is:

- Harness and session identifier.
- Governed source locator.
- SHA-256 over the exact bytes.
- Byte size.
- Capture range.
- Parser or manual extraction method.

Line numbers are valid anchors only together with the exact source hash. Event
UUIDs, when the harness supplies them, and timestamps strengthen the anchor but
do not replace source identity.

## Candidate record

`mine_session.py extract` emits one JSON object per canonical text-bearing
user-role event. For Codex rollout logs, the canonical surface is the user-role
`response_item`; its `event_msg.user_message` projection is not a second
candidate:

```json
{
  "schema_version": "docsfab.knowledge.transcript-candidate/v1",
  "candidate_id": "<adapter>:<session-id>:line:<line>",
  "source": {
    "format": "claude-code-jsonl or codex-rollout-jsonl",
    "path": "/governed/local/path/session.jsonl",
    "sha256": "<digest>",
    "size_bytes": 123,
    "session_id": "<session-id>"
  },
  "anchor": {
    "line_number": 42,
    "event_id": "<event-uuid>",
    "timestamp": "2026-08-07T00:00:00Z"
  },
  "authorship": {
    "event_role": "user",
    "origin_class": "likely-human",
    "classification_reasons": []
  },
  "text": "verbatim human text",
  "text_sha256": "<digest>",
  "text_length": 19,
  "text_transform": "none",
  "sensitive_flags": [],
  "duplicate_of": null
}
```

`origin_class` is a triage aid, not proof of identity:

- `likely-human`: no known synthetic wrapper remains after supported wrapper
  extraction.
- `ambiguous`: mixed or unfamiliar structure requires contextual review.
- `synthetic`: a known harness, tool, skill, poll, or dispatch surface.

The extractor emits synthetic events so exclusions remain auditable. It
withholds sensitive candidate text by default while retaining a text hash and
length for identification. When a compacted or resumed session repeats an
event, the later record names the first candidate in `duplicate_of`; it is not
silently removed.

## Selection manifest

Create one JSON manifest per bounded mining pass:

```json
{
  "schema_version": "docsfab.knowledge.transcript-selection/v1",
  "title": "Andrew Chen descriptions of the agent control plane",
  "source_sha256": "<raw-session-digest>",
  "selection_scope": {
    "participant": "Andrew Chen (andrewch)",
    "time_range": "2026-07-17 through 2026-08-07",
    "model_regions": ["product intent", "process", "UI and interaction"]
  },
  "selections": [
    {
      "candidate_id": "claude:<session-id>:line:42",
      "evidence_id": "A-001",
      "heading": "Human participation",
      "model_regions": ["UI and interaction"],
      "topics": ["chat input"],
      "selection_note": "States a durable interaction requirement."
    }
  ]
}
```

Evidence IDs and candidate IDs must be unique. Order selections by source
line. Select `likely-human` candidates only unless an `ambiguous` candidate
has been contextually reviewed; the renderer refuses `synthetic` and
sensitive candidates. Select the first inspectable occurrence of a duplicated
event rather than a later replay.

## Retained artifact

The rendered Markdown artifact contains:

- Raw source identity, hash, size, session ID, and selection range.
- The mining and review boundary.
- One chronological section per selected statement.
- Evidence ID, timestamp, source line, event ID, model regions, topics,
  selection note, and wrapper transformation.
- The participant's selected text as a verbatim block quote.

The artifact is evidence, not a summary or shared model. Topic labels and
selection notes are collector metadata and must not be cited as participant
statements.

## Source-thread registration

Register the mining pass as one source item with at least two representations:

1. `raw-session`: non-retained governed locator, exact SHA-256 and byte size,
   no parent representation.
2. `curated-verbatim-excerpts`: content-addressed retained artifact, derived
   from `raw-session`, with the adapter version, selection method, and review
   state recorded as a transform.

Use `evidence_state: transformed`; the excerpt bytes are transformed, while
the quoted words remain direct source evidence. Record limitations including
selection incompleteness, authorship-classifier limits, missing attachments,
and any unsearched session stores.
