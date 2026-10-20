# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
from __future__ import annotations

import importlib.util
import json
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path


REPOSITORY_ROOT = Path(__file__).resolve().parents[5]
FIXTURE_MODEL = Path(__file__).resolve().parents[3] / "tests/fixtures/reference-model"
SCRIPT = (
    REPOSITORY_ROOT
    / "packages/knowledge/skills/converge-documentation/scripts"
    / "project_knowledge_accepted_snapshot.py"
)
SPEC = importlib.util.spec_from_file_location("project_knowledge_accepted_snapshot", SCRIPT)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError(f"Unable to load projector script: {SCRIPT}")
projector = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(projector)


def live_model_skip_reason(root: Path) -> str | None:
    """Skip only when the whole live model is absent, as in the exported tree; a partial model still runs and fails."""
    if (root / ".docsfab/reference-model").is_dir():
        return None
    return "live repository model .docsfab/reference-model is absent from this tree"


LIVE_SKIP = live_model_skip_reason(REPOSITORY_ROOT)


class AcceptedSnapshotCases:
    """Projector behavior over one file model; subclasses name the model root and its expected claims."""

    root: Path
    VERSION: str
    STREAM_VERSION: int
    CLI_ARGUMENTS: list[str]
    CLAIM_COUNT: int
    FIRST_CLAIM: str
    LAST_CLAIM: str
    INHERITED_CLAIM: str
    DELTA_CLAIMS: tuple[str, str]
    APPROVED_CLAIM: str

    def model_path(self) -> Path:
        return self.root / f".docsfab/reference-model/shared/DOCSFAB-PRODUCT/{self.VERSION}/model.md"

    def test_nested_merge_and_claim_decoys_are_not_semantic_records(self) -> None:
        model_path = self.model_path()
        text = model_path.read_text(encoding="utf-8")
        baseline_frontmatter = projector.parse_frontmatter(text, str(model_path))
        baseline_claims = projector.parse_claims(text, str(model_path), self.VERSION)
        decoy = (
            "````text\n```yaml\nmodel_id: DECOY\nmodel_version: v999.0\n```\n\n"
            "### CLM-DECOY: Nested\n\n```yaml\nclaim_id: CLM-DECOY\n```\n````\n\n"
        )
        self.assertEqual(
            projector.parse_frontmatter(decoy + text, str(model_path)),
            baseline_frontmatter,
        )
        self.assertEqual(
            projector.parse_claims(decoy + text, str(model_path), self.VERSION),
            baseline_claims,
        )

    def test_rejects_unsupported_claim_relationship(self) -> None:
        model_path = self.model_path()
        text = model_path.read_text(encoding="utf-8").replace(
            "relationship: behavior-conflict",
            "relationship: adversarial-bogus",
            1,
        )
        with self.assertRaises(projector.SnapshotError):
            projector.parse_claims(text, str(model_path), self.VERSION)

    def test_rejects_duplicate_complete_top_level_claim(self) -> None:
        model_path = self.model_path()
        text = model_path.read_text(encoding="utf-8")
        first, second = self.DELTA_CLAIMS
        first_start = text.index(f"### {first}")
        second_start = text.index(f"### {second}")
        duplicated = (
            text[:second_start]
            + text[first_start:second_start]
            + text[second_start:]
        )
        with self.assertRaisesRegex(
            projector.SnapshotError, f"duplicate claim ID {first}"
        ):
            projector.parse_claims(duplicated, str(model_path), self.VERSION)

    def test_file_model_flattens_inherited_claims(self) -> None:
        first = projector.project_snapshot(self.root, model_version=self.VERSION)
        second = projector.project_snapshot(self.root, model_version=self.VERSION)
        claim_ids = [claim["id"] for claim in first["claims"]]

        self.assertEqual(first["kind"], "knowledge-accepted-snapshot")
        self.assertEqual(first["schemaVersion"], 1)
        self.assertEqual(first["projectId"], "DOCSFAB-PRODUCT")
        self.assertEqual(first["modelVersionId"], self.VERSION)
        self.assertEqual(first["streamVersion"], self.STREAM_VERSION)
        self.assertEqual(first["status"], "candidate")
        self.assertEqual(first["conflicts"], [])
        self.assertEqual(len(claim_ids), self.CLAIM_COUNT)
        self.assertEqual(claim_ids[0], self.FIRST_CLAIM)
        self.assertEqual(claim_ids[-1], self.LAST_CLAIM)
        self.assertIn(self.INHERITED_CLAIM, claim_ids)
        self.assertNotEqual(set(claim_ids), set(self.DELTA_CLAIMS))
        self.assertEqual(
            next(claim["modelState"] for claim in first["claims"] if claim["id"] == self.APPROVED_CLAIM),
            "canonical",
        )
        self.assertTrue(first["sources"])
        for source in first["sources"]:
            self.assertRegex(source["id"], r"^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$")
            self.assertTrue(source["locator"])
        self.assertRegex(first["snapshotSha256"], r"^[a-f0-9]{64}$")
        self.assertEqual(first["snapshotSha256"], second["snapshotSha256"])
        self.assertEqual(first, second)

        without_digest = {key: value for key, value in first.items() if key != "snapshotSha256"}
        self.assertEqual(first["snapshotSha256"], projector.canonical_digest(without_digest))

    def test_cli_from_repo_root_is_digest_stable(self) -> None:
        command = ["python3", str(SCRIPT), "--root", str(self.root), *self.CLI_ARGUMENTS]
        first = subprocess.run(command, check=True, capture_output=True, text=True, timeout=30)
        second = subprocess.run(command, check=True, capture_output=True, text=True, timeout=30)
        snapshot = json.loads(first.stdout)
        self.assertEqual(snapshot["kind"], "knowledge-accepted-snapshot")
        self.assertEqual(snapshot["status"], "candidate")
        self.assertEqual(len(snapshot["claims"]), self.CLAIM_COUNT)
        self.assertEqual(json.loads(first.stdout)["snapshotSha256"], json.loads(second.stdout)["snapshotSha256"])
        self.assertEqual(first.returncode, 0)
        self.assertEqual(second.stderr, "")


