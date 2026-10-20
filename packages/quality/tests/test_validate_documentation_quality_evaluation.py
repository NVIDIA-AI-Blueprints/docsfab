# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.

from __future__ import annotations

import hashlib
import json
from copy import deepcopy
from pathlib import Path
import sys
import unittest

from _repo_root import owner_absent_reason, repo_root


ROOT = repo_root()
QUALITY = ROOT / "packages" / "quality"
sys.path.insert(0, str(QUALITY / "checks"))

import quality_decision_policy  # noqa: E402
from validate_documentation_quality_evaluation import (  # noqa: E402
    validate_documentation_quality_evaluation,
)
from validate_json_artifact import validate_json_schema  # noqa: E402


PROFILE = json.loads(
    (
        QUALITY
        / "profiles"
        / "docsfab-documentation-quality"
        / "profile.json"
    ).read_text(encoding="utf-8")
)
EVALUATION_SCHEMA = json.loads(
    (QUALITY / "schemas" / "documentation-quality-evaluation.schema.json").read_text(
        encoding="utf-8"
    )
)
SIGNAL_SCHEMA = json.loads(
    (QUALITY / "schemas" / "doc-quality-signals.schema.json").read_text(
        encoding="utf-8"
    )
)
RETAINED_BASELINE = (
    ROOT
    / ".docsfab"
    / "reference-model"
    / "assessments"
    / "documentation-quality"
    / "ASSESS-DOCSFAB-DOCS-QUALITY-20260818"
)


def dimension(dimension_id: str) -> dict[str, object]:
    return {
        "dimension_id": dimension_id,
        "applicability": "required",
        "assessment": "not-assessed",
        "confidence": 0,
        "evidence": [],
        "measures": [],
        "rationale": "No direct evidence has been collected.",
    }


def constraint(dimension_id: str) -> dict[str, object]:
    return {
        "dimension_id": dimension_id,
        "applicability": "required",
        "assessment": "not-assessed",
        "confidence": 0,
        "evidence": [],
        "measures": [],
        "rationale": "No direct evidence has been collected.",
    }


def finding(finding_id: str, dimension_id: str) -> dict[str, object]:
    return {
        "id": finding_id,
        "severity": "major",
        "dimension_id": dimension_id,
        "description": "A required reader task cannot be completed.",
        "evidence": [
            {
                "evidence_class": "document-inspection",
                "strength": "direct",
                "locator": "docs/procedural/install.md",
                "description": "The required instruction is absent.",
            }
        ],
        "owner": "documentation-owner",
        "acceptance_condition": "Add the missing instruction.",
        "status": "open",
    }


