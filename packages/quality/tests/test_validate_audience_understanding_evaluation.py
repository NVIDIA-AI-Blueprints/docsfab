# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.

from __future__ import annotations

from copy import deepcopy
import json
from pathlib import Path
import sys
import unittest

from _repo_root import repo_root


ROOT = repo_root()
QUALITY = ROOT / "packages" / "quality"
sys.path.insert(0, str(QUALITY / "checks"))

from validate_audience_understanding_evaluation import (  # noqa: E402
    validate_audience_understanding_evaluation,
)
from validate_json_artifact import validate_json_schema  # noqa: E402


SCHEMA = json.loads(
    (QUALITY / "schemas" / "audience-understanding-evaluation.schema.json").read_text(
        encoding="utf-8"
    )
)


def participant(population: str = "human") -> dict[str, object]:
    configuration: dict[str, object] = {
        "human_profile_locator": "evidence://audiences/technical-writer",
        "agent_provider": None,
        "agent_model": None,
        "system_instructions_hash": None,
        "retrieval_configuration": None,
        "tool_configuration": None,
        "context_budget": None,
        "run_id": None,
    }
    participant_id = "HUMAN-001"
    authorization = "evidence://consent/HUMAN-001"
    if population == "agent":
        participant_id = "AGENT-001"
        authorization = "evidence://run-authority/AGENT-001"
        configuration = {
            "human_profile_locator": None,
            "agent_provider": "example-provider",
            "agent_model": "example-model-v1",
            "system_instructions_hash": f"sha256:{'1' * 64}",
            "retrieval_configuration": "docs-only-v1",
            "tool_configuration": "read-and-search-only-v1",
            "context_budget": 32000,
            "run_id": "RUN-AGENT-001",
        }
    return {
        "participant_id": participant_id,
        "population": population,
        "audience_match": "matched",
        "prerequisite_evidence": "evidence://prerequisites/verified",
        "consent_or_run_authorization_locator": authorization,
        "configuration": configuration,
        "contamination": {
            "state": "clean",
            "authorship_participation": False,
            "synthesis_participation": False,
            "prior_review_participation": False,
            "expected_answers_exposed": False,
            "private_authoring_context_exposed": False,
            "prior_results_exposed": False,
            "non_safety_coaching_during_measurement": False,
            "evidence_locator": f"evidence://independence/{participant_id}",
            "rationale": "The participant received only the frozen documentation and prompt.",
        },
        "attempts": [
            {
                "attempt_id": f"ATTEMPT-{participant_id}",
                "scenario_id": "SCENARIO-CONCEPT-001",
                "started_at": "2026-08-18T12:01:00Z",
                "completed_at": "2026-08-18T12:02:00Z",
                "prompt_locator": "corpus://concept-001/prompt",
                "response_locator": f"evidence://responses/{participant_id}",
                "trace_locator": f"evidence://traces/{participant_id}",
                "outcome": "success",
                "correctness": "met",
                "relationship_fidelity": "met",
                "boundary_recognition": "met",
                "prediction_or_transfer": "met",
                "confidence": 0.8,
                "evidence_location_success": "met",
                "interventions": [],
                "misconceptions": [],
                "scored_by": "EVALUATOR-001",
                "score_evidence_locator": f"evidence://scores/{participant_id}",
                "limitations": [],
            }
        ],
        "evidence_status": "direct-outcome-evidence",
        "limitations": [],
    }


def population_summary(
    participant_count: int, attempt_count: int
) -> dict[str, object]:
    scenario_ids = ["SCENARIO-CONCEPT-001"] if attempt_count else []
    return {
        "participant_count": participant_count,
        "direct_evidence_participant_count": participant_count,
        "attempt_count": attempt_count,
        "direct_evidence_attempt_count": attempt_count,
        "scenario_ids": scenario_ids,
        "measures": [],
        "limitations": [],
    }


