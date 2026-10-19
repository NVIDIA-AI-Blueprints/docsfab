# Source Thread Contract

Use format `docsfab.knowledge.source-thread/v1`. Existing immutable source
items remain `docsfab.knowledge.source-item/v1`. New registrations use
`docsfab.knowledge.source-item/v2`; the v1 schema path is the compatibility
schema for both item versions. The JSON schemas beside this file are
authoritative for thread, item, and event structure.

```text
source-threads/<source-thread-id>/
├── thread.json
├── events.jsonl
├── items/
│   └── <item-id>.json
├── artifacts/
│   └── sha256/<first-two-digest-chars>/<full-digest>
└── views/
    └── thread.md
```

`thread.json`, `items/*.json`, and `events.jsonl` are canonical. Files under
`views/` are deterministic projections. Artifact bytes are retained only when
authorized; otherwise item representations point to immutable Git locations
or governed external versions.

## Thread record

```json
{
  "schema_version": "docsfab.knowledge.source-thread/v1",
  "thread_id": "SRC-PERSON-001",
  "origin": {
    "kind": "person",
    "identity": "person@example.com",
    "identity_state": "verified"
  },
  "created_at": "2026-08-07T00:00:00Z",
  "access": {"classification": "project-private"},
  "item_ids": ["ITEM-001"],
  "relations": [],
  "event_log": "events.jsonl",
  "head_event_ids": ["EVT-002"]
}
```

## Item record

Every item has its own attribution, time, version, scope, governance, lineage,
and evidence state. It also has at least one `representation` or collection
`member`.

```json
{
  "schema_version": "docsfab.knowledge.source-item/v2",
  "item_id": "ITEM-001",
  "thread_id": "SRC-PERSON-001",
  "artifact_type": "diagram",
  "governed_visual": true,
  "title": "Control-plane model",
  "summary": null,
  "attribution": {
    "author": "person@example.com",
    "contributors": [],
    "collector": "agent@example.com"
  },
  "timestamps": {
    "source_created_at": "2026-08-06T23:00:00Z",
    "ingested_at": "2026-08-07T00:00:00Z"
  },
  "version": {"kind": "content-hash", "value": "<sha256>"},
  "scope": {
    "product_version": null,
    "deployment": null,
    "audience": null,
    "model_region": "architecture"
  },
  "representations": [
    {
      "representation_id": "original",
      "role": "original",
      "visual_metadata": {
        "artifact_kind": "diagram",
        "provenance_role": "source",
        "lifecycle_disposition": "current"
      },
      "media_type": "application/vnd.jgraph.mxfile",
      "original_filename": "control-plane.drawio",
      "size_bytes": 12000,
      "locator": {
        "scheme": "thread-artifact",
        "uri": "artifacts/sha256/ab/abcdef...",
        "repository": null,
        "commit": null,
        "path": null,
        "external_version": null,
        "retained_copy": "artifacts/sha256/ab/abcdef..."
      },
      "integrity": {"algorithm": "sha256", "value": "abcdef..."},
      "derived_from": [],
      "transform": null,
      "access_override": null
    }
  ],
  "members": [],
  "governance": {
    "consent": "retained for project use",
    "citation_boundary": "project-private",
    "retention_boundary": "repository history",
    "redistribution_boundary": "project-private",
    "access_classification": "project-private"
  },
  "lineage": {
    "parent_item_ids": [],
    "supersedes": [],
    "related_item_ids": []
  },
  "transforms": [],
  "evidence_state": "source-authored",
  "limitations": []
}
```

For a PDF, DOCX, presentation, image, audio file, video, or diagram, keep the
original as one representation and add extracted, transcribed, rendered,
redacted, or summarized representations separately. Every derivative names
`derived_from` representation IDs and its transform. Never replace the
original with extracted text.

## Governed visual representation custody

Every new governed visual artifact uses source-item v2 and sets
`governed_visual: true`. Its exact retained or content-addressed representation
has a stable `representation_id`, a media type, and a SHA-256 integrity value
for the exact representation bytes. Retain it under `artifacts/sha256/`, or
use `scheme: content-addressed` with a URI exactly equal to
`sha256:<digest>` or `urn:sha256:<digest>`. An ordinary external link, Git
locator, summary, prose closure statement, decision list, or arbitrary
external version label is not representation custody.

Source-item v1 remains valid only for the exact legacy visual item paths and
item-file SHA-256 values in `source_thread.py`. The validator infers a visual
from its artifact type, visual media type, `visual_metadata`, or a Mermaid,
D2, Graphviz, PlantUML, or SVG marker in retained content. A new v1 item, a
changed legacy item, or generic Markdown containing a visual marker must use
v2 and the governed metadata.

