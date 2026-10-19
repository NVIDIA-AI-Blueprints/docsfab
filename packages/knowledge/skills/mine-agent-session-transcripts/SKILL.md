---
name: mine-agent-session-transcripts
description: Mine human-authored evidence from agent session transcripts into provenance-preserving, secret-safe, verbatim artifacts for a DocsFab knowledge-gathering source thread. Use when prior conversations contain product intent, mental models, process requirements, decisions, corrections, or UI descriptions that must be recovered without treating harness messages, tool traffic, or agent prose as human evidence.
license: Apache-2.0 AND CC-BY-4.0
---

# Mine Agent Session Transcripts

Recover attributable human evidence without turning a mixed agent log into an
anonymous summary. This skill produces a reviewed verbatim excerpt artifact;
`$register-source-thread` registers it, and later extraction or synthesis
interprets it.

Read [transcript-evidence-contract.md](references/transcript-evidence-contract.md)
before selecting or retaining evidence.

## Establish the evidence boundary

Require:

- The participant or source thread the evidence belongs to.
- The exact session file, harness format, and session identifier.
- The requested time range and model regions.
- Consent, retention, citation, redistribution, and access boundaries.
- An authorized working directory for intermediate candidate files.

Hash the original transcript before extraction. Do not copy a complete session
into a project repository merely because it is readable. Agent sessions often
contain unrelated personal material, credentials, tool output, and other
participants' words.

Stop if the speaker cannot be established, the source changes during mining,
retention is ambiguous, or credential material would enter the retained
artifact.

## Inventory before selecting

For Claude Code or Codex rollout JSONL, use the deterministic adapter. It
detects the format and fails if an explicitly requested format disagrees:

```bash
python3 scripts/mine_session.py inventory <session.jsonl>
python3 scripts/mine_session.py extract <session.jsonl> \
  --after <ISO-8601> --before <ISO-8601> --output <candidates.jsonl>
```

If a dispatcher or control plane in your deployment injects messages under its
own marker, pass each marker with `--synthetic-prefix <marker>` (repeatable) so
those messages are classified as `synthetic`. A blank marker is refused.

The Claude adapter emits every text-bearing user-role event. The Codex adapter
uses user-role `response_item` messages as the canonical text surface and does
not duplicate their `event_msg.user_message` projections. Both classify emitted
candidates as `likely-human`, `ambiguous`, or `synthetic`; neither silently
discards an emitted candidate. They record the source hash, byte size, session
and available event identifiers, line number, timestamp, text hash, wrapper
transform, and sensitive-data flags. Sensitive text is withheld from candidate
output by default.

For another harness, first identify its authoritative session store and event
schema. Preserve equivalent anchors and explicitly record the adapter or
manual method. Never force an unsupported format through an existing adapter.

## Select evidence conservatively

Review likely-human and ambiguous candidates against surrounding events.
Select only words attributable to the named participant and relevant to the
requested model regions. Include operational statements when they express a
durable product, process, interaction, authority, reliability, or quality
requirement.

Create a `docsfab.knowledge.transcript-selection/v1` manifest following the contract.
For every selection, record an evidence ID, heading, model regions, topics, and
why the statement belongs. Preserve chronology so later readers can see the
model change over time.

Exclude:

- System instructions, skill injections, tool results, local-command echoes,
  agent-to-agent dispatch wrappers, polling prompts, and generated summaries.
- Agent responses, even when they paraphrase the participant fluently.
- Credentials, signed URLs, tokens, unrelated private content, and evidence
  whose authorship remains unresolved.

Do not paraphrase selected evidence. A stripped harness wrapper is a recorded
transformation; the participant's remaining text stays verbatim.

## Render and inspect the evidence artifact

Render from the candidate file and reviewed selection manifest:

```bash
python3 scripts/mine_session.py render \
  --candidates <candidates.jsonl> \
  --selection <selection.json> \
  --output <verbatim-evidence.md>
```

The renderer verifies source-hash agreement, selection uniqueness, candidate
existence, authorship state, chronology, and secret-safety before writing. Read
the rendered artifact end to end and compare a sample from every time segment
against the raw session. Search the output for credential patterns and for
synthetic markers before retention.

## Register without synthesizing

Use `$register-source-thread` to attach the excerpt collection as a new item in
the participant's stable source thread. Register the original session as a
non-retained governed locator with its SHA-256 and byte size. Register the
retained excerpt as a derived representation with its own hash, transformation
method, and review state.

Do not extract claims, resolve contradictions, or update the shared model in
this skill. Handoff should name the evidence coverage, known omissions, and
the next bounded extraction, interview, or synthesis action.
