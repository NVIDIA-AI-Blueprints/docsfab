# Documentation Convergence Contract

## Purpose

A convergence cycle aligns five versioned surfaces:

1. registered source evidence;
2. the canonical product reference model;
3. reader-facing documentation projections;
4. readiness and blocked-target records; and
5. deterministic and independent-review evidence.

The cycle is complete only when the receipt states what was compared, what
changed, what was checked, and what remains blocked.

## Governed Visual Completion Gate

A convergence cycle cannot mark a governed visual artifact closed, current,
or of record until its post-adjudication representation exists directly in the
new immutable Product Reference Model. This applies to diagrams, architecture
views, state machines, timelines, and equivalent rendered representations.

The representation-completeness review requires a stable visual identifier, a
content checksum for the exact representation bytes, exact source-
representation references, exact governing-decision references, and a
decision-coverage verification record for every accepted decision. The
closure record must equal the required-source and accepted-decision sets in a
digest-bound, retained source-thread closure manifest and its merge-boundary
target projection. Each accepted decision ID resolves exactly once to a real
claim across immutable model history. The cycle and receipt preserve source,
derived, superseded, rejected, and current
representations as distinct states. Superseded and rejected representations
remain inspectable and cannot be current.

A source-thread artifact, external link, summary, prose closure statement, or
list of resolved decisions cannot replace the direct representation. If that
representation is missing or intentionally omitted, semantic resolution does
not close it. Keep an open or deferred `representation-conflict` that blocks
only the governed visual target.

For v0.29 and later, `check_freshness.py` invokes
`validate_visual_closure.py`. That named validator enforces the declared
target and closure-record structure, the exact fenced-content checksum, exact
source and decision set equality, one coverage entry per accepted decision,
bidirectional open/deferred conflict state, and the exact machine-readable
section 14 receipt. It enumerates all governed visual headings, metadata
blocks, and representation fences before semantic validation. It does not
accept a Mermaid fence label and checksum without valid governed-flowchart
syntax. It does not establish that the named representation elements
semantically encode a decision. Independent review remains required for that
claim; policy-text matching and structural validation are insufficient.

Freshness and visual closure share the same pinned MarkdownIt top-level token
index for merge boundaries, claims, conflicts, visual records, and section 14.
Nested example text cannot supply any of those records. Exact direct visual
bytes remain sliced from the indexed source Markdown without normalization.

## Freshness States

| State | Meaning |
| --- | --- |
| `fresh` | The current source-thread heads, registered-item coverage, model pointer, watched repository inputs, documentation bytes, checks, and review match the receipt. |
| `stale` | Valid evidence changed after the receipt, a registered source item lacks an explicit model-history reference, or the recorded `git_revision` is absent from the clone while `content_sha256` and `git_tree` remain schema-valid. |
| `blocked` | Required checks or independent review are incomplete. |
| error | Evidence or configuration is malformed. The command stops. |

Advisory mode returns success for the first three states and prints the full
report. Strict mode returns failure for `stale` or `blocked`. Errors return a
distinct failure in both modes.

## Receipt Schema

The receipt uses schema
`docsfab.knowledge.documentation-freshness/v4` and contains:

- the product model ID and version;
- the exact Git revision and tree recorded at snapshot time;
- every source-thread head event ID;
- SHA-256 digests for canonical source-thread records and retained artifacts;
- SHA-256 digests for immutable model history and the current model package;
- watched repository paths and their combined content digest;
- the Fern navigation file, every navigation Markdown page, the root README,
  and their SHA-256 digests;
- named checks with passed, pending, or failed states and evidence strings;
- a non-author review with its state, tracked evidence path and SHA-256,
  reviewed commit and tree, and exact finalization paths;
- target readiness, blocked targets, and known evidence gaps.

The watched repository digest includes tracked and untracked regular files
under the configured paths and records missing tracked files. Symbolic links
in repository, documentation, source, or model inputs are errors: the checker
does not follow an input outside the declared boundary. The active freshness
receipt is the only permitted repository-digest exclusion, including when a
custom watch boundary contains the repository root. This avoids a
self-referential hash without allowing a receipt to narrow its own assertion.

Snapshot creation computes the watched digest twice: from the working tree and
from the recorded commit's Git blobs. The values must match. A passed review
must be a tracked Markdown report under
`.docsfab/reference-model/assessments/`, contain an explicit PASS verdict, and
name the exact reviewed commit and tree. The reviewed commit must be an
ancestor of the snapshot commit, and the only permitted finalization delta is
the retained review report itself. Pending or failed review states remain
unbound and therefore keep freshness blocked.

Review authority is read from a CommonMark token stream, not from raw prose
regular expressions. The report must contain one top-level ATX `## Verdict`,
followed immediately by one strongly emphasized `PASS`, plus exactly two
distinct top-level bullet-list items. The first direct paragraph of one item
must declare the reviewed commit, and the first direct paragraph of the other
must declare its tree. Continuation paragraphs, later blocks in the same item,
fenced code, indented code, HTML blocks, blockquotes, and nested illustrative
structures do not supply authority. Rendered duplicates or contradictory
verdicts reject the report.

## Deterministic Guarantees

The checker can establish that:

- source-thread heads have not moved;
- canonical source-thread registries, events, items, and retained artifact
  hashes satisfy the source-thread contract and have not changed;
