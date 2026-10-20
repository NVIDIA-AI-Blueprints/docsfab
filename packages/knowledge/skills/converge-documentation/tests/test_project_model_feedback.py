# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Canonical source-backed projection tests, not a live approval proof."""
import importlib.util
import json
import pathlib
import shutil
import subprocess
import sys
import tempfile
import unittest

SCRIPTS = pathlib.Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(SCRIPTS))
import project_model_feedback as projection

FIXTURE_MODEL = pathlib.Path(__file__).resolve().parents[3] / "tests/fixtures/reference-model"


def live_model_skip_reason(root):
    """Skip only when the whole live model is absent, as in the exported tree; a partial model still runs and fails."""
    if (root / ".docsfab/reference-model").is_dir():
        return None
    return "live repository model .docsfab/reference-model is absent from this tree"


class ModelFeedbackCases:
    """Projector behavior over a copied model; subclasses name the model and its versions."""

    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory()
        cls.root = pathlib.Path(cls.temp.name)
        destination = cls.root / ".docsfab/reference-model"
        destination.parent.mkdir()
        shutil.copytree(cls.SOURCE, destination)
        cls.git("init", "-q")
        cls.git("config", "user.email", "fixture@example.test")
        cls.git("config", "user.name", "Fixture")
        cls.commit()

    @classmethod
    def tearDownClass(cls):
        cls.temp.cleanup()

    @classmethod
    def git(cls, *args):
        return subprocess.run(["git", *args], cwd=cls.root, check=True,
                              capture_output=True).stdout.decode().strip()

    @classmethod
    def commit(cls):
        cls.git("add", ".docsfab")
        cls.git("commit", "-qm", "fixture", "--allow-empty")
        return cls.git("rev-parse", "HEAD")

    def read(self, version=None, **overrides):
        args = dict(project_id="sample-project", model_id="DOCSFAB-PRODUCT",
                    version=version or self.NEWER, revision=self.git("rev-parse", "HEAD"))
        args.update(overrides)
        return projection.project(self.root, **args)

    def test_uncommitted_model_and_source_changes_are_refused(self):
        for relative in [f"shared/DOCSFAB-PRODUCT/{self.NEWER}/model.md", f"source-threads/{self.THREAD}/thread.json"]:
            path = self.root / ".docsfab/reference-model" / relative
            before = path.read_bytes()
            try:
                path.write_bytes(before + b"\n")
                with self.assertRaises(ValueError): self.read()
            finally:
                path.write_bytes(before)

    def test_committed_duplicate_and_malformed_conflict_records_are_refused(self):
        path = self.root / f".docsfab/reference-model/shared/DOCSFAB-PRODUCT/{self.NEWER}/inconsistency-report.md"
        before = path.read_text()
        variants = [before + "\n" + before, before.replace("status: open", "status: open\nstatus: resolved", 1),
                    before.replace(f"conflict_id: {self.OPEN_CONFLICTS[0]}", "conflict_id: CONFLICT-OTHER-001", 1)]
        for content in variants:
            try:
                path.write_text(content); self.commit()
                with self.assertRaises((ValueError, projection.canonical.FreshnessError)): self.read()
            finally:
                path.write_text(before); self.commit()

    def test_unsafe_identity_symlink_and_revision_are_refused(self):
        for args in [{"model_id": "../elsewhere"}, {"revision": "HEAD"}, {"version": f"../../{self.NEWER}"}]:
            with self.assertRaises((ValueError, projection.canonical.FreshnessError)): self.read(**args)
        path = self.root / f".docsfab/reference-model/shared/DOCSFAB-PRODUCT/{self.NEWER}/model.md"
        before = path.read_bytes()
        try:
            path.unlink(); path.symlink_to(f"../{self.OLDER}/model.md")
            with self.assertRaises((ValueError, projection.canonical.FreshnessError)): self.read()
        finally:
            path.unlink(); path.write_bytes(before)

    def test_other_model_id_uses_same_parser_without_approval_inference(self):
        base = self.root / ".docsfab/reference-model/shared"
        alternate = base / "EXAMPLE-PRODUCT"
        shutil.copytree(base / "DOCSFAB-PRODUCT", alternate)
        for path in alternate.glob("*/model.md"):
            path.write_text(path.read_text().replace("model_id: DOCSFAB-PRODUCT", "model_id: EXAMPLE-PRODUCT"))
        path = alternate / f"{self.OLDER}/model.md"
        path.write_text(path.read_text().replace("approval_state: candidate", "approval_state: approved"))
        self.commit()
        result = self.read(self.OLDER, model_id="EXAMPLE-PRODUCT")
        self.assertEqual(result["modelId"], "EXAMPLE-PRODUCT")
        self.assertEqual(result["state"], "candidate")
        self.assertTrue(result["modelPath"].startswith(".docsfab/reference-model/shared/EXAMPLE-PRODUCT/"))

    def test_git_replacement_does_not_redefine_an_exact_revision(self):
        relative = f".docsfab/reference-model/shared/DOCSFAB-PRODUCT/{self.OLDER}/model.md"
        path = self.root / relative
        before = path.read_bytes()
        old_oid = self.git("rev-parse", "HEAD:" + relative)
        try:
            path.write_bytes(before + b"\nUncommitted replacement text.\n")
            new_oid = self.git("hash-object", "-w", relative)
            self.git("replace", old_oid, new_oid)
            with self.assertRaises(ValueError): self.read(self.OLDER)
        finally:
            self.git("replace", "-d", old_oid)
            path.write_bytes(before)


    def test_models_remain_candidates_and_open_conflicts_are_exact(self):
        older, newer = self.read(self.OLDER), self.read()
        self.assertEqual(older["state"], "candidate")
        self.assertEqual(older["modelSha256"], self.OLDER_MODEL_SHA256)
        self.assertGreater(len(older["claims"]), self.MIN_OLDER_CLAIMS)  # Includes inherited claims.
        self.assertEqual(newer["state"], "candidate")
        self.assertEqual([x["id"] for x in newer["openConflicts"]], self.OPEN_CONFLICTS)
        self.assertEqual(newer["snapshotSha256"], projection.digest({k: v for k, v in newer.items() if k != "snapshotSha256"}))
        self.assertTrue(any("artifacts/sha256/" in x["path"] for x in newer["files"]))


class FixtureModelFeedbackTests(ModelFeedbackCases, unittest.TestCase):
    """The sanitized synthetic model under tests/fixtures, which every tree carries."""
    SOURCE = FIXTURE_MODEL
    OLDER, NEWER, THREAD = "v0.10", "v0.11", "SRC-EXAMPLE-A"
    OLDER_MODEL_SHA256 = "1d61dd01d7ed690f005f66538e6228b10b9eea13099643728e56bfb5156530fb"
    MIN_OLDER_CLAIMS = 2
    OPEN_CONFLICTS = ["CONFLICT-EXAMPLE-001"]


class LiveModelSkipScopeTests(unittest.TestCase):
    def test_skips_only_an_absent_model_never_an_incomplete_one(self):
        with tempfile.TemporaryDirectory() as temp:
            root = pathlib.Path(temp)
            self.assertEqual(live_model_skip_reason(root),
                             "live repository model .docsfab/reference-model is absent from this tree")
            (root / ".docsfab/reference-model").mkdir(parents=True)
            self.assertIsNone(live_model_skip_reason(root))


if __name__ == "__main__":
    unittest.main()