def baseline_evaluation() -> dict[str, object]:
    layers = {
        layer_id: {
            "decision": "insufficient-evidence",
            "confidence": 0,
            "dimensions": [dimension(item) for item in dimensions],
            "hard_gate_failures": [],
            "limitations": ["Outcome evidence is not available."],
        }
        for layer_id, dimensions in PROFILE["applicability"]["documentation_set"][
            "required_dimensions_by_layer"
        ].items()
    }
    return {
        "evaluation_id": "DOCSFAB-QUALITY-BASELINE-001",
        "evaluation_version": "v0.1",
        "evaluated_at": "2026-08-18T12:00:00Z",
        "model_version": PROFILE["model"],
        "profile": {"id": PROFILE["id"], "version": PROFILE["version"]},
        "evaluator": {
            "provider_id": "clean-evaluator",
            "provider_type": "agent",
            "independent_of_authors": True,
            "independence_evidence": "clean context receipt",
        },
        "target": {
            "scope_type": "documentation-set",
            "documentation_families": [
                "about",
                "conceptual",
                "get-started",
                "procedural",
                "reference",
                "release-notes",
                "resources",
                "troubleshooting",
            ],
            "documentation_family_evidence": [
                {
                    "family": family,
                    "paths": [f"docs/{family}/"],
                    "method": "path-convention",
                    "evidence_locator": "fern/docs.yml",
                    "rationale": "The versioned navigation declares this family.",
                }
                for family in (
                    "about",
                    "conceptual",
                    "get-started",
                    "procedural",
                    "reference",
                    "release-notes",
                    "resources",
                    "troubleshooting",
                )
            ],
            "repository_revision": "83defdc",
            "documentation_revision": f"sha256:{'0' * 64}",
            "paths": ["docs/"],
            "product_reference_model": {
                "id": "DOCSFAB-PRODUCT",
                "version": "v0.4",
            },
            "approved_evidence_revision": "ASSESS-DOCSFAB-DOCS-001",
            "product_version": "in-development",
            "environment": "local Fern preview",
            "delivery_surface_locator": "http://localhost:3003",
            "risk_boundary": "Local in-development documentation only.",
            "risk_classes": ["general-information"],
            "audiences": ["developer", "technical writer"],
            "intended_outcomes": [
                "understand DocsFab",
                "use the documented workflow",
            ],
            "intended_outcome_classes": ["orientation", "task-completion"],
        },
        "layers": layers,
        "constraints": {
            "accessibility_and_inclusion": constraint(
                "accessibility-and-inclusion"
            ),
            "global_and_localization_readiness": {
                **constraint("global-and-localization-readiness"),
                "applicability": "not-applicable",
                "assessment": "not-applicable",
            },
            "safety_security_privacy": constraint("safety-security-privacy"),
            "legal_policy_support": constraint("legal-policy-support"),
            "human_agent_representation_parity": constraint(
                "human-agent-representation-parity"
            ),
        },
        "outcomes": {"human": [], "agent": []},
        "hard_gate_failures": [],
        "overall_decision": "insufficient-evidence",
        "conditions": [],
        "confidence": 0,
        "findings": [],
        "limitations": ["Outcome evidence is not available."],
    }


