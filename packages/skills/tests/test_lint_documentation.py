# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
from __future__ import annotations

import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[3]
SKILL_ROOT = ROOT / "packages" / "skills" / "lint-documentation"


def collapse(text: str) -> str:
    return " ".join(text.split())


class LintDocumentationSkillTests(unittest.TestCase):
    def setUp(self) -> None:
        self.skill = (SKILL_ROOT / "SKILL.md").read_text(encoding="utf-8")
        self.selection = (SKILL_ROOT / "references" / "check-selection.md").read_text(
            encoding="utf-8"
        )
        self.normalized_skill = collapse(self.skill)
        self.normalized_selection = collapse(self.selection)

    def test_skill_reports_native_checks_without_scoring_or_rewriting(self) -> None:
        self.assertIn("name: lint-documentation", self.skill)
        self.assertIn(
            "Do not invent a parallel linter when a native check exists.",
            self.normalized_skill,
        )
        self.assertIn("Build a validation matrix", self.skill)
        self.assertIn(
            "without making a quality score or claiming technical truth",
            self.skill,
        )
        self.assertIn(
            "Do not edit, score, publish, commit, push, or merge the documentation.",
            self.skill,
        )
        self.assertNotIn("TODO", self.skill)
        self.assertNotIn("/skill:", self.skill)

    def test_skill_handoffs_technical_truth_and_quality_scoring(self) -> None:
        self.assertIn("verify-technical-accuracy", self.skill)
        self.assertIn("evaluate-document-quality", self.skill)
        self.assertIn(
            "Pass technical behavior questions to `verify-technical-accuracy`",
            self.normalized_skill,
        )
        self.assertIn(
            "complete evidence package to `evaluate-document-quality` when requested",
            self.normalized_skill,
        )

    def test_unavailable_checks_remain_gaps_not_passes(self) -> None:
        self.assertIn(
            "Never fall back to unrestricted execution or claim the check passed.",
            self.normalized_skill,
        )
        self.assertIn(
            "A passing linter establishes only the rules it checked.",
            self.skill,
        )
        self.assertIn(
            "A documentation build is not proof that examples execute or claims are true.",
            self.skill,
        )
        self.assertIn(
            "do not substitute a model's inspection for a command that did not run",
            self.normalized_skill,
        )
        self.assertIn(
            "Do not weaken, skip, or replace a required check without recording the gap.",
            self.skill,
        )

    def test_check_selection_preserves_omitted_classes_and_numbering_evidence(
        self,
    ) -> None:
        self.assertTrue(
            (SKILL_ROOT / "references" / "check-selection.md").is_file()
        )
        self.assertIn(
            "Never report an omitted class as passing.",
            self.normalized_selection,
        )
        for status in ("not-applicable", "not-assessed", "insufficient-evidence"):
            self.assertIn(status, self.selection)
        self.assertIn("Do not invent an additional linter", self.selection)
        self.assertIn(
            "Repeated `1.` markers are valid CommonMark/GFM",
            self.selection,
        )
        self.assertIn(
            "A reviewer preference is an unverified question",
            self.selection,
        )
        self.assertIn(
            "A contrary style finding requires the selected rule's stable ID",
            self.normalized_selection,
        )


if __name__ == "__main__":
    unittest.main()