@unittest.skipIf(LIVE_SKIP, LIVE_SKIP)
class ProjectKnowledgeAcceptedSnapshotTests(AcceptedSnapshotCases, unittest.TestCase):
    """The actual retained DocsFab v0.23 model, through the CLI's default version."""

    root = REPOSITORY_ROOT
    VERSION = "v0.23"
    STREAM_VERSION = 23
    CLI_ARGUMENTS: list[str] = []
    CLAIM_COUNT = 82
    FIRST_CLAIM, LAST_CLAIM, INHERITED_CLAIM = "CLM-DOCSFAB-001", "CLM-DOCSFAB-082", "CLM-DOCSFAB-080"
    DELTA_CLAIMS = ("CLM-DOCSFAB-081", "CLM-DOCSFAB-082")
    APPROVED_CLAIM = "CLM-DOCSFAB-001"


class FixtureAcceptedSnapshotTests(AcceptedSnapshotCases, unittest.TestCase):
    """The sanitized synthetic model under tests/fixtures, which every tree carries."""

    VERSION = "v0.11"
    STREAM_VERSION = 11
    CLI_ARGUMENTS = ["--model-version", "v0.11"]
    CLAIM_COUNT = 5
    FIRST_CLAIM, LAST_CLAIM, INHERITED_CLAIM = "CLM-EXAMPLE-001", "CLM-EXAMPLE-005", "CLM-EXAMPLE-002"
    DELTA_CLAIMS = ("CLM-EXAMPLE-004", "CLM-EXAMPLE-005")
    APPROVED_CLAIM = "CLM-EXAMPLE-001"

    @classmethod
    def setUpClass(cls) -> None:
        cls.temporary_directory = tempfile.TemporaryDirectory()
        cls.root = Path(cls.temporary_directory.name)
        shutil.copytree(FIXTURE_MODEL, cls.root / ".docsfab/reference-model")

    @classmethod
    def tearDownClass(cls) -> None:
        cls.temporary_directory.cleanup()


class LiveModelSkipScopeTests(unittest.TestCase):
    def test_skips_only_an_absent_model_never_an_incomplete_one(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            self.assertEqual(
                live_model_skip_reason(root),
                "live repository model .docsfab/reference-model is absent from this tree",
            )
            (root / ".docsfab/reference-model").mkdir(parents=True)
            self.assertIsNone(live_model_skip_reason(root))


if __name__ == "__main__":
    unittest.main()
