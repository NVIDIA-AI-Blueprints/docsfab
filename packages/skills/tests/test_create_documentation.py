# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
from __future__ import annotations

import re
import subprocess
import unittest
from pathlib import Path


ROOT = Path(
    subprocess.run(
        ["git", "rev-parse", "--show-toplevel"],
        text=True,
        capture_output=True,
        check=True,
        timeout=10,
    ).stdout.strip()
)
SKILLS = ROOT / "packages" / "skills"
QUALITY = ROOT / "packages" / "quality"
RUNTIME = ROOT / "packages" / "runtime"


class DocumentationWorkflowTests(unittest.TestCase):
    def test_every_canonical_directory_is_an_active_skill_id(self) -> None:
        actual_skills = {path.parent.name for path in SKILLS.glob("*/SKILL.md")}
        expected_skills = {
            "assess-documentation-readiness",
            "audit-documentation",
            "doc-context-analyzer",
            "evaluate-document-quality",
            "lint-documentation",
            "review-documentation",
            "plan-documentation",
            "repo-bootstrap",
            "template-scaffold-site",
            "test-audience-understanding",
            "tpl-design-ia",
            "verify-technical-accuracy",
            "write-documentation",
        }
        retired_skills = {
            "derive-source-obligations",
            "polish-documentation",
            "assess-effective-experience",
            "assess-transferable-understanding",
            "assess-trustworthy-information",
            "fill-srd",
            "guided-demo",
            "measure-assurance-system",
            "create-documentation",
            "restructure-documentation",
            "review-verify-document",
            "write-document",
            "doc-audit",
            "doc-polish",
            "peer-review-documentation",
        }

        self.assertEqual(expected_skills, actual_skills)
        self.assertTrue(retired_skills.isdisjoint(actual_skills))
        self.assertFalse((ROOT / ".claude-plugin").exists())
        self.assertFalse((QUALITY / "adapters").exists())

    def test_writer_is_focused_and_supports_runtime_selected_modes(self) -> None:
        writer = (SKILLS / "write-documentation" / "SKILL.md").read_text(
            encoding="utf-8"
        )

        self.assertIn("DocsFab runtime", writer)
        self.assertIn("create, update, revise, or restructure", writer)
        self.assertIn("only the authoring mutation", writer)
        self.assertIn("Stop after authoring", writer)
        self.assertIn("references/content-map.md", writer)
        self.assertIn("references/output-contract.md", writer)
        self.assertIn("Do not publish, commit, push", writer)
        self.assertNotIn("/skill:", writer)

    def test_writer_keeps_one_compact_flat_style_guide(self) -> None:
        writer = (SKILLS / "write-documentation" / "SKILL.md").read_text(
            encoding="utf-8"
        )

        self.assertEqual(1, writer.count("## Style guide"))
        style_guide = writer.split("## Style guide\n", 1)[1].split("\n## ", 1)[0]
        bullets = [
            " ".join(match.split())
            for match in re.findall(r"(?ms)^- (.*?)(?=^- |\Z)", style_guide)
        ]

        self.assertGreater(len(bullets), 0)
        self.assertLessEqual(len(bullets), 24)
        self.assertTrue(all(bullet.endswith(".") for bullet in bullets))
        self.assertNotRegex(style_guide, r"(?m)^#{3,}\s")
        self.assertFalse(any(line.startswith("|") for line in style_guide.splitlines()))
        self.assertFalse(any(bullet.startswith("[") for bullet in bullets))
        self.assertFalse(
            any(
                0x1F000 <= ord(character) <= 0x1FAFF
                or 0x2600 <= ord(character) <= 0x27BF
                for character in style_guide
            )
        )
        normalized = " ".join(style_guide.split())
        for required in (
            "selected locked profile",
            "target-repository instructions",
            "NVIDIA in all caps",
            "active voice",
            "technical accuracy",
            "literal code",
            "canonical product terms",
            "quoted output",
            "do not make a mechanical style change",
            "em dashes",
            "shell prompt markers",
            "Expected output:",
            "do not nest callouts",
            "uses `the following` immediately before every table and bulleted list",
            "end it with a period before a table and a colon before a list",
            "the list under a `Related Topics` heading needs no introductory "
            "sentence",
        ):
            self.assertIn(required, normalized)

    def test_reviewer_applies_the_style_guide_without_rewriting(self) -> None:
        reviewer = (SKILLS / "review-documentation" / "SKILL.md").read_text(
            encoding="utf-8"
        )
        normalized = " ".join(reviewer.split())

        self.assertIn("## Review guide", reviewer)
        for required in (
            "target-repository instructions",
            "directly and concisely to a colleague",
            "common generated-text patterns",
            "literal code",
            "shell prompt markers",
            "rendered result",
            "checks not run",
            "clear introductions that let readers identify their purpose and "
            "how to use them",
            "A specific applicable rule may require wording or punctuation; "
            "cite that rule and explain why it applies",
        ):
            self.assertIn(required, normalized)
        self.assertIn("Return findings; do not rewrite", normalized)

    def test_runtime_manifests_compose_both_workflows_from_skill_ids(self) -> None:
        import json

        create = json.loads(
            (RUNTIME / "workflows" / "create-documentation.json").read_text(
                encoding="utf-8"
            )
        )
        restructure = json.loads(
            (RUNTIME / "workflows" / "restructure-documentation.json").read_text(
                encoding="utf-8"
            )
        )

        self.assertEqual("create-documentation", create["name"])
        self.assertEqual("restructure-documentation", restructure["name"])
        if "steps" in create:
            create_paths = [create["steps"]]
        else:
            prefix = create["prefix"]["steps"]
            branches = create["branches"]
            self.assertGreater(len(branches), 0)
            create_paths = [prefix + branch["steps"] for branch in branches]
        for create_path in create_paths:
            create_skill_ids = {step["skill"] for step in create_path}
            self.assertNotIn("create-documentation", create_skill_ids)
            self.assertIn("write-documentation", create_skill_ids)
        restructure_skill_ids = {step["skill"] for step in restructure["steps"]}
        self.assertNotIn(
            "restructure-documentation", restructure_skill_ids
        )
        self.assertIn("write-documentation", restructure_skill_ids)



if __name__ == "__main__":
    unittest.main()
