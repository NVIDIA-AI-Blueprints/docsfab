---
name: register-source-thread
description: Register one or more documents, interviews, repository snapshots, observations, tests, or corrections as versioned items in stable provenance lineages. Use when collecting Stage 1 source material before claim extraction or synthesis, especially when one person or source contributes multiple items over time.
license: Apache-2.0 AND CC-BY-4.0
---

# Register Source Thread

Preserve where evidence came from before interpreting what it means. A source
thread is a durable lineage; each artifact, interview, correction, or
observation is a separately attributable item in that lineage.

Read [source-thread-contract.md](references/source-thread-contract.md) before
registering material.

## Establish identity and permissions

For each proposed item, determine:

- The identifiable origin and its existing `source_thread_id`, if any.
- A distinct `item_id`, item type, version, capture time, and scope.
- Author, scoped contributors, collector, custody, consent, citation,
  retention, redistribution, and access boundaries.
- The canonical source location, immutable version identifier, and checksum
  when bytes are available.

Do not copy a source merely because it is readable. Register a link, commit,
or custody record when copying or redistribution is not authorized. Never
store secrets, credentials, or unintended personal data in the registry.

## Reuse the lineage

One person can contribute many interviews, authored documents, corrections,
decisions, and later clarifications to one thread. One repository can
contribute many commit-bound observations or tests to one repository thread.
Do not create a new thread per session or flatten several items into one
current artifact.

For cross-authored material, preserve one stable artifact item and explicit
contributor relations. Do not duplicate the item into every contributor's
thread or imply that every contributor asserted every extracted claim. Add a
relation from a person's thread only when the relationship itself is known.

If the origin is unknown or disputed, use a standalone artifact thread and
mark attribution unverified. Do not attach it to a person based on filename,
seniority, presentation ownership, or inference.

## Register without synthesizing

Create or update canonical `thread.json` and one `items/*.json` envelope per
item, then append the change to `events.jsonl`. Preserve immutable source
evidence or an exact locator. When copying is authorized, retain bytes by
SHA-256 under the thread's `artifacts/` directory. Do not embed binary content
in JSON or duplicate a file whose exact Git commit and path already provide
durable custody.

Record the original, OCR, transcript, conversion, extraction, render,
redaction, participant edit, or summary as distinct representations. Every
derivative names its parent representation and transformation. Use collection
members when one item intentionally registers a bounded artifact corpus.

## Preserve governed visual representations

For every governed visual artifact, retain an exact representation or bind an
exact content-addressed representation. This rule covers diagrams,
architecture views, state machines, timelines, and equivalent rendered
representations. Assign each representation a stable `representation_id` and
a content checksum. A mutable locator, summary, prose description, or list of
decisions is not an exact representation.

The validator recognizes legacy source-item v1 visuals only at the checked
thread, item path, and item-file SHA-256 recorded in its compatibility
manifest. Register every new or changed visual source item with
`docsfab.knowledge.source-item/v2`, and set its
`governed_visual` boolean explicitly. A v2 diagram, image, or presentation must
set it to `true`. Set it for another artifact type when its declared output is
a state machine, timeline, architecture view, or equivalent rendered
representation. Artifact type, visual media type, or a visual fence in
retained Markdown independently identifies a visual, so a generic label or
omitted marker cannot downgrade it to v1. Fence detection recognizes tildes
or three or more backticks with equal or longer closers, plus retained SVG and
PlantUML markers, in one bounded CommonMark pass, including blockquote and
list containers.

Add `visual_metadata` to each governed representation. Record `source` or
`derived` in `provenance_role` independently from `current`, `superseded`, or
`rejected` in `lifecycle_disposition`. A derived visual names every source
representation and transformation used to create it. A superseded or rejected
representation remains inspectable but is not current.

Apply inference per representation. Every representation inferred as visual
must carry `visual_metadata` and governed custody even when another
representation in the item is already valid. A nonvisual participant
confirmation or decision record can remain plain text or Markdown without
visual metadata.

Normalize each media type to its lowercase MIME essence before inference and
ignore parameters. For example, `text/vnd.mermaid; charset=utf-8` is visual,
as are parameterized image, SVG, Graphviz, and PlantUML media types.
Inferred visual media forces `governed_visual: true`; a supplied false flag
cannot suppress per-representation metadata or custody checks.

Retain each governed visual under `artifacts/sha256/`, or use a
`content-addressed` locator whose URI is exactly `sha256:<digest>` or
`urn:sha256:<digest>` and equals the SHA-256 integrity value. The validator
recomputes retained bytes. It rejects HTTPS, external-version, Git, and other
unverified locator-only records even when they carry a claimed checksum.
All canonical JSON objects reject duplicate and unexpected keys at every
closed schema layer.

Registration preserves evidence; it does not make a visual current in a
Product Reference Model. If exact bytes or an exact content address are
unavailable, record the representation gap and leave downstream visual
closure blocked.

For a document used as a proxy for an unavailable contributor's mental model,
mark extracted representation `awaiting-author-confirmation`. The document is
direct evidence of its text, not proof of its author's complete current model
or of product truth.

Do not normalize claims, resolve contradictions, or update the shared model in
this skill. Hand registered items to the relevant extraction, interview, or
synthesis capability.

## Verify and receipt

Before closing:

1. Confirm thread identity is stable and the item ID is unique.
2. Verify the source locator, commit/version, checksum, and access boundary.
3. Confirm prior thread items remain inspectable and unchanged.
4. Record transformations and provenance gaps.
5. For each governed visual, verify exact retained bytes or a checksum-equal
   content address, stable representation ID, content checksum, provenance
   role, and lifecycle disposition.
6. Validate JSON, item indexes, event parents, heads, and representation
   lineage with `scripts/source_thread.py validate`.
7. Render the Markdown view and rerun validation with `--check-view`.
8. Write the registry delta and next extraction or interview action.

Stop on lost provenance, ambiguous authorization, checksum mismatch, or an
attempt to rewrite an earlier item without a superseding record.
