# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
from __future__ import annotations

import importlib.util
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
from fnmatch import fnmatchcase
from unittest import mock
from pathlib import Path

import yaml


REPOSITORY_ROOT = Path(__file__).resolve().parents[5]
SCRIPT = (
    REPOSITORY_ROOT
    / "packages/knowledge/skills/converge-documentation/scripts/check_freshness.py"
)
SPEC = importlib.util.spec_from_file_location("check_freshness", SCRIPT)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError(f"Unable to load freshness script: {SCRIPT}")
check_freshness = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(check_freshness)


class FreshnessTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary_directory = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary_directory.name)
        self._write_fixture()
        self._git("init", "-q")
        self._git("config", "user.email", "test@example.com")
        self._git("config", "user.name", "Test User")
        self._git("add", ".")
        self._git("commit", "-qm", "fixture")
        self.reviewed_commit = self._git_text("rev-parse", "HEAD")
        self.reviewed_tree = self._git_text("rev-parse", "HEAD^{tree}")
        self._write(
            ".docsfab/reference-model/assessments/clean-review.md",
            "# Clean review\n\n"
            "## Verdict\n\n"
            "**PASS**\n\n"
            f"- Reviewed target: `{self.reviewed_commit}`\n"
            f"- Reviewed target tree: `{self.reviewed_tree}`\n",
        )
        self._git("add", ".docsfab/reference-model/assessments/clean-review.md")
        self._git("commit", "-qm", "retain clean review")

    def tearDown(self) -> None:
        self.temporary_directory.cleanup()

    def _git(self, *arguments: str) -> None:
        subprocess.run(
            ["git", *arguments],
            cwd=self.root,
            check=True,
            capture_output=True,
            timeout=10,
        )

    def _git_text(self, *arguments: str) -> str:
        result = subprocess.run(
            ["git", *arguments],
            cwd=self.root,
            check=True,
            capture_output=True,
            text=True,
            timeout=10,
        )
        return result.stdout.strip()

    def _write(self, relative: str, content: str) -> None:
        path = self.root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")

    def _write_fixture(self) -> None:
        source_skill = (
            REPOSITORY_ROOT / "packages/knowledge/skills/register-source-thread"
        )
        fixture_skill = self.root / "packages/knowledge/skills/register-source-thread"
        shutil.copytree(source_skill, fixture_skill)
        synthesis_skill = (
            REPOSITORY_ROOT / "packages/knowledge/skills/synthesize-source-threads"
        )
        fixture_synthesis_skill = (
            self.root / "packages/knowledge/skills/synthesize-source-threads"
        )
        shutil.copytree(synthesis_skill, fixture_synthesis_skill)
        fixture_convergence_scripts = (
            self.root
            / "packages/knowledge/skills/converge-documentation/scripts"
        )
        fixture_convergence_scripts.mkdir(parents=True)
        shutil.copy2(SCRIPT, fixture_convergence_scripts / SCRIPT.name)
        self._write("README.md", "# Project\n")
        self._write(".gitignore", ".docsfab/reports/\n")
        self._write(
            ".gitlab/ci/knowledge.yml",
            "documentation:freshness:\n  script: [safe]\n",
        )
        self._write(
            ".docsfab/reference-model/assessments/clean-review.md",
            "# Clean review\n\nPassed.\n",
        )
        self._write(
            "fern/docs.yml",
            "navigation:\n  - page: Page\n    path: ../docs/about/page.md\n",
        )
        self._write("docs/about/page.md", "---\ntitle: Page\n---\n\nBody.\n")
        self._write("packages/runtime/source.txt", "runtime\n")
        thread_root = self.root / ".docsfab/reference-model/source-threads/SRC-ONE"
        (thread_root / "items").mkdir(parents=True)
        (thread_root / "views").mkdir()
        artifact = b"fixture evidence\n"
        artifact_digest = hashlib.sha256(artifact).hexdigest()
        artifact_relative = f"artifacts/sha256/{artifact_digest[:2]}/{artifact_digest}"
        artifact_path = thread_root / artifact_relative
        artifact_path.parent.mkdir(parents=True)
        artifact_path.write_bytes(artifact)
        self._write(
            ".docsfab/reference-model/source-threads/SRC-ONE/thread.json",
            json.dumps(
                {
                    "schema_version": "docsfab.knowledge.source-thread/v1",
                    "thread_id": "SRC-ONE",
                    "origin": {
                        "kind": "artifact",
                        "identity": "fixture",
                        "identity_state": "verified",
                    },
                    "created_at": "2026-08-18T00:00:00Z",
                    "access": {"classification": "test"},
                    "item_ids": ["ITEM-ONE"],
                    "relations": [],
                    "event_log": "events.jsonl",
                    "head_event_ids": ["EVT-TWO"],
                },
                indent=2,
            ),
        )
        self._write(
            ".docsfab/reference-model/source-threads/SRC-ONE/items/ITEM-ONE.json",
            json.dumps(
                {
                    "schema_version": "docsfab.knowledge.source-item/v1",
                    "item_id": "ITEM-ONE",
                    "thread_id": "SRC-ONE",
                    "artifact_type": "document",
                    "title": "Fixture evidence",
                    "summary": "Test source item.",
                    "attribution": {
                        "author": "fixture",
                        "contributors": [],
                        "collector": "test",
                    },
                    "timestamps": {
                        "source_created_at": "2026-08-18T00:00:00Z",
                        "ingested_at": "2026-08-18T00:00:00Z",
                    },
                    "version": {"kind": "content-hash", "value": artifact_digest},
                    "scope": {
                        "product_version": "fixture",
                        "deployment": "test",
                        "audience": "test",
                        "model_region": "test",
                    },
                    "representations": [
                        {
                            "representation_id": "original",
                            "role": "original",
                            "media_type": "text/plain",
                            "original_filename": "fixture.txt",
                            "size_bytes": len(artifact),
                            "locator": {
                                "scheme": "thread-artifact",
                                "uri": artifact_relative,
                                "repository": None,
                                "commit": None,
                                "path": None,
                                "external_version": None,
                                "retained_copy": artifact_relative,
                            },
                            "integrity": {
                                "algorithm": "sha256",
                                "value": artifact_digest,
                            },
                            "derived_from": [],
                            "transform": None,
                            "access_override": None,
                        }
                    ],
                    "members": [],
                    "governance": {
                        "consent": "test",
                        "citation_boundary": "test",
                        "retention_boundary": "test",
                        "redistribution_boundary": "test",
                        "access_classification": "test",
                    },
                    "lineage": {
                        "parent_item_ids": [],
                        "supersedes": [],
                        "related_item_ids": [],
                    },
                    "transforms": [],
                    "evidence_state": "source-authored",
                    "limitations": [],
                },
                indent=2,
            ),
        )
        self._write(
            ".docsfab/reference-model/source-threads/SRC-ONE/events.jsonl",
            "\n".join(
                [
                    json.dumps(
                        {
                            "schema_version": "docsfab.knowledge.source-event/v1",
                            "event_id": "EVT-ONE",
                            "thread_id": "SRC-ONE",
                            "sequence": 1,
                            "occurred_at": "2026-08-18T00:00:00Z",
                            "actor": "test",
                            "event_type": "thread.created",
                            "item_id": None,
                            "parent_event_ids": [],
                            "payload": {},
                        }
                    ),
                    json.dumps(
                        {
                            "schema_version": "docsfab.knowledge.source-event/v1",
                            "event_id": "EVT-TWO",
                            "thread_id": "SRC-ONE",
                            "sequence": 2,
                            "occurred_at": "2026-08-18T00:00:01Z",
                            "actor": "test",
                            "event_type": "item.registered",
                            "item_id": "ITEM-ONE",
                            "parent_event_ids": ["EVT-ONE"],
                            "payload": {},
                        }
                    ),
                ]
            )
            + "\n",
        )
        self._write(
            ".docsfab/reference-model/shared/DOCSFAB-PRODUCT/history.md",
            "| Version | Date |\n| --- | --- |\n| [v0.1](v0.1/model.md) | now |\n",
        )
        self._write(
            ".docsfab/reference-model/shared/DOCSFAB-PRODUCT/v0.1/model.md",
            f"""# Model

```yaml
merge_id: MERGE-FIXTURE-001
model_id: DOCSFAB-PRODUCT
model_version: v0.1
prior_model_version: none
created_at: 2026-08-18T00:00:02Z
model_region: fixture
target_release: test
audience: test
documentation_targets: [docs/about/page.md]
source_items:
  - source_thread_id: SRC-ONE
    item_id: ITEM-ONE
    version: sha256:{artifact_digest}
    representation_id: original
    member_id: none
    integrity: sha256:{artifact_digest}
    thread_head_event_ids: [EVT-TWO]
reviewers: [test]
approval_state: candidate
```

### CLM-ONE — Fixture claim

```yaml
claim_id: CLM-ONE
source_claims: [ITEM-ONE]
relationship: compatible
action: added
statement: The fixture is valid.
scope: {{component: fixture}}
exact_evidence: [ITEM-ONE]
agent_inferences: []
behavior_verification: supported
representation_state: confirmed
intent_approval: not-applicable
model_state: candidate
decision_basis: Fixture evidence.
resolution_owner: test
blocks_targets: []
unblocks_targets: []
```
""",
        )
        self._write(
            ".docsfab/reference-model/shared/DOCSFAB-PRODUCT/v0.1/inconsistency-report.md",
            "# Report\n\nNo inconsistencies were found.\n",
        )
        receipt_sections = "\n".join(
            f"## {number}. Section {number}\n\nFixture.\n"
            for number in range(1, 14)
        )
        self._write(
            ".docsfab/reference-model/shared/DOCSFAB-PRODUCT/v0.1/merge-receipt.md",
            f"# Receipt\n\n{receipt_sections}",
        )
        self._write(
            ".docsfab/reference-model/README.md",
            "[Current](shared/DOCSFAB-PRODUCT/v0.1/model.md)\n",
        )
        result = subprocess.run(
            [
                sys.executable,
                str(fixture_skill / "scripts/source_thread.py"),
                "render",
                str(thread_root),
            ],
            cwd=self.root,
            check=False,
            capture_output=True,
            text=True,
            timeout=10,
        )
        if result.returncode != 0:
            raise RuntimeError(f"Unable to render fixture source thread: {result.stderr}")

    def _snapshot(
        self,
        *,
        model_version: str = "v0.1",
        review_status: str = "passed",
        repository_paths: list[str] | None = None,
    ) -> dict:
        return check_freshness.create_snapshot(
            self.root,
            model_version=model_version,
            repository_paths=repository_paths or ["packages/runtime"],
            checks=[{"name": "tests", "status": "passed", "evidence": "fixture"}],
            readiness=[
                {
                    "target": "fixture docs",
                    "status": "partial",
                    "owner": "test",
                    "evidence": "fixture",
                }
            ],
            blocked_targets=[
                {"target": "release", "owner": "test", "reason": "fixture only"}
            ],
            known_gaps=["No human evidence."],
            review_status=review_status,
            review_evidence=(
                ".docsfab/reference-model/assessments/clean-review.md"
                if review_status == "passed"
                else "clean-review-fixture"
            ),
            reviewed_commit=(self.reviewed_commit if review_status == "passed" else None),
            reviewed_tree=(self.reviewed_tree if review_status == "passed" else None),
        )

    def _run_cli(
        self, *arguments: str, environment: dict[str, str] | None = None
    ) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [sys.executable, str(SCRIPT), *arguments],
            cwd=self.root,
            check=False,
            capture_output=True,
            text=True,
            timeout=30,
            env=environment,
        )

    def _render_thread(self) -> None:
        validator = (
            self.root
            / "packages/knowledge/skills/register-source-thread/scripts/source_thread.py"
        )
        thread_root = self.root / ".docsfab/reference-model/source-threads/SRC-ONE"
        result = subprocess.run(
            [sys.executable, str(validator), "render", str(thread_root)],
            cwd=self.root,
            check=False,
            capture_output=True,
            text=True,
            timeout=10,
        )
        if result.returncode != 0:
            self.fail(f"Unable to render fixture source thread: {result.stderr}")

    def _register_second_item(
        self,
        *,
        parent_event_id: str = "EVT-TWO",
        occurred_at: str = "2026-08-18T00:00:03Z",
        render: bool = True,
    ) -> None:
        thread_path = self.root / ".docsfab/reference-model/source-threads/SRC-ONE/thread.json"
        thread = json.loads(thread_path.read_text(encoding="utf-8"))
        thread["item_ids"].append("ITEM-TWO")
        thread["head_event_ids"] = (
            ["EVT-TWO", "EVT-THREE"]
            if parent_event_id == "EVT-ONE"
            else ["EVT-THREE"]
        )
        thread_path.write_text(json.dumps(thread, indent=2), encoding="utf-8")

        first_item_path = (
            self.root
            / ".docsfab/reference-model/source-threads/SRC-ONE/items/ITEM-ONE.json"
        )
        second_item = json.loads(first_item_path.read_text(encoding="utf-8"))
        second_item["item_id"] = "ITEM-TWO"
        second_item["title"] = "Second fixture evidence"
        representation = second_item["representations"][0]
        representation["size_bytes"] = None
        representation["locator"] = {
            "scheme": "external",
            "uri": "fixture://item-two",
            "repository": None,
            "commit": None,
            "path": None,
            "external_version": "1",
            "retained_copy": None,
        }
        self._write(
            ".docsfab/reference-model/source-threads/SRC-ONE/items/ITEM-TWO.json",
            json.dumps(second_item, indent=2),
        )
        events_path = self.root / ".docsfab/reference-model/source-threads/SRC-ONE/events.jsonl"
        with events_path.open("a", encoding="utf-8") as handle:
            handle.write(
                json.dumps(
                    {
                        "schema_version": "docsfab.knowledge.source-event/v1",
                        "event_id": "EVT-THREE",
                        "thread_id": "SRC-ONE",
                        "sequence": 3,
                        "occurred_at": occurred_at,
                        "actor": "test",
                        "event_type": "item.registered",
                        "item_id": "ITEM-TWO",
                        "parent_event_ids": [parent_event_id],
                        "payload": {},
                    }
                )
                + "\n"
            )
        if render:
            self._render_thread()

    def _configure_collection_members(self) -> tuple[str, str]:
        item_path = (
            self.root
            / ".docsfab/reference-model/source-threads/SRC-ONE/items/ITEM-ONE.json"
        )
        item = json.loads(item_path.read_text(encoding="utf-8"))
        member_integrities = (
            hashlib.sha256(b"member-one").hexdigest(),
            hashlib.sha256(b"member-two").hexdigest(),
        )
        members = []
        for member_id, integrity in zip(
            ("member-one", "member-two"), member_integrities
        ):
            representation = json.loads(json.dumps(item["representations"][0]))
            representation["locator"] = {
                "scheme": "external",
                "uri": f"fixture://{member_id}",
                "repository": None,
                "commit": None,
                "path": None,
                "external_version": "1",
                "retained_copy": None,
            }
            representation["integrity"] = {
                "algorithm": "sha256",
                "value": integrity,
            }
            members.append(
                {
                    "member_id": member_id,
                    "title": member_id,
                    "artifact_type": "document",
                    "representations": [representation],
                }
            )
        item["members"] = members
        item_path.write_text(json.dumps(item, indent=2), encoding="utf-8")
        self._render_thread()
        return member_integrities

    def _select_second_item_in_model(self, thread_heads: str) -> None:
        model_path = (
            self.root
            / ".docsfab/reference-model/shared/DOCSFAB-PRODUCT/v0.1/model.md"
        )
        model_text = model_path.read_text(encoding="utf-8")
        model_text = model_text.replace("item_id: ITEM-ONE", "item_id: ITEM-TWO")
        model_text = model_text.replace(
            "thread_head_event_ids: [EVT-TWO]",
            f"thread_head_event_ids: [{thread_heads}]",
        )
        model_text = model_text.replace(
            "reviewers: [test]\n",
            "source_item_dispositions:\n"
            "  - item_id: ITEM-ONE\n"
            "    disposition: superseded\n"
            "    rationale: The fixture selects the later item.\n"
            "reviewers: [test]\n",
        )
        model_path.write_text(model_text, encoding="utf-8")

    def _add_current_model_version(self, model_version: str = "v0.2") -> None:
        model_root = self.root / ".docsfab/reference-model/shared/DOCSFAB-PRODUCT"
        source = model_root / "v0.1"
        target = model_root / model_version
        shutil.copytree(source, target)
        model_path = target / "model.md"
        model_path.write_text(
            model_path.read_text(encoding="utf-8").replace("v0.1", model_version),
            encoding="utf-8",
        )
        history_path = model_root / "history.md"
        history_path.write_text(
            history_path.read_text(encoding="utf-8").replace(
                "| --- | --- |\n",
                f"| --- | --- |\n| [{model_version}]({model_version}/model.md) | now |\n",
            ),
            encoding="utf-8",
        )
        self._write(
            ".docsfab/reference-model/README.md",
            f"[Current](shared/DOCSFAB-PRODUCT/{model_version}/model.md)\n",
        )

    def _make_visual_contract_current(self, model_version: str = "v0.29") -> None:
        self._register_second_item(occurred_at="2026-08-18T00:00:03Z")
        source_digest = hashlib.sha256(b"fixture evidence\n").hexdigest()
        source_reference = {
            "source_thread_id": "SRC-ONE",
            "item_id": "ITEM-ONE",
            "version": f"sha256:{source_digest}",
            "representation_id": "original",
            "member_id": "none",
            "integrity": f"sha256:{source_digest}",
        }
        manifest = {
            "schema_version": "docsfab.knowledge.visual-closure-manifest/v1",
            "visual_id": "VISUAL-ONE",
            "required_source_representations": [source_reference],
            "accepted_decision_ids": ["CLM-TWO"],
        }
        manifest_bytes = (
            json.dumps(manifest, indent=2, sort_keys=True) + "\n"
        ).encode("utf-8")
        manifest_digest = hashlib.sha256(manifest_bytes).hexdigest()
        self.visual_manifest_digest = manifest_digest
        manifest_relative = (
            f"artifacts/sha256/{manifest_digest[:2]}/{manifest_digest}"
        )
        manifest_path = (
            self.root
            / ".docsfab/reference-model/source-threads/SRC-ONE"
            / manifest_relative
        )
        manifest_path.parent.mkdir(parents=True, exist_ok=True)
        manifest_path.write_bytes(manifest_bytes)
        manifest_item_path = (
            self.root
            / ".docsfab/reference-model/source-threads/SRC-ONE/items/ITEM-TWO.json"
        )
        manifest_item = json.loads(manifest_item_path.read_text(encoding="utf-8"))
        manifest_item["schema_version"] = "docsfab.knowledge.source-item/v2"
        manifest_item["governed_visual"] = False
        manifest_item["title"] = "Visual closure manifest"
        manifest_item["version"] = {"kind": "content-hash", "value": manifest_digest}
        manifest_representation = manifest_item["representations"][0]
        manifest_representation["representation_id"] = "visual-closure-manifest"
        manifest_representation["media_type"] = "application/json"
        manifest_representation["size_bytes"] = len(manifest_bytes)
        manifest_representation["locator"] = {
            "scheme": "thread-artifact",
            "uri": manifest_relative,
            "repository": None,
            "commit": None,
            "path": None,
            "external_version": None,
            "retained_copy": manifest_relative,
        }
        manifest_representation["integrity"] = {
            "algorithm": "sha256",
            "value": manifest_digest,
        }
        manifest_item_path.write_text(
            json.dumps(manifest_item, indent=2), encoding="utf-8"
        )
        self._render_thread()

        self._add_current_model_version(model_version)
        direct_content = "flowchart LR\n  A --> B\n"
        direct_digest = hashlib.sha256(direct_content.encode("utf-8")).hexdigest()
        version_root = (
            self.root
            / ".docsfab/reference-model/shared/DOCSFAB-PRODUCT"
            / model_version
        )
        model_path = version_root / "model.md"
        base_model = model_path.read_text(encoding="utf-8")
        base_model = base_model.replace("CLM-ONE", "CLM-TWO")
        base_model = base_model.replace(
            "created_at: 2026-08-18T00:00:02Z",
            "created_at: 2026-08-18T00:00:04Z",
        )
        base_model = base_model.replace(
            "thread_head_event_ids: [EVT-TWO]",
            "thread_head_event_ids: [EVT-THREE]",
        )
        model_path.write_text(
            base_model.replace(
                "reviewers: [test]\n",
                "  - source_thread_id: SRC-ONE\n"
                "    item_id: ITEM-TWO\n"
                f"    version: sha256:{manifest_digest}\n"
                "    representation_id: visual-closure-manifest\n"
                "    member_id: none\n"
                f"    integrity: sha256:{manifest_digest}\n"
                "    thread_head_event_ids: [EVT-THREE]\n"
                "governed_visual_targets:\n"
                "  - visual_id: VISUAL-ONE\n"
                "    target_state: current\n"
                "    conflict_id: none\n"
                "    closure_manifest_source:\n"
                "      source_thread_id: SRC-ONE\n"
                "      item_id: ITEM-TWO\n"
                f"      version: sha256:{manifest_digest}\n"
                "      representation_id: visual-closure-manifest\n"
                "      member_id: none\n"
                f"      integrity: sha256:{manifest_digest}\n"
                "    required_source_representations:\n"
                "      - source_thread_id: SRC-ONE\n"
                "        item_id: ITEM-ONE\n"
                f"        version: sha256:{source_digest}\n"
                "        representation_id: original\n"
                "        member_id: none\n"
                f"        integrity: sha256:{source_digest}\n"
                "    accepted_decision_ids: [CLM-TWO]\n"
                "reviewers: [test]\n",
            )
            + "\n## Governed Visuals\n\n"
            "### VISUAL-ONE: Fixture\n\n"
            "```yaml visual-closure\n"
            "visual_id: VISUAL-ONE\n"
            "artifact_kind: diagram\n"
            "lifecycle_disposition: current\n"
            "representation_id: visual-one-mermaid\n"
            "representation_format: mermaid\n"
            f"content_sha256: sha256:{direct_digest}\n"
            "source_representations:\n"
            "  - source_thread_id: SRC-ONE\n"
            "    item_id: ITEM-ONE\n"
            f"    version: sha256:{source_digest}\n"
            "    representation_id: original\n"
            "    member_id: none\n"
            f"    integrity: sha256:{source_digest}\n"
            "governing_decision_ids: [CLM-TWO]\n"
            "decision_coverage:\n"
            "  verification_state: verified\n"
            "  verifier: fixture\n"
            "  method: Compared CLM-TWO to the named nodes and edge.\n"
            "  accepted_decisions:\n"
            "    - decision_id: CLM-TWO\n"
            "      representation_elements: [node:A, node:B, edge:A--B]\n"
            "```\n\n"
            "```mermaid\n"
            f"{direct_content}"
            "```\n",
            encoding="utf-8",
        )
        receipt_path = version_root / "merge-receipt.md"
        with receipt_path.open("a", encoding="utf-8") as handle:
            handle.write(
                "\n## 14. Governed Visual Closure\n\n"
                "```yaml visual-closure-receipt\n"
                "schema_version: docsfab.knowledge.visual-closure-receipt/v1\n"
                "visual_closures:\n"
                "  - visual_id: VISUAL-ONE\n"
                "    target_state: current\n"
                "    conflict_id: none\n"
                "    closure_manifest_source:\n"
                "      source_thread_id: SRC-ONE\n"
                "      item_id: ITEM-TWO\n"
                f"      version: sha256:{manifest_digest}\n"
                "      representation_id: visual-closure-manifest\n"
                "      member_id: none\n"
                f"      integrity: sha256:{manifest_digest}\n"
                "    representation_id: visual-one-mermaid\n"
                f"    content_sha256: sha256:{direct_digest}\n"
                "    source_representations:\n"
                "      - source_thread_id: SRC-ONE\n"
                "        item_id: ITEM-ONE\n"
                f"        version: sha256:{source_digest}\n"
                "        representation_id: original\n"
                "        member_id: none\n"
                f"        integrity: sha256:{source_digest}\n"
                "    governing_decision_ids: [CLM-TWO]\n"
                "    coverage_verification:\n"
                "      verification_state: verified\n"
                "      verification_result: verified\n"
                "      verifier: fixture\n"
                "      method: Compared CLM-TWO to the named nodes and edge.\n"
                "```\n"
            )

    NATIVE_CONFLICT = (
        "## CONFLICT-NATIVE-001: CLM-ONE\n\n```yaml\n"
        "conflict_id: CONFLICT-NATIVE-001\nstatus: resolved\nclassification: intent-conflict\n"
        'summary: "An input offers a variant of CLM-ONE."\nsource_variants:\n'
        '  - source_claim_ids: ["CLM-ONE"]\n    statement: "The fixture is valid."\n'
        '    scope: {"component": "fixture"}\n    exact_evidence: ["Approved claim record."]\n'
        '  - source_claim_ids: ["source-version:fixture"]\n    statement: "The fixture is valid in the native scope."\n'
        '    scope: {"component": "fixture"}\n    exact_evidence: ["Comparison receipt."]\n'
        'why_inconsistent: "Both statements cannot be canonical."\n'
        'consequence_if_unresolved: "The model would carry two statements."\n'
        'resolution_owner: "fixture-owner"\nblocks_targets: []\nadjudication:\n'
        '  adjudicator: "fixture-owner"\n  authority_basis: "owner-decision receipt fixture"\n'
        '  decided_at: "2026-08-18T00:00:05.000Z"\n  disposition: accept-variant\n'
        '  rationale: "Protected decision custody fixture; the original reply is not reproduced."\n'
        '  decision_evidence: ["ITEM-TWO"]\n  resulting_claim_ids: ["CLM-ONE"]\n```\n'
    )

    def _native_envelope(self, version: str, parent: str, *, change: bool) -> dict:
        record = {"claim_id": "CLM-ONE", "statement": "The fixture is valid in the native scope.",
                  "scope": {"component": "fixture"}}
        return {
            "schemaVersion": 1, "kind": "docsfab-product-feedback-model", "projectId": "fixture",
            "modelId": "DOCSFAB-PRODUCT", "version": version, "streamVersion": 2, "state": "candidate",
            "recipeSha256": "a" * 64,
            "parent": {"version": parent, "modelSha256": "b" * 64, "modelGitObjectId": "c" * 40,
                       "baselineGeneration": 0, "baselineSha256": "d" * 64, "sourceClosureSha256": "e" * 64},
            "metadata": {"successorVersion": version, "createdAt": "2026-08-18T00:00:05.000Z", "title": "Native fixture"},
            "retainedFiles": [],
            "change": {"claimId": "CLM-ONE", "beforeClaimRecordSha256": "f" * 64, "record": record} if change else None,
            "openConflicts": [],
            "sourceRegistration": {"threadId": "SRC-ONE", "itemId": "ITEM-TWO", "artifactSha256": "1" * 64,
                                   "decisionRegistrationSha256": "2" * 64 if change else None, "files": []},
            "sourceClosureSha256": "3" * 64, "approvalTargetSha256": "4" * 64 if change else None,
        }

    def _native_receipt(self, *, change: bool, visual_block: str = "") -> str:
        sections = [f"## {number}. Section {number}\n\nFixture.\n" for number in range(1, 13)]
        sections.append(
            "## 13. Inconsistency Report and Transitions\n\n- Report: [inconsistency-report.md](inconsistency-report.md)\n"
            + ("- Resolved: `CONFLICT-NATIVE-001`.\n" if change else "- Conflicts: none.\n")
        )
        sections.append(f"## 14. Governed Visual Closure\n\nThis version changes no governed visual.\n{visual_block}")
        return "# Receipt\n\n" + "\n".join(sections)

    def _add_native_version(
        self, version: str = "v0.30", parent: str = "v0.1", *, change: bool = True, register: bool = True,
        envelope: dict | None = None, report: str | None = None, receipt: str | None = None,
    ) -> Path:
        if register:
            self._register_second_item(occurred_at="2026-08-18T00:00:03Z")
        model_root = self.root / ".docsfab/reference-model/shared/DOCSFAB-PRODUCT"
        target = model_root / version
        target.mkdir()
        model = envelope or self._native_envelope(version, parent, change=change)
        (target / "model.md").write_text(check_freshness.native_text(model), encoding="utf-8")
        default_report = "# Report\n\n" + (self.NATIVE_CONFLICT if change else "No inconsistencies were found for this input.\n")
        (target / "inconsistency-report.md").write_text(default_report if report is None else report, encoding="utf-8")
        (target / "merge-receipt.md").write_text(
            self._native_receipt(change=change) if receipt is None else receipt, encoding="utf-8"
        )
        history_path = model_root / "history.md"
        history_path.write_text(
            history_path.read_text(encoding="utf-8").replace(
                "| --- | --- |\n", f"| --- | --- |\n| [{version}]({version}/model.md) | now |\n"
            ),
            encoding="utf-8",
        )
        self._write(".docsfab/reference-model/README.md", f"[Current](shared/DOCSFAB-PRODUCT/{version}/model.md)\n")
        return target

    def _native_refusal(self, version: str = "v0.30") -> str:
        registry = check_freshness.canonical_source_registry(self.root)
        with self.assertRaises(check_freshness.FreshnessError) as raised:
            check_freshness.validate_current_model(self.root, version, registry)
        return str(raised.exception)

    def test_native_version_passes_every_checker_entry(self) -> None:
        target = self._add_native_version()
        check_freshness.validate_source_threads(self.root)
        registry = check_freshness.canonical_source_registry(self.root)
        assert sorted(check_freshness.model_history_packages(self.root, registry)) == ["v0.1", "v0.30"]
        check_freshness.validate_current_model(self.root, "v0.30", registry)
        assert check_freshness.unaccounted_source_items(self.root, registry) == []
        assert check_freshness.model_source_item_dispositions(target / "model.md", registry) == {"ITEM-TWO": "included"}
        report = check_freshness.evaluate(self.root, self._snapshot(model_version="v0.30"))
        assert report["status"] == "fresh", report["stale_findings"]

    def test_native_record_only_version_records_no_conflict(self) -> None:
        target = self._add_native_version(change=False)
        registry = check_freshness.canonical_source_registry(self.root)
        check_freshness.validate_current_model(self.root, "v0.30", registry)
        assert check_freshness.unaccounted_source_items(self.root, registry) == []
        report = target / "inconsistency-report.md"
        report.write_text("# Report\n\nNo inconsistencies were found.\n\n" + self.NATIVE_CONFLICT, encoding="utf-8")
        assert "records conflicts for a record-only version" in self._native_refusal()
        report.write_text("# Report\n\nThe input was compared.\n", encoding="utf-8")
        assert "must contain conflict records or state that none were found" in self._native_refusal()

    def test_native_version_without_its_adjudication_is_refused(self) -> None:
        target = self._add_native_version(report="# Report\n\nThe input was compared.\n")
        assert "must contain conflict records or state that none were found" in self._native_refusal()
        report = target / "inconsistency-report.md"
        for replacement in (
            self.NATIVE_CONFLICT.replace('decision_evidence: ["ITEM-TWO"]', 'decision_evidence: ["ITEM-OTHER"]'),
            self.NATIVE_CONFLICT.replace('resulting_claim_ids: ["CLM-ONE"]', 'resulting_claim_ids: ["CLM-OTHER"]'),
            "No inconsistencies were found.\n",
        ):
            report.write_text("# Report\n\n" + replacement, encoding="utf-8")
            assert "must record the adjudication of CLM-ONE citing ITEM-TWO" in self._native_refusal()

    def test_native_claim_change_without_a_decision_is_refused(self) -> None:
        # The materializer's unapproved rendering: the claim changes while its conflict stays open, decided by no one.
        unapproved = (
            self.NATIVE_CONFLICT.replace("status: resolved", "status: open")
            .replace('adjudicator: "fixture-owner"', 'adjudicator: "none"')
            .replace('authority_basis: "owner-decision receipt fixture"', 'authority_basis: "none"')
            .replace('decided_at: "2026-08-18T00:00:05.000Z"', 'decided_at: "none"')
            .replace("disposition: accept-variant", "disposition: none")
            .replace('rationale: "Protected decision custody fixture; the original reply is not reproduced."', 'rationale: "none"')
        )
        assert unapproved.count('"none"') == 4 and "status: open" in unapproved and "disposition: none" in unapproved
        refusal = "changes CLM-ONE without a decision: CONFLICT-NATIVE-001 must be resolved with a disposition other than none"
        target = self._add_native_version(report="# Report\n\n" + unapproved)
        assert refusal in self._native_refusal()
        report = target / "inconsistency-report.md"
        # Each half of the decision is required on its own.
        for replacement in (
            self.NATIVE_CONFLICT.replace("disposition: accept-variant", "disposition: none"),
            self.NATIVE_CONFLICT.replace("status: resolved", "status: open"),
            self.NATIVE_CONFLICT.replace("status: resolved", "status: deferred"),
        ):
            report.write_text("# Report\n\n" + replacement, encoding="utf-8")
            assert refusal in self._native_refusal()
        # Positive control: the same version with its decided record validates.
        report.write_text("# Report\n\n" + self.NATIVE_CONFLICT, encoding="utf-8")
        check_freshness.validate_current_model(self.root, "v0.30", check_freshness.canonical_source_registry(self.root))

    def test_native_receipt_must_name_the_report_and_conflict(self) -> None:
        target = self._add_native_version()
        receipt = target / "merge-receipt.md"
        text = receipt.read_text(encoding="utf-8")
        receipt.write_text(text.replace("## 13. Inconsistency Report and Transitions", "## Thirteen"), encoding="utf-8")
        assert "missing required receipt section 13" in self._native_refusal()
        receipt.write_text(text.replace("- Resolved: `CONFLICT-NATIVE-001`.\n", ""), encoding="utf-8")
        assert "section 13 must name the inconsistency report and its conflict IDs" in self._native_refusal()
        receipt.write_text(text.replace("## 14. Governed Visual Closure", "## Fourteen"), encoding="utf-8")
        assert "missing required receipt section 14" in self._native_refusal()

    def test_native_envelope_lineage_and_registration_refusals(self) -> None:
        target = self._add_native_version()
        model = target / "model.md"
        text = model.read_text(encoding="utf-8")
        model.write_text(text + "\nUnreviewed prose.\n", encoding="utf-8")
        assert "native envelope is invalid: native feedback bytes differ from their envelope" in self._native_refusal()
        for version, parent, item_id, expected in (
            ("v0.30", "v0.5", "ITEM-TWO", "parent v0.5 must be an earlier version listed in the model history"),
            ("v0.30", "v0.31", "ITEM-TWO", "parent v0.31 must be an earlier version listed in the model history"),
            ("v0.30", "v0.1", "ITEM-NONE", "registration item ITEM-NONE is not registered in SRC-ONE"),
        ):
            envelope = self._native_envelope(version, parent, change=True)
            envelope["sourceRegistration"]["itemId"] = item_id
            model.write_text(check_freshness.native_text(envelope), encoding="utf-8")
            assert expected in self._native_refusal()
        envelope = self._native_envelope("v0.30", "v0.1", change=True)
        envelope["version"] = envelope["metadata"]["successorVersion"] = 30
        model.write_text(check_freshness.native_text(envelope), encoding="utf-8")
        assert "native envelope is invalid: native feedback identity differs" in self._native_refusal()

    def test_native_section_14_carries_the_legacy_ancestor_receipt_unchanged(self) -> None:
        stray = "\n```yaml visual-closure-receipt\nschema_version: docsfab.knowledge.visual-closure-receipt/v1\n```\n"
        self._add_native_version(receipt=self._native_receipt(change=True, visual_block=stray))
        assert "section 14 must carry the visual-closure receipt of legacy ancestor v0.1 unchanged" in self._native_refusal()

    def test_native_successor_of_a_visual_model_carries_its_receipt_block(self) -> None:
        self._make_visual_contract_current("v0.29")
        ancestor = (self.root / ".docsfab/reference-model/shared/DOCSFAB-PRODUCT/v0.29/merge-receipt.md").read_text(encoding="utf-8")
        block = ancestor[ancestor.index("```yaml visual-closure-receipt"):ancestor.rindex("```") + 3]
        target = self._add_native_version(parent="v0.29", register=False,
                                          receipt=self._native_receipt(change=True, visual_block=f"\n{block}\n"))
        registry = check_freshness.canonical_source_registry(self.root)
        check_freshness.validate_current_model(self.root, "v0.30", registry)
        receipt = target / "merge-receipt.md"
        receipt.write_text(receipt.read_text(encoding="utf-8").replace("target_state: current", "target_state: open"), encoding="utf-8")
        assert "section 14 must carry the visual-closure receipt of legacy ancestor v0.29 unchanged" in self._native_refusal()

    def test_fresh_snapshot_evaluates_fresh(self) -> None:
        report = check_freshness.evaluate(self.root, self._snapshot())
        assert report["status"] == "fresh"
        assert report["stale_findings"] == []

    def test_v029_current_model_invokes_governed_visual_closure_validator(self) -> None:
        self._make_visual_contract_current()
        check_freshness.validate_current_model(self.root, "v0.29")

        version_root = (
            self.root
            / ".docsfab/reference-model/shared/DOCSFAB-PRODUCT/v0.29"
        )
        receipt_path = version_root / "merge-receipt.md"
        receipt_text = receipt_path.read_text(encoding="utf-8")
        section_start = receipt_text.index("## 14. Governed Visual Closure")
        receipt_path.write_text(
            receipt_text[:section_start]
            + "## 14. Governed Visual Closure\n\nNo governed visual targets.\n",
            encoding="utf-8",
        )
        with self.assertRaises(check_freshness.FreshnessError) as raised:
            check_freshness.validate_current_model(self.root, "v0.29")
        assert "visual-closure-receipt block" in str(raised.exception)
        receipt_path.write_text(receipt_text, encoding="utf-8")

        model_path = (
            version_root / "model.md"
        )
        model_text = model_path.read_text(encoding="utf-8")
        targets_start = model_text.index("governed_visual_targets:\n")
        targets_end = model_text.index("reviewers: [test]\n", targets_start)
        model_path.write_text(
            model_text[:targets_start]
            + "governed_visual_targets: []\n"
            + model_text[targets_end:],
            encoding="utf-8",
        )
        with self.assertRaises(check_freshness.FreshnessError) as raised:
            check_freshness.validate_current_model(self.root, "v0.29")
        assert "governed visual closure is invalid" in str(raised.exception)
        assert "governed_visual_targets" in str(raised.exception)

    def test_v029_rejects_nonexistent_claim_through_full_validation(self) -> None:
        self._make_visual_contract_current()
        source_digest = hashlib.sha256(b"fixture evidence\n").hexdigest()
        source_reference = {
            "source_thread_id": "SRC-ONE",
            "item_id": "ITEM-ONE",
            "version": f"sha256:{source_digest}",
            "representation_id": "original",
            "member_id": "none",
            "integrity": f"sha256:{source_digest}",
        }
        manifest = {
            "schema_version": "docsfab.knowledge.visual-closure-manifest/v1",
            "visual_id": "VISUAL-ONE",
            "required_source_representations": [source_reference],
            "accepted_decision_ids": ["CLM-NOT-REAL"],
        }
        manifest_bytes = (
            json.dumps(manifest, indent=2, sort_keys=True) + "\n"
        ).encode("utf-8")
        new_digest = hashlib.sha256(manifest_bytes).hexdigest()
        retained = f"artifacts/sha256/{new_digest[:2]}/{new_digest}"
        thread_root = (
            self.root / ".docsfab/reference-model/source-threads/SRC-ONE"
        )
        retained_path = thread_root / retained
        retained_path.parent.mkdir(parents=True, exist_ok=True)
        retained_path.write_bytes(manifest_bytes)
        item_path = thread_root / "items/ITEM-TWO.json"
        item = json.loads(item_path.read_text(encoding="utf-8"))
        item["version"]["value"] = new_digest
        representation = item["representations"][0]
        representation["size_bytes"] = len(manifest_bytes)
        representation["locator"] = {
            "scheme": "thread-artifact",
            "uri": retained,
            "repository": None,
            "commit": None,
            "path": None,
            "external_version": None,
            "retained_copy": retained,
        }
        representation["integrity"]["value"] = new_digest
        item_path.write_text(json.dumps(item, indent=2), encoding="utf-8")
        self._render_thread()

        version_root = (
            self.root / ".docsfab/reference-model/shared/DOCSFAB-PRODUCT/v0.29"
        )
        model_path = version_root / "model.md"
        model_text = model_path.read_text(encoding="utf-8")
        model_text = model_text.replace(self.visual_manifest_digest, new_digest)
        model_text = model_text.replace(
            "accepted_decision_ids: [CLM-TWO]",
            "accepted_decision_ids: [CLM-NOT-REAL]",
        )
        model_text = model_text.replace(
            "governing_decision_ids: [CLM-TWO]",
            "governing_decision_ids: [CLM-NOT-REAL]",
        )
        model_text = model_text.replace(
            "decision_id: CLM-TWO", "decision_id: CLM-NOT-REAL"
        )
        model_path.write_text(model_text, encoding="utf-8")
        receipt_path = version_root / "merge-receipt.md"
        receipt_text = receipt_path.read_text(encoding="utf-8")
        receipt_text = receipt_text.replace(self.visual_manifest_digest, new_digest)
        receipt_text = receipt_text.replace(
            "governing_decision_ids: [CLM-TWO]",
            "governing_decision_ids: [CLM-NOT-REAL]",
        )
        receipt_path.write_text(receipt_text, encoding="utf-8")

        with self.assertRaises(check_freshness.FreshnessError) as raised:
            check_freshness.validate_current_model(self.root, "v0.29")
        assert "must resolve to exactly one model claim; found 0" in str(raised.exception)

    def test_v029_ignores_nested_semantic_record_decoys(self) -> None:
        self._make_visual_contract_current()
        version_root = (
            self.root / ".docsfab/reference-model/shared/DOCSFAB-PRODUCT/v0.29"
        )
        model_path = version_root / "model.md"
        model_text = model_path.read_text(encoding="utf-8")
        model_text = (
            "````text\n```yaml\nmerge_id: DECOY\nmodel_version: v999.0\n```\n````\n\n"
            + model_text.replace(
                "## Governed Visuals",
                "````text\n### CLM-DECOY: Nested\n\n"
                "```yaml\nclaim_id: CLM-DECOY\n```\n````\n\n"
                "## Governed Visuals",
            )
        )
        model_path.write_text(model_text, encoding="utf-8")

        report_path = version_root / "inconsistency-report.md"
        report_path.write_text(
            "````text\n## CONFLICT-DECOY: Nested\n\n"
            "```yaml\nconflict_id: CONFLICT-DECOY\nstatus: open\n```\n````\n\n"
            + report_path.read_text(encoding="utf-8"),
            encoding="utf-8",
        )
        receipt_path = version_root / "merge-receipt.md"
        receipt_path.write_text(
            "````text\n## 14. Governed Visual Closure\n\n"
            "```yaml visual-closure-receipt\n"
            "schema_version: decoy\nvisual_closures: []\n```\n````\n\n"
            + receipt_path.read_text(encoding="utf-8"),
            encoding="utf-8",
        )
        check_freshness.validate_current_model(self.root, "v0.29")

    def test_document_change_is_stale(self) -> None:
        snapshot = self._snapshot()
        self._write("docs/about/page.md", "---\ntitle: Page\n---\n\nChanged.\n")
        report = check_freshness.evaluate(self.root, snapshot)
        assert report["status"] == "stale"
        assert "documentation-content-drift" in {
            finding["code"] for finding in report["stale_findings"]
        }

    def test_new_source_item_is_stale(self) -> None:
        snapshot = self._snapshot()
        self._register_second_item()
        report = check_freshness.evaluate(self.root, snapshot)
        codes = {finding["code"] for finding in report["stale_findings"]}
        assert report["status"] == "stale"
        assert "unaccounted-source-item" in codes
        assert "source-thread-head-drift" in codes

    def test_item_id_substring_does_not_count_as_model_accounting(self) -> None:
        self._register_second_item()
        model_path = (
            self.root
            / ".docsfab/reference-model/shared/DOCSFAB-PRODUCT/v0.1/model.md"
        )
        model_path.write_text(
            model_path.read_text(encoding="utf-8").replace(
                "source_claims: [ITEM-ONE]",
                "source_claims: [ITEM-ONE, ITEM-TWO-LONGER]",
            ),
            encoding="utf-8",
        )
        missing = check_freshness.unaccounted_source_items(self.root)
        assert missing == [{"thread_id": "SRC-ONE", "item_id": "ITEM-TWO"}]

    def test_repository_change_is_stale(self) -> None:
        snapshot = self._snapshot()
        self._write("packages/runtime/source.txt", "changed\n")
        report = check_freshness.evaluate(self.root, snapshot)
        assert report["status"] == "stale"
        assert "repository-input-drift" in {
            finding["code"] for finding in report["stale_findings"]
        }

    def test_snapshot_rejects_uncommitted_watched_bytes(self) -> None:
        self._write("packages/runtime/source.txt", "changed\n")
        with self.assertRaises(check_freshness.FreshnessError) as raised:
            self._snapshot()
        assert "do not match HEAD" in str(raised.exception)

    def test_unresolvable_repository_revision_is_advisory_stale(self) -> None:
        snapshot = self._snapshot()
        snapshot["repository_snapshot"]["git_revision"] = "0" * 40
        report = check_freshness.evaluate(self.root, snapshot)
        codes = {finding["code"] for finding in report["stale_findings"]}
        assert report["status"] == "stale"
        assert "receipt-revision-unresolvable" in codes

    def test_repository_revision_digest_is_bound(self) -> None:
        snapshot = self._snapshot()
        snapshot["repository_snapshot"]["content_sha256"] = "0" * 64
        with self.assertRaises(check_freshness.FreshnessError) as raised:
            check_freshness.evaluate(self.root, snapshot)
        assert "does not match its recorded revision" in str(raised.exception)

    def test_review_evidence_must_exist(self) -> None:
        snapshot = self._snapshot()
        snapshot["independent_review"]["evidence"] = (
            ".docsfab/reference-model/assessments/not-a-review.md"
        )
        with self.assertRaises(check_freshness.FreshnessError) as raised:
            check_freshness.evaluate(self.root, snapshot)
        assert "must be one tracked file" in str(raised.exception)

    def test_review_evidence_must_match_target_commit_and_tree(self) -> None:
        snapshot = self._snapshot()
        finalization_commit = self._git_text("rev-parse", "HEAD")
        finalization_tree = self._git_text("rev-parse", "HEAD^{tree}")
        review = snapshot["independent_review"]
        review["reviewed_commit"] = finalization_commit
        review["reviewed_tree"] = finalization_tree
        review["finalization_paths"] = []
        with self.assertRaises(check_freshness.FreshnessError) as raised:
            check_freshness.evaluate(self.root, snapshot)
        assert "exact reviewed target commit and tree" in str(raised.exception)

    def test_review_parser_rejects_contradictory_verdict(self) -> None:
        report = (
            "# Review\n\n"
            "## Verdict\n\n"
            "**PASS**\n\n"
            f"- Reviewed target: `{self.reviewed_commit}`\n"
            f"- Reviewed target tree: `{self.reviewed_tree}`\n\n"
            "**BLOCK**\n"
        ).encode()
        with self.assertRaises(check_freshness.FreshnessError) as raised:
            check_freshness._assert_review_report(
                report,
                reviewed_commit=self.reviewed_commit,
                reviewed_tree=self.reviewed_tree,
                label="attack review",
            )
        assert "uncontradicted PASS" in str(raised.exception)

    def test_review_parser_rejects_fenced_pass_example(self) -> None:
        report = (
            "# Review\n\n"
            "## Verdict\n\n"
            "**BLOCK**\n\n"
            "~~~markdown\n"
            "## Verdict\n\n"
            "**PASS**\n\n"
            f"- Reviewed target: `{self.reviewed_commit}`\n"
            f"- Reviewed target tree: `{self.reviewed_tree}`\n"
            "~~~\n"
        ).encode()
        with self.assertRaises(check_freshness.FreshnessError) as raised:
            check_freshness._assert_review_report(
                report,
                reviewed_commit=self.reviewed_commit,
                reviewed_tree=self.reviewed_tree,
                label="attack review",
            )
        assert "uncontradicted PASS" in str(raised.exception)

    def test_review_parser_rejects_invalid_backtick_fence_info(self) -> None:
        for spaces in (0, 1, 2, 3):
            indent = " " * spaces
            report = (
                "# Review\n\n"
                "## Verdict\n\n"
                "**PASS**\n\n"
                f"- Reviewed target: `{self.reviewed_commit}`\n"
                f"- Reviewed target tree: `{self.reviewed_tree}`\n\n"
                f"{indent}```markdown`invalid-info\n"
                "## Verdict\n\n"
                "**BLOCK**\n"
                "```\n"
            ).encode()
            with self.subTest(spaces=spaces), self.assertRaises(
                check_freshness.FreshnessError
            ) as raised:
                check_freshness._assert_review_report(
                    report,
                    reviewed_commit=self.reviewed_commit,
                    reviewed_tree=self.reviewed_tree,
                    label="attack review",
                )
            assert "exactly one top-level verdict" in str(raised.exception)

    def test_review_parser_rejects_commonmark_indented_block(self) -> None:
        for spaces in (1, 2, 3):
            indent = " " * spaces
            report = (
                "# Review\n\n"
                f"{indent}## Verdict\n\n"
                f"{indent}**BLOCK**\n\n"
                "## Verdict\n\n"
                "**PASS**\n\n"
                f"- Reviewed target: `{self.reviewed_commit}`\n"
                f"- Reviewed target tree: `{self.reviewed_tree}`\n"
            ).encode()
            with self.subTest(spaces=spaces), self.assertRaises(
                check_freshness.FreshnessError
            ) as raised:
                check_freshness._assert_review_report(
                    report,
                    reviewed_commit=self.reviewed_commit,
                    reviewed_tree=self.reviewed_tree,
                    label="attack review",
                )
            assert "exactly one top-level verdict" in str(raised.exception)

    def test_review_parser_rejects_commonmark_indented_duplicate_targets(self) -> None:
        for spaces in (1,):
            indent = " " * spaces
            report = (
                "# Review\n\n"
                "## Verdict\n\n"
                "**PASS**\n\n"
                f"- Reviewed target: `{self.reviewed_commit}`\n"
                f"- Reviewed target tree: `{self.reviewed_tree}`\n"
                f"{indent}- Reviewed target: `{self.reviewed_commit}`\n"
                f"{indent}- Reviewed target tree: `{self.reviewed_tree}`\n"
            ).encode()
            with self.subTest(spaces=spaces), self.assertRaises(
                check_freshness.FreshnessError
            ) as raised:
                check_freshness._assert_review_report(
                    report,
                    reviewed_commit=self.reviewed_commit,
                    reviewed_tree=self.reviewed_tree,
                    label="attack review",
                )
            assert "exact reviewed target commit and tree exactly once" in str(
                raised.exception
            )

    def test_review_parser_ignores_nested_indented_target_examples(self) -> None:
        for spaces in (2, 3):
            indent = " " * spaces
            report = (
                "# Review\n\n"
                "## Verdict\n\n"
                "**PASS**\n\n"
                f"- Reviewed target: `{self.reviewed_commit}`\n"
                f"- Reviewed target tree: `{self.reviewed_tree}`\n"
                f"{indent}- Reviewed target: `{'a' * 40}`\n"
                f"{indent}- Reviewed target tree: `{'b' * 40}`\n"
            ).encode()
            check_freshness._assert_review_report(
                report,
                reviewed_commit=self.reviewed_commit,
                reviewed_tree=self.reviewed_tree,
                label="review",
            )
            assert b"  - Reviewed target:" in report

    def test_review_parser_rejects_targets_nested_under_ordered_list(self) -> None:
        report = (
            "# Review\n\n"
            "## Verdict\n\n"
            "**PASS**\n\n"
            "1. Illustrative metadata:\n"
            f"   - Reviewed target: `{self.reviewed_commit}`\n"
            f"   - Reviewed target tree: `{self.reviewed_tree}`\n"
        ).encode()
        with self.assertRaises(check_freshness.FreshnessError) as raised:
            check_freshness._assert_review_report(
                report,
                reviewed_commit=self.reviewed_commit,
                reviewed_tree=self.reviewed_tree,
                label="attack review",
            )
        assert "exact reviewed target commit and tree exactly once" in str(
            raised.exception
        )

    def test_review_parser_rejects_targets_nested_under_bullet_list(self) -> None:
        report = (
            "# Review\n\n"
            "## Verdict\n\n"
            "**PASS**\n\n"
            "- Illustrative metadata:\n"
            f"  - Reviewed target: `{self.reviewed_commit}`\n"
            f"  - Reviewed target tree: `{self.reviewed_tree}`\n"
        ).encode()
        with self.assertRaises(check_freshness.FreshnessError) as raised:
            check_freshness._assert_review_report(
                report,
                reviewed_commit=self.reviewed_commit,
                reviewed_tree=self.reviewed_tree,
                label="attack review",
            )
        assert "exact reviewed target commit and tree exactly once" in str(
            raised.exception
        )

    def test_review_parser_rejects_targets_in_one_item_continuations(self) -> None:
        report = (
            "# Review\n\n"
            "## Verdict\n\n"
            "**PASS**\n\n"
            "- Illustrative metadata only.\n\n"
            f"  Reviewed target: `{self.reviewed_commit}`\n\n"
            f"  Reviewed target tree: `{self.reviewed_tree}`\n"
        ).encode()
        with self.assertRaises(check_freshness.FreshnessError) as raised:
            check_freshness._assert_review_report(
                report,
                reviewed_commit=self.reviewed_commit,
                reviewed_tree=self.reviewed_tree,
                label="attack review",
            )
        assert "exact reviewed target commit and tree exactly once" in str(
            raised.exception
        )

    def test_review_parser_rejects_targets_in_two_item_continuations(self) -> None:
        report = (
            "# Review\n\n"
            "## Verdict\n\n"
            "**PASS**\n\n"
            "- Illustrative commit metadata.\n\n"
            f"  Reviewed target: `{self.reviewed_commit}`\n\n"
            "- Illustrative tree metadata.\n\n"
            f"  Reviewed target tree: `{self.reviewed_tree}`\n"
        ).encode()
        with self.assertRaises(check_freshness.FreshnessError) as raised:
            check_freshness._assert_review_report(
                report,
                reviewed_commit=self.reviewed_commit,
                reviewed_tree=self.reviewed_tree,
                label="attack review",
            )
        assert "exact reviewed target commit and tree exactly once" in str(
            raised.exception
        )

    def test_review_parser_ignores_four_space_indented_code(self) -> None:
        report = (
            "# Review\n\n"
            "## Verdict\n\n"
            "**PASS**\n\n"
            f"- Reviewed target: `{self.reviewed_commit}`\n"
            f"- Reviewed target tree: `{self.reviewed_tree}`\n\n"
            "Ordinary review prose.\n\n"
            "    ## Verdict\n\n"
            "    **BLOCK**\n"
            f"    - Reviewed target: `{self.reviewed_commit}`\n"
            f"    - Reviewed target tree: `{self.reviewed_tree}`\n"
        ).encode()
        assert b"    ## Verdict" in report
        assert b"    **BLOCK**" in report
        check_freshness._assert_review_report(
            report,
            reviewed_commit=self.reviewed_commit,
            reviewed_tree=self.reviewed_tree,
            label="review",
        )

    def test_snapshot_rejects_block_report_with_fenced_pass_example(self) -> None:
        self._write(
            ".docsfab/reference-model/assessments/clean-review.md",
            "# Review\n\n"
            "## Verdict\n\n"
            "**BLOCK**\n\n"
            "~~~markdown\n"
            "## Verdict\n\n"
            "**PASS**\n\n"
            f"- Reviewed target: `{self.reviewed_commit}`\n"
            f"- Reviewed target tree: `{self.reviewed_tree}`\n"
            "~~~\n",
        )
        self._git("add", ".docsfab/reference-model/assessments/clean-review.md")
        self._git("commit", "-qm", "retain attack review")
        with self.assertRaises(check_freshness.FreshnessError) as raised:
            self._snapshot()
        assert "uncontradicted PASS" in str(raised.exception)

    def test_snapshot_rejects_invalid_backtick_fence_block(self) -> None:
        self._write(
            ".docsfab/reference-model/assessments/clean-review.md",
            "# Review\n\n"
            "## Verdict\n\n"
            "**PASS**\n\n"
            f"- Reviewed target: `{self.reviewed_commit}`\n"
            f"- Reviewed target tree: `{self.reviewed_tree}`\n\n"
            "```markdown`invalid-info\n"
            "## Verdict\n\n"
            "**BLOCK**\n"
            "```\n",
        )
        self._git("add", ".docsfab/reference-model/assessments/clean-review.md")
        self._git("commit", "-qm", "retain invalid-fence attack review")
        with self.assertRaises(check_freshness.FreshnessError) as raised:
            self._snapshot()
        assert "exactly one top-level verdict" in str(raised.exception)

    def test_snapshot_rejects_nested_target_example(self) -> None:
        self._write(
            ".docsfab/reference-model/assessments/clean-review.md",
            "# Review\n\n"
            "## Verdict\n\n"
            "**PASS**\n\n"
            "1. Illustrative metadata only:\n"
            f"   - Reviewed target: `{self.reviewed_commit}`\n"
            f"   - Reviewed target tree: `{self.reviewed_tree}`\n",
        )
        self._git("add", ".docsfab/reference-model/assessments/clean-review.md")
        self._git("commit", "-qm", "retain nested-target attack review")
        with self.assertRaises(check_freshness.FreshnessError) as raised:
            self._snapshot()
        assert "exact reviewed target commit and tree exactly once" in str(
            raised.exception
        )

    def test_snapshot_rejects_continuation_target_example(self) -> None:
        self._write(
            ".docsfab/reference-model/assessments/clean-review.md",
            "# Review\n\n"
            "## Verdict\n\n"
            "**PASS**\n\n"
            "- Illustrative metadata only.\n\n"
            f"  Reviewed target: `{self.reviewed_commit}`\n\n"
            f"  Reviewed target tree: `{self.reviewed_tree}`\n",
        )
        self._git("add", ".docsfab/reference-model/assessments/clean-review.md")
        self._git("commit", "-qm", "retain continuation attack review")
        with self.assertRaises(check_freshness.FreshnessError) as raised:
            self._snapshot()
        assert "exact reviewed target commit and tree exactly once" in str(
            raised.exception
        )

    def test_snapshot_rejects_commonmark_indented_block(self) -> None:
        self._write(
            ".docsfab/reference-model/assessments/clean-review.md",
            "# Review\n\n"
            " ## Verdict\n\n"
            " **BLOCK**\n\n"
            "## Verdict\n\n"
            "**PASS**\n\n"
            f"- Reviewed target: `{self.reviewed_commit}`\n"
            f"- Reviewed target tree: `{self.reviewed_tree}`\n",
        )
        self._git("add", ".docsfab/reference-model/assessments/clean-review.md")
        self._git("commit", "-qm", "retain indented attack review")
        with self.assertRaises(check_freshness.FreshnessError) as raised:
            self._snapshot()
        assert "exactly one top-level verdict" in str(raised.exception)

    def test_snapshot_rejects_unreviewed_finalization_path(self) -> None:
        self._write("packages/runtime/source.txt", "changed\n")
        self._git("add", "packages/runtime/source.txt")
        self._git("commit", "-qm", "unreviewed product change")
        with self.assertRaises(check_freshness.FreshnessError) as raised:
            self._snapshot()
        assert "finalization may change only" in str(raised.exception)

    def test_watched_repository_symlink_is_an_error(self) -> None:
        product_path = self.root / "packages/runtime/source.txt"
        outside = self.root / "outside-a.txt"
        outside.write_text("runtime\n", encoding="utf-8")
        product_path.unlink()
        product_path.symlink_to(outside)
        self._git("add", "packages/runtime/source.txt")
        with self.assertRaises(check_freshness.FreshnessError) as raised:
            self._snapshot()
        assert "symbolic link" in str(raised.exception)

    def test_watched_repository_symlinked_directory_is_an_error(self) -> None:
        runtime = self.root / "packages/runtime"
        outside = self.root / "outside-runtime"
        shutil.copytree(runtime, outside)
        shutil.rmtree(runtime)
        runtime.symlink_to(outside, target_is_directory=True)
        with self.assertRaises(check_freshness.FreshnessError) as raised:
            self._snapshot()
        assert "symbolic link" in str(raised.exception)

    def test_documentation_symlink_is_an_error(self) -> None:
        page = self.root / "docs/about/page.md"
        outside = self.root / "outside-page.md"
        outside.write_text(page.read_text(encoding="utf-8"), encoding="utf-8")
        page.unlink()
        page.symlink_to(outside)
        with self.assertRaises(check_freshness.FreshnessError) as raised:
            self._snapshot()
        assert "symbolic link" in str(raised.exception)

    def test_incomplete_review_is_blocked(self) -> None:
        snapshot = self._snapshot(review_status="pending")
        report = check_freshness.evaluate(self.root, snapshot)
        assert report["status"] == "blocked"
        assert report["blocked_findings"][0]["code"] == "independent-review-incomplete"

    def test_malformed_event_ledger_is_an_error(self) -> None:
        snapshot = self._snapshot()
        self._write(
            ".docsfab/reference-model/source-threads/SRC-ONE/events.jsonl",
            "{not-json}\n",
        )
        with self.assertRaises(check_freshness.FreshnessError) as raised:
            check_freshness.evaluate(self.root, snapshot)
        assert "source thread" in str(raised.exception)

    def test_dangling_source_thread_directory_is_an_error(self) -> None:
        snapshot = self._snapshot()
        self._write(
            ".docsfab/reference-model/source-threads/SRC-BROKEN/events.jsonl",
            "{not-json}\n",
        )
        with self.assertRaises(check_freshness.FreshnessError) as raised:
            check_freshness.evaluate(self.root, snapshot)
        assert "requires a regular file: thread.json" in str(raised.exception)

    def test_malformed_item_is_an_error(self) -> None:
        snapshot = self._snapshot()
        self._write(
            ".docsfab/reference-model/source-threads/SRC-ONE/items/ITEM-ONE.json",
            "{}\n",
        )
        with self.assertRaises(check_freshness.FreshnessError) as raised:
            check_freshness.evaluate(self.root, snapshot)
        assert "source thread" in str(raised.exception)

    def test_retained_artifact_mutation_is_an_error(self) -> None:
        snapshot = self._snapshot()
        artifact_paths = list(
            (
                self.root
                / ".docsfab/reference-model/source-threads/SRC-ONE/artifacts/sha256"
            ).glob("*/*")
        )
        assert len(artifact_paths) == 1
        artifact_paths[0].write_text("mutated\n", encoding="utf-8")
        with self.assertRaises(check_freshness.FreshnessError) as raised:
            check_freshness.evaluate(self.root, snapshot)
        assert "hash mismatch" in str(raised.exception)

    def test_valid_model_mutation_is_stale(self) -> None:
        snapshot = self._snapshot()
        model_path = (
            self.root
            / ".docsfab/reference-model/shared/DOCSFAB-PRODUCT/v0.1/model.md"
        )
        model_path.write_text(
            model_path.read_text(encoding="utf-8") + "\n<!-- mutation -->\n",
            encoding="utf-8",
        )
        report = check_freshness.evaluate(self.root, snapshot)
        assert report["status"] == "stale"
        assert "model-history-content-drift" in {
            finding["code"] for finding in report["stale_findings"]
        }

    def test_malformed_current_model_is_an_error(self) -> None:
        snapshot = self._snapshot()
        model_path = (
            self.root
            / ".docsfab/reference-model/shared/DOCSFAB-PRODUCT/v0.1/model.md"
        )
        model_path.write_text(
            model_path.read_text(encoding="utf-8").replace("action: added\n", ""),
            encoding="utf-8",
        )
        with self.assertRaises(check_freshness.FreshnessError) as raised:
            check_freshness.evaluate(self.root, snapshot)
        assert "missing fields" in str(raised.exception)

    def test_syntactically_invalid_claim_sequence_is_an_error(self) -> None:
        model_path = (
            self.root
            / ".docsfab/reference-model/shared/DOCSFAB-PRODUCT/v0.1/model.md"
        )
        model_path.write_text(
            model_path.read_text(encoding="utf-8").replace(
                "source_claims: [ITEM-ONE]", "source_claims: ["
            ),
            encoding="utf-8",
        )
        with self.assertRaises(check_freshness.FreshnessError) as raised:
            self._snapshot()
        assert "valid contract YAML" in str(raised.exception)

    def test_invalid_claim_yaml_forms_are_errors(self) -> None:
        model_path = (
            self.root
            / ".docsfab/reference-model/shared/DOCSFAB-PRODUCT/v0.1/model.md"
        )
        original = model_path.read_text(encoding="utf-8")
        mutations = [
            ("The fixture is valid.", "invalid: nested mapping"),
            ("The fixture is valid.", "invalid:"),
            ("The fixture is valid.", "? invalid"),
            ("The fixture is valid.", "- invalid"),
            ("The fixture is valid.", '"invalid\\q"'),
            ("The fixture is valid.", '"unterminated'),
            ("The fixture is valid.", "!unsafe value"),
            ("The fixture is valid.", "&anchored value"),
            ("The fixture is valid.", "valid # hidden comment"),
            ("source_claims: [ITEM-ONE]", "source_claims: [ITEM-ONE, ]"),
            ("scope: {component: fixture}", "scope: {component}"),
        ]
        for old, new in mutations:
            with self.subTest(mutation=new):
                model_path.write_text(original.replace(old, new), encoding="utf-8")
                with self.assertRaises(check_freshness.FreshnessError) as raised:
                    self._snapshot()
                assert str(raised.exception)
        model_path.write_text(original, encoding="utf-8")

    def test_invalid_merge_boundary_sibling_is_an_error(self) -> None:
        model_path = (
            self.root
            / ".docsfab/reference-model/shared/DOCSFAB-PRODUCT/v0.1/model.md"
        )
        model_path.write_text(
            model_path.read_text(encoding="utf-8").replace(
                "reviewers: [test]",
                "reviewers: [test]\n  malformed: nested under scalar",
            ),
            encoding="utf-8",
        )
        with self.assertRaises(check_freshness.FreshnessError) as raised:
            self._snapshot()
        assert "valid contract YAML" in str(raised.exception)

    def test_invalid_nested_conflict_yaml_is_an_error(self) -> None:
        report_path = (
            self.root
            / ".docsfab/reference-model/shared/DOCSFAB-PRODUCT/v0.1/"
            "inconsistency-report.md"
        )
        report_path.write_text(
            """# Report

## CONFLICT-ONE — Fixture conflict

```yaml
conflict_id: CONFLICT-ONE
status: resolved
classification: behavior-conflict
summary: A resolved fixture conflict.
  malformed: nested under scalar
source_variants:
  - source_claim_ids: [ITEM-ONE]
    statement: The first variant.
    scope: {component: fixture}
    exact_evidence: [ITEM-ONE]
why_inconsistent: The variants differ.
consequence_if_unresolved: The fixture is ambiguous.
resolution_owner: test
blocks_targets: []
adjudication:
  adjudicator: test
  authority_basis: fixture authority
  decided_at: 2026-08-18T00:00:00Z
  disposition: accept-variant
  rationale: fixture decision
  decision_evidence: [ITEM-ONE]
  resulting_claim_ids: [CLM-ONE]
```
""",
            encoding="utf-8",
        )
        with self.assertRaises(check_freshness.FreshnessError) as raised:
            self._snapshot()
        assert "valid contract YAML" in str(raised.exception)

    def test_comment_only_item_reference_does_not_count_as_accounting(self) -> None:
        self._register_second_item()
        model_path = (
            self.root
            / ".docsfab/reference-model/shared/DOCSFAB-PRODUCT/v0.1/model.md"
        )
        model_path.write_text(
            model_path.read_text(encoding="utf-8")
            + "\n<!--\nitem_id: ITEM-TWO\n-->\n",
            encoding="utf-8",
        )
        assert check_freshness.unaccounted_source_items(self.root) == [
            {"thread_id": "SRC-ONE", "item_id": "ITEM-TWO"}
        ]

    def test_explicit_source_item_dispositions_count_as_accounting(self) -> None:
        self._register_second_item()
        model_path = (
            self.root
            / ".docsfab/reference-model/shared/DOCSFAB-PRODUCT/v0.1/model.md"
        )
        original = model_path.read_text(encoding="utf-8")
        marker = "    thread_head_event_ids: [EVT-TWO]\n"
        for disposition in sorted(check_freshness.SOURCE_ITEM_DISPOSITIONS):
            with self.subTest(disposition=disposition):
                addition = (
                    "source_item_dispositions:\n"
                    "  - item_id: ITEM-TWO\n"
                    f"    disposition: {disposition}\n"
                    "    rationale: Explicit fixture disposition.\n"
                )
                model_path.write_text(
                    original.replace(marker, marker + addition), encoding="utf-8"
                )
                assert check_freshness.unaccounted_source_items(self.root) == []
        model_path.write_text(original, encoding="utf-8")

    def test_source_item_wrong_thread_is_an_error(self) -> None:
        model_path = (
            self.root
            / ".docsfab/reference-model/shared/DOCSFAB-PRODUCT/v0.1/model.md"
        )
        model_path.write_text(
            model_path.read_text(encoding="utf-8").replace(
                "source_thread_id: SRC-ONE", "source_thread_id: SRC-NOT-ONE"
            ),
            encoding="utf-8",
        )
        with self.assertRaises(check_freshness.FreshnessError) as raised:
            self._snapshot()
        assert "expected SRC-ONE" in str(raised.exception)

    def test_unknown_explicit_source_item_disposition_is_an_error(self) -> None:
        model_path = (
            self.root
            / ".docsfab/reference-model/shared/DOCSFAB-PRODUCT/v0.1/model.md"
        )
        marker = "reviewers: [test]\n"
        addition = (
            "source_item_dispositions:\n"
            "  - item_id: ITEM-NOT-REGISTERED\n"
            "    disposition: pending\n"
            "    rationale: Fixture pending item.\n"
        )
        model_path.write_text(
            model_path.read_text(encoding="utf-8").replace(
                marker, addition + marker
            ),
            encoding="utf-8",
        )
        with self.assertRaises(check_freshness.FreshnessError) as raised:
            self._snapshot()
        assert "is not registered" in str(raised.exception)

    def test_source_item_version_is_bound_to_registry(self) -> None:
        model_path = (
            self.root
            / ".docsfab/reference-model/shared/DOCSFAB-PRODUCT/v0.1/model.md"
        )
        model_path.write_text(
            re.sub(
                r"    version: sha256:[a-f0-9]{64}",
                "    version: sha256:" + "0" * 64,
                model_path.read_text(encoding="utf-8"),
                count=1,
            ),
            encoding="utf-8",
        )
        with self.assertRaises(check_freshness.FreshnessError) as raised:
            self._snapshot()
        assert ".version is" in str(raised.exception)

    def test_source_item_integrity_is_bound_to_registry(self) -> None:
        model_path = (
            self.root
            / ".docsfab/reference-model/shared/DOCSFAB-PRODUCT/v0.1/model.md"
        )
        model_path.write_text(
            re.sub(
                r"    integrity: sha256:[a-f0-9]{64}",
                "    integrity: sha256:" + "0" * 64,
                model_path.read_text(encoding="utf-8"),
                count=1,
            ),
            encoding="utf-8",
        )
        with self.assertRaises(check_freshness.FreshnessError) as raised:
            self._snapshot()
        assert ".integrity is" in str(raised.exception)

    def test_source_item_representation_is_bound_to_registry(self) -> None:
        model_path = (
            self.root
            / ".docsfab/reference-model/shared/DOCSFAB-PRODUCT/v0.1/model.md"
        )
        model_path.write_text(
            model_path.read_text(encoding="utf-8").replace(
                "representation_id: original", "representation_id: absent"
            ),
            encoding="utf-8",
        )
        with self.assertRaises(check_freshness.FreshnessError) as raised:
            self._snapshot()
        assert "does not contain representation absent" in str(raised.exception)

    def test_source_item_multi_member_selection_is_an_error(self) -> None:
        model_path = (
            self.root
            / ".docsfab/reference-model/shared/DOCSFAB-PRODUCT/v0.1/model.md"
        )
        model_path.write_text(
            model_path.read_text(encoding="utf-8").replace(
                "member_id: none", "member_id: member-one, member-two"
            ),
            encoding="utf-8",
        )
        with self.assertRaises(check_freshness.FreshnessError) as raised:
            self._snapshot()
        assert "must select exactly one member" in str(raised.exception)

    def test_source_item_member_integrity_is_bound_to_selected_member(self) -> None:
        _, member_two_integrity = self._configure_collection_members()
        model_path = (
            self.root
            / ".docsfab/reference-model/shared/DOCSFAB-PRODUCT/v0.1/model.md"
        )
        model_text = model_path.read_text(encoding="utf-8").replace(
            "member_id: none", "member_id: member-one"
        )
        model_text = re.sub(
            r"    integrity: sha256:[a-f0-9]{64}",
            f"    integrity: sha256:{member_two_integrity}",
            model_text,
            count=1,
        )
        model_path.write_text(model_text, encoding="utf-8")
        with self.assertRaises(check_freshness.FreshnessError) as raised:
            self._snapshot()
        assert ".integrity is" in str(raised.exception)

    def test_source_item_member_selection_rejects_item_level_integrity(self) -> None:
        self._configure_collection_members()
        model_path = (
            self.root
            / ".docsfab/reference-model/shared/DOCSFAB-PRODUCT/v0.1/model.md"
        )
        model_path.write_text(
            model_path.read_text(encoding="utf-8").replace(
                "member_id: none", "member_id: member-one"
            ),
            encoding="utf-8",
        )
        with self.assertRaises(check_freshness.FreshnessError) as raised:
            self._snapshot()
        assert ".integrity is" in str(raised.exception)

    def test_source_item_member_selection_accepts_exact_member_integrity(self) -> None:
        member_one_integrity, _ = self._configure_collection_members()
        model_path = (
            self.root
            / ".docsfab/reference-model/shared/DOCSFAB-PRODUCT/v0.1/model.md"
        )
        model_text = model_path.read_text(encoding="utf-8").replace(
            "member_id: none", "member_id: member-one"
        )
        model_text = re.sub(
            r"    integrity: sha256:[a-f0-9]{64}",
            f"    integrity: sha256:{member_one_integrity}",
            model_text,
            count=1,
        )
        model_path.write_text(model_text, encoding="utf-8")
        snapshot = self._snapshot()
        assert snapshot["model"]["version"] == "v0.1"

    def test_source_item_stale_thread_head_is_an_error(self) -> None:
        model_path = (
            self.root
            / ".docsfab/reference-model/shared/DOCSFAB-PRODUCT/v0.1/model.md"
        )
        model_path.write_text(
            model_path.read_text(encoding="utf-8").replace(
                "thread_head_event_ids: [EVT-TWO]",
                "thread_head_event_ids: [EVT-ONE]",
            ),
            encoding="utf-8",
        )
        with self.assertRaises(check_freshness.FreshnessError) as raised:
            self._snapshot()
        assert "exact thread head" in str(raised.exception)

    def test_source_item_exact_frontier_accepts_older_sibling_head(self) -> None:
        self._register_second_item(
            parent_event_id="EVT-ONE",
            occurred_at="2026-08-18T00:00:01.500Z",
        )
        self._select_second_item_in_model("EVT-TWO, EVT-THREE")
        snapshot = self._snapshot()
        assert snapshot["model"]["version"] == "v0.1"

    def test_source_item_registration_after_merge_is_an_error(self) -> None:
        self._register_second_item()
        self._select_second_item_in_model("EVT-TWO")
        with self.assertRaises(check_freshness.FreshnessError) as raised:
            self._snapshot()
        assert "was registered after the merge boundary" in str(raised.exception)

    def test_source_item_child_before_parent_is_an_error(self) -> None:
        self._register_second_item(
            occurred_at="2026-08-18T00:00:00.500Z",
            render=False,
        )
        self._select_second_item_in_model("EVT-THREE")
        with self.assertRaises(check_freshness.FreshnessError) as raised:
            self._snapshot()
        assert "occurred_at precedes parent EVT-TWO.occurred_at" in str(
            raised.exception
        )

    def test_source_item_future_thread_head_is_an_error(self) -> None:
        self._register_second_item()
        model_path = (
            self.root
            / ".docsfab/reference-model/shared/DOCSFAB-PRODUCT/v0.1/model.md"
        )
        model_path.write_text(
            model_path.read_text(encoding="utf-8").replace(
                "thread_head_event_ids: [EVT-TWO]",
                "thread_head_event_ids: [EVT-THREE]",
            ),
            encoding="utf-8",
        )
        with self.assertRaises(check_freshness.FreshnessError) as raised:
            self._snapshot()
        assert "exact thread head" in str(raised.exception)

    def test_source_item_non_head_event_is_an_error(self) -> None:
        self._register_second_item(occurred_at="2026-08-18T00:00:01.500Z")
        with self.assertRaises(check_freshness.FreshnessError) as raised:
            self._snapshot()
        assert "expected ['EVT-THREE'], found ['EVT-TWO']" in str(raised.exception)

    def test_source_item_missing_branch_head_is_an_error(self) -> None:
        self._register_second_item(
            parent_event_id="EVT-ONE",
            occurred_at="2026-08-18T00:00:01.500Z",
        )
        with self.assertRaises(check_freshness.FreshnessError) as raised:
            self._snapshot()
        assert "expected ['EVT-THREE', 'EVT-TWO']" in str(raised.exception)

    def test_source_item_extra_future_head_is_an_error(self) -> None:
        self._register_second_item()
        model_path = (
            self.root
            / ".docsfab/reference-model/shared/DOCSFAB-PRODUCT/v0.1/model.md"
        )
        model_path.write_text(
            model_path.read_text(encoding="utf-8").replace(
                "thread_head_event_ids: [EVT-TWO]",
                "thread_head_event_ids: [EVT-TWO, EVT-THREE]",
            ),
            encoding="utf-8",
        )
        with self.assertRaises(check_freshness.FreshnessError) as raised:
            self._snapshot()
        assert "exact thread head" in str(raised.exception)

    def _fixture_model_replace(self, old: str, new: str) -> None:
        model_path = (
            self.root
            / ".docsfab/reference-model/shared/DOCSFAB-PRODUCT/v0.1/model.md"
        )
        model_path.write_text(
            model_path.read_text(encoding="utf-8").replace(old, new),
            encoding="utf-8",
        )

    def test_legacy_thread_head_matches_only_its_exact_version_item_and_heads(self) -> None:
        self._fixture_model_replace(
            "thread_head_event_ids: [EVT-TWO]", "thread_head_event_ids: [EVT-ONE]"
        )
        key = check_freshness._legacy_id_key
        exact = {("v0.1", key("ITEM-ONE")): frozenset({key("EVT-ONE")})}
        with mock.patch.object(check_freshness, "LEGACY_THREAD_HEAD_SELECTIONS", exact):
            assert self._snapshot()["model"]["version"] == "v0.1"
        adjacent = {
            "other version": {("v0.2", key("ITEM-ONE")): frozenset({key("EVT-ONE")})},
            "other item": {("v0.1", key("ITEM-TWO")): frozenset({key("EVT-ONE")})},
            "other heads": {
                ("v0.1", key("ITEM-ONE")): frozenset({key("EVT-ONE"), key("EVT-TWO")})
            },
            "plain IDs": {("v0.1", "ITEM-ONE"): frozenset({"EVT-ONE"})},
        }
        for name, table in adjacent.items():
            with self.subTest(name), mock.patch.object(
                check_freshness, "LEGACY_THREAD_HEAD_SELECTIONS", table
            ):
                with self.assertRaises(check_freshness.FreshnessError) as raised:
                    self._snapshot()
                assert "exact thread head" in str(raised.exception)

    def test_legacy_multi_member_matches_only_its_exact_version_item_and_members(self) -> None:
        self._configure_collection_members()
        self._fixture_model_replace("member_id: none", "member_id: member-one, member-two")
        key = check_freshness._legacy_id_key
        members = frozenset({"member-one", "member-two"})
        exact = {("v0.1", key("ITEM-ONE")): members}
        with mock.patch.object(check_freshness, "LEGACY_MULTI_MEMBER_SELECTIONS", exact):
            assert self._snapshot()["model"]["version"] == "v0.1"
        adjacent = {
            "other version": {("v0.2", key("ITEM-ONE")): members},
            "other item": {("v0.1", key("ITEM-TWO")): members},
            "other members": {("v0.1", key("ITEM-ONE")): frozenset({"member-one"})},
            "plain IDs": {("v0.1", "ITEM-ONE"): members},
        }
        for name, table in adjacent.items():
            with self.subTest(name), mock.patch.object(
                check_freshness, "LEGACY_MULTI_MEMBER_SELECTIONS", table
            ):
                with self.assertRaises(check_freshness.FreshnessError) as raised:
                    self._snapshot()
                assert "must select exactly one member" in str(raised.exception)

    def test_legacy_id_key_is_the_sha256_of_the_utf8_id(self) -> None:
        assert check_freshness._legacy_id_key("ITEM-ONE") == hashlib.sha256(
            b"ITEM-ONE"
        ).hexdigest()

    def test_manifest_is_excluded_from_broad_repository_boundary(self) -> None:
        snapshot = self._snapshot(repository_paths=["."])
        manifest_path = self.root / check_freshness.DEFAULT_MANIFEST
        manifest_path.write_text(json.dumps(snapshot, indent=2), encoding="utf-8")
        report = check_freshness.evaluate(self.root, snapshot)
        assert report["status"] == "fresh"

    def test_manifest_rejects_arbitrary_repository_exclusions(self) -> None:
        snapshot = self._snapshot(repository_paths=["."])
        snapshot["repository_snapshot"]["excluded_paths"].append(
            "packages/runtime/source.txt"
        )
        with self.assertRaises(check_freshness.FreshnessError) as raised:
            check_freshness.evaluate(self.root, snapshot)
        assert "only the active receipt" in str(raised.exception)

    def test_alternate_manifest_requires_its_exact_exclusion(self) -> None:
        manifest = ".docsfab/reference-model/receipts/alternate.json"
        snapshot = check_freshness.create_snapshot(
            self.root,
            model_version="v0.1",
            repository_paths=["."],
            checks=[{"name": "tests", "status": "passed", "evidence": "fixture"}],
            readiness=[],
            blocked_targets=[],
            known_gaps=[],
            review_status="passed",
            review_evidence=".docsfab/reference-model/assessments/clean-review.md",
            reviewed_commit=self.reviewed_commit,
            reviewed_tree=self.reviewed_tree,
            manifest_path=manifest,
        )
        report = check_freshness.evaluate(
            self.root, snapshot, manifest_path=manifest
        )
        assert report["status"] == "fresh"

    def test_unexpected_historical_model_entry_is_an_error(self) -> None:
        self._write(
            ".docsfab/reference-model/shared/DOCSFAB-PRODUCT/v9.9/model.txt",
            "unexpected\n",
        )
        with self.assertRaises(check_freshness.FreshnessError) as raised:
            self._snapshot()
        assert "model history namespace mismatch" in str(raised.exception)

    def test_incomplete_historical_model_package_is_an_error(self) -> None:
        self._add_current_model_version()
        (
            self.root
            / ".docsfab/reference-model/shared/DOCSFAB-PRODUCT/v0.1/merge-receipt.md"
        ).unlink()
        with self.assertRaises(check_freshness.FreshnessError) as raised:
            self._snapshot(model_version="v0.2")
        assert "namespace mismatch" in str(raised.exception)

    def test_malformed_prior_model_is_an_error(self) -> None:
        self._add_current_model_version()
        prior_model = (
            self.root
            / ".docsfab/reference-model/shared/DOCSFAB-PRODUCT/v0.1/model.md"
        )
        prior_model.write_text(
            prior_model.read_text(encoding="utf-8").replace("action: added\n", ""),
            encoding="utf-8",
        )
        with self.assertRaises(check_freshness.FreshnessError) as raised:
            self._snapshot(model_version="v0.2")
        assert "missing fields" in str(raised.exception)

    def test_invalid_legacy_yaml_is_an_error(self) -> None:
        self._add_current_model_version()
        prior_model = (
            self.root
            / ".docsfab/reference-model/shared/DOCSFAB-PRODUCT/v0.1/model.md"
        )
        prior_model.write_text(
            prior_model.read_text(encoding="utf-8").replace(
                "statement: The fixture is valid.", "statement: invalid:"
            ),
            encoding="utf-8",
        )
        with self.assertRaises(check_freshness.FreshnessError) as raised:
            self._snapshot(model_version="v0.2")
        assert "invalid legacy scalar syntax" in str(raised.exception)

    def test_navigation_metadata_change_is_stale(self) -> None:
        snapshot = self._snapshot()
        self._write(
            "fern/docs.yml",
            "navigation:\n  - page: Renamed page\n    path: ../docs/about/page.md\n",
        )
        report = check_freshness.evaluate(self.root, snapshot)
        assert report["status"] == "stale"
        assert "documentation-navigation-drift" in {
            finding["code"] for finding in report["stale_findings"]
        }

    def test_moved_documentation_page_is_path_drift_not_error(self) -> None:
        snapshot = self._snapshot()
        self._write(
            "docs/about/core-concepts/page.md",
            "---\ntitle: Page\n---\n\nBody.\n",
        )
        self._write(
            "fern/docs.yml",
            "navigation:\n  - page: Page\n    path: ../docs/about/core-concepts/page.md\n",
        )
        (self.root / "docs/about/page.md").unlink()
        report = check_freshness.evaluate(self.root, snapshot)
        codes = {finding["code"] for finding in report["stale_findings"]}
        assert report["status"] == "stale"
        assert "documentation-path-drift" in codes
        assert "documentation-navigation-drift" in codes

    def test_retained_review_change_is_stale_when_watched(self) -> None:
        assessment_path = ".docsfab/reference-model/assessments"
        snapshot = self._snapshot(
            repository_paths=["packages/runtime", assessment_path]
        )
        self._write(f"{assessment_path}/clean-review.md", "# Review\n\nChanged.\n")
        report = check_freshness.evaluate(self.root, snapshot)
        assert report["status"] == "stale"
        assert "repository-input-drift" in {
            finding["code"] for finding in report["stale_findings"]
        }
        assert assessment_path in check_freshness.DEFAULT_REPOSITORY_PATHS

    def test_default_boundary_detects_knowledge_ci_change(self) -> None:
        snapshot = self._snapshot(
            repository_paths=list(check_freshness.DEFAULT_REPOSITORY_PATHS)
        )
        self._write(
            ".gitlab/ci/knowledge.yml",
            "documentation:freshness:\n  script: [disabled]\n",
        )
        report = check_freshness.evaluate(self.root, snapshot)
        assert report["status"] == "stale"
        assert "repository-input-drift" in {
            finding["code"] for finding in report["stale_findings"]
        }

    def test_cli_modes_and_output_reports(self) -> None:
        snapshot = self._snapshot()
        manifest_path = self.root / check_freshness.DEFAULT_MANIFEST
        manifest_path.write_text(json.dumps(snapshot, indent=2), encoding="utf-8")

        fresh = self._run_cli(
            "check", "--output", ".docsfab/reports/fresh-report.json"
        )
        assert fresh.returncode == 0
        assert json.loads(
            (self.root / ".docsfab/reports/fresh-report.json").read_text()
        )["status"] == "fresh"

        self._write("docs/about/page.md", "---\ntitle: Page\n---\n\nChanged.\n")
        advisory = self._run_cli(
            "check", "--output", ".docsfab/reports/advisory-report.json"
        )
        strict = self._run_cli(
            "check", "--strict", "--output", ".docsfab/reports/strict-report.json"
        )
        environment = dict(os.environ)
        environment["DOCSFAB_FRESHNESS_STRICT"] = "1"
        environment_strict = self._run_cli(
            "check",
            "--output",
            ".docsfab/reports/environment-report.json",
            environment=environment,
        )
        assert advisory.returncode == 0
        assert strict.returncode == 1
        assert environment_strict.returncode == 1
        assert json.loads(
            (self.root / ".docsfab/reports/strict-report.json").read_text()
        )["status"] == "stale"

    def test_unresolvable_revision_cli_is_advisory_stale(self) -> None:
        snapshot = self._snapshot()
        snapshot["repository_snapshot"]["git_revision"] = "0" * 40
        manifest_path = self.root / check_freshness.DEFAULT_MANIFEST
        manifest_path.write_text(json.dumps(snapshot, indent=2), encoding="utf-8")
        advisory = self._run_cli(
            "check", "--output", ".docsfab/reports/orphan-revision.json"
        )
        strict = self._run_cli(
            "check",
            "--strict",
            "--output",
            ".docsfab/reports/orphan-revision-strict.json",
        )
        assert advisory.returncode == 0
        assert strict.returncode == 1
        report = json.loads(
            (self.root / ".docsfab/reports/orphan-revision.json").read_text()
        )
        codes = {finding["code"] for finding in report["stale_findings"]}
        assert report["status"] == "stale"
        assert "receipt-revision-unresolvable" in codes

    def test_corrupt_receipt_json_exits_two(self) -> None:
        manifest_path = self.root / check_freshness.DEFAULT_MANIFEST
        manifest_path.write_text("{not-json\n", encoding="utf-8")
        advisory = self._run_cli(
            "check", "--output", ".docsfab/reports/corrupt-receipt.json"
        )
        strict = self._run_cli(
            "check",
            "--strict",
            "--output",
            ".docsfab/reports/corrupt-receipt-strict.json",
        )
        assert advisory.returncode == 2
        assert strict.returncode == 2
        report = json.loads(
            (self.root / ".docsfab/reports/corrupt-receipt.json").read_text()
        )
        assert report["status"] == "error"
        assert report["errors"][0]["code"] == "freshness-error"

    def test_blocked_strict_cli_returns_one(self) -> None:
        snapshot = self._snapshot(review_status="pending")
        manifest_path = self.root / check_freshness.DEFAULT_MANIFEST
        manifest_path.write_text(json.dumps(snapshot, indent=2), encoding="utf-8")
        result = self._run_cli(
            "check",
            "--strict",
            "--output",
            ".docsfab/reports/blocked-report.json",
        )
        assert result.returncode == 1
        assert json.loads(
            (self.root / ".docsfab/reports/blocked-report.json").read_text()
        )["status"] == "blocked"

    def test_report_output_does_not_stale_root_watch(self) -> None:
        snapshot = self._snapshot(repository_paths=["."])
        manifest_path = self.root / check_freshness.DEFAULT_MANIFEST
        manifest_path.write_text(json.dumps(snapshot, indent=2), encoding="utf-8")
        arguments = (
            "check",
            "--output",
            ".docsfab/reports/root-watch-report.json",
        )
        first = self._run_cli(*arguments)
        second = self._run_cli(*arguments)
        assert first.returncode == 0
        assert second.returncode == 0
        report = json.loads(
            (self.root / ".docsfab/reports/root-watch-report.json").read_text()
        )
        assert report["status"] == "fresh"

    def test_manifest_cannot_overwrite_watched_product_file(self) -> None:
        product_path = self.root / "packages/runtime/source.txt"
        before = product_path.read_text(encoding="utf-8")
        result = self._run_cli(
            "snapshot",
            "--manifest",
            "packages/runtime/source.txt",
            "--repository-path",
            "packages/runtime",
            "--check",
            "tests=passed",
            "--review-evidence",
            "clean review",
        )
        assert result.returncode == 2
        assert product_path.read_text(encoding="utf-8") == before

    def test_report_cannot_overwrite_documentation(self) -> None:
        snapshot = self._snapshot()
        manifest_path = self.root / check_freshness.DEFAULT_MANIFEST
        manifest_path.write_text(json.dumps(snapshot, indent=2), encoding="utf-8")
        readme = self.root / "README.md"
        before = readme.read_text(encoding="utf-8")
        result = self._run_cli("check", "--output", "README.md")
        assert result.returncode == 2
        assert readme.read_text(encoding="utf-8") == before

    def test_report_rejects_symlink_parent_escape(self) -> None:
        snapshot = self._snapshot()
        manifest_path = self.root / check_freshness.DEFAULT_MANIFEST
        manifest_path.write_text(json.dumps(snapshot, indent=2), encoding="utf-8")
        reports = self.root / ".docsfab/reports"
        reports.parent.mkdir(parents=True, exist_ok=True)
        reports.symlink_to(self.root / "docs", target_is_directory=True)
        result = self._run_cli(
            "check", "--output", ".docsfab/reports/escaped.json"
        )
        assert result.returncode == 2
        assert not (self.root / "docs/escaped.json").exists()

    def test_snapshot_cli_preserves_incomplete_gates_and_readiness(self) -> None:
        result = self._run_cli(
            "snapshot",
            "--repository-path",
            "packages/runtime",
            "--check",
            "tests=pending=environment unavailable",
            "--readiness",
            "docs|partial|test owner|source review only",
            "--blocked-target",
            "release|release owner|no approval",
            "--known-gap",
            "No human evidence.",
            "--review-status",
            "pending",
            "--review-evidence",
            "review requested",
        )
        assert result.returncode == 0
        manifest = json.loads(
            (self.root / check_freshness.DEFAULT_MANIFEST).read_text()
        )
        assert manifest["checks"][0]["status"] == "pending"
        assert manifest["independent_review"]["status"] == "pending"
        assert manifest["readiness"][0]["target"] == "docs"
        assert manifest["blocked_targets"][0]["target"] == "release"
        assert manifest["known_gaps"] == ["No human evidence."]

    def test_cli_error_writes_json_report(self) -> None:
        result = self._run_cli(
            "check", "--output", ".docsfab/reports/error-report.json"
        )
        assert result.returncode == 2
        report = json.loads(
            (self.root / ".docsfab/reports/error-report.json").read_text()
        )
        assert report["status"] == "error"
        assert report["errors"][0]["code"] == "freshness-error"

    def test_control_character_path_writes_structured_error(self) -> None:
        snapshot = self._snapshot()
        snapshot["repository_snapshot"]["paths"] = ["packages\u0000runtime"]
        manifest_path = self.root / check_freshness.DEFAULT_MANIFEST
        manifest_path.write_text(json.dumps(snapshot, indent=2), encoding="utf-8")
        result = self._run_cli(
            "check", "--output", ".docsfab/reports/nul-error.json"
        )
        assert result.returncode == 2
        assert "Traceback" not in result.stderr
        report = json.loads(
            (self.root / ".docsfab/reports/nul-error.json").read_text()
        )
        assert report["status"] == "error"
        assert "control characters" in report["errors"][0]["message"]


