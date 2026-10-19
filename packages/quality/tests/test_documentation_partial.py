# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.

from __future__ import annotations

import copy
import json
from pathlib import Path
import sys
import unittest

from _repo_root import repo_root


ROOT = repo_root()
QUALITY = ROOT / "packages" / "quality"
sys.path.insert(0, str(QUALITY / "checks"))

from validate_documentation_partial import (  # noqa: E402
    validate_documentation_partial,
)
from validate_json_artifact import validate_json_schema  # noqa: E402


SCHEMA = json.loads(
    (QUALITY / "schemas" / "documentation-partial-result.schema.json").read_text(
        encoding="utf-8"
    )
)


def sha(value: str) -> str:
    import hashlib

    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def valid_partial(**overrides: object) -> dict[str, object]:
    markdown = "# Supported Linux install\n\nUse the repository-observed Linux package.\n"
    envelope: dict[str, object] = {
        "schemaVersion": 1,
        "kind": "docsfab-documentation-partial-result",
        "originalRequest": {
            "instructionSha256": sha("create-install"),
            "workflow": "create-documentation",
            "repositoryRevision": "a" * 40,
            "targetPaths": ["docs/get-started.md"],
        },
        "sourceIdentity": {"assessmentIdentitySha256": "b" * 64, "snapshotSha256": "c" * 64},
        "applicability": "useful-partial",
        "draft": {
            "format": "markdown",
            "bytesSha256": sha(markdown),
            "locator": "bytes:sha256:" + sha(markdown),
        },
        "obligations": [
            {
                "id": "target-01",
                "origin": "workflow",
                "targetPaths": ["docs/get-started.md"],
                "condition": "Linux install is supported.",
                "status": "supported",
                "evidenceSpanIds": ["SPAN-001"],
                "detail": "README install stanza.",
                "proposedDeliverable": "included-supported",
            },
            {
                "id": "explicit-macos",
                "origin": "explicit",
                "targetPaths": ["docs/get-started.md"],
                "condition": "macOS install",
                "status": "missing",
                "evidenceSpanIds": [],
                "detail": "No macOS source.",
                "proposedDeliverable": "deferred",
            },
        ],
        "unresolvedQuestions": [
            {
                "obligationId": "explicit-macos",
                "readerTask": "Install on macOS",
                "neededSourceOrDecision": "Repository evidence or a product decision for macOS install.",
            }
        ],
        "originalUnmetRequirementIds": ["explicit-macos"],
        "claimsNotMade": [
            "Complete installation guide",
            "Any macOS command",
            "Publication eligibility",
        ],
        "publicationEligible": False,
    }
    envelope.update(overrides)
    return envelope


class DocumentationPartialTests(unittest.TestCase):
    def test_schema_accepts_useful_partial(self) -> None:
        errors = validate_json_schema(valid_partial(), SCHEMA)
        self.assertEqual(errors, [])
        self.assertEqual(validate_documentation_partial(valid_partial()), [])

    def test_schema_rejects_publication_true(self) -> None:
        value = valid_partial(publicationEligible=True)
        errors = validate_documentation_partial(value)
        self.assertTrue(any("publicationEligible" in item for item in errors))

    def test_rejects_unsupported_included_supported(self) -> None:
        value = valid_partial()
        obligations = copy.deepcopy(value["obligations"])
        obligations[0]["status"] = "missing"
        value["obligations"] = obligations
        errors = validate_documentation_partial(value)
        self.assertTrue(any("included-supported" in item for item in errors))

    def test_rejects_template_structure_used_as_product_evidence(self) -> None:
        value = valid_partial()
        obligations = copy.deepcopy(value["obligations"])
        obligations[0]["proposedDeliverable"] = "template-structure"
        value["obligations"] = obligations
        errors = validate_documentation_partial(value)
        self.assertTrue(any("template-structure" in item for item in errors))

    def test_rejects_useful_partial_without_included_supported(self) -> None:
        value = valid_partial()
        obligations = copy.deepcopy(value["obligations"])
        obligations[0]["proposedDeliverable"] = "deferred"
        obligations[0]["status"] = "missing"
        value["obligations"] = obligations
        errors = validate_documentation_partial(value)
        self.assertTrue(any("useful-partial" in item for item in errors))

    def test_no_useful_deliverable_omits_draft_body(self) -> None:
        value = valid_partial(
            applicability="no-useful-deliverable",
            draft=None,
            originalUnmetRequirementIds=["target-01", "explicit-macos"],
        )
        obligations = copy.deepcopy(value["obligations"])
        obligations[0]["status"] = "missing"
        obligations[0]["proposedDeliverable"] = "deferred"
        obligations[0]["evidenceSpanIds"] = []
        value["obligations"] = obligations
        self.assertEqual(validate_documentation_partial(value), [])


if __name__ == "__main__":
    unittest.main()
