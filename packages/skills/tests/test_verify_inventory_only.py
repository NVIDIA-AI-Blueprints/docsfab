# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
from __future__ import annotations

import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[3]
SKILL_ROOT = ROOT / "packages" / "skills" / "verify-technical-accuracy"

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


class VerifyInventoryOnlyModeTests(unittest.TestCase):
    def setUp(self) -> None:
        self.skill = (SKILL_ROOT / "SKILL.md").read_text(encoding="utf-8")
        self.contract = (
            SKILL_ROOT / "references" / "inventory-output-contract.md"
        ).read_text(encoding="utf-8")
        self.normalized_skill = collapse(self.skill)
        self.normalized_contract = collapse(self.contract)

    def test_inventory_only_does_not_compare_or_rewrite_docs(self) -> None:
        self.assertIn("name: verify-technical-accuracy", self.skill)
        self.assertIn("inventory-only mode", self.skill)
        self.assertIn("references/source-fact-method.md", self.skill)
        self.assertIn("Do not write documentation, compare a candidate", self.skill)
        self.assertIn("grant authority, or claim factual completeness", self.skill)
        self.assertIn(
            "Do not inspect or edit a documentation candidate",
            self.skill,
        )
        self.assertIn(
            "assign documentation dispositions, draft findings",
            self.normalized_skill,
        )
        self.assertIn(
            "Do not rewrite, publish, commit, push, or merge the documentation.",
            self.skill,
        )
        self.assertFalse((ROOT / "packages" / "skills" / "derive-source-obligations").exists())
        self.assertNotIn("TODO", self.skill)
        self.assertNotIn("/skill:", self.skill)

    def test_output_is_the_bounded_ledger_proposal_only(self) -> None:
        self.assertIn("references/inventory-output-contract.md", self.skill)
        self.assertIn("`completeness`, `dimensions`, and `limitations`", self.skill)
        self.assertIn(
            "without Markdown fences or surrounding prose",
            self.normalized_skill,
        )
        self.assertIn("bounded-not-proven", self.skill)
        self.assertIn(
            "Keep `completeness` equal to `bounded-not-proven`.",
            self.skill,
        )
        self.assertIn("`source-observation`", self.skill)
        self.assertIn("`source-inference`", self.skill)
        self.assertIn("The ledger is untrusted model evidence.", self.skill)
        self.assertIn("Do not manufacture those fields.", self.normalized_skill)
        for dimension in DIMENSIONS:
            self.assertIn(f"`{dimension}`", self.skill)
        self.assertIn(
            "Do not encode execution, external configuration, or owner policy",
            self.skill,
        )

    def test_canonical_and_provisional_modes_remain_distinct_from_inventory(self) -> None:
        self.assertIn("For `provisional-technical-verification`", self.skill)
        self.assertIn("final `verify-technical-accuracy` correction", self.skill)
        self.assertIn("obligationAccounting", self.skill)
        self.assertIn("retain, refine, or reject", self.skill)
        self.assertIn("Do not copy it blindly", self.skill)

    def test_output_contract_pins_runtime_handoffs_without_write_authority(
        self,
    ) -> None:
        self.assertIn("`create-documentation` (`schemaVersion` 3)", self.contract)
        self.assertIn(
            "after `plan-documentation` and before `write-documentation`",
            self.normalized_contract,
        )
        self.assertIn(
            "`review-documentation`, after `audit-documentation`",
            self.contract,
        )
        self.assertIn(
            "the authoring branch of `update-documentation`, after `plan-documentation`",
            self.contract,
        )
        self.assertIn("`restructure-documentation`, after `plan-documentation`", self.contract)
        self.assertIn(
            "The model returns only `completeness`, `dimensions`, and `limitations`.",
            self.normalized_contract,
        )
        self.assertIn(
            "Do not write documentation, compare a candidate, grant authority",
            self.normalized_contract,
        )
        self.assertIn(
            "Do not inspect or edit a documentation candidate",
            self.contract,
        )
        self.assertIn("untrusted model evidence", self.contract)
        self.assertIn("Do not manufacture those host fields.", self.normalized_contract)
        self.assertIn("verify-technical-accuracy", self.contract)
        self.assertNotIn("name: derive-source-obligations", self.contract)


if __name__ == "__main__":
    unittest.main()