The retained-content scan follows CommonMark fences with tildes or three or
more backticks and an equal or longer matching closer. It also recognizes SVG
start tags split across lines and PlantUML markers with LF or CRLF line
endings. The scan is single-pass even for unmatched or adversarial opener
sequences. The pinned CommonMark parser recognizes fences and raw visual
markers inside blockquote and list containers.

The compatibility JSON Schema conditionally requires v2 governed visuals to
contain `visual_metadata`, non-null lowercase SHA-256 integrity, an allowed
retained or content-addressed locator shape, valid provenance and lifecycle
enums, and source or derived lineage. `source_thread.py` additionally rejects
duplicate JSON keys and verifies cross-field path and checksum equality.
It also rejects unexpected keys in thread, item, member, representation,
locator, integrity, transform, governance, event, and visual-metadata objects.

Visual inference applies to each representation. In a v2 governed item, every
representation with visual media, visual metadata, or retained visual content
must carry its own `visual_metadata` and governed custody. A second inferred
visual cannot borrow validity from the first. Nonvisual companion evidence,
such as a participant-confirmation Markdown representation with no visual
body, does not require visual metadata.

MIME inference lowercases the essence and ignores parameters. It recognizes
parameterized image and SVG types plus Mermaid, Graphviz, and PlantUML text or
application types at both item and collection-member levels. The Draft
2020-12 schema applies the same essence rule where media-type inference is
expressible; Python also inspects retained representation content.
Both schema and Python force `governed_visual: true` when any top-level or
member representation has a visual MIME essence. The supplied boolean cannot
disable inference or allow that representation to omit visual metadata.

Each governed representation's `visual_metadata` distinguishes two provenance
roles and three lifecycle dispositions:

- `source` identifies exact source-authored or source-displayed content.
- `derived` identifies a transformation and names its `derived_from` sources.
- `current` identifies the representation selected for the stated source
  scope.
- `superseded` preserves a representation replaced by a later one.
- `rejected` preserves a representation considered and not selected.

Record lifecycle changes append-only in the item lineage and event ledger.
Never relabel a superseded or rejected representation as current by erasing
its earlier state. Source-thread `current` describes the stated source scope;
it does not establish a current or diagram-of-record representation in an
immutable Product Reference Model.

A collection item uses `members`; each member has its own representation
locator and integrity value. This preserves file-level lineage without
creating an anonymous merged source.

## Event ledger

Write exactly one JSON object per line. Existing lines are immutable.

```json
{"schema_version":"docsfab.knowledge.source-event/v1","event_id":"EVT-001","thread_id":"SRC-PERSON-001","sequence":1,"occurred_at":"2026-08-07T00:00:00Z","actor":"agent@example.com","event_type":"thread.created","item_id":null,"parent_event_ids":[],"payload":{}}
{"schema_version":"docsfab.knowledge.source-event/v1","event_id":"EVT-002","thread_id":"SRC-PERSON-001","sequence":2,"occurred_at":"2026-08-07T00:00:01Z","actor":"agent@example.com","event_type":"item.registered","item_id":"ITEM-001","parent_event_ids":["EVT-001"],"payload":{"representation_ids":["original"]}}
```

Append corrections, supersessions, transformations, migrations, and relation
changes as later events. Never edit an earlier event to make history look
cleaner.

## Registry invariants

- Thread and item IDs remain stable.
- The thread item index equals the item JSON records.
- Event IDs and sequence numbers are unique.
- Event parents exist and precede their children.
- Thread heads equal event-ledger leaf nodes.
- An item contains at least one representation or collection member.
- Representation IDs are unique inside an item or member.
- Derived representations name existing parents and a transformation.
- Each governed visual binds exact retained bytes or a checksum-equal content
  address, a stable representation ID, and a content checksum.
- Governed visual records distinguish source, derived, current, superseded,
  and rejected representations without erasing earlier states.
- Original evidence stays inspectable.

Run the deterministic validator and renderer:

```bash
python3 skills/register-source-thread/scripts/source_thread.py validate <thread-dir>
python3 skills/register-source-thread/scripts/source_thread.py render <thread-dir>
python3 skills/register-source-thread/scripts/source_thread.py validate <thread-dir> --check-view
```

## Migration

For a Markdown/YAML source thread, retain its last Git commit as an immutable
locator, create equivalent JSON records, append `format.migrated`, and render
the view. Removing old working-tree manifests is non-erasing only when Git
retains them and the migration event records that boundary.
