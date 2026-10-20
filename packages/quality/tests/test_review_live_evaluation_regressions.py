# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.

"""Regression fixtures from two recorded review-live evaluator payloads (#1221, #1126).

Both payloads come from main ``f05a81f1b``. Runs ``14a76aaa`` and ``a46d742d``
failed ``evaluate-document-quality`` with ``evaluation-invalid``. The fixtures
are the recorded evaluation payloads, re-indented with sorted keys only. Their canonical JSON
digests equal the recorded ``payloadSha256`` values. They evaluate a disposable
fixture repository and contain no credentials, host paths, or personal data.

The locked validator rejects them for three model-produced shapes:

* a profile-required dimension assessed as ``not-applicable``;
* a layer confidence above its lowest required-dimension confidence, where
  that minimum is a ``not-assessed`` dimension; and
* one placeholder ``attempt_id`` reused for the human and agent "not run"
  outcomes.

The validator rules are right. The host contract and skill guidance now state
the representation that satisfies them. Applying that representation makes
each recorded payload valid. Skipping any one correction leaves exactly that
rule's recorded rejection.
"""

from __future__ import annotations

from copy import deepcopy
import hashlib
import json
from pathlib import Path
import sys
import unittest


QUALITY = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(QUALITY / "checks"))

from validate_documentation_quality_evaluation import (  # noqa: E402
    validate_documentation_quality_evaluation,
)
from validate_json_artifact import validate_json_schema  # noqa: E402


FIXTURES = QUALITY / "tests" / "fixtures" / "documentation-quality-evaluation"
PROFILE = json.loads(
    (QUALITY / "profiles" / "docsfab-documentation-quality" / "profile.json").read_text(
        encoding="utf-8"
    )
)
SCHEMA = json.loads(
    (QUALITY / "schemas" / "documentation-quality-evaluation.schema.json").read_text(
        encoding="utf-8"
    )
)
REQUIRED_BY_LAYER = PROFILE["applicability"]["documentation_set"][
    "required_dimensions_by_layer"
]

NOT_APPLICABLE = "not-applicable"
CONFIDENCE = "confidence"
OUTCOMES = "outcomes"
CORRECTIONS = (NOT_APPLICABLE, CONFIDENCE, OUTCOMES)

RECORDED = {
    "review-live-main-f05a81f1-a.json": {
        "payload_sha256": "405854219466482c8061ca4c8628f2f27755beaa839e949fe284e58cfdc6eea7",
        "errors": {
            NOT_APPLICABLE: [
                "required dimension 'visual-explanation' cannot be not-applicable",
                "required dimension 'interaction-responsiveness' cannot be not-applicable",
            ],
            CONFIDENCE: [],
            OUTCOMES: ["outcomes repeats attempt_id 'not-run' across 'human' and 'agent'"],
        },
    },
    "review-live-main-f05a81f1-b.json": {
        "payload_sha256": "ab9168096cebc343fad544d56ab2eb7b658fc30cdc0ab13ae4ddc928fec9bd94",
        "errors": {
            NOT_APPLICABLE: [
                "required dimension 'interaction-responsiveness' cannot be not-applicable",
            ],
            CONFIDENCE: [
                "layers.trustworthy_information confidence exceeds its lowest "
                "required-dimension confidence",
                "layers.transferable_understanding confidence exceeds its lowest "
                "required-dimension confidence",
            ],
            OUTCOMES: [
                "outcomes repeats attempt_id "
                "'test-audience-understanding-prerequisites-only' across 'human' and 'agent'"
            ],
        },
    },
}


def load(name: str) -> dict[str, object]:
    return json.loads((FIXTURES / name).read_text(encoding="utf-8"))


def apply_contract(
    evaluation: dict[str, object], corrections: tuple[str, ...] = CORRECTIONS
) -> dict[str, object]:
    """Apply the host-contract representation for the selected corrections."""
    corrected = deepcopy(evaluation)
    layers = corrected["layers"]
    assert isinstance(layers, dict)
    lowest_overall: list[float] = []
    for layer_id, layer in layers.items():
        required = set(REQUIRED_BY_LAYER[layer_id])
        required_confidences: list[float] = []
        for dimension in layer["dimensions"]:
            if dimension["dimension_id"] not in required:
                continue
            if NOT_APPLICABLE in corrections and dimension["assessment"] == "not-applicable":
                dimension["assessment"] = "not-assessed"
                for item in dimension["evidence"]:
                    item["strength"] = "none"
                layer["limitations"].append(
                    f"{dimension['dimension_id']} was not assessed from the available evidence."
                )
            required_confidences.append(float(dimension["confidence"]))
        if CONFIDENCE in corrections and required_confidences:
            layer["confidence"] = min(float(layer["confidence"]), min(required_confidences))
        lowest_overall.extend(required_confidences)
    if CONFIDENCE in corrections and lowest_overall:
        corrected["confidence"] = min(float(corrected["confidence"]), min(lowest_overall))
    if OUTCOMES in corrections:
        corrected["outcomes"] = {"human": [], "agent": []}
    return corrected


class RecordedReviewLiveEvaluationTests(unittest.TestCase):
    def test_fixtures_are_the_recorded_payloads_and_fail_with_their_recorded_issues(
        self,
    ) -> None:
        for name, recorded in RECORDED.items():
            with self.subTest(fixture=name):
                evaluation = load(name)
                canonical = json.dumps(
                    evaluation, sort_keys=True, separators=(",", ":"), ensure_ascii=False
                ).encode("utf-8")
                self.assertEqual(
                    hashlib.sha256(canonical).hexdigest(), recorded["payload_sha256"]
                )
                self.assertEqual(validate_json_schema(evaluation, SCHEMA), [])
                errors = validate_documentation_quality_evaluation(evaluation, PROFILE)
                self.assertCountEqual(
                    errors,
                    [error for kind in CORRECTIONS for error in recorded["errors"][kind]],
                )

    def test_contract_representation_makes_each_recorded_payload_valid(self) -> None:
        for name in RECORDED:
            with self.subTest(fixture=name):
                corrected = apply_contract(load(name))
                self.assertEqual(validate_json_schema(corrected, SCHEMA), [])
                self.assertEqual(
                    validate_documentation_quality_evaluation(corrected, PROFILE), []
                )
                self.assertEqual(corrected["outcomes"], {"human": [], "agent": []})

    def test_each_rule_still_rejects_its_recorded_shape_when_left_uncorrected(
        self,
    ) -> None:
        for name, recorded in RECORDED.items():
            for skipped in CORRECTIONS:
                with self.subTest(fixture=name, uncorrected=skipped):
                    applied = tuple(kind for kind in CORRECTIONS if kind != skipped)
                    errors = validate_documentation_quality_evaluation(
                        apply_contract(load(name), applied), PROFILE
                    )
                    self.assertCountEqual(errors, recorded["errors"][skipped])


if __name__ == "__main__":
    unittest.main()
