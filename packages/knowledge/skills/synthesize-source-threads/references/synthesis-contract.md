# Source-Thread Synthesis Contract

Use repository-authorized paths. A portable default is:

```text
models/shared/<model-id>/
├── history.md
└── <model-version>/
    ├── inconsistency-report.md
    ├── model.md
    └── merge-receipt.md
```

Never overwrite a prior model version or receipt.

## Merge boundary

```yaml
merge_id: <stable ID>
model_id: <stable ID>
model_version: <new version>
prior_model_version: <version or none>
created_at: <UTC timestamp>
model_region: <bounded region>
target_release: <version or unknown>
audience: <audience or unknown>
documentation_targets: []
source_items:
  - source_thread_id: <ID>
    item_id: <ID>
    version: <immutable version>
    representation_id: <ID or none for a collection member>
    member_id: <ID or none>
    integrity: <algorithm:value or governed version>
    thread_head_event_ids: []
source_item_dispositions:
  - item_id: <registered item considered without becoming a source_items input>
    disposition: <included | superseded | excluded | pending>
    rationale: <non-empty evidence-based reason>
governed_visual_targets:
  - visual_id: <stable visual ID>
    target_state: <current | open | deferred>
    conflict_id: <none or stable representation-conflict ID>
    closure_manifest_source:
      source_thread_id: <ID>
      item_id: <ID>
      version: <immutable version>
      representation_id: <ID>
      member_id: <ID or none>
      integrity: <sha256:digest>
    required_source_representations:
      - source_thread_id: <ID>
        item_id: <ID>
        version: <immutable version>
        representation_id: <ID>
        member_id: <ID or none>
        integrity: <sha256:digest>
    accepted_decision_ids: [<decision ID>]
reviewers: []
approval_state: <candidate | representation-reviewed | behavior-supported | intent-approved | release-approved>
```

Every `source_items` entry has the implicit disposition `included`. Use
`source_item_dispositions` only for a registered item that was considered but
is not an input to that merge. A comment, prose mention, evidence quotation,
or arbitrary YAML field is not a disposition. Across immutable model history,
every registered item must have one of these structured dispositions.

## Claim decision record

```yaml
claim_id: <stable shared-model claim ID>
source_claims: []
relationship: <compatible | behavior-conflict | intent-conflict | terminology-conflict | scope-conflict | version-conflict | representation-conflict | documentation-quality-conflict | unknown>
action: <included | added | superseded | excluded | rescoped | variant | unresolved>
statement: <normalized atomic statement or explicit unresolved variants>
scope: {}
exact_evidence: []
agent_inferences: []
behavior_verification: <not-checked | supported | contradicted | inconclusive | not-applicable>
representation_state: <unreviewed | confirmed | corrected | disputed | not-applicable>
intent_approval: <not-requested | approved | rejected | participant-not-authorized | not-applicable>
model_state: <candidate | disputed | unresolved | superseded | approved>
decision_basis: <evidence and authority, not vote count>
resolution_owner: <identity/role or none>
blocks_targets: []
unblocks_targets: []
```

## Inconsistency record

Create `inconsistency-report.md` for every synthesis run. If the comparison
finds no inconsistencies, state that explicitly and preserve the comparison
boundary. Otherwise, create one record per inconsistency:

```yaml
conflict_id: <stable ID retained across model versions>
status: <open | resolved | deferred>
classification: <behavior-conflict | intent-conflict | terminology-conflict | scope-conflict | version-conflict | representation-conflict | documentation-quality-conflict | unknown>
summary: <the precise inconsistency>
source_variants:
  - source_claim_ids: []
    statement: <atomic claim>
    scope: {}
    exact_evidence: []
why_inconsistent: <why both claims cannot be canonical in the same scope, or what remains unknown>
consequence_if_unresolved: <model or documentation effect>
resolution_owner: <identity/role>
blocks_targets: []
adjudication:
  adjudicator: <identity/role or none>
  authority_basis: <why this actor may decide, or none>
  decided_at: <UTC timestamp or none>
  disposition: <accept-variant | supersede-variant | rescope | retain-variants | defer | none>
  rationale: <explicit rationale or none>
  decision_evidence: []
  resulting_claim_ids: []
```

An adjudication is not a vote. Behavior requires version-bound evidence;
intent requires accountable intent authority; representation requires the
represented source or person; documentation quality requires named criteria
and a review owner. Record rejected proposals and superseded variants rather
than deleting them.

Never reopen and edit a previously issued model version in place. A later
adjudication creates a new version and receipt, carries the same `conflict_id`,
and records the state transition. The candidate model may preserve open
variants, but an open conflict cannot be presented as settled canonical truth.

## Governed visual closure record

