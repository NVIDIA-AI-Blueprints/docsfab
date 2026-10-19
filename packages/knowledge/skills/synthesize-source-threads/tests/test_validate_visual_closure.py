# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
from __future__ import annotations

import hashlib
import importlib.util
import json
import re
import tempfile
import unittest
from pathlib import Path


SCRIPT = Path(__file__).resolve().parents[1] / "scripts/validate_visual_closure.py"
REPOSITORY_ROOT = Path(__file__).resolve().parents[5]
SPEC = importlib.util.spec_from_file_location("validate_visual_closure", SCRIPT)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError(f"Unable to load visual closure validator: {SCRIPT}")
visual_closure = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(visual_closure)


def live_model_skip_reason(root: Path) -> str | None:
    """Skip only when the whole live model is absent, as in the exported tree; a partial model still runs and fails."""
    if (root / ".docsfab/reference-model").is_dir():
        return None
    return "live repository model .docsfab/reference-model is absent from this tree"


LIVE_SKIP = live_model_skip_reason(REPOSITORY_ROOT)

SOURCE_BYTES = b"flowchart LR\n  SOURCE --> MODEL\n"
SOURCE_DIGEST = hashlib.sha256(SOURCE_BYTES).hexdigest()
DIRECT_CONTENT = "flowchart LR\n  A --> B\n"
DIRECT_DIGEST = hashlib.sha256(DIRECT_CONTENT.encode("utf-8")).hexdigest()
SOURCE_REFERENCE = {
    "source_thread_id": "SRC-ONE",
    "item_id": "ITEM-ONE",
    "version": f"sha256:{SOURCE_DIGEST}",
    "representation_id": "source-diagram",
    "member_id": "none",
    "integrity": f"sha256:{SOURCE_DIGEST}",
}
CLOSURE_MANIFEST = {
    "schema_version": "docsfab.knowledge.visual-closure-manifest/v1",
    "visual_id": "VISUAL-ONE",
    "required_source_representations": [SOURCE_REFERENCE],
    "accepted_decision_ids": ["CLM-ONE", "CLM-TWO"],
}
CLOSURE_MANIFEST_BYTES = (
    json.dumps(CLOSURE_MANIFEST, indent=2, sort_keys=True) + "\n"
).encode("utf-8")
MANIFEST_DIGEST = hashlib.sha256(CLOSURE_MANIFEST_BYTES).hexdigest()
MANIFEST_REFERENCE = {
    "source_thread_id": "SRC-ONE",
    "item_id": "ITEM-MANIFEST",
    "version": f"sha256:{MANIFEST_DIGEST}",
    "representation_id": "visual-closure-manifest",
    "member_id": "none",
    "integrity": f"sha256:{MANIFEST_DIGEST}",
}


def source_yaml(reference: dict[str, str], indent: str) -> str:
    return "".join(f"{indent}{field}: {reference[field]}\n" for field in (
        "source_thread_id",
        "item_id",
        "version",
        "representation_id",
        "member_id",
        "integrity",
    ))