def repository_ci_skip_reason(root: Path) -> str | None:
    """Skip only when the root pipeline file is absent, as in the exported tree; a partial CI tree still runs and fails."""
    if (root / ".gitlab-ci.yml").is_file():
        return None
    return "repository CI configuration .gitlab-ci.yml is absent from this tree"


REPOSITORY_CI_SKIP = repository_ci_skip_reason(REPOSITORY_ROOT)


class RepositoryCISkipScopeTests(unittest.TestCase):
    def test_skips_only_an_absent_pipeline_never_an_incomplete_one(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            self.assertEqual(
                repository_ci_skip_reason(root),
                "repository CI configuration .gitlab-ci.yml is absent from this tree",
            )
            (root / ".gitlab-ci.yml").write_text("workflow: {}\n", encoding="utf-8")
            self.assertIsNone(repository_ci_skip_reason(root))


@unittest.skipIf(REPOSITORY_CI_SKIP, REPOSITORY_CI_SKIP)
class RepositoryCIPolicyTests(unittest.TestCase):
    def test_merge_request_workflow_covers_every_freshness_input_family(self) -> None:
        root_configuration = yaml.load(
            (REPOSITORY_ROOT / ".gitlab-ci.yml").read_text(encoding="utf-8"),
            Loader=yaml.BaseLoader,
        )
        workflow_rules = root_configuration["workflow"]["rules"]
        merge_request_workflow_rules = [
            rule
            for rule in workflow_rules
            if rule.get("if") == '$CI_PIPELINE_SOURCE == "merge_request_event"'
            and rule.get("when", "on_success") != "never"
        ]
        assert len(merge_request_workflow_rules) == 1

        knowledge_configuration = yaml.load(
            (REPOSITORY_ROOT / ".gitlab/ci/knowledge.yml").read_text(
                encoding="utf-8"
            ),
            Loader=yaml.BaseLoader,
        )
        freshness_rules = knowledge_configuration[
            ".rules:documentation-freshness"
        ]["rules"]
        merge_request_job_rules = [
            rule
            for rule in freshness_rules
            if rule.get("if") == '$CI_PIPELINE_SOURCE == "merge_request_event"'
            and isinstance(rule.get("changes"), dict)
        ]
        assert len(merge_request_job_rules) == 1
        patterns = merge_request_job_rules[0]["changes"]["paths"]

        def matches(path: str, pattern: str) -> bool:
            if pattern.endswith("/**/*"):
                return path.startswith(pattern.removesuffix("**/*"))
            return path == pattern or fnmatchcase(path, pattern)

        representative_paths = [
            ".docsfab/reference-model/source-threads/thread.json",
            ".gitlab/ci/knowledge.yml",
            ".gitlab-ci.yml",
            "GOVERNANCE.md",
            "README.md",
            "deploy/helm/values.yaml",
            "docs/about/index.md",
            "fern/docs.yml",
            "governance/release.md",
            "packages/runtime/src/server.ts",
            "planning/design/product.md",
        ]
        uncovered = [
            path
            for path in representative_paths
            if not any(matches(path, pattern) for pattern in patterns)
        ]
        assert uncovered == []
        assert (
            ".gitlab/ci/knowledge.yml"
            in check_freshness.DEFAULT_REPOSITORY_PATHS
        )


if __name__ == "__main__":
    unittest.main()
