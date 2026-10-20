# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

from __future__ import annotations

import importlib.util
from pathlib import Path
import tempfile
import unittest

from _repo_root import git_checkout_absent_reason, repo_root


ROOT = repo_root()
COLLECTOR_PATH = (
    ROOT / "packages" / "quality" / "checks" / "collect_doc_quality_signals.py"
)
SPEC = importlib.util.spec_from_file_location("collect_doc_quality_signals", COLLECTOR_PATH)
assert SPEC and SPEC.loader
collector = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(collector)


class CollectDocQualitySignalsTests(unittest.TestCase):
    def test_analyze_file_reports_title_links_and_diagnostic_grade(self) -> None:
        with tempfile.TemporaryDirectory(dir=ROOT) as temporary_directory:
            docs = Path(temporary_directory)
            target = docs / "target.md"
            target.write_text("# Target\n", encoding="utf-8")
            source = docs / "source.md"
            source.write_text(
                "---\n"
                "title: Source\n"
                "---\n\n"
                "# Duplicate\n\n"
                "Use the concise example. See [target](target.md) and "
                "[missing](missing.md). TODO\n",
                encoding="utf-8",
            )

            result, relative_links = collector.analyze_file(source, ROOT)

        self.assertEqual(result["title_source"], "frontmatter")
        self.assertTrue(result["duplicate_h1_after_frontmatter"])
        self.assertEqual(result["broken_relative_links"], ["missing.md"])
        self.assertEqual(result["todo_marker_count"], 1)
        self.assertIsInstance(result["flesch_kincaid_grade"], float)
        self.assertEqual(relative_links, 2)

    def test_collector_states_outcome_limitations(self) -> None:
        # collect() records the git revision and worktree state it read.
        reason = git_checkout_absent_reason(ROOT, "collect_doc_quality_signals.collect()")
        if reason is not None:
            self.skipTest(reason)
        report = collector.collect(
            ROOT,
            "docs/about/core-concepts/documentation-quality.md",
        )

        self.assertEqual(report["schema_version"], "doc-quality-signals-v0.1")
        self.assertEqual(report["totals"]["document_count"], 1)
        self.assertRegex(report["documentation_content_hash"], r"^sha256:[0-9a-f]{64}$")
        self.assertIsInstance(report["worktree_dirty"], bool)
        limitations = " ".join(report["limitations"])
        self.assertIn("do not establish factual accuracy", limitations)
        self.assertIn("not proof of clarity", limitations)


if __name__ == "__main__":
    unittest.main()