- every registered item ID has a structured disposition in at least one
  immutable `model.md` merge boundary;
- every structured source input names the registered thread and exact item
  version, selects either one item-level representation or one collection
  member, matches that exact selection's integrity, and cites the complete
  source-thread head set at the merge boundary timestamp;
- for v0.29 and later, every declared current governed visual has a direct
  closure record whose exact fenced bytes match its checksum, whose sources
  and accepted decisions equal a retained closure manifest, whose claim IDs
  resolve exactly once, and whose coverage record maps every accepted decision
  exactly once;
- governed Mermaid representations satisfy the fail-closed flowchart syntax
  subset used by D1–D8 and D6A rather than only carrying a Mermaid fence label;
- section 14 contains one machine-readable visual receipt record per target,
  exactly matching current closures or open/deferred representation conflicts;
- the reference-model index points to the receipt's version;
- every complete YAML block parses without duplicate keys, aliases, anchors,
  tags, comments, ignored siblings, or unsupported fields, and current model
  decision records use the declared synthesis vocabulary;
- every history entry has exactly the required immutable package files and a
  version-appropriate valid structure. The compatibility schema preserves the
  explicitly enumerated v0.3 source-reference forms and v0.5 and v0.6 decision
  vocabulary without applying them to other versions;
- immutable model history and the selected model package have not changed;
- watched repository inputs have the same content bytes;
- configured documentation pages have the same content bytes;
- the watched digest matches both current bytes and the recorded Git
  revision/tree; and
- a passed independent review is retained, byte-bound, target-bound, and
  separated from its reviewed commit by at most its own report path.

It cannot establish semantic correctness, whether named representation
elements actually encode their mapped decisions, complete product intent,
representative-reader success, publication, deployment, or release approval.
The recorded Git revision and tree identify the watched snapshot boundary.
The checker proves commit existence when the object is in the clone, then
commit/tree identity, watched-byte equality, review ancestry, and the bounded
review-finalization delta. If `repository_snapshot.git_revision` cannot be
resolved (for example a squash-orphaned SHA) while `content_sha256` and
`git_tree` are present and schema-valid, the checker records `stale` with
code `receipt-revision-unresolvable` and still compares surviving watched
bytes to `content_sha256`. That case is not an error. Corrupt JSON or
schema remains an error in both advisory and strict modes. The checker does
not claim that the revision is a particular remote branch head.

## Default Watch Boundary

DocsFab watches product behavior and planning under:

- `packages/`;
- `planning/`;
- `governance/`;
- `deploy/`;
- `.gitlab-ci.yml`;
- `.gitlab/ci/knowledge.yml`;
- `.docsfab/reference-model/assessments/`;
- `GOVERNANCE.md`.

Documentation bytes come from root `README.md` and every Markdown path listed
in `fern/docs.yml`. Source-thread and model state are checked separately.
The top-level merge-request workflow and package-owned freshness job both
cover these families. The job definition is itself watched, so changing its
rules, dependency bootstrap, checker invocation, mode, or retained artifact
causes repository drift. Repository-path regressions prevent a watched
`packages/` subtree or the job definition from falling outside the receipt.

Source-thread head validation is temporal. For each merge boundary, the
checker first proves that the selected item's registration event is active at
`created_at`, then derives the complete event-graph frontier at that timestamp
and requires the source record to cite that exact set—no missing, extra,
future, or already-superseded event. A valid frontier may include an
older-sequence sibling branch; sequence alone does not define staleness. A
source record with `member_id: none` binds only to an item-level
representation. Any other current record selects exactly one member and binds
only to that member's representation and integrity. The immutable v0.3
package predates those shapes and has two exact, ID-bound compatibility
records; the exception cannot authorize a new version, item, or selection.

Projects that package this skill can replace the watch boundary in the
receipt. A narrower boundary must be justified because omitted inputs can
create false freshness.

An item listed in a merge boundary's `source_items` is explicitly `included`.
An item that was considered without becoming an input uses the optional
structured `source_item_dispositions` list with `item_id`, one of `included`,
`superseded`, `excluded`, or `pending`, and a non-empty `rationale`. Comments,
prose, evidence quotations, and arbitrary YAML fields never count as item
accounting.

The default retained receipt is
`.docsfab/reference-model/freshness.json`. Alternate receipts must remain
under `.docsfab/reference-model/receipts/`. Generated reports must remain
under the ignored `.docsfab/reports/` namespace. The checker rejects tracked
report targets, symbolic-link escapes, control characters, and manifest or
report locations outside those namespaces so its output cannot overwrite
product, documentation, or canonical evidence.

## CI Policy

CI runs advisory checks and retains
`.docsfab/reports/documentation-freshness-report.json`, including an error
report when the receipt is missing or malformed. An unresolvable recorded
revision with a valid `content_sha256` and `git_tree` is advisory `stale`
(`receipt-revision-unresolvable`), not a malformed-receipt error. Teams can set
`DOCSFAB_FRESHNESS_STRICT=1` for an explicitly gated workflow after validating
its trigger precision. Relevant merge requests, default-branch changes, and
scheduled pipelines all run the check, so the JSON result becomes a durable CI
handoff signal for the next agentic cycle. CI must never auto-rewrite a source
thread, model, or documentation page to make the check pass.