class ValidateDocumentationQualityEvaluationTests(unittest.TestCase):
    def test_retained_baseline_artifacts_are_machine_valid(self) -> None:
        reason = owner_absent_reason(RETAINED_BASELINE, ROOT / ".docsfab")
        if reason is not None:
            self.skipTest(reason)
        evaluation_bytes = (RETAINED_BASELINE / "evaluation.json").read_bytes()
        signal_bytes = (RETAINED_BASELINE / "doc-quality-signals.json").read_bytes()
        evaluation = json.loads(evaluation_bytes)
        signals = json.loads(signal_bytes)

        assert validate_json_schema(evaluation, EVALUATION_SCHEMA) == []
        assert validate_documentation_quality_evaluation(evaluation, PROFILE) == []
        self.assertEqual(validate_json_schema(signals, SIGNAL_SCHEMA), [])
        self.assertEqual(
            signals["repository_revision"],
            "a7d5adcdfe74b933a6f55ce3da4d2dca9ba67dc2",
        )
        self.assertEqual(
            signals["documentation_content_hash"],
            evaluation["target"]["documentation_revision"],
        )
        self.assertEqual(
            hashlib.sha256(evaluation_bytes).hexdigest(),
            "3d887d8920d7eab3c6480361b866382073e7fbf0f01c70852b3974b5c2a95fd1",
        )
        self.assertEqual(
            hashlib.sha256(signal_bytes).hexdigest(),
            "617ce72ec14f1c0242fa1951eecce44ad439072ed644e804810422271adbf2b5",
        )

    def test_insufficient_evidence_baseline_is_semantically_valid(self) -> None:
        assert (
            validate_documentation_quality_evaluation(
                baseline_evaluation(), PROFILE
            )
            == []
        )

    def test_missing_required_dimension_is_rejected(self) -> None:
        evaluation = baseline_evaluation()
        evaluation["layers"]["trustworthy_information"]["dimensions"].pop()

        errors = validate_documentation_quality_evaluation(evaluation, PROFILE)

        assert any("missing required dimension" in error for error in errors)

    def test_empty_required_layer_uses_d7_missing_evidence_not_failure(self) -> None:
        evaluation = baseline_evaluation()
        profile = deepcopy(PROFILE)
        profile["applicability"]["documentation_set"]["required_dimensions_by_layer"][
            "trustworthy_information"
        ] = []
        evaluation["layers"]["trustworthy_information"]["decision"] = "pass"

        errors = validate_documentation_quality_evaluation(evaluation, profile)
        decision = quality_decision_policy.RULES["layer-decision"](
            [],
            evaluation["layers"]["trustworthy_information"]["dimensions"],
            [],
            profile,
        )
        gated_decision = quality_decision_policy.RULES["layer-decision"](
            ["critical-factual-error"],
            evaluation["layers"]["trustworthy_information"]["dimensions"],
            [],
            profile,
        )

        self.assertEqual(decision, "insufficient-evidence")
        self.assertEqual(gated_decision, "fail")
        self.assertIn(
            "layers.trustworthy_information pass requires at least one required dimension",
            errors,
        )

    def test_contradictory_pass_is_rejected(self) -> None:
        evaluation = baseline_evaluation()
        evaluation["overall_decision"] = "pass"
        evaluation["evaluator"]["independent_of_authors"] = False
        evaluation["hard_gate_failures"] = ["critical-factual-error"]

        errors = validate_documentation_quality_evaluation(evaluation, PROFILE)

        assert any("requires overall_decision 'fail'" in error for error in errors)
        self.assertTrue(any("not release-gate eligible" in error for error in errors))
        self.assertTrue(any("requires an independent evaluator" in error for error in errors))
        self.assertTrue(
            any("requires every layer decision to pass" in error for error in errors)
        )
        self.assertTrue(any("requires human outcome evidence" in error for error in errors))
        self.assertTrue(any("requires agent outcome evidence" in error for error in errors))

    def test_duplicate_and_unknown_dimensions_are_rejected(self) -> None:
        evaluation = baseline_evaluation()
        dimensions = evaluation["layers"]["trustworthy_information"]["dimensions"]
        dimensions.append(dimension("factual-accuracy"))
        dimensions.append(dimension("imaginary-quality"))

        errors = validate_documentation_quality_evaluation(evaluation, PROFILE)

        assert any("repeats dimension 'factual-accuracy'" in error for error in errors)
        self.assertTrue(any("unknown dimension 'imaginary-quality'" in error for error in errors))

    def test_layer_pass_requires_its_own_dimension_gate_and_confidence(self) -> None:
        evaluation = baseline_evaluation()
        layer = evaluation["layers"]["trustworthy_information"]
        layer["decision"] = "pass"
        layer["confidence"] = 0.5
        layer["hard_gate_failures"] = ["critical-factual-error"]
        evaluation["hard_gate_failures"] = ["critical-factual-error"]
        evaluation["overall_decision"] = "fail"

        errors = validate_documentation_quality_evaluation(evaluation, PROFILE)

        assert (
            any(
                "layers.trustworthy_information pass requires dimension" in error
                for error in errors
            )
        )
        self.assertTrue(
            any("hard gate failures require layer decision 'fail'" in error for error in errors)
        )
        self.assertTrue(
            any("confidence exceeds its lowest required-dimension" in error for error in errors)
        )

    def test_layer_confidence_below_required_minimum_is_rejected(self) -> None:
        evaluation = baseline_evaluation()
        layer = evaluation["layers"]["trustworthy_information"]
        for item in layer["dimensions"]:
            item["confidence"] = 0.5
        layer["confidence"] = 0

        errors = validate_documentation_quality_evaluation(evaluation, PROFILE)

        self.assertTrue(
            any(
                "layers.trustworthy_information confidence is below its lowest "
                "required-dimension confidence" in error
                for error in errors
            ),
            errors,
        )

    def test_layer_with_no_required_dimensions_has_zero_confidence(self) -> None:
        evaluation = baseline_evaluation()
        target = evaluation["target"]
        target["scope_type"] = "individual-page"
        target["documentation_families"] = ["procedural"]
        target["documentation_family_evidence"] = [
            {
                "family": "procedural",
                "paths": ["docs/procedural/index.md"],
                "method": "path-convention",
                "evidence_locator": "fern/docs.yml",
                "rationale": "The versioned navigation declares this family.",
            }
        ]
        target["paths"] = ["docs/procedural/index.md"]
        target["risk_classes"] = []
        target["intended_outcome_classes"] = []
        evaluation["layers"]["transferable_understanding"]["confidence"] = 0.25

        errors = validate_documentation_quality_evaluation(evaluation, PROFILE)

        self.assertTrue(
            any(
                "layers.transferable_understanding confidence must be 0 when no dimensions "
                "are required" in error
                for error in errors
            ),
            errors,
        )

    def test_overall_confidence_below_required_minimum_is_rejected(self) -> None:
        evaluation = baseline_evaluation()
        for layer in evaluation["layers"].values():
            for item in layer["dimensions"]:
                item["confidence"] = 0.5
            layer["confidence"] = 0.5
        evaluation["confidence"] = 0.25

        errors = validate_documentation_quality_evaluation(evaluation, PROFILE)

        self.assertIn(
            "overall confidence is below the lowest required-dimension confidence",
            errors,
        )

    def test_not_applicable_required_dimension_is_reported_without_rewriting_residual(self) -> None:
        evaluation = baseline_evaluation()
        residual = evaluation["layers"]["trustworthy_information"]["dimensions"][0]
        residual["assessment"] = "not-applicable"
        original = deepcopy(evaluation)

        errors = validate_documentation_quality_evaluation(evaluation, PROFILE)

        self.assertIn(
            "required dimension 'factual-accuracy' cannot be not-applicable",
            errors,
        )
        self.assertEqual(evaluation, original)

    def test_finding_dimension_id_must_name_a_profile_dimension_or_constraint(self) -> None:
        evaluation = baseline_evaluation()
        evaluation["findings"] = [
            finding("dimension-finding", "factual-accuracy"),
            finding("constraint-finding", "accessibility-and-inclusion"),
            finding("unknown-finding", "not-a-profile-dimension"),
        ]

        errors = validate_documentation_quality_evaluation(evaluation, PROFILE)

        self.assertEqual(
            [error for error in errors if "findings[" in error],
            [
                "findings[2].dimension_id 'not-a-profile-dimension' is not a "
                "profile dimension or constraint"
            ],
        )

    def test_missing_evidence_fail_is_not_misreported_as_a_hard_gate(self) -> None:
        evaluation = baseline_evaluation()
        profile = deepcopy(PROFILE)
        profile["decision_policy"]["missing_required_evidence"] = "fail"

        errors = validate_documentation_quality_evaluation(evaluation, profile)

        self.assertFalse(
            any("hard gate" in error or "hard_gate_failures" in error for error in errors),
            errors,
        )

    def test_profile_disallows_conditional_pass(self) -> None:
        evaluation = baseline_evaluation()
        evaluation["overall_decision"] = "conditional-pass"

        errors = validate_documentation_quality_evaluation(evaluation, PROFILE)

        assert any("does not permit conditional-pass" in error for error in errors)

    def test_failed_outcomes_cannot_support_pass(self) -> None:
        evaluation = baseline_evaluation()
        evaluation["overall_decision"] = "pass"
        failed_outcome = {
            "population_id": "representative",
            "task_or_scenario_id": "orientation",
            "attempt_id": "attempt-1",
            "outcome": "failure",
            "verified": False,
            "evidence": [
                {
                    "evidence_class": "outcome-evaluation",
                    "strength": "direct",
                    "population": "human",
                    "locator": "assessment://attempt-1",
                    "description": "The participant did not complete the task.",
                }
            ],
            "measures": [],
            "limitations": [],
        }
        evaluation["outcomes"] = {
            "human": [failed_outcome],
            "agent": [
                {
                    **failed_outcome,
                    "attempt_id": "attempt-2",
                    "evidence": [
                        {
                            **failed_outcome["evidence"][0],
                            "population": "agent",
                            "locator": "assessment://attempt-2",
                        }
                    ],
                }
            ],
        }
        promoted = deepcopy(PROFILE)
        promoted["release_gate_eligible"] = True

        errors = validate_documentation_quality_evaluation(evaluation, promoted)

        assert any("human outcome success rate" in error for error in errors)
        self.assertTrue(
            any("agent outcome success rate" in error for error in errors)
        )

    def test_one_success_cannot_mask_failed_or_unverified_outcomes(self) -> None:
        evaluation = baseline_evaluation()
        evaluation["overall_decision"] = "pass"

        def outcome(
            population: str, attempt_id: str, result: str, verified: bool
        ) -> dict[str, object]:
            return {
                "population_id": "representative",
                "task_or_scenario_id": "orientation",
                "attempt_id": attempt_id,
                "outcome": result,
                "verified": verified,
                "evidence": [
                    {
                        "evidence_class": "outcome-evaluation",
                        "strength": "direct",
                        "population": population,
                        "locator": f"assessment://{attempt_id}",
                        "description": "The task outcome was observed.",
                    }
                ],
                "measures": [],
                "limitations": [],
            }

        evaluation["outcomes"] = {
            population: [
                outcome(population, f"{population}-success", "success", True),
                outcome(population, f"{population}-failure", "failure", True),
                outcome(population, f"{population}-unverified", "success", False),
            ]
            for population in ("human", "agent")
        }
        promoted = deepcopy(PROFILE)
        promoted["release_gate_eligible"] = True

        errors = validate_documentation_quality_evaluation(evaluation, promoted)

        assert any("rejects unverified human outcomes" in error for error in errors)
        self.assertTrue(any("human outcome success rate" in error for error in errors))
        self.assertTrue(any("rejects unverified agent outcomes" in error for error in errors))
        self.assertTrue(any("agent outcome success rate" in error for error in errors))

    def test_one_mixed_attempt_cannot_satisfy_two_populations(self) -> None:
        evaluation = baseline_evaluation()
        shared_attempt = {
            "population_id": "representative",
            "task_or_scenario_id": "orientation",
            "attempt_id": "shared-attempt",
            "outcome": "success",
            "verified": True,
            "evidence": [
                {
                    "evidence_class": "outcome-evaluation",
                    "strength": "direct",
                    "population": "mixed",
                    "locator": "assessment://shared-attempt",
                    "description": "One mixed observation was copied into both arrays.",
                }
            ],
            "measures": [],
            "limitations": [],
        }
        evaluation["outcomes"] = {
            "human": [shared_attempt],
            "agent": [deepcopy(shared_attempt)],
        }
        evaluation["overall_decision"] = "pass"
        promoted = deepcopy(PROFILE)
        promoted["release_gate_eligible"] = True

        errors = validate_documentation_quality_evaluation(evaluation, promoted)

        assert any("repeats attempt_id 'shared-attempt'" in error for error in errors)
        self.assertTrue(
            any(
                "outcomes.human outcome-evaluation evidence must be labeled" in error
                for error in errors
            )
        )
        self.assertTrue(
            any(
                "outcomes.agent outcome-evaluation evidence must be labeled" in error
                for error in errors
            )
        )

    def test_constraint_results_are_bound_to_their_schema_keys(self) -> None:
        evaluation = baseline_evaluation()
        for result in evaluation["constraints"].values():
            result["dimension_id"] = "accessibility-and-inclusion"
        evaluation["overall_decision"] = "pass"
        promoted = deepcopy(PROFILE)
        promoted["release_gate_eligible"] = True

        errors = validate_documentation_quality_evaluation(evaluation, promoted)

        for constraint_id in (
            "global-and-localization-readiness",
            "safety-security-privacy",
            "legal-policy-support",
            "human-agent-representation-parity",
        ):
            assert (
                any(f"dimension_id must be {constraint_id!r}" in error for error in errors)
            )
        self.assertTrue(any("constraints repeats dimension_id" in error for error in errors))

    def test_page_dimensions_include_outcome_and_risk_overrides(self) -> None:
        evaluation = baseline_evaluation()
        evaluation["target"].update(
            {
                "scope_type": "individual-page",
                "documentation_families": ["about"],
                "documentation_family_evidence": [
                    {
                        "family": "about",
                        "paths": ["docs/about/security.md"],
                        "method": "path-convention",
                        "evidence_locator": "fern/docs.yml",
                        "rationale": "The versioned navigation declares this family.",
                    }
                ],
                "paths": ["docs/about/security.md"],
                "risk_classes": ["security-sensitive"],
                "intended_outcome_classes": ["conceptual-reasoning"],
            }
        )
        evaluation["layers"]["trustworthy_information"]["dimensions"] = [
            dimension("factual-accuracy"),
            dimension("boundary-clarity"),
        ]
        evaluation["layers"]["transferable_understanding"]["dimensions"] = [
            dimension("audience-fit"),
            dimension("purpose-rationale"),
        ]
        evaluation["layers"]["effective_experience"]["dimensions"] = [
            dimension("findability")
        ]

        errors = validate_documentation_quality_evaluation(evaluation, PROFILE)

        assert any("grounding-authority" in error for error in errors)
        self.assertTrue(any("conceptual-fidelity" in error for error in errors))
        self.assertTrue(any("calibrated-confidence" in error for error in errors))

    def test_page_path_must_match_declared_family(self) -> None:
        evaluation = baseline_evaluation()
        evaluation["target"].update(
            {
                "scope_type": "individual-page",
                "documentation_families": ["about"],
                "documentation_family_evidence": [
                    {
                        "family": "about",
                        "paths": ["docs/troubleshooting/problem.md"],
                        "method": "manual-reviewed",
                        "evidence_locator": "assessment://classification",
                        "rationale": "The evaluator classified the page as About.",
                    }
                ],
                "paths": ["docs/troubleshooting/problem.md"],
                "risk_classes": ["general-information"],
                "intended_outcome_classes": ["orientation"],
            }
        )

        errors = validate_documentation_quality_evaluation(evaluation, PROFILE)

        assert any("implies family 'troubleshooting'" in error for error in errors)

    def test_classification_evidence_paths_must_bind_to_target(self) -> None:
        evaluation = baseline_evaluation()
        evaluation["target"]["documentation_family_evidence"][0]["paths"] = [
            "unrelated/about/"
        ]

        errors = validate_documentation_quality_evaluation(evaluation, PROFILE)

        assert any("is unrelated to target.paths" in error for error in errors)

    def test_classification_rejects_noncanonical_target_and_evidence_paths(self) -> None:
        aliases = (
            "docs/about/../troubleshooting/problem.md",
            "docs/about//problem.md",
            "./docs/about/problem.md",
            "/docs/about/problem.md",
        )
        for alias in aliases:
            with self.subTest(alias=alias):
                evaluation = baseline_evaluation()
                evaluation["target"].update(
                    {
                        "scope_type": "individual-page",
                        "documentation_families": ["about"],
                        "documentation_family_evidence": [
                            {
                                "family": "about",
                                "paths": [alias],
                                "method": "path-convention",
                                "evidence_locator": "fern/docs.yml",
                                "rationale": "The path is intentionally noncanonical.",
                            }
                        ],
                        "paths": [alias],
                        "risk_classes": ["general-information"],
                        "intended_outcome_classes": ["orientation"],
                    }
                )

                errors = validate_documentation_quality_evaluation(evaluation, PROFILE)

                assert any(
                    "target.paths[0] path" in error for error in errors
                ), errors
                self.assertTrue(
                    any("documentation_family_evidence" in error for error in errors),
                    errors,
                )


if __name__ == "__main__":
    unittest.main()