def current_model() -> str:
    return f"""# Model

```yaml
merge_id: MERGE-ONE
model_id: MODEL-ONE
model_version: v0.29
prior_model_version: v0.28
created_at: 2026-09-08T00:00:00Z
model_region: fixture
target_release: fixture
audience: fixture
documentation_targets: [docs/fixture.md]
source_items:
  - source_thread_id: SRC-ONE
    item_id: ITEM-ONE
    version: sha256:{SOURCE_DIGEST}
    representation_id: source-diagram
    member_id: none
    integrity: sha256:{SOURCE_DIGEST}
    thread_head_event_ids: [EVT-ONE]
  - source_thread_id: SRC-ONE
    item_id: ITEM-MANIFEST
    version: sha256:{MANIFEST_DIGEST}
    representation_id: visual-closure-manifest
    member_id: none
    integrity: sha256:{MANIFEST_DIGEST}
    thread_head_event_ids: [EVT-ONE]
governed_visual_targets:
  - visual_id: VISUAL-ONE
    target_state: current
    conflict_id: none
    closure_manifest_source:
{source_yaml(MANIFEST_REFERENCE, '      ')}    required_source_representations:
      - source_thread_id: SRC-ONE
        item_id: ITEM-ONE
        version: sha256:{SOURCE_DIGEST}
        representation_id: source-diagram
        member_id: none
        integrity: sha256:{SOURCE_DIGEST}
    accepted_decision_ids: [CLM-ONE, CLM-TWO]
reviewers: []
approval_state: candidate
```

## Claim Decisions

### CLM-ONE: First Decision

```yaml
claim_id: CLM-ONE
source_claims: [SOURCE-CLAIM-ONE]
relationship: compatible
action: included
statement: First fixture decision.
scope: {{product: fixture}}
exact_evidence: [fixture evidence one]
agent_inferences: []
behavior_verification: not-applicable
representation_state: confirmed
intent_approval: approved
model_state: approved
decision_basis: Fixture adjudication one.
resolution_owner: Fixture owner
blocks_targets: []
unblocks_targets: [VISUAL-ONE]
```

### CLM-TWO: Second Decision

```yaml
claim_id: CLM-TWO
source_claims: [SOURCE-CLAIM-TWO]
relationship: compatible
action: included
statement: Second fixture decision.
scope: {{product: fixture}}
exact_evidence: [fixture evidence two]
agent_inferences: []
behavior_verification: not-applicable
representation_state: confirmed
intent_approval: approved
model_state: approved
decision_basis: Fixture adjudication two.
resolution_owner: Fixture owner
blocks_targets: []
unblocks_targets: [VISUAL-ONE]
```

## Governed Visuals

### VISUAL-ONE: Fixture Architecture

```yaml visual-closure
visual_id: VISUAL-ONE
artifact_kind: architecture-view
lifecycle_disposition: current
representation_id: visual-one-mermaid
representation_format: mermaid
content_sha256: sha256:{DIRECT_DIGEST}
source_representations:
  - source_thread_id: SRC-ONE
    item_id: ITEM-ONE
    version: sha256:{SOURCE_DIGEST}
    representation_id: source-diagram
    member_id: none
    integrity: sha256:{SOURCE_DIGEST}
governing_decision_ids: [CLM-ONE, CLM-TWO]
decision_coverage:
  verification_state: verified
  verifier: fixture-reviewer
  method: Compared every accepted decision with named Mermaid elements.
  accepted_decisions:
    - decision_id: CLM-ONE
      representation_elements: [node:A, node:B, edge:A--B]
    - decision_id: CLM-TWO
      representation_elements: [edge:A--B]
```

```mermaid
{DIRECT_CONTENT.rstrip(chr(10))}
```
"""


def current_receipt() -> str:
    return f"""# Merge Receipt

## 14. Governed Visual Closure

```yaml visual-closure-receipt
schema_version: docsfab.knowledge.visual-closure-receipt/v1
visual_closures:
  - visual_id: VISUAL-ONE
    target_state: current
    conflict_id: none
    closure_manifest_source:
{source_yaml(MANIFEST_REFERENCE, '      ')}    representation_id: visual-one-mermaid
    content_sha256: sha256:{DIRECT_DIGEST}
    source_representations:
      - source_thread_id: SRC-ONE
        item_id: ITEM-ONE
        version: sha256:{SOURCE_DIGEST}
        representation_id: source-diagram
        member_id: none
        integrity: sha256:{SOURCE_DIGEST}
    governing_decision_ids: [CLM-ONE, CLM-TWO]
    coverage_verification:
      verification_state: verified
      verification_result: verified
      verifier: fixture-reviewer
      method: Compared every accepted decision with named Mermaid elements.
```
"""


def open_model() -> str:
    model = current_model()
    model = model.replace("target_state: current", "target_state: open", 1)
    model = model.replace("conflict_id: none", "conflict_id: CONFLICT-VISUAL-ONE", 1)
    return model[: model.index("## Governed Visuals")]


