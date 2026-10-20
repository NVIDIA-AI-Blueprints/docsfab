# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
from __future__ import annotations

import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[3]
SKILLS = ROOT / "packages" / "skills"
VERIFY = SKILLS / "verify-technical-accuracy"
WRITE = SKILLS / "write-documentation"
METHOD = VERIFY / "references" / "source-fact-method.md"

DIMENSIONS = (
    "input-representations",
    "defaults-and-overrides",
    "mutable-state",
    "destination-and-trust",
    "error-status-retry",
    "environment-prerequisite",
)


def collapse(text: str) -> str:
    return " ".join(text.split())


class SharedSourceFactMethodTests(unittest.TestCase):
    def setUp(self) -> None:
        self.method = METHOD.read_text(encoding="utf-8")
        self.verify = (VERIFY / "SKILL.md").read_text(encoding="utf-8")
        self.methods = (
            VERIFY / "references" / "verification-methods.md"
        ).read_text(encoding="utf-8")
        self.writer = (WRITE / "SKILL.md").read_text(encoding="utf-8")
        self.normalized_method = collapse(self.method)
        self.normalized_writer = collapse(self.writer)

    def test_verify_owns_the_single_source_fact_method(self) -> None:
        self.assertTrue(METHOD.is_file())
        self.assertFalse((WRITE / "references" / "source-fact-method.md").exists())
        self.assertIn("verify-technical-accuracy` owns this method", self.method)
        self.assertIn(
            "Inventory-only mode and compare mode share it",
            self.normalized_method,
        )
        self.assertIn("atomic", self.normalized_method)
        self.assertIn("source-observation", self.method)
        self.assertIn("source-inference", self.method)
        self.assertIn("Unexecuted-path uncertainty", self.method)
        self.assertIn("untrusted", self.normalized_method)
        self.assertIn("Re-read every cited establishing span", self.method)
        self.assertIn("writer-owned inventory artifact", self.method)
        for dimension in DIMENSIONS:
            self.assertIn(f"`{dimension}`", self.method)

    def test_verify_modes_cite_the_shared_method(self) -> None:
        self.assertIn("references/source-fact-method.md", self.verify)
        self.assertIn("inventory-only mode", self.verify)
        self.assertIn("Apply the source-fact method", self.verify)
        self.assertIn("source-fact-method.md", self.methods)
        self.assertIn("Do not copy it blindly", self.verify)
        self.assertIn("retain, refine, or reject", self.verify)

    def test_write_cites_verify_method_without_a_second_discovery_copy(self) -> None:
        self.assertIn("verify-technical-accuracy", self.writer)
        self.assertIn(
            "packages/skills/verify-technical-accuracy/references/source-fact-method.md",
            self.writer,
        )
        self.assertIn("untrusted model evidence", self.writer)
        self.assertIn("Re-read every cited establishing span", self.writer)
        self.assertIn("agreement is not evidence", self.normalized_writer)
        self.assertIn("writer-owned inventory artifact", self.writer)
        self.assertIn("Do not duplicate that discovery procedure here", self.writer)
        self.assertNotIn("Inspect each applicable dimension:", self.writer)
        self.assertNotIn(
            "A typed parameter or declared platform type alone does",
            self.writer,
        )


if __name__ == "__main__":
    unittest.main()
