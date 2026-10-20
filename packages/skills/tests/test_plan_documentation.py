# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
from __future__ import annotations

import json
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[3]
SKILLS = ROOT / "packages" / "skills"
QUALITY = ROOT / "packages" / "quality"


class PlanDocumentationTests(unittest.TestCase):
    def test_brief_schema_requires_explicit_srd_provided_boolean(self) -> None:
        schema = json.loads(
            (QUALITY / "schemas" / "documentation-brief.schema.json").read_text(
                encoding="utf-8"
            )
        )
        self.assertIn("srd_provided", schema["required"])
        self.assertEqual(schema["properties"]["srd_provided"]["type"], "boolean")

    def test_plan_skill_preserves_conditional_srd_intake(self) -> None:
        skill_root = SKILLS / "plan-documentation"
        skill = (skill_root / "SKILL.md").read_text(encoding="utf-8")
        interview = (skill_root / "references" / "minimal-interview.md").read_text(
            encoding="utf-8"
        )
        srd_format = (QUALITY / "formats" / "requirements-document-format.md").read_text(
            encoding="utf-8"
        )

        self.assertIn("name: plan-documentation", skill)
        self.assertNotIn("TODO", skill)
        self.assertIn("references/minimal-interview.md", skill)
        # The SRD format is a product-layer quality resource, read from the
        # mounted quality pack beside the skill, not a skill-local reference.
        self.assertIn("(../../quality/formats/requirements-document-format.md)", skill)
        self.assertNotIn("(references/requirements-document-format.md)", skill)
        self.assertFalse((skill_root / "references" / "requirements-document-format.md").exists())
        self.assertIn("conditional source evidence, not a universal gate", skill)
        self.assertNotIn("NVIDIA structure", skill)
        self.assertIn("brief.srd_provided", skill)
        self.assertIn("first in `brief.source_priority`", skill)
        self.assertIn("approval-ready documentation plan", skill)
        self.assertIn("Ask at most five compact prompts", interview)
        self.assertIn("Ask one follow-up round only", interview)
        self.assertIn("do not infer approvers", interview)
        self.assertIn("Never infer non-applicability from silence", interview)
        self.assertIn("Never infer non-applicability from silence", interview)
        self.assertIn("Keep a supplied SRD unchanged", skill)
        self.assertIn("references/canonical-ia.md", skill)
        self.assertIn("references/page-set.md", skill)
        self.assertIn("runtime-selected mode", skill)
        self.assertNotIn("::tpl-new-site", skill)
        self.assertNotIn("site-scaffold.py", skill)
        self.assertNotIn("/skill:", skill)

        ordered_sections = [
            "## Purpose and scope",
            "## Users and scenarios",
            "## Requirements and acceptance checks",
            "## Constraints and interfaces",
            "## Open decisions and evidence gaps",
            "## Document ownership, revision, and source references",
        ]
        positions = [srd_format.index(section) for section in ordered_sections]
        self.assertEqual(positions, sorted(positions))
        self.assertIn("| ID | Required behavior | Source | Acceptance or verification check |", srd_format)
        self.assertIn("stable, atomic, observable behavior", srd_format)
        self.assertIn("Preserve a supplied SRD read-only", srd_format)
        self.assertIn("Do not invent approvals, evidence", srd_format)
        self.assertNotIn("NVIDIA", srd_format)
        self.assertNotIn("PLC-L1", srd_format)

    def test_create_documentation_handles_supplied_and_generated_srds(self) -> None:
        plan = (SKILLS / "plan-documentation" / "SKILL.md").read_text(
            encoding="utf-8"
        )
        writer = (SKILLS / "write-documentation" / "SKILL.md").read_text(
            encoding="utf-8"
        )

        self.assertIn("For a supplied SRD", plan)
        self.assertIn("When an SRD is required but absent", plan)
        self.assertIn("return the plan, source locators, unresolved questions", plan)
        self.assertIn("Keep a generated SRD in conversation", plan)
        self.assertIn("approved plan", writer)
        self.assertIn("unresolved decision", writer)
        self.assertNotIn("/skill:", writer)

    def test_plan_skill_freezes_ia_placement_and_page_set(self) -> None:
        skill_root = SKILLS / "plan-documentation"
        skill = (skill_root / "SKILL.md").read_text(encoding="utf-8")
        canonical_ia = (skill_root / "references" / "canonical-ia.md").read_text(
            encoding="utf-8"
        )
        page_set = (skill_root / "references" / "page-set.md").read_text(
            encoding="utf-8"
        )

        self.assertIn("references/canonical-ia.md", skill)
        self.assertIn("references/page-set.md", skill)
        self.assertIn("structure guidance only", skill)
        self.assertIn("Do not force-create", skill)
        self.assertIn("one topic", skill)
        self.assertIn("one Diataxis content type", skill)
        self.assertIn("concept, how-to, tutorial, or reference", skill)
        self.assertIn("exceeds 500 lines", skill)
        self.assertIn("modular pages", skill)
        self.assertIn("reorder and reposition", skill)
        self.assertIn("structure guidance", canonical_ia)
        self.assertIn("Do **not** force-create", canonical_ia)
        self.assertIn("## One topic and one content type", canonical_ia)
        self.assertIn("`concept`", canonical_ia)
        self.assertIn("`how-to`", canonical_ia)
        self.assertIn("`tutorial`", canonical_ia)
        self.assertIn("`reference`", canonical_ia)
        self.assertIn("exceeds 500 lines", canonical_ia)
        self.assertIn("Reorder the proposed pages", canonical_ia)
        self.assertIn("Reposition modules that sit in the wrong family", canonical_ia)
        self.assertIn("Do not force-create", page_set)
        self.assertIn("structure guidance", page_set)
        self.assertIn("## Modular page splits", page_set)
        self.assertIn("one of `concept`, `how-to`, `tutorial`, `reference`", page_set)
        self.assertIn("500 lines", page_set)
        self.assertIn("TOC family order", page_set)
        self.assertIn("TOC tree for the modularized set", page_set)
        self.assertIn("| Family | Path | Disposition | Topic | Content type | Purpose | Sources | Nav or redirect | Unresolved |", page_set)
        self.assertIn("topic-slug filename", skill)
        self.assertIn("always include a Release Notes page", skill)
        self.assertIn("**New documentation set:**", canonical_ia)
        self.assertIn("`about/release-notes`", canonical_ia)
        self.assertIn("Do not ship an empty placeholder", canonical_ia)
        self.assertIn("always includes a Release Notes page", page_set)
        self.assertIn("Freeze the document", skill)
        self.assertIn("runtime-selected mode", skill)
        self.assertNotIn("::tpl-new-site", skill)
        self.assertNotIn("site-scaffold.py", skill)
        self.assertNotIn("/skill:", skill)

        self.assertIn("Overlay the target repository", canonical_ia)
        self.assertIn("## Table of Contents", canonical_ia)
        self.assertIn("title case for headings", canonical_ia)
        self.assertIn("### About", canonical_ia)
        self.assertIn("### Get Started", canonical_ia)
        self.assertIn("### Use Case", canonical_ia)
        self.assertIn("### Reference", canonical_ia)
        self.assertIn("### Troubleshooting", canonical_ia)
        self.assertIn("### Resources", canonical_ia)
        self.assertIn("Fixed Issues", canonical_ia)
        self.assertIn("Known Issues", canonical_ia)
        self.assertIn("Core Concepts", canonical_ia)
        self.assertIn("Use Cases", canonical_ia)
        self.assertIn("Next Steps", canonical_ia)
        self.assertIn("Support Matrix", canonical_ia)
        self.assertIn("Previous Releases", canonical_ia)
        self.assertIn("Related Topics", canonical_ia)
        self.assertNotIn("Fixed issues in the release", canonical_ia)
        self.assertNotIn("Known issues in the release", canonical_ia)
        self.assertIn("Catalog organization is not destination IA", canonical_ia)
        self.assertIn("Do not put product names in filenames", canonical_ia)
        self.assertIn("Use hyphens, not underscores", canonical_ia)
        self.assertIn("target repository's documentation tree and navigation win", canonical_ia)
        self.assertNotIn("::tpl-new-site", canonical_ia)
        self.assertNotIn("site-scaffold.py", canonical_ia)
        self.assertNotIn("/skill:", canonical_ia)

        self.assertIn("`create`", page_set)
        self.assertIn("`update`", page_set)
        self.assertIn("`restructure`", page_set)
        self.assertIn("`retain`", page_set)
        self.assertIn("`move`", page_set)
        self.assertIn("`merge`", page_set)
        self.assertIn("`split`", page_set)
        self.assertIn("`revise-with-evidence`", page_set)
        self.assertIn("`deprecate-with-rationale`", page_set)
        self.assertIn("`out-of-scope`", page_set)
        self.assertIn("Do not infer deletion from a missing target", page_set)
        self.assertNotIn("write-documentation", page_set)
        self.assertNotIn("/skill:", page_set)


if __name__ == "__main__":
    unittest.main()
