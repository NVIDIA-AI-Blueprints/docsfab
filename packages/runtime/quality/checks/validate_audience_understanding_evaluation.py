#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.

"""Validate an audience-understanding evaluation artifact."""

from __future__ import annotations

import argparse
from datetime import datetime
from pathlib import Path
import sys
from typing import Any

from validate_json_artifact import validate_json_artifact


CONTAMINATION_SIGNALS = (
    "authorship_participation",
    "synthesis_participation",
    "prior_review_participation",
    "expected_answers_exposed",
    "private_authoring_context_exposed",
    "prior_results_exposed",
    "non_safety_coaching_during_measurement",
)
AGENT_CONFIGURATION_FIELDS = (
    "agent_provider",
    "agent_model",
    "system_instructions_hash",
    "retrieval_configuration",
    "tool_configuration",
    "context_budget",
    "run_id",
)
SCORED_FIELDS = (
    "correctness",
    "relationship_fidelity",
    "boundary_recognition",
    "prediction_or_transfer",
)


def _mapping(value: object, label: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ValueError(f"{label} must contain an object")
    return value


def _list(value: object, label: str) -> list[Any]:
    if not isinstance(value, list):
        raise ValueError(f"{label} must contain an array")
    return value


def _timestamp(value: object, label: str) -> datetime:
    if not isinstance(value, str):
        raise ValueError(f"{label} must contain a date-time string")
    normalized = value[:-1] + "+00:00" if value.endswith(("Z", "z")) else value
    try:
        parsed = datetime.fromisoformat(normalized)
    except ValueError as exc:
        raise ValueError(f"{label} must contain an RFC 3339 date-time") from exc
    if parsed.tzinfo is None:
        raise ValueError(f"{label} must contain a timezone offset")
    return parsed


def _unique_ids(
    records: list[Any], id_field: str, label: str, errors: list[str]
) -> dict[str, dict[str, Any]]:
    indexed: dict[str, dict[str, Any]] = {}
    for index, raw_record in enumerate(records):
        record = _mapping(raw_record, f"{label}[{index}]")
        record_id = record.get(id_field)
        if not isinstance(record_id, str):
            raise ValueError(f"{label}[{index}].{id_field} must contain a string")
        if record_id in indexed:
            errors.append(f"{label} repeats {id_field} {record_id!r}")
        indexed[record_id] = record
    return indexed


def _validate_time_order(evaluation: dict[str, Any], errors: list[str]) -> None:
    protocol = _mapping(evaluation.get("protocol"), "protocol")
    frozen = _timestamp(protocol.get("scenario_frozen_at"), "protocol.scenario_frozen_at")
    exposure = _timestamp(protocol.get("exposure_started_at"), "protocol.exposure_started_at")
    measured_end = _timestamp(
        protocol.get("measured_phase_ended_at"), "protocol.measured_phase_ended_at"
    )
    scored = _timestamp(protocol.get("scored_at"), "protocol.scored_at")
    evaluated = _timestamp(evaluation.get("evaluated_at"), "evaluated_at")
    if frozen > exposure:
        errors.append("scenario corpus must be frozen before participant exposure")
    if exposure > measured_end:
        errors.append("measured phase must end after participant exposure starts")
    if measured_end > scored:
        errors.append("scoring must occur after the measured phase ends")
    if scored > evaluated:
        errors.append("evaluation record must be created after scoring")


def _validate_configuration(
    participant: dict[str, Any], label: str, errors: list[str]
) -> None:
    population = participant.get("population")
    configuration = _mapping(participant.get("configuration"), f"{label}.configuration")
    human_profile = configuration.get("human_profile_locator")
    agent_values = {field: configuration.get(field) for field in AGENT_CONFIGURATION_FIELDS}

    if population == "human":
        if not isinstance(human_profile, str) or not human_profile:
            errors.append(f"{label} human participant requires human_profile_locator")
        populated_agent_fields = [
            field for field, value in agent_values.items() if value is not None
        ]
        if populated_agent_fields:
            errors.append(
                f"{label} human participant contains agent configuration fields: "
                + ", ".join(populated_agent_fields)
            )
        return

    if population != "agent":
        raise ValueError(f"{label}.population must be human or agent")
    if human_profile is not None:
        errors.append(f"{label} agent participant must not contain human_profile_locator")
    missing = [
        field
        for field, value in agent_values.items()
        if value is None or (isinstance(value, str) and not value)
    ]
    evidence_status = participant.get("evidence_status")
    configuration_failure_statuses = {"insufficient-evidence", "failed-protocol"}
    if missing and evidence_status not in configuration_failure_statuses:
        errors.append(
            f"{label} agent participant lacks reproducibility fields: "
            + ", ".join(missing)
        )


def _validate_contamination(
    participant: dict[str, Any], label: str, errors: list[str]
) -> str:
    contamination = _mapping(
        participant.get("contamination"), f"{label}.contamination"
    )
    state = contamination.get("state")
    signaled = [field for field in CONTAMINATION_SIGNALS if contamination.get(field) is True]
    evidence_status = participant.get("evidence_status")

    if signaled and state != "contaminated":
        errors.append(
            f"{label} must be contaminated when these signals are true: "
            + ", ".join(signaled)
        )
    if state == "contaminated" and evidence_status != "contaminated":
        errors.append(f"{label} contaminated participant requires contaminated evidence_status")
    if state == "unknown" and evidence_status != "insufficient-evidence":
        errors.append(f"{label} unknown contamination requires insufficient-evidence")
    if evidence_status == "direct-outcome-evidence":
        if state != "clean":
            errors.append(f"{label} direct outcome evidence requires clean contamination state")
        if participant.get("audience_match") not in ("matched", "partial"):
            errors.append(f"{label} direct outcome evidence requires an interpretable audience match")
    return state if isinstance(state, str) else "unknown"


def _validate_attempt(
    attempt: dict[str, Any],
    participant: dict[str, Any],
    label: str,
    scenario_ids: set[str],
    scenario_prompts: dict[str, object],
    exposure: datetime,
    measured_end: datetime,
    errors: list[str],
) -> None:
    scenario_id = attempt.get("scenario_id")
    if not isinstance(scenario_id, str) or scenario_id not in scenario_ids:
        errors.append(f"{label} references unknown scenario_id {scenario_id!r}")
    elif attempt.get("prompt_locator") != scenario_prompts[scenario_id]:
        errors.append(f"{label} prompt_locator differs from the frozen scenario")

    started = _timestamp(attempt.get("started_at"), f"{label}.started_at")
    completed = _timestamp(attempt.get("completed_at"), f"{label}.completed_at")
    if started < exposure:
        errors.append(f"{label} starts before the declared exposure boundary")
    if completed < started:
        errors.append(f"{label} completes before it starts")
    if completed > measured_end:
        errors.append(f"{label} completes after the measured phase ended")

    interventions = _list(attempt.get("interventions"), f"{label}.interventions")
    measured_safety = False
    measured_coaching = False
    for index, raw_intervention in enumerate(interventions):
        intervention = _mapping(raw_intervention, f"{label}.interventions[{index}]")
        if intervention.get("during_measured_phase") is not True:
            continue
        if intervention.get("kind") == "safety":
            measured_safety = True
        if intervention.get("kind") == "substantive-coaching":
            measured_coaching = True
    if measured_coaching:
        contamination = _mapping(
            participant.get("contamination"), f"{label} participant contamination"
        )
        if contamination.get("non_safety_coaching_during_measurement") is not True:
            errors.append(
                f"{label} measured substantive coaching must set the contamination signal"
            )
    if measured_safety and attempt.get("outcome") == "success":
        errors.append(f"{label} cannot record unassisted success after a safety intervention")

    if participant.get("evidence_status") == "direct-outcome-evidence":
        for field in SCORED_FIELDS:
            if attempt.get(field) == "not-assessed":
                errors.append(f"{label} direct outcome evidence requires {field} scoring")


def _validate_population_summaries(
    evaluation: dict[str, Any], participants: list[dict[str, Any]], errors: list[str]
) -> None:
    summaries = _mapping(evaluation.get("population_summaries"), "population_summaries")
    for population in ("human", "agent"):
        summary = _mapping(summaries.get(population), f"population_summaries.{population}")
        selected = [item for item in participants if item.get("population") == population]
        attempts = [
            attempt
            for participant in selected
            for attempt in _list(participant.get("attempts"), "participant.attempts")
        ]
        direct_participants = [
            item
            for item in selected
            if item.get("evidence_status") == "direct-outcome-evidence"
        ]
        direct_attempts = [
            attempt
            for participant in direct_participants
            for attempt in _list(participant.get("attempts"), "participant.attempts")
        ]
        expected = {
            "participant_count": len(selected),
            "direct_evidence_participant_count": len(direct_participants),
            "attempt_count": len(attempts),
            "direct_evidence_attempt_count": len(direct_attempts),
        }
        for field, value in expected.items():
            if summary.get(field) != value:
                errors.append(
                    f"population_summaries.{population}.{field} must equal {value}"
                )
        scenario_ids = sorted(
            {
                attempt["scenario_id"]
                for attempt in attempts
                if isinstance(attempt, dict) and isinstance(attempt.get("scenario_id"), str)
            }
        )
        if summary.get("scenario_ids") != scenario_ids:
            errors.append(
                f"population_summaries.{population}.scenario_ids must equal {scenario_ids!r}"
            )


def _agent_configuration_key(configuration: dict[str, Any]) -> tuple[object, ...]:
    """Return a reproducibility key that excludes only run-specific identity."""
    return tuple(
        configuration.get(field)
        for field in AGENT_CONFIGURATION_FIELDS
        if field != "run_id"
    )


def _validate_agent_repeats(
    evaluation: dict[str, Any],
    participants: list[dict[str, Any]],
    scenario_ids: set[str],
    errors: list[str],
) -> None:
    """Enforce frozen repeat counts for every direct agent configuration."""
    direct_agents = [
        participant
        for participant in participants
        if participant.get("population") == "agent"
        and participant.get("evidence_status") == "direct-outcome-evidence"
    ]
    if not direct_agents:
        return

    protocol = _mapping(evaluation.get("protocol"), "protocol")
    repeats = protocol.get("agent_repeats_per_configuration")
    if not isinstance(repeats, int) or isinstance(repeats, bool) or repeats < 1:
        errors.append(
            "direct agent evidence requires agent_repeats_per_configuration "
            "to be a positive integer"
        )
        return

    grouped_runs: dict[
        tuple[object, ...], dict[str, set[str]]
    ] = {}
    seen_run_ids: set[str] = set()
    for participant in direct_agents:
        configuration = _mapping(
            participant.get("configuration"), "agent participant configuration"
        )
        run_id = configuration.get("run_id")
        if not isinstance(run_id, str) or not run_id:
            continue
        if run_id in seen_run_ids:
            errors.append(f"direct agent participants repeat run_id {run_id!r}")
        seen_run_ids.add(run_id)

        configuration_key = _agent_configuration_key(configuration)
        scenario_runs = grouped_runs.setdefault(configuration_key, {})
        attempts = _list(participant.get("attempts"), "agent participant attempts")
        for attempt in attempts:
            attempt_record = _mapping(attempt, "agent participant attempt")
            scenario_id = attempt_record.get("scenario_id")
            if isinstance(scenario_id, str) and scenario_id in scenario_ids:
                scenario_runs.setdefault(scenario_id, set()).add(run_id)

    for configuration_key, scenario_runs in grouped_runs.items():
        provider = configuration_key[0]
        model = configuration_key[1]
        for scenario_id in sorted(scenario_ids):
            actual = len(scenario_runs.get(scenario_id, set()))
            if actual < repeats:
                errors.append(
                    f"agent configuration {provider!r}/{model!r} has {actual} "
                    f"distinct run(s) for scenario {scenario_id!r}; "
                    f"protocol requires {repeats}"
                )


def validate_audience_understanding_evaluation(
    evaluation: dict[str, Any],
) -> list[str]:
    """Return semantic validation errors for one structurally valid artifact."""
    errors: list[str] = []
    _validate_time_order(evaluation, errors)
    protocol = _mapping(evaluation.get("protocol"), "protocol")
    exposure = _timestamp(protocol.get("exposure_started_at"), "protocol.exposure_started_at")
    measured_end = _timestamp(
        protocol.get("measured_phase_ended_at"), "protocol.measured_phase_ended_at"
    )

    scenarios = _list(evaluation.get("scenarios"), "scenarios")
    scenario_map = _unique_ids(scenarios, "scenario_id", "scenarios", errors)
    scenario_ids = set(scenario_map)
    scenario_prompts = {
        scenario_id: scenario.get("prompt_locator")
        for scenario_id, scenario in scenario_map.items()
    }

    participants_raw = _list(evaluation.get("participants"), "participants")
    participant_map = _unique_ids(
        participants_raw, "participant_id", "participants", errors
    )
    participants = list(participant_map.values())
    all_attempt_ids: set[str] = set()
    for participant_index, participant in enumerate(participants):
        label = f"participants[{participant_index}]"
        _validate_configuration(participant, label, errors)
        _validate_contamination(participant, label, errors)
        attempts = _list(participant.get("attempts"), f"{label}.attempts")
        maximum = protocol.get("maximum_attempts_per_participant")
        if isinstance(maximum, int) and len(attempts) > maximum:
            errors.append(f"{label} exceeds maximum_attempts_per_participant")
        local_attempts = _unique_ids(attempts, "attempt_id", f"{label}.attempts", errors)
        for attempt_id, attempt in local_attempts.items():
            if attempt_id in all_attempt_ids:
                errors.append(f"participants repeat attempt_id {attempt_id!r}")
            all_attempt_ids.add(attempt_id)
            _validate_attempt(
                attempt,
                participant,
                f"{label}.attempts[{attempt_id!r}]",
                scenario_ids,
                scenario_prompts,
                exposure,
                measured_end,
                errors,
            )

    _validate_population_summaries(evaluation, participants, errors)
    _validate_agent_repeats(evaluation, participants, scenario_ids, errors)
    if evaluation.get("evidence_status") == "direct-outcome-evidence":
        evaluator = _mapping(evaluation.get("evaluator"), "evaluator")
        if evaluator.get("independent_of_authors") is not True:
            errors.append("direct outcome evidence requires an evaluator independent of authors")
        if not any(
            item.get("evidence_status") == "direct-outcome-evidence"
            for item in participants
        ):
            errors.append("direct outcome evidence requires at least one clean participant")
    return errors


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("artifact", type=Path)
    parser.add_argument("--schema", required=True, type=Path)
    args = parser.parse_args()

    try:
        value, errors = validate_json_artifact(args.artifact, args.schema)
        if not errors:
            evaluation = _mapping(value, "evaluation")
            errors.extend(validate_audience_understanding_evaluation(evaluation))
    except ValueError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    if errors:
        for error in errors:
            print(f"error: {error}", file=sys.stderr)
        return 1
    print(f"Audience-understanding evaluation is valid: {args.artifact}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
