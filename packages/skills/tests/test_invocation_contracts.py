# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
from __future__ import annotations

import json
import unittest
from pathlib import Path
import sys


ROOT = Path(__file__).resolve().parents[3]
QUALITY = ROOT / "packages" / "quality"
SKILLS = ROOT / "packages" / "skills"
sys.path.insert(0, str(QUALITY / "checks"))

from validate_json_artifact import validate_json_schema  # noqa: E402


SCHEMA = json.loads(
    (QUALITY / "schemas" / "skill-invocation.schema.json").read_text(encoding="utf-8")
)
CONTRACT_SKILLS = (
    "assess-documentation-readiness",
    "audit-documentation",
    "doc-context-analyzer",
    "evaluate-document-quality",
    "lint-documentation",
    "plan-documentation",
    "repo-bootstrap",
    "review-documentation",
    "template-scaffold-site",
    "test-audience-understanding",
    "tpl-design-ia",
    "verify-technical-accuracy",
    "write-documentation",
)
# Hardcoded expected compatibility. Do not derive this map from generated crate copies.
EXPECTED = {
    "repo-bootstrap": {
        "application": "authoring-result",
        "completed": True,
        "reader_assessment": False,
        "participant": "not-applicable",
    },
    "assess-documentation-readiness": {
        "application": "readiness-assessment",
        "completed": False,
        "reader_assessment": False,
        "participant": "not-applicable",
    },
    "audit-documentation": {
        "application": "audit-result",
        "completed": False,
        "reader_assessment": False,
        "participant": "not-applicable",
    },
    "doc-context-analyzer": {
        "application": "audit-result",
        "completed": True,
        "reader_assessment": False,
        "participant": "not-applicable",
    },
    "evaluate-document-quality": {
        "application": "quality-evaluation-result",
        "completed": True,
        "reader_assessment": False,
        "participant": "not-applicable",
    },
    "lint-documentation": {
        "application": "lint-result",
        "completed": True,
        "reader_assessment": False,
        "participant": "not-applicable",
    },
    "plan-documentation": {
        "application": "plan-proposal",
        "completed": False,
        "reader_assessment": True,
        "participant": "not-applicable",
    },
    "review-documentation": {
        "application": "review-result",
        "completed": True,
        "reader_assessment": False,
        "participant": "not-applicable",
    },
    "template-scaffold-site": {
        "application": "authoring-result",
        "completed": False,
        "reader_assessment": False,
        "participant": "not-applicable",
    },
    "test-audience-understanding": {
        "application": "audience-assessment-result",
        "completed": True,
        "reader_assessment": False,
        "participant": "audience-isolated",
    },
    "tpl-design-ia": {
        "application": "plan-proposal",
        "completed": False,
        "reader_assessment": False,
        "participant": "not-applicable",
    },
    "verify-technical-accuracy": {
        "application": "technical-verification-result",
        "completed": True,
        "reader_assessment": False,
        "participant": "not-applicable",
    },
    "write-documentation": {
        "application": "authoring-result",
        "completed": True,
        "reader_assessment": False,
        "participant": "not-applicable",
    },
}


class InvocationContractTests(unittest.TestCase):
    def test_installed_skills_have_validated_metadata(self) -> None:
        for skill_id in CONTRACT_SKILLS:
            with self.subTest(skill_id=skill_id):
                path = SKILLS / skill_id / "invocation.json"
                self.assertTrue(path.is_file(), f"missing {path}")
                document = json.loads(path.read_text(encoding="utf-8"))
                self.assertEqual(validate_json_schema(document, SCHEMA), [])
                self.assertEqual(document["schemaVersion"], 1)
                self.assertEqual(document["skillId"], skill_id)

    def test_expected_compatibility_is_independent_of_generated_descriptors(self) -> None:
        for skill_id, expected in EXPECTED.items():
            with self.subTest(skill_id=skill_id):
                document = json.loads(
                    (SKILLS / skill_id / "invocation.json").read_text(encoding="utf-8")
                )
                profiles = {item["id"]: item for item in document["profiles"]}
                self.assertIn("plain-guidance", profiles)
                self.assertEqual(profiles["plain-guidance"]["acceptedCallerFields"], [])
                self.assertEqual(profiles["plain-guidance"]["contextPhase"], "absent")
                self.assertIn("supporting-reference", profiles)
                self.assertEqual(profiles["supporting-reference"]["acceptedCallerFields"], [])
                self.assertIn("workflow-step-absent", profiles)
                self.assertEqual(
                    profiles["workflow-step-absent"]["applicationResultKind"],
                    expected["application"],
                )
                if expected["completed"]:
                    completed = profiles["workflow-step-completed-reader-context"]
                    self.assertEqual(completed["contextPhase"], "completed-reader-context")
                    self.assertEqual(
                        completed["applicationResultKind"], expected["application"]
                    )
                    self.assertEqual(
                        completed["participantContext"], expected["participant"]
                    )
                else:
                    self.assertNotIn(
                        "workflow-step-completed-reader-context", profiles
                    )
                if expected["reader_assessment"]:
                    assessment = profiles["direct-reader-assessment"]
                    self.assertEqual(assessment["contextPhase"], "reader-input")
                    self.assertEqual(
                        assessment["requiredCallerFields"], ["readerContext"]
                    )
                    self.assertIn("readerContext", assessment["acceptedCallerFields"])
                else:
                    self.assertNotIn("direct-reader-assessment", profiles)

    def test_retired_derive_skill_is_not_a_catalog_identity(self) -> None:
        self.assertFalse((SKILLS / "derive-source-obligations").exists())


if __name__ == "__main__":
    unittest.main()