def valid_evaluation(population: str = "human") -> dict[str, object]:
    selected = participant(population)
    summaries = {
        "human": population_summary(1, 1)
        if population == "human"
        else population_summary(0, 0),
        "agent": population_summary(1, 1)
        if population == "agent"
        else population_summary(0, 0),
    }
    return {
        "schema_version": "docsfab.quality.audience-understanding-evaluation/v1",
        "evaluation_id": "AUDIENCE-EVAL-001",
        "evaluation_version": "v0.1",
        "evaluated_at": "2026-08-18T12:05:00Z",
        "target": {
            "repository_revision": "7b5685f",
            "documentation_revision": f"sha256:{'0' * 64}",
            "documentation_paths": ["docs/conceptual/product-reference-model.md"],
            "delivery_surface_locator": "http://localhost:3003",
            "product_version": "in-development",
            "product_reference_model": {
                "id": "DOCSFAB-PRODUCT",
                "version": "v0.4",
                "locator": ".docsfab/reference-model/model/v0.4",
            },
            "approved_evidence_revision": "ASSESS-DOCSFAB-DOCS-001",
            "audience_profile_id": "technical-writer-v1",
            "declared_prerequisites": ["technical documentation experience"],
            "allowed_tools": ["web browser"],
            "risk_boundary": "In-development conceptual documentation only.",
        },
        "evaluator": {
            "provider_id": "EVALUATOR-001",
            "provider_type": "human",
            "independent_of_authors": True,
            "independence_evidence": "evidence://evaluator/independence",
        },
        "protocol": {
            "protocol_version": "audience-understanding-v1",
            "scenario_corpus_id": "DOCSFAB-CONCEPT-CORPUS",
            "scenario_corpus_version": "v0.1",
            "scenario_corpus_locator": "corpus://docsfab-concepts/v0.1",
            "scenario_frozen_at": "2026-08-18T11:50:00Z",
            "exposure_started_at": "2026-08-18T12:00:00Z",
            "measured_phase_ended_at": "2026-08-18T12:03:00Z",
            "scored_at": "2026-08-18T12:04:00Z",
            "realistic_entry_point": "http://localhost:3003",
            "maximum_prompts_per_scenario": 3,
            "maximum_attempts_per_participant": 2,
            "agent_repeats_per_configuration": 0 if population == "human" else 1,
            "correction_policy": "no-substantive-correction-during-measurement",
            "debrief_after_measurement": True,
            "raw_evidence_boundary": "Private DocsFab evaluation storage.",
        },
        "scenarios": [
            {
                "scenario_id": "SCENARIO-CONCEPT-001",
                "version": "v0.1",
                "prompt_locator": "corpus://concept-001/prompt",
                "oracle_locator": "corpus://concept-001/oracle",
                "acceptance_criteria_locator": "corpus://concept-001/criteria",
                "model_claim_ids": ["CLAIM-REFERENCE-MODEL-CANONICAL"],
                "methods": ["teach-back", "relationship", "transfer"],
                "starting_point": "http://localhost:3003",
                "risk_boundary": "No product mutation or credential use.",
            }
        ],
        "participants": [selected],
        "population_summaries": summaries,
        "evidence_status": "direct-outcome-evidence",
        "findings": [],
        "limitations": ["One calibration participant does not establish a population baseline."],
    }