A diagram, architecture view, state machine, timeline, or equivalent governed
visual is not closed, current, or of record until the new immutable
`model.md` contains its direct post-adjudication representation. For Mermaid,
the direct representation is the exact final Mermaid content in that model
version. A source-thread artifact, ordinary external link, summary, prose
closure statement, or list of resolved decisions cannot substitute for it.

Every model version from v0.29 onward declares
`governed_visual_targets` in its merge boundary. A `current` target names its
independent retained `closure_manifest_source`, required source-representation
set, and accepted-decision set. An `open` or `deferred` target names the
matching representation conflict.

The closure manifest is retained source-thread JSON with this exact shape:

```json
{
  "schema_version": "docsfab.knowledge.visual-closure-manifest/v1",
  "visual_id": "<stable visual ID>",
  "required_source_representations": [
    {
      "source_thread_id": "<ID>",
      "item_id": "<ID>",
      "version": "<immutable version>",
      "representation_id": "<ID>",
      "member_id": "<ID or none>",
      "integrity": "sha256:<lowercase digest>"
    }
  ],
  "accepted_decision_ids": ["<CLM-ID>"]
}
```

The manifest representation itself is an exact `source_items` entry in the
merge boundary and uses retained `thread-artifact` bytes. Each accepted
decision ID resolves exactly once to a claim record across immutable model
history. Deleting the same ID from the target, closure, and coverage cannot
change the retained manifest or the real claim set.

A current representation uses this exact adjacent block shape:

````markdown
### <visual-id>: <title>

```yaml visual-closure
visual_id: <same stable visual ID>
artifact_kind: <diagram | architecture-view | state-machine | timeline | rendered-representation>
lifecycle_disposition: current
representation_id: <stable representation ID>
representation_format: <mermaid | d2 | dot | plantuml | svg>
content_sha256: sha256:<lowercase digest>
source_representations:
  - source_thread_id: <ID>
    item_id: <ID>
    version: <immutable version>
    representation_id: <ID>
    member_id: <ID or none>
    integrity: sha256:<lowercase digest>
governing_decision_ids: [<decision ID>]
decision_coverage:
  verification_state: verified
  verifier: <identity or named validator>
  method: <non-empty method>
  accepted_decisions:
    - decision_id: <ID>
      representation_elements: [<stable node, edge, state, or region reference>]
```

```mermaid
<exact direct representation bytes>
```
````

The `content_sha256` byte boundary starts immediately after the LF or CRLF
that ends the opening representation-fence line. It includes all content bytes
and the final LF or CRLF immediately before the closing fence. It excludes
both fence lines. Hash these exact bytes as UTF-8 without newline
normalization.

The closure record's sources and governing decisions must equal the
retained closure manifest and its merge-boundary target projection, not merely
be subsets. Each source tuple must also equal one `source_items` entry in the
merge boundary. Decision coverage must map every accepted decision exactly
once to one or more stable representation elements. For
`artifact_kind: diagram`, the format and direct fence must be `mermaid`.

The production Mermaid gate supports governed `flowchart` and `graph`
representations with directions `TB`, `TD`, `BT`, `RL`, or `LR`. It accepts
the D1–D8 and D6A constructs: balanced subgraphs, subgraph directions,
balanced quoted node shapes, chained edges, labeled edges, dotted links,
bidirectional links, and invisible `~~~` links. It requires at least one
complete edge and rejects prose, dangling endpoints, unbalanced delimiters or
quotes, unmatched subgraphs, unknown statements, and unsupported Mermaid
families. An unsupported diagram remains an open representation conflict or
uses another supported exact rendered format; a fence label and checksum are
not syntax evidence.

The parser consumes every token in each node-edge chain and validates every
nonempty semicolon-separated statement. Empty separators and a trailing
semicolon are permitted. The supported `style` form names one or more node IDs
and one or more comma-separated `property:value` pairs. Malformed `style`,
`classDef`, `class`, `linkStyle`, `click`, trailing garbage after a valid edge,
and prose after a semicolon are rejected.

The model has exactly one `## Governed Visuals` section when any target is
current. Every H3 visual heading, `yaml visual-closure` metadata block, and
direct representation fence in that section has a one-to-one match. Reject
missing markers, malformed or duplicate blocks, duplicate headings, blocks
outside the section, and undeclared visual IDs. Enumerate all CommonMark
fences in one pass, including tildes and backtick markers of any valid length.
Each target uses exactly one three-backtick metadata fence followed by one
three-backtick direct fence; any additional or longer-marker fence is rogue.
The union of the 2-fence sets associated with each H3 must equal the full
CommonMark fence set in the section. A fence between `## Governed Visuals` and
the first H3 is therefore rejected rather than left unowned.

