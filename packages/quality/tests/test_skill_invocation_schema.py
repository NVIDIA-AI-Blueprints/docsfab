# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.

from __future__ import annotations

import json
import unittest
from pathlib import Path
import sys


ROOT = Path(
    __file__
).resolve().parents[3]
QUALITY = ROOT / "packages" / "quality"
sys.path.insert(0, str(QUALITY / "checks"))

from validate_json_artifact import validate_json_schema  # noqa: E402


SCHEMA = json.loads(
    (QUALITY / "schemas" / "skill-invocation.schema.json").read_text(encoding="utf-8")
)


def profile(**overrides: object) -> dict[str, object]:
    value: dict[str, object] = {
        "id": "plain-guidance",
        "operation": "load-guidance",
        "contextPhase": "absent",
        "acceptedCallerFields": [],
        "requiredCallerFields": [],
        "schemaReferences": [],
        "immediateToolResultKind": "instructions-loaded",
        "applicationResultKind": "none",
        "participantContext": "not-applicable",
    }
    value.update(overrides)
    return value


def metadata(**overrides: object) -> dict[str, object]:
    value: dict[str, object] = {
        "schemaVersion": 1,
        "skillId": "write-documentation",
        "profiles": [profile()],
    }
    value.update(overrides)
    return value


class SkillInvocationSchemaTests(unittest.TestCase):
    def test_schema_is_closed_and_versioned(self) -> None:
        self.assertEqual(SCHEMA["$schema"], "https://json-schema.org/draft/2020-12/schema")
        self.assertEqual(SCHEMA["title"], "SkillInvocationV1")
        self.assertFalse(SCHEMA["additionalProperties"])
        self.assertEqual(SCHEMA["properties"]["schemaVersion"]["const"], 1)
        self.assertIn("load-guidance", SCHEMA["$defs"]["operation"]["enum"])
        self.assertIn("reader-input", SCHEMA["$defs"]["contextPhase"]["enum"])
        self.assertIn(
            "reader-context.schema.json#/$defs/readerContextInputV1",
            SCHEMA["$defs"]["schemaReference"]["enum"],
        )
        self.assertIn(
            "reader-context.schema.json#/$defs/readerContextV1",
            SCHEMA["$defs"]["schemaReference"]["enum"],
        )

    def test_accepts_independent_plain_guidance_fixture(self) -> None:
        self.assertEqual(validate_json_schema(metadata(), SCHEMA), [])

    def test_accepts_independent_input_phase_fixture(self) -> None:
        document = metadata(
            skillId="plan-documentation",
            profiles=[
                profile(
                    id="direct-reader-assessment",
                    operation="load-reader-assessment-guidance",
                    contextPhase="reader-input",
                    acceptedCallerFields=[
                        "readerContext",
                        "readerSources",
                        "readerComparison",
                    ],
                    requiredCallerFields=["readerContext"],
                    schemaReferences=[
                        "reader-context.schema.json#/$defs/readerContextInputV1"
                    ],
                    immediateToolResultKind="instructions-plus-input-projection",
                )
            ],
        )
        self.assertEqual(validate_json_schema(document, SCHEMA), [])

    def test_accepts_independent_completed_phase_fixture(self) -> None:
        document = metadata(
            profiles=[
                profile(
                    id="workflow-step-completed-reader-context",
                    operation="execute-workflow-step",
                    contextPhase="completed-reader-context",
                    schemaReferences=[
                        "reader-context.schema.json#/$defs/readerContextV1"
                    ],
                    immediateToolResultKind="workflow-step-result",
                    applicationResultKind="authoring-result",
                )
            ]
        )
        self.assertEqual(validate_json_schema(document, SCHEMA), [])

    def test_rejects_unknown_version_and_unknown_operation(self) -> None:
        self.assertTrue(validate_json_schema(metadata(schemaVersion=2), SCHEMA))
        self.assertTrue(
            validate_json_schema(
                metadata(profiles=[profile(operation="plan-pipeline")]),
                SCHEMA,
            )
        )

    def test_rejects_extra_keys_and_invented_schema_references(self) -> None:
        extra = metadata()
        extra["grant"] = True
        self.assertTrue(validate_json_schema(extra, SCHEMA))
        self.assertTrue(
            validate_json_schema(
                metadata(
                    profiles=[
                        profile(schemaReferences=["https://example.invalid/other.json"])
                    ]
                ),
                SCHEMA,
            )
        )


if __name__ == "__main__":
    unittest.main()
