# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
from __future__ import annotations

import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[3]
SKILLS = ROOT / "packages" / "skills"
EVALUATOR = SKILLS / "evaluate-document-quality"


class EvaluateDocumentQualitySkillTests(unittest.TestCase):
    def test_skill_requires_three_bound_outputs_for_rubric_eligible_targets(self) -> None:
        skill = (EVALUATOR / "SKILL.md").read_text(encoding="utf-8")

        for artifact in ("evaluation.json", "quality-score.json", "quality-report.md"):
            self.assertIn(artifact, skill)
        self.assertIn("validate_documentation_quality_evaluation.py", skill)
        self.assertIn("validate_quality_score.py", skill)
        self.assertIn("validate_quality_report.py", skill)
        self.assertNotIn("legacy scoring", skill)
        self.assertNotIn("Optionally apply", skill)

    def test_skill_leaves_the_quality_answer_shape_to_the_host_contract(self) -> None:
        skill = " ".join(
            (EVALUATOR / "SKILL.md").read_text(encoding="utf-8").split()
        )

        self.assertIn("host supplies a response contract in the step prompt", skill)
        self.assertNotIn("reportMarkdown", skill)
        self.assertNotIn("candidateJson", skill)
        self.assertIn(
            "When the host runs the validators after inference, omit the "
            "template's Validated result summary section",
            skill,
        )

    def test_scoring_policy_delegates_authoritative_values_to_yaml(self) -> None:
        policy = (EVALUATOR / "references" / "scoring-policy.md").read_text(
            encoding="utf-8"
        )

        self.assertIn("packages/quality/rubrics/", policy)
        self.assertIn("authoritative", policy)
        self.assertIn("insufficient-evidence", policy)
        self.assertNotIn("| Dimension |", policy)
        self.assertNotIn("| Technical accuracy |", policy)

    def test_report_template_keeps_required_result_and_editorial_fields(self) -> None:
        template = (EVALUATOR / "assets" / "quality-report-template.md").read_text(
            encoding="utf-8"
        )

        required = (
            '"repository_revision"',
            '"documentation_revision"',
            '"profile"',
            '"dimension_scores"',
            '"total"',
            '"threshold"',
            '"hard_gates"',
            '"decision"',
            '"confidence"',
            "## Findings",
            "## Evidence gaps and limitations",
            '"validation"',
            '"artifact_locators"',
            "Correctness",
            "Clarity",
            "Consistency",
            "Terminology",
            "Tone of Voice",
            "Inclusive Language",
            "Scannability",
            "Flesch Reading Ease",
            "Informality Index",
            "Liveliness Index",
        )
        for value in required:
            with self.subTest(value=value):
                self.assertIn(value, template)
        self.assertIn("do not form a second overall score", template)
        self.assertIn("unavailable", template)

    def test_portable_contracts_require_validation_and_artifact_locators(self) -> None:
        paths = (
            SKILLS / "EXECUTION_CONTRACT.md",
            SKILLS / "workflows" / "create-documentation.md",
            SKILLS / "workflows" / "update-documentation.md",
        )
        for path in paths:
            value = path.read_text(encoding="utf-8")
            with self.subTest(path=path.name):
                for artifact in (
                    "evaluation.json",
                    "quality-score.json",
                    "quality-report.md",
                ):
                    self.assertIn(artifact, value)
                self.assertIn("validat", value.lower())

    def test_layered_reference_states_the_validator_rules_behind_review_live_rejections(
        self,
    ) -> None:
        # #1221 / #1126: each sentence names the representation the locked
        # validator accepts for a shape it rejected in recorded review-live runs.
        reference = " ".join(
            (EVALUATOR / "references" / "layered-evaluation.md")
            .read_text(encoding="utf-8")
            .split()
        )
        for sentence in (
            "For a `documentation-set` target, every dimension the profile lists "
            "under `required_dimensions_by_layer` is required, even when the set is "
            "a single page.",
            "never assess it as `not-applicable`.",
            "Required dimensions assessed as `not-assessed` count toward these limits.",
            "When no attempt ran for a population, leave its list empty.",
            "Never invent a placeholder attempt such as `not-run`.",
        ):
            with self.subTest(sentence=sentence):
                self.assertIn(sentence, reference)
        self.assertNotIn(
            "DocsFab documentation set. Select applicable dimensions by page family",
            reference,
        )


if __name__ == "__main__":
    unittest.main()
