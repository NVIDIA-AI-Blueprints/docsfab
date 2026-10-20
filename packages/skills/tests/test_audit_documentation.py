# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
from __future__ import annotations

import subprocess
import unittest
from pathlib import Path


def repo_root() -> Path:
    result = subprocess.run(
        ["git", "rev-parse", "--show-toplevel"],
        capture_output=True,
        text=True,
        timeout=10,
    )
    if result.returncode != 0 or not result.stdout.strip():
        raise RuntimeError(result.stderr.strip() or "unable to resolve repository root")
    return Path(result.stdout.strip()).resolve()


ROOT = repo_root()
SKILL_ROOT = ROOT / "packages" / "skills" / "audit-documentation"


def collapse(text: str) -> str:
    return " ".join(text.split())


class AuditDocumentationSkillTests(unittest.TestCase):
    def setUp(self) -> None:
        self.skill = (SKILL_ROOT / "SKILL.md").read_text(encoding="utf-8")
        self.normalized_skill = collapse(self.skill)
        self.protocol = (
            SKILL_ROOT / "references" / "triangulation-protocol.md"
        ).read_text(encoding="utf-8")
        self.aggregation = (
            SKILL_ROOT / "references" / "aggregation-confidence.md"
        ).read_text(encoding="utf-8")
        self.contract = (
            SKILL_ROOT / "references" / "output-contract.md"
        ).read_text(encoding="utf-8")
        self.template = (
            SKILL_ROOT / "assets" / "audit-report-template.md"
        ).read_text(encoding="utf-8")

    def test_skill_declares_both_read_only_scopes(self) -> None:
        self.assertIn("`focused-document` or `documentation-set`", self.skill)
        self.assertIn("Build a coverage matrix", self.normalized_skill)
        self.assertIn("Do not invoke or route to another skill", self.skill)
        self.assertIn("Do not issue a release-readiness verdict", self.skill)
        self.assertIn("human and agent outcomes separately", self.normalized_skill)
        self.assertIn("insufficient-evidence", self.skill)

    def test_focused_document_owns_scope_coverage_and_set_problems(self) -> None:
        self.assertIn(
            "Use focused-document scope for scope, coverage, and documentation-set problems",
            self.skill,
        )
        self.assertIn(
            "primary findings are scope defects, coverage gaps, and documentation-set problems",
            self.normalized_skill,
        )
        self.assertNotIn(
            "Use focused-document scope for source drift, broken examples, invalid links, and unsupported claims",
            self.skill,
        )
        self.assertIn(
            "Do not classify source-vs-claim, example validity, or unsupported technical claims as primary findings",
            self.normalized_skill,
        )
        self.assertIn("`verify-technical-accuracy`", self.skill)
        self.assertIn(
            "Do not treat native lint, link, syntax, or formatting results as the focused-document verdict",
            self.normalized_skill,
        )
        self.assertIn("`lint-documentation` and the host executor", self.normalized_skill)

    def test_triangulation_covers_documentation_gaps_not_technical_claims(
        self,
    ) -> None:
        normalized = collapse(self.protocol)
        self.assertIn(
            "Use triangulation for documentation coverage and gaps, not as a second technical verifier",
            self.normalized_skill,
        )
        self.assertIn("documentation coverage and gaps", normalized)
        self.assertIn("Path A: Focused document", self.protocol)
        self.assertIn("Path B: Declared documentation set", self.protocol)
        self.assertIn("Path C: Requested outcomes and audiences", self.protocol)
        self.assertIn(
            "Do not use this protocol to decide source-vs-claim, example validity, or unsupported technical claims",
            normalized,
        )
        self.assertNotIn(
            "Find the code that implements the claimed behavior",
            self.protocol,
        )
        self.assertNotIn("MAX_BATCH_SIZE", self.protocol)
        self.assertNotIn(
            "compare documentation with applicable implementation",
            collapse(self.aggregation),
        )
        self.assertIn(
            "Do not use agreement among documentation paths to decide source-vs-claim",
            collapse(self.aggregation),
        )

    def test_focused_output_contract_keeps_technical_claims_out_of_band(
        self,
    ) -> None:
        normalized = collapse(self.contract)
        self.assertIn("Focused-document output", self.contract)
        self.assertIn(
            "Primary findings are scope defects, coverage gaps, and documentation-set problems",
            normalized,
        )
        self.assertIn(
            "Do not report source-vs-claim, example validity, or unsupported technical claims as primary findings",
            normalized,
        )
        self.assertIn("supplied host receipts only as coverage context", normalized)
        self.assertIn("Scope and Coverage Assessment", self.template)
        self.assertIn("out-of-scope notes, not audit defects", collapse(self.template))
        self.assertNotIn("Claim Assessment", self.template)

    def test_set_scope_preserves_lenses_and_independence(self) -> None:
        roster = (SKILL_ROOT / "references" / "lens-roster.md").read_text(
            encoding="utf-8"
        )

        for lens in (
            "Technical verifier",
            "Product-model verifier",
            "Senior editor",
            "Information architect",
            "Target-audience participant",
            "Constraint reviewer",
        ):
            self.assertIn(lens, roster)

        self.assertIn("contaminated context is not a clean review", roster)
        self.assertIn("Uncovered rows remain `not-assessed`", roster)
        self.assertIn(
            "Do not invoke technical verification, peer review, audience testing, or quality evaluation",
            self.normalized_skill,
        )

    def test_shared_output_contract_keeps_quality_and_assurance_separate(self) -> None:
        normalized = collapse(self.contract)

        self.assertIn("Focused-document output", self.contract)
        self.assertIn("Documentation-set output", self.contract)
        self.assertIn("evaluation.json", self.contract)
        self.assertIn("assurance-system.json", self.contract)
        self.assertIn("audit-report.md", self.contract)
        self.assertIn("Report human and agent outcomes separately", normalized)
        self.assertIn("not another layer score", normalized)

    def test_retired_audit_skill_directory_is_absent(self) -> None:
        retired_skill = (
            ROOT
            / "packages"
            / "skills"
            / "audit-documentation-set"
            / "SKILL.md"
        )
        self.assertFalse(retired_skill.exists())


if __name__ == "__main__":
    unittest.main()