class ValidateAudienceUnderstandingEvaluationTests(unittest.TestCase):
    def test_valid_human_evaluation_passes_shape_and_semantics(self) -> None:
        evaluation = valid_evaluation()

        assert validate_json_schema(evaluation, SCHEMA) == []
        assert validate_audience_understanding_evaluation(evaluation) == []

    def test_valid_clean_agent_evaluation_preserves_reproducibility(self) -> None:
        evaluation = valid_evaluation("agent")

        assert validate_json_schema(evaluation, SCHEMA) == []
        assert validate_audience_understanding_evaluation(evaluation) == []

    def test_answer_exposure_contaminates_direct_evidence(self) -> None:
        evaluation = valid_evaluation()
        contamination = evaluation["participants"][0]["contamination"]
        contamination["expected_answers_exposed"] = True

        errors = validate_audience_understanding_evaluation(evaluation)

        assert any("must be contaminated" in error for error in errors)

    def test_scenario_must_be_frozen_before_exposure(self) -> None:
        evaluation = valid_evaluation()
        evaluation["protocol"]["scenario_frozen_at"] = "2026-08-18T12:01:00Z"

        errors = validate_audience_understanding_evaluation(evaluation)

        assert any("frozen before" in error for error in errors)

    def test_attempt_cannot_drift_from_frozen_prompt(self) -> None:
        evaluation = valid_evaluation()
        attempt = evaluation["participants"][0]["attempts"][0]
        attempt["prompt_locator"] = "corpus://changed-prompt"

        errors = validate_audience_understanding_evaluation(evaluation)

        assert any("differs from the frozen scenario" in error for error in errors)

    def test_measured_coaching_requires_contamination(self) -> None:
        evaluation = valid_evaluation()
        attempt = evaluation["participants"][0]["attempts"][0]
        attempt["interventions"] = [
            {
                "kind": "substantive-coaching",
                "during_measured_phase": True,
                "description": "The evaluator explained the component relationship.",
                "evidence_locator": "evidence://interventions/1",
            }
        ]

        errors = validate_audience_understanding_evaluation(evaluation)

        assert any("must set the contamination signal" in error for error in errors)

    def test_safety_intervention_cannot_count_as_unassisted_success(self) -> None:
        evaluation = valid_evaluation()
        attempt = evaluation["participants"][0]["attempts"][0]
        attempt["interventions"] = [
            {
                "kind": "safety",
                "during_measured_phase": True,
                "description": "The evaluator stopped an unsafe action.",
                "evidence_locator": "evidence://interventions/1",
            }
        ]

        errors = validate_audience_understanding_evaluation(evaluation)

        assert any("safety intervention" in error for error in errors)

    def test_population_summary_must_match_attempts(self) -> None:
        evaluation = valid_evaluation()
        evaluation["population_summaries"]["human"]["attempt_count"] = 2

        errors = validate_audience_understanding_evaluation(evaluation)

        assert any("attempt_count must equal 1" in error for error in errors)

    def test_agent_requires_reproducible_configuration(self) -> None:
        evaluation = valid_evaluation("agent")
        evaluation["participants"][0]["configuration"]["agent_model"] = None

        errors = validate_audience_understanding_evaluation(evaluation)

        assert any("lacks reproducibility fields" in error for error in errors)

    def test_agent_can_record_configuration_failure_as_insufficient_evidence(
        self,
    ) -> None:
        evaluation = valid_evaluation("agent")
        participant_record = evaluation["participants"][0]
        participant_record["configuration"]["agent_model"] = None
        participant_record["configuration"]["context_budget"] = None
        participant_record["evidence_status"] = "insufficient-evidence"
        evaluation["evidence_status"] = "insufficient-evidence"
        evaluation["population_summaries"]["agent"][
            "direct_evidence_participant_count"
        ] = 0
        evaluation["population_summaries"]["agent"][
            "direct_evidence_attempt_count"
        ] = 0

        errors = validate_audience_understanding_evaluation(evaluation)

        assert not any("lacks reproducibility fields" in error for error in errors)

    def test_direct_agent_evidence_enforces_declared_repeat_count(self) -> None:
        evaluation = valid_evaluation("agent")
        evaluation["protocol"]["agent_repeats_per_configuration"] = 3

        errors = validate_audience_understanding_evaluation(evaluation)

        assert any("protocol requires 3" in error for error in errors)

    def test_repeat_group_excludes_run_specific_identity(self) -> None:
        evaluation = valid_evaluation("agent")
        original = evaluation["participants"][0]
        repeated = deepcopy(original)
        repeated["participant_id"] = "AGENT-002"
        repeated["configuration"]["run_id"] = "RUN-AGENT-002"
        repeated["attempts"][0]["attempt_id"] = "ATTEMPT-AGENT-002"
        repeated["attempts"][0]["response_locator"] = "evidence://responses/AGENT-002"
        repeated["attempts"][0]["trace_locator"] = "evidence://traces/AGENT-002"
        repeated["contamination"]["evidence_locator"] = (
            "evidence://independence/AGENT-002"
        )
        evaluation["participants"].append(repeated)
        evaluation["protocol"]["agent_repeats_per_configuration"] = 2
        agent_summary = evaluation["population_summaries"]["agent"]
        agent_summary["participant_count"] = 2
        agent_summary["direct_evidence_participant_count"] = 2
        agent_summary["attempt_count"] = 2
        agent_summary["direct_evidence_attempt_count"] = 2

        errors = validate_audience_understanding_evaluation(evaluation)

        assert errors == []

    def test_direct_evidence_requires_independent_evaluator(self) -> None:
        evaluation = valid_evaluation()
        evaluation["evaluator"]["independent_of_authors"] = False

        errors = validate_audience_understanding_evaluation(evaluation)

        assert any("independent of authors" in error for error in errors)


if __name__ == "__main__":
    unittest.main()