def open_receipt() -> str:
    receipt = current_receipt()
    receipt = receipt.replace("target_state: current", "target_state: open", 1)
    receipt = receipt.replace("conflict_id: none", "conflict_id: CONFLICT-VISUAL-ONE", 1)
    receipt = receipt.replace("representation_id: visual-one-mermaid", "representation_id: none", 1)
    receipt = receipt.replace(f"content_sha256: sha256:{DIRECT_DIGEST}", "content_sha256: none", 1)
    receipt = receipt.replace(
        "verification_state: verified\n"
        "      verification_result: verified\n"
        "      verifier: fixture-reviewer\n"
        "      method: Compared every accepted decision with named Mermaid elements.",
        "verification_state: blocked\n"
        "      verification_result: blocked\n"
        "      verifier: none\n"
        "      method: none",
        1,
    )
    return receipt


def open_report() -> str:
    return """# Inconsistency Report

## CONFLICT-VISUAL-ONE: Missing Direct Representation

```yaml
conflict_id: CONFLICT-VISUAL-ONE
status: open
classification: representation-conflict
summary: The final bytes are missing.
source_variants:
  - source_claim_ids: [CLM-ONE, CLM-TWO]
    statement: The decisions are accepted without a final visual.
    scope: {target: VISUAL-ONE}
    exact_evidence: [ITEM-ONE]
why_inconsistent: Semantic closure is not representation closure.
consequence_if_unresolved: VISUAL-ONE remains blocked.
resolution_owner: fixture-owner
blocks_targets: [VISUAL-ONE]
adjudication:
  adjudicator: none
  authority_basis: none
  decided_at: none
  disposition: none
  rationale: none
  decision_evidence: []
  resulting_claim_ids: []
```
"""


def replace_closure(model: str, before: str, after: str) -> str:
    prefix, marker, closure = model.partition("```yaml visual-closure")
    if not marker or before not in closure:
        raise AssertionError(f"closure fixture does not contain {before!r}")
    return prefix + marker + closure.replace(before, after, 1)


def replace_target(model: str, before: str, after: str) -> str:
    boundary, marker, remainder = model.partition("```yaml visual-closure")
    if not marker or before not in boundary:
        raise AssertionError(f"target fixture does not contain {before!r}")
    return boundary.replace(before, after, 1) + marker + remainder


def replace_direct_content(content: str) -> tuple[str, str]:
    digest = hashlib.sha256(content.encode("utf-8")).hexdigest()
    model = current_model().replace(
        f"content_sha256: sha256:{DIRECT_DIGEST}",
        f"content_sha256: sha256:{digest}",
    )
    model = model.replace(DIRECT_CONTENT, content, 1)
    receipt = current_receipt().replace(
        f"content_sha256: sha256:{DIRECT_DIGEST}",
        f"content_sha256: sha256:{digest}",
    )
    return model, receipt


class VisualClosureTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary_directory = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary_directory.name)
        self.model_history_root = self.root / "shared" / "MODEL-ONE"
        self.version_root = self.model_history_root / "v0.29"
        self.version_root.mkdir(parents=True)
        self.model_path = self.version_root / "model.md"
        self.report_path = self.version_root / "inconsistency-report.md"
        self.receipt_path = self.version_root / "merge-receipt.md"
        self.source_threads_root = self.root / "source-threads"
        thread_root = self.source_threads_root / "SRC-ONE"
        item_root = thread_root / "items"
        artifact_root = thread_root / "artifacts" / "sha256"
        item_root.mkdir(parents=True)
        source_relative = f"artifacts/sha256/{SOURCE_DIGEST[:2]}/{SOURCE_DIGEST}"
        manifest_relative = f"artifacts/sha256/{MANIFEST_DIGEST[:2]}/{MANIFEST_DIGEST}"
        for relative, content in (
            (source_relative, SOURCE_BYTES),
            (manifest_relative, CLOSURE_MANIFEST_BYTES),
        ):
            path = thread_root / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(content)
        self._write_item("ITEM-ONE", "source-diagram", SOURCE_DIGEST, source_relative)
        self._write_item(
            "ITEM-MANIFEST",
            "visual-closure-manifest",
            MANIFEST_DIGEST,
            manifest_relative,
        )
        self.report_path.write_text("# Report\n\nNo inconsistencies.\n", encoding="utf-8")
        self.receipt_path.write_text(current_receipt(), encoding="utf-8")

    def tearDown(self) -> None:
        self.temporary_directory.cleanup()

    def _write_item(
        self, item_id: str, representation_id: str, digest: str, retained: str
    ) -> None:
        item = {
            "item_id": item_id,
            "version": {"kind": "content-hash", "value": digest},
            "representations": [
                {
                    "representation_id": representation_id,
                    "locator": {"retained_copy": retained},
                    "integrity": {"algorithm": "sha256", "value": digest},
                }
            ],
            "members": [],
        }
        path = self.source_threads_root / "SRC-ONE" / "items" / f"{item_id}.json"
        path.write_text(json.dumps(item), encoding="utf-8")

    def validate(self, model: str, receipt: str | None = None) -> list[dict]:
        self.model_path.write_bytes(model.encode("utf-8"))
        self.receipt_path.write_text(receipt or current_receipt(), encoding="utf-8")
        return visual_closure.validate_visual_closure(
            self.model_path,
            self.report_path,
            self.receipt_path,
            self.source_threads_root,
            self.model_history_root,
        )

    def assert_invalid(
        self, model: str, message: str, *, receipt: str | None = None
    ) -> None:
        with self.assertRaises(visual_closure.VisualClosureError) as raised:
            self.validate(model, receipt)
        self.assertIn(message, str(raised.exception))

    def test_accepts_direct_checksum_bound_complete_current_visual(self) -> None:
        records = self.validate(current_model())
        self.assertEqual([record["visual_id"] for record in records], ["VISUAL-ONE"])

    def test_ignores_semantic_record_decoys_nested_in_outer_fences(self) -> None:
        merge_decoy = (
            "````text\n```yaml\nmerge_id: DECOY\nmodel_version: v999.0\n```\n````\n\n"
        )
        records = self.validate(merge_decoy + current_model())
        self.assertEqual(records[0]["visual_id"], "VISUAL-ONE")

        conflict_decoy = (
            "````text\n## CONFLICT-DECOY: Nested\n\n```yaml\n"
            "conflict_id: CONFLICT-DECOY\nstatus: open\n"
            "classification: representation-conflict\n"
            "blocks_targets: [VISUAL-ONE]\n```\n````\n\n"
        )
        self.report_path.write_text(
            conflict_decoy + open_report(), encoding="utf-8"
        )
        self.assertEqual(self.validate(open_model(), open_receipt()), [])

        self.report_path.write_text("# Report\n\nNo inconsistencies.\n", encoding="utf-8")
        receipt_decoy = (
            "````text\n## 14. Governed Visual Closure\n\n"
            "```yaml visual-closure-receipt\n"
            "schema_version: decoy\nvisual_closures: []\n```\n````\n\n"
        )
        records = self.validate(current_model(), receipt_decoy + current_receipt())
        self.assertEqual(records[0]["visual_id"], "VISUAL-ONE")

    def test_accepts_missing_visual_only_as_target_blocking_open_conflict(self) -> None:
        self.report_path.write_text(open_report(), encoding="utf-8")
        self.assertEqual(self.validate(open_model(), open_receipt()), [])

    def test_rejects_prose_only_or_indirect_current_visual(self) -> None:
        boundary_only = current_model()[: current_model().index("## Governed Visuals")]
        for substitute in (
            "VISUAL-ONE is current because every decision was resolved in prose.\n",
            "[VISUAL-ONE](https://example.test/mutable-diagram) is current.\n",
        ):
            with self.subTest(substitute=substitute):
                self.assert_invalid(boundary_only + substitute, "Governed Visuals section")

    def test_rejects_missing_required_closure_fields(self) -> None:
        mutations = {
            "visual_id": ("visual_id: VISUAL-ONE\n", "", "visual_id"),
            "checksum": (f"content_sha256: sha256:{DIRECT_DIGEST}\n", "", "content_sha256"),
            "sources": (
                "source_representations:\n"
                "  - source_thread_id: SRC-ONE\n"
                "    item_id: ITEM-ONE\n"
                f"    version: sha256:{SOURCE_DIGEST}\n"
                "    representation_id: source-diagram\n"
                "    member_id: none\n"
                f"    integrity: sha256:{SOURCE_DIGEST}\n",
                "source_representations: []\n",
                "source_representations",
            ),
            "decisions": (
                "governing_decision_ids: [CLM-ONE, CLM-TWO]",
                "governing_decision_ids: []",
                "governing_decision_ids",
            ),
            "coverage": (
                "decision_coverage:\n"
                "  verification_state: verified\n"
                "  verifier: fixture-reviewer\n"
                "  method: Compared every accepted decision with named Mermaid elements.\n"
                "  accepted_decisions:\n"
                "    - decision_id: CLM-ONE\n"
                "      representation_elements: [node:A, node:B, edge:A--B]\n"
                "    - decision_id: CLM-TWO\n"
                "      representation_elements: [edge:A--B]\n",
                "decision_coverage: {}\n",
                "decision_coverage",
            ),
        }
        for field, (before, after, expected) in mutations.items():
            with self.subTest(field=field):
                self.assert_invalid(
                    replace_closure(current_model(), before, after), expected
                )

    def test_rejects_changed_direct_bytes_and_preserves_lf_crlf_boundary(self) -> None:
        self.assert_invalid(
            current_model().replace("A --> B", "A --> C"), "expected sha256:"
        )
        crlf_content = DIRECT_CONTENT.replace("\n", "\r\n")
        crlf_digest = hashlib.sha256(crlf_content.encode("utf-8")).hexdigest()
        crlf_model = current_model().replace(
            f"content_sha256: sha256:{DIRECT_DIGEST}",
            f"content_sha256: sha256:{crlf_digest}",
        ).replace("\n", "\r\n")
        crlf_receipt = current_receipt().replace(
            f"content_sha256: sha256:{DIRECT_DIGEST}",
            f"content_sha256: sha256:{crlf_digest}",
        )
        self.assertEqual(self.validate(crlf_model, crlf_receipt)[0]["visual_id"], "VISUAL-ONE")

    def test_rejects_checksum_valid_prose_and_malformed_mermaid(self) -> None:
        invalid = [
            "%%{init: not-json}%%\nflowchart LR\nA --> B\n",
            "%%{init: {\"theme\": \"dark\"}}\nflowchart LR\nA --> B\n",
            "%%{ just a comment\nflowchart LR\nA --> B\n",
            "This is prose, not Mermaid.\n",
            "flowchart LR\n  A -->\n",
            "flowchart LR\n  A[Unclosed label --> B\n",
            "flowchart LR\n  subgraph MissingEnd[\"Missing end\"]\n  A --> B\n",
            "flowchart LR\n  A --> B !!! invalid garbage\n",
            "flowchart LR\n  A --> B; THIS IS GARBAGE\n",
            "flowchart LR\n  style nonsense\n  A --> B\n",
            "flowchart TB\n  subgraph S[\"Scope\"] garbage?!\n  A --> B\n  end\n",
            "flowchart LR\n  end --> B\n",
            "flowchart LR\n  end-node --> B\n",
            "flowchart LR\n  flowchart --> B\n",
            "flowchart LR\n  A((((x)))) --> B\n",
            "flowchart LR\n  A{[x]} --> B\n",
            "flowchart LR\n  A[] --> B\n",
        ]
        for content in invalid:
            with self.subTest(content=content):
                model, receipt = replace_direct_content(content)
                self.assert_invalid(model, "Mermaid", receipt=receipt)

    def test_accepts_d1_through_d8_and_d6a_flowchart_shapes(self) -> None:
        diagrams = {
            "D1": "flowchart LR\n  subgraph Truth[\"Truth\"]\n    A[\"Source\"] --> B[\"Model\"]\n  end\n",
            "D2": "flowchart TB\n  User -->|\"request\"| Runtime[\"Runtime\"]\n  Runtime --> Result[\"Result\"]\n",
            "D3": "flowchart LR\n  AO <--> Bus[\"Coordination bus\"]\n  Authority -. guidance .-> Bus\n",
            "D4": "flowchart LR\n  A --> B --> C --> A\n",
            "D5": "flowchart TB\n  Ready{\"Ready?\"} -- Yes --> Run[\"Run\"]\n  Ready -- No --> Ask[\"Ask\"]\n",
            "D6": "flowchart LR\n  Model[(\"Product model\")] --> Capsule[\"Context capsule\"]\n",
            "D6A": "flowchart LR\n  Threads ~~~ Model ~~~ Docs\n  Threads[\"Threads\"] --> Model[\"Model\"] --> Docs[\"Docs\"]\n",
            "D7": "flowchart TB\n  subgraph Stage[\"Stage\"]\n    direction LR\n    New[\"New\"] --> Mature[\"Mature\"]\n  end\n",
            "D8": "flowchart LR\n  Request --> Context --> Worker --> Results\n",
        }
        for diagram_id, content in diagrams.items():
            with self.subTest(diagram_id=diagram_id):
                visual_closure._validate_mermaid_flowchart(
                    content.encode("utf-8"), diagram_id
                )

    def test_accepts_compact_edges_and_empty_semicolon_separators(self) -> None:
        valid = [
            "flowchart LR\nA-->B\n",
            "flowchart LR\nA-.->B\n",
            "flowchart LR\nA---B\n",
            "flowchart LR\nA-->B-->C\n",
            "flowchart LR\nA-->B;;B-->C;\n",
        ]
        for content in valid:
            with self.subTest(content=content):
                visual_closure._validate_mermaid_flowchart(
                    content.encode("utf-8"), "compact"
                )

    def test_accepts_compact_edges_and_empty_semicolon_separators(self) -> None:
        compact = [
            "flowchart LR\nA-->B\n",
            "flowchart LR\nA-.->B\n",
            "flowchart LR\nA---B\n",
            "flowchart LR\nA-->B-->C\n",
            "flowchart LR\nA-->B;;B-->C;\n",
        ]
        for content in compact:
            with self.subTest(content=content):
                visual_closure._validate_mermaid_flowchart(
                    content.encode("utf-8"), "compact"
                )

    def test_live_model_skip_covers_only_an_absent_model(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            self.assertEqual(
                live_model_skip_reason(root),
                "live repository model .docsfab/reference-model is absent from this tree",
            )
            (root / ".docsfab/reference-model").mkdir(parents=True)
            self.assertIsNone(live_model_skip_reason(root))

    @unittest.skipIf(LIVE_SKIP, LIVE_SKIP)
    def test_accepts_every_retained_flowchart_body(self) -> None:
        artifact_root = REPOSITORY_ROOT / ".docsfab/reference-model/source-threads"
        count = 0
        for path in artifact_root.glob("*/artifacts/sha256/*/*"):
            try:
                content = path.read_bytes()
            except OSError:
                continue
            for match in re.finditer(
                rb"^```mermaid\s*\r?\n(.*?\r?\n)^```", content, re.MULTILINE | re.DOTALL
            ):
                body = match.group(1)
                first = body.lstrip().splitlines()[0] if body.strip() else b""
                if first.startswith((b"flowchart", b"graph")):
                    visual_closure._validate_mermaid_flowchart(body, str(path))
                    count += 1
        self.assertGreaterEqual(count, 36)

    def test_rejects_coordinated_decision_deletion_against_retained_manifest(self) -> None:
        model = current_model().replace(
            "accepted_decision_ids: [CLM-ONE, CLM-TWO]",
            "accepted_decision_ids: [CLM-ONE]",
        )
        model = model.replace(
            "governing_decision_ids: [CLM-ONE, CLM-TWO]",
            "governing_decision_ids: [CLM-ONE]",
        )
        model = model.replace(
            "    - decision_id: CLM-TWO\n      representation_elements: [edge:A--B]\n",
            "",
        )
        self.assert_invalid(model, "retained closure manifest")

    def test_rejects_nonexistent_or_duplicate_model_claim(self) -> None:
        duplicate_record = """### CLM-ONE: Duplicate

```yaml
claim_id: CLM-ONE
source_claims: [SOURCE-CLAIM-DUPLICATE]
relationship: compatible
action: included
statement: Duplicate fixture decision.
scope: {product: fixture}
exact_evidence: [duplicate fixture evidence]
agent_inferences: []
behavior_verification: not-applicable
representation_state: confirmed
intent_approval: approved
model_state: approved
decision_basis: Duplicate fixture adjudication.
resolution_owner: Fixture owner
blocks_targets: []
unblocks_targets: [VISUAL-ONE]
```

"""
        self.assert_invalid(
            current_model().replace(
                "## Governed Visuals",
                duplicate_record + "## Governed Visuals",
            ),
            "exactly one model claim",
        )

        manifest = dict(CLOSURE_MANIFEST)
        manifest["accepted_decision_ids"] = ["CLM-NOT-REAL"]
        manifest_digest = self._replace_manifest(manifest)
        model = current_model().replace(MANIFEST_DIGEST, manifest_digest).replace(
            "accepted_decision_ids: [CLM-ONE, CLM-TWO]",
            "accepted_decision_ids: [CLM-NOT-REAL]",
        ).replace(
            "governing_decision_ids: [CLM-ONE, CLM-TWO]",
            "governing_decision_ids: [CLM-NOT-REAL]",
        ).replace(
            "    - decision_id: CLM-ONE\n",
            "    - decision_id: CLM-NOT-REAL\n",
        ).replace(
            "    - decision_id: CLM-TWO\n      representation_elements: [edge:A--B]\n",
            "",
        )
        model = model.replace(
            "## Governed Visuals",
            "````text\n### CLM-NOT-REAL: Nested Decoy\n\n"
            "```yaml\nclaim_id: CLM-NOT-REAL\n```\n````\n\n"
            "## Governed Visuals",
        )
        receipt = current_receipt().replace(MANIFEST_DIGEST, manifest_digest).replace(
            "governing_decision_ids: [CLM-ONE, CLM-TWO]",
            "governing_decision_ids: [CLM-NOT-REAL]",
        )
        self.assert_invalid(
            model, "must resolve to exactly one model claim", receipt=receipt
        )

    def test_rejects_top_level_incomplete_claim_record(self) -> None:
        malformed = current_model().replace(
            "claim_id: CLM-ONE\nsource_claims: [SOURCE-CLAIM-ONE]",
            "claim_id: CLM-ONE",
            1,
        )
        self.assert_invalid(malformed, "is not a complete valid model claim")

    def _replace_manifest(self, manifest: dict) -> str:
        content = (json.dumps(manifest, indent=2, sort_keys=True) + "\n").encode()
        digest = hashlib.sha256(content).hexdigest()
        old_path = self.source_threads_root / "SRC-ONE" / "artifacts" / "sha256" / MANIFEST_DIGEST[:2] / MANIFEST_DIGEST
        new_relative = f"artifacts/sha256/{digest[:2]}/{digest}"
        new_path = self.source_threads_root / "SRC-ONE" / new_relative
        new_path.parent.mkdir(parents=True, exist_ok=True)
        new_path.write_bytes(content)
        item_path = self.source_threads_root / "SRC-ONE" / "items" / "ITEM-MANIFEST.json"
        item = json.loads(item_path.read_text())
        item["version"]["value"] = digest
        item["representations"][0]["locator"]["retained_copy"] = new_relative
        item["representations"][0]["integrity"]["value"] = digest
        item_path.write_text(json.dumps(item))
        old_path.unlink()
        return digest

    def test_rejects_malformed_duplicate_or_undeclared_visual_blocks(self) -> None:
        malformed = current_model().replace("```yaml visual-closure", "```yaml", 1)
        self.assert_invalid(malformed, "first fence must be top-level yaml visual-closure")
        duplicate_heading = current_model().replace(
            "### VISUAL-ONE: Fixture Architecture",
            "### VISUAL-ONE: Duplicate\n\n### VISUAL-ONE: Fixture Architecture",
        )
        self.assert_invalid(duplicate_heading, "duplicate governed visual headings")
        marker_start = current_model().index("```yaml visual-closure")
        representation_start = current_model().index("```mermaid", marker_start)
        duplicate_metadata = current_model()[marker_start:representation_start]
        duplicate_block = (
            current_model()[:representation_start]
            + duplicate_metadata
            + current_model()[representation_start:]
        )
        self.assert_invalid(
            duplicate_block, "exactly one metadata and one direct fence"
        )
        rogue_mermaid = current_model() + (
            "\n```mermaid\nflowchart LR\n  Rogue --> Fence\n```\n"
        )
        self.assert_invalid(
            rogue_mermaid, "exactly one metadata and one direct fence"
        )
        outside_mermaid = current_model().replace(
            "## Governed Visuals",
            "```mermaid\nflowchart LR\n  Rogue --> Outside\n```\n\n"
            "## Governed Visuals",
        )
        self.assert_invalid(outside_mermaid, "governed visual fence outside")
        before_first_heading = current_model().replace(
            "## Governed Visuals\n\n### VISUAL-ONE",
            "## Governed Visuals\n\n"
            "```mermaid\nflowchart LR\n  Rogue --> BeforeHeading\n```\n\n"
            "### VISUAL-ONE",
        )
        self.assert_invalid(
            before_first_heading, "rogue fences outside visual headings"
        )
        blockquote_mermaid = current_model() + (
            "\n> ```mermaid\n> flowchart LR\n>   Rogue --> Quoted\n> ```\n"
        )
        self.assert_invalid(
            blockquote_mermaid, "exactly one metadata and one direct fence"
        )
        undeclared_block = current_model() + current_model()[
            current_model().index("### VISUAL-ONE:") :
        ].replace("VISUAL-ONE", "VISUAL-TWO")
        self.assert_invalid(undeclared_block, "undeclared visual closure records")
        rogue_mermaid = current_model() + (
            "\n```mermaid\nflowchart LR\n  Rogue --> Fence\n```\n"
        )
        self.assert_invalid(rogue_mermaid, "exactly one metadata and one direct fence")
        rogue_long_fences = current_model() + (
            "\n````yaml visual-closure\nvisual_id: VISUAL-ROGUE\n````\n\n"
            "````mermaid\nflowchart LR\n  Rogue --> Fence\n````\n"
        )
        self.assert_invalid(
            rogue_long_fences, "exactly one metadata and one direct fence"
        )

    def test_rejects_current_target_with_open_representation_conflict(self) -> None:
        self.report_path.write_text(open_report(), encoding="utf-8")
        self.assert_invalid(
            current_model(), "is current while representation conflict"
        )

    def test_rejects_missing_or_drifting_machine_readable_receipt(self) -> None:
        prose_receipt = "# Receipt\n\n## 14. Governed Visual Closure\n\nNo governed visual targets.\n"
        self.assert_invalid(current_model(), "visual-closure-receipt block", receipt=prose_receipt)
        drifted = current_receipt().replace(
            f"content_sha256: sha256:{DIRECT_DIGEST}", "content_sha256: sha256:" + "0" * 64
        )
        self.assert_invalid(current_model(), "receipt content_sha256", receipt=drifted)

    def test_rejects_every_receipt_binding_drift(self) -> None:
        mutations = [
            ("visual_id: VISUAL-ONE", "visual_id: VISUAL-OTHER", "receipt IDs"),
            ("conflict_id: none", "conflict_id: CONFLICT-OTHER", "receipt conflict_id"),
            (
                "representation_id: visual-one-mermaid",
                "representation_id: visual-other-mermaid",
                "receipt representation_id",
            ),
            (
                "representation_id: source-diagram",
                "representation_id: other-source",
                "receipt sources",
            ),
            (
                "governing_decision_ids: [CLM-ONE, CLM-TWO]",
                "governing_decision_ids: [CLM-ONE]",
                "receipt decisions",
            ),
            ("verifier: fixture-reviewer", "verifier: other-reviewer", "receipt coverage"),
            (
                "method: Compared every accepted decision with named Mermaid elements.",
                "method: Different method.",
                "receipt coverage",
            ),
            (
                "verification_state: verified",
                "verification_state: blocked",
                "receipt coverage",
            ),
            (
                "verification_result: verified",
                "verification_result: blocked",
                "receipt coverage",
            ),
        ]
        for before, after, expected in mutations:
            with self.subTest(before=before):
                self.assert_invalid(
                    current_model(),
                    expected,
                    receipt=current_receipt().replace(before, after, 1),
                )

    def test_diagram_requires_direct_mermaid_not_a_prose_fence(self) -> None:
        model = current_model().replace(
            "artifact_kind: architecture-view", "artifact_kind: diagram"
        )
        model = model.replace("representation_format: mermaid", "representation_format: text")
        model = model.replace("```mermaid\n", "```text\n")
        self.assert_invalid(model, "second fence is not a top-level supported representation")


if __name__ == "__main__":
    unittest.main()