Parse all semantic Markdown records through one pinned MarkdownIt token index.
The merge-boundary YAML, `CLM-*` H3 and YAML pairs, `CONFLICT-*` H2 and YAML
pairs, governed visual H3 and fence pairs, and receipt section 14 are
top-level tokens. Identical-looking text inside an outer fence, blockquote,
list, or example is not a semantic record. Direct representation checksums
still use the exact original byte slice between the indexed opening and
closing fence lines.

The model and merge receipt preserve `source`, `derived`, `superseded`,
`rejected`, and `current` distinctions. Superseded and rejected representations
remain in immutable history and cannot be current. If any direct content,
identifier, checksum, source reference, decision reference, or verified
decision coverage is missing, keep an `open` or `deferred`
`representation-conflict`. Its `blocks_targets` contains only the governed
visual target. Semantic adjudication by itself cannot close the representation
conflict.

Open and deferred representation conflicts are bidirectional: every such
conflict blocks exactly one declared visual target, and that target names the
same conflict and state. A current target cannot coexist with an open or
deferred representation conflict that blocks it.

Run the named validator before issuing the model version:

```bash
python3 packages/knowledge/skills/synthesize-source-threads/scripts/validate_visual_closure.py \
  <model-version>/model.md \
  <model-version>/inconsistency-report.md \
  <model-version>/merge-receipt.md \
  .docsfab/reference-model/source-threads \
  .docsfab/reference-model/shared/DOCSFAB-PRODUCT
```

## Required merge-receipt sections

1. Boundary and prior version.
2. Exact source thread heads, item versions, representations or collection
   members, integrity values, and claim versions considered.
3. Included and added claims.
4. Superseded and excluded claims with reasons.
5. Rescoped and variant claims.
6. Unresolved conflicts and routing owners.
7. Behavior evidence and accountable intent decisions used.
8. Agent inferences introduced during synthesis.
9. Documentation targets blocked or unblocked.
10. Reviewer and approval states, including evidence independence.
11. Exact delta to the prior model.
12. Failures, manual interventions, and remaining acquisition work.
13. Inconsistency-report path, conflict IDs, status transitions, and resulting
    claim IDs.
14. One `yaml visual-closure-receipt` block using schema
    `docsfab.knowledge.visual-closure-receipt/v1`. It contains exactly one
    record per declared target:

    ```yaml
    schema_version: docsfab.knowledge.visual-closure-receipt/v1
    visual_closures:
      - visual_id: <ID>
        target_state: <current | open | deferred>
        conflict_id: <ID or none>
        closure_manifest_source:
          source_thread_id: <ID>
          item_id: <ID>
          version: <immutable version>
          representation_id: <ID>
          member_id: <ID or none>
          integrity: sha256:<lowercase digest>
        representation_id: <ID or none when blocked>
        content_sha256: <sha256:digest or none when blocked>
        source_representations:
          - source_thread_id: <ID>
            item_id: <ID>
            version: <immutable version>
            representation_id: <ID>
            member_id: <ID or none>
            integrity: sha256:<lowercase digest>
        governing_decision_ids: [<CLM-ID>]
        coverage_verification:
          verification_state: <verified | blocked>
          verification_result: <verified | blocked>
          verifier: <identity or none>
          method: <method or none>
    ```

    A current receipt record exactly matches its model target and closure
    record. An open or deferred record exactly matches its target and conflict,
    uses `none` for representation ID and checksum, and records blocked
    coverage. Prose such as "No governed visual targets" is not a receipt.

## Native versions

The product-feedback materializer writes native model versions. A native
`model.md` starts with the `docsfab-product-feedback-model:v1` marker and holds
a JSON envelope instead of a merge boundary; its parent chain ends at a
legacy version. Each native version still has its own
`inconsistency-report.md` and `merge-receipt.md`, a `history.md` row, and one
registered source item, so the freshness checker accounts for it like any
other version.

The materializer generates receipt sections 1 through 13 from the recipe, the
approved parent, and the registered decision. Section 13 names the report and
every conflict ID it records. A version that records a consistent input states
that no inconsistencies were found and records no conflict. A native version
changes no governed visual, so section 14 carries the legacy ancestor's
`yaml visual-closure-receipt` block byte for byte, or states that the ancestor
has none. The visual-closure validator is not run for a native version; the
freshness checker verifies that the carried block equals the ancestor's.

## Interaction direction

When an interaction becomes evidence, retain:

```yaml
event_id: <stable ID>
actor: <participant | interviewer | agent | reviewer | system>
direction: <actor-to-recipient>
interaction_kind: <question | answer | addition | correction | challenge | request | approval | refusal | observation | other>
sequence: <ordered value>
exact_content: <verbatim, participant-edited, or labeled paraphrase>
related_claim_ids: []
```

If a backend cannot represent the event faithfully, preserve the append-only
record, record the schema gap, and stop before creating a misattributed event.
