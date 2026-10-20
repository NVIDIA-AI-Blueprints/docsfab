#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.

"""Validate a layered documentation quality result against its profile."""

from __future__ import annotations

import argparse
import json
from pathlib import Path, PurePosixPath
import sys
from typing import Any

import quality_decision_policy as quality_policy
from quality_decision_policy import (
    CONSTRAINT_KEYS,
    require_mapping as _require_mapping,
    require_string_list as _require_string_list,
)
from validate_json_artifact import load_json, validate_json_artifact

# Every derived member this validator checks goes through
# ``quality_policy.RULES``, looked up at call time, so the deriver and the
# validator share one implementation of each rule.


def _canonical_repo_relative_path(
    value: str, label: str, errors: list[str]
) -> str | None:
    """Return one canonical repository-relative POSIX path or record an error."""
    if value.startswith("/") or PurePosixPath(value).is_absolute():
        errors.append(f"{label} path {value!r} must be repository-relative")
        return None
    if "\\" in value:
        errors.append(f"{label} path {value!r} must use POSIX separators")
        return None

    segments = value.split("/")
    comparable_segments = segments[:-1] if segments and segments[-1] == "" else segments
    if any(segment in ("", ".", "..") for segment in comparable_segments):
        errors.append(
            f"{label} path {value!r} must not contain empty, '.', or '..' segments"
        )
        return None

    normalized = PurePosixPath(value).as_posix().rstrip("/")
    if not normalized or normalized == ".":
        errors.append(f"{label} path {value!r} must identify a repository location")
        return None
    return normalized


def _validate_target_classification(
    evaluation: dict[str, Any], profile: dict[str, Any], errors: list[str]
) -> None:
    target = _require_mapping(evaluation.get("target"), "target")
    families = set(
        _require_string_list(
            target.get("documentation_families"), "target.documentation_families"
        )
    )
    evidence_items = target.get("documentation_family_evidence")
    if not isinstance(evidence_items, list):
        raise ValueError("target.documentation_family_evidence must contain an array")
    evidenced_families: set[str] = set()
    raw_target_paths = _require_string_list(target.get("paths"), "target.paths")
    target_paths = [
        normalized
        for index, value in enumerate(raw_target_paths)
        if (
            normalized := _canonical_repo_relative_path(
                value, f"target.paths[{index}]", errors
            )
        )
        is not None
    ]

    for item in evidence_items:
        evidence = _require_mapping(item, "target.documentation_family_evidence item")
        family = evidence.get("family")
        if not isinstance(family, str):
            raise ValueError("documentation family evidence must name a family")
        if family not in families:
            errors.append(
                f"documentation family evidence references undeclared family {family!r}"
            )
        if family in evidenced_families:
            errors.append(f"documentation family evidence repeats family {family!r}")
        evidenced_families.add(family)
        raw_evidence_paths = _require_string_list(
            evidence.get("paths"), "documentation family evidence paths"
        )
        for index, value in enumerate(raw_evidence_paths):
            evidence_path = _canonical_repo_relative_path(
                value,
                f"target.documentation_family_evidence[{family!r}].paths[{index}]",
                errors,
            )
            if evidence_path is None:
                continue
            if quality_policy.RULES["family-paths-subset"]([evidence_path], target_paths):
                errors.append(
                    f"documentation family evidence path {evidence_path!r} "
                    "is unrelated to target.paths"
                )
    for family in sorted(families - evidenced_families):
        errors.append(f"documentation family {family!r} lacks classification evidence")

    if target.get("scope_type") != "individual-page":
        return
    applicability = _require_mapping(profile.get("applicability"), "profile.applicability")
    individual_page = _require_mapping(
        applicability.get("individual_page"), "profile.applicability.individual_page"
    )
    prefixes = _require_mapping(
        individual_page.get("path_prefix_by_family"),
        "profile individual-page path prefixes",
    )
    normalized_prefixes = {
        family: normalized
        for family, prefix in prefixes.items()
        if isinstance(prefix, str)
        and (
            normalized := _canonical_repo_relative_path(
                prefix, f"profile path prefix {family!r}", errors
            )
        )
        is not None
    }
    for path in target_paths:
        inferred = [
            family
            for family, prefix in normalized_prefixes.items()
            if path == prefix or path.startswith(f"{prefix}/")
        ]
        if inferred and not set(inferred).issubset(families):
            errors.append(
                f"path {path!r} implies family {inferred[0]!r}, not the declared family"
            )


def _dimension_maps(
    evaluation: dict[str, Any], errors: list[str]
) -> dict[str, dict[str, dict[str, Any]]]:
    layers = _require_mapping(evaluation.get("layers"), "layers")
    result: dict[str, dict[str, dict[str, Any]]] = {}
    for layer_id, layer_value in layers.items():
        layer = _require_mapping(layer_value, f"layers.{layer_id}")
        dimensions = layer.get("dimensions")
        if not isinstance(dimensions, list):
            raise ValueError(f"layers.{layer_id}.dimensions must contain an array")
        indexed: dict[str, dict[str, Any]] = {}
        for item in dimensions:
            dimension = _require_mapping(item, f"layers.{layer_id}.dimensions item")
            dimension_id = dimension.get("dimension_id")
            if not isinstance(dimension_id, str):
                raise ValueError(f"layers.{layer_id} contains a dimension without an ID")
            if dimension_id in indexed:
                errors.append(f"layers.{layer_id} repeats dimension {dimension_id!r}")
            indexed[dimension_id] = dimension
        result[layer_id] = indexed
    return result


def _validate_dimensions(
    evaluation: dict[str, Any], profile: dict[str, Any], errors: list[str]
) -> tuple[dict[str, dict[str, Any]], dict[str, dict[str, dict[str, Any]]]]:
    """Check layer dimensions; return the derived applicability and dimensions by layer."""
    allowed = quality_policy.profile_dimensions(profile)
    applicability = quality_policy.RULES["applicability-from-profile"](
        _require_mapping(evaluation.get("target"), "target"), profile
    )
    required = _required_by_layer(applicability)
    actual = _dimension_maps(evaluation, errors)
    _require_mapping(profile.get("evidence_policy"), "profile.evidence_policy")

    for layer_id, allowed_dimensions in allowed.items():
        layers = _require_mapping(evaluation.get("layers"), "layers")
        layer = _require_mapping(layers.get(layer_id), f"layers.{layer_id}")
        layer_decision = layer.get("decision")
        layer_dimensions = actual.get(layer_id, {})
        layer_required = required.get(layer_id, set())
        unknown = set(layer_dimensions) - set(allowed_dimensions)
        for dimension_id in sorted(unknown):
            errors.append(f"layers.{layer_id} contains unknown dimension {dimension_id!r}")
        missing = layer_required - set(layer_dimensions)
        for dimension_id in sorted(missing):
            errors.append(f"layers.{layer_id} is missing required dimension {dimension_id!r}")

        derived_layer_decision = quality_policy.RULES["layer-decision"](
            _require_string_list(
                layer.get("hard_gate_failures"),
                f"layers.{layer_id}.hard_gate_failures",
            ),
            list(layer_dimensions.values()),
            layer_required,
            profile,
        )
        if (
            layer_decision in ("pass", "conditional-pass")
            and derived_layer_decision != "pass"
            and not layer_required
        ):
            errors.append(
                f"layers.{layer_id} {layer_decision} requires at least one required dimension"
            )

        for dimension_id, dimension in layer_dimensions.items():
            is_required = dimension_id in layer_required
            if is_required:
                expected = applicability["dimensions"][layer_id][dimension_id]
                if dimension.get("applicability") != expected:
                    errors.append(
                        f"required dimension {dimension_id!r} must have applicability 'required'"
                    )

            assessment = dimension.get("assessment")
            if (
                layer_decision in ("pass", "conditional-pass")
                and derived_layer_decision != "pass"
                and is_required
                and assessment != "met"
            ):
                errors.append(
                    f"layers.{layer_id} {layer_decision} requires dimension "
                    f"{dimension_id!r} to be met"
                )
            errors.extend(
                quality_policy.check_record(
                    "dimension", dimension_id, dimension, profile, required=is_required
                )
            )

        layer_confidence = layer.get("confidence")
        dimensions = list(layer_dimensions.values())
        if isinstance(layer_confidence, (int, float)) and not isinstance(
            layer_confidence, bool
        ):
            expected_confidence = float(
                quality_policy.RULES["layer-confidence-minimum"](dimensions, layer_required)
            )
            observed_confidence = float(layer_confidence)
            if observed_confidence != expected_confidence:
                if not layer_required:
                    errors.append(
                        f"layers.{layer_id} confidence must be 0 when no dimensions are required"
                    )
                elif observed_confidence > expected_confidence:
                    errors.append(
                        f"layers.{layer_id} confidence exceeds its lowest "
                        "required-dimension confidence"
                    )
                else:
                    errors.append(
                        f"layers.{layer_id} confidence is below its lowest "
                        "required-dimension confidence"
                    )
    return applicability, actual


def _required_by_layer(applicability: dict[str, dict[str, Any]]) -> dict[str, set[str]]:
    return {
        layer_id: set(dimensions)
        for layer_id, dimensions in applicability["dimensions"].items()
    }


def _validate_hard_gates(
    evaluation: dict[str, Any],
    profile: dict[str, Any],
    applicability: dict[str, dict[str, Any]],
    actual: dict[str, dict[str, dict[str, Any]]],
    errors: list[str],
) -> None:
    required = _required_by_layer(applicability)
    vocabulary = set(_require_string_list(profile.get("hard_gates"), "profile.hard_gates"))
    top_level = _require_string_list(
        evaluation.get("hard_gate_failures"), "hard_gate_failures"
    )
    if len(top_level) != len(set(top_level)):
        errors.append("hard_gate_failures must be unique")
    for gate in sorted(set(top_level) - vocabulary):
        errors.append(f"hard_gate_failures contains unknown gate {gate!r}")

    layer_gate_lists: list[list[str]] = []
    layers = _require_mapping(evaluation.get("layers"), "layers")
    for layer_id, layer_value in layers.items():
        layer = _require_mapping(layer_value, f"layers.{layer_id}")
        failures = _require_string_list(
            layer.get("hard_gate_failures"), f"layers.{layer_id}.hard_gate_failures"
        )
        derived_decision = quality_policy.RULES["layer-decision"](
            failures,
            list(actual.get(layer_id, {}).values()),
            required.get(layer_id, set()),
            profile,
        )
        if failures and derived_decision == "fail" and layer.get("decision") != "fail":
            errors.append(
                f"layers.{layer_id} hard gate failures require layer decision 'fail'"
            )
        layer_gate_lists.append(failures)
        for gate in sorted(set(failures) - vocabulary):
            errors.append(f"layers.{layer_id} contains unknown hard gate {gate!r}")
    layer_failures = set(quality_policy.RULES["overall-gates-union"](layer_gate_lists, profile))
    for gate in sorted(layer_failures - set(top_level)):
        errors.append(f"layer hard gate {gate!r} is missing from top-level hard_gate_failures")

    decision = evaluation.get("overall_decision")
    gate_decision = quality_policy.RULES["overall-decision"]({}, top_level, profile)
    if top_level and gate_decision == "fail" and decision != "fail":
        errors.append("a nonempty hard_gate_failures list requires overall_decision 'fail'")


def _validate_constraints(
    evaluation: dict[str, Any],
    applicability: dict[str, dict[str, Any]],
    errors: list[str],
) -> None:
    constraints = _require_mapping(evaluation.get("constraints"), "constraints")
    seen_dimension_ids: dict[str, str] = {}
    for constraint_id, schema_key in CONSTRAINT_KEYS.items():
        result = _require_mapping(constraints.get(schema_key), f"constraints.{schema_key}")
        actual_id = result.get("dimension_id")
        if actual_id != constraint_id:
            errors.append(
                f"constraints.{schema_key} dimension_id must be {constraint_id!r}, "
                f"not {actual_id!r}"
            )
        if isinstance(actual_id, str):
            previous = seen_dimension_ids.get(actual_id)
            if previous is not None:
                errors.append(
                    f"constraints repeats dimension_id {actual_id!r} under "
                    f"{previous!r} and {schema_key!r}"
                )
            seen_dimension_ids[actual_id] = schema_key

    for constraint_id, expected in applicability["constraints"].items():
        schema_key = CONSTRAINT_KEYS[constraint_id]
        result = _require_mapping(constraints.get(schema_key), f"constraints.{schema_key}")
        if result.get("applicability") != expected:
            errors.append(f"constraint {constraint_id!r} must have applicability 'required'")


def _validate_outcomes(evaluation: dict[str, Any], errors: list[str]) -> None:
    outcomes = _require_mapping(evaluation.get("outcomes"), "outcomes")
    all_attempt_ids: dict[str, str] = {}
    for population in ("human", "agent"):
        attempts = outcomes.get(population)
        if not isinstance(attempts, list):
            raise ValueError(f"outcomes.{population} must contain an array")
        for attempt in attempts:
            result = _require_mapping(attempt, f"outcomes.{population} item")
            attempt_id = result.get("attempt_id")
            if isinstance(attempt_id, str):
                previous_population = all_attempt_ids.get(attempt_id)
                if previous_population is not None:
                    errors.append(
                        f"outcomes repeats attempt_id {attempt_id!r} across "
                        f"{previous_population!r} and {population!r}"
                    )
                all_attempt_ids[attempt_id] = population
            for evidence in result.get("evidence", []):
                if not isinstance(evidence, dict):
                    continue
                evidence_population = evidence.get("population")
                if (
                    evidence.get("evidence_class") == "outcome-evaluation"
                    and evidence_population != population
                ):
                    errors.append(
                        f"outcomes.{population} outcome-evaluation evidence must be "
                        f"labeled for population {population!r}, not "
                        f"{evidence_population!r}"
                    )
                elif evidence_population not in (None, population):
                    errors.append(
                        f"outcomes.{population} contains evidence for population {evidence_population!r}"
                    )


def _validate_decision(
    evaluation: dict[str, Any],
    profile: dict[str, Any],
    applicability: dict[str, dict[str, Any]],
    actual: dict[str, dict[str, dict[str, Any]]],
    errors: list[str],
) -> None:
    decision = evaluation.get("overall_decision")
    evaluator = _require_mapping(evaluation.get("evaluator"), "evaluator")
    layers = _require_mapping(evaluation.get("layers"), "layers")
    layer_decisions = {
        layer_id: _require_mapping(value, f"layers.{layer_id}").get("decision")
        for layer_id, value in layers.items()
    }
    layer_decision = quality_policy.RULES["overall-decision"](layer_decisions, [], profile)
    decision_without_profile_ceiling = quality_policy.RULES["overall-decision"](
        layer_decisions, [], {**profile, "release_gate_eligible": True}
    )
    if layer_decision == "fail" and decision != "fail":
        errors.append("a failing layer requires overall_decision 'fail'")
    if decision in ("pass", "conditional-pass"):
        # The most favorable decision the profile admits: one passing layer, no gate.
        most_favorable = quality_policy.RULES["overall-decision"](
            {"*": "pass"}, [], profile
        )
        if most_favorable not in ("pass", "conditional-pass"):
            errors.append("the selected experimental profile is not release-gate eligible")
        if decision_without_profile_ceiling != "pass":
            errors.append("pass or conditional-pass requires every layer decision to pass")
        if evaluator.get("independent_of_authors") is not True:
            errors.append("pass or conditional-pass requires an independent evaluator")
        if (
            decision == "conditional-pass"
            and quality_policy.RULES["conditions-from-policy"](profile) is not None
        ):
            errors.append("the selected profile does not permit conditional-pass")
        required = _require_string_list(
            _require_mapping(profile.get("constraints"), "profile.constraints").get(
                "required"
            ),
            "profile.constraints.required",
        )
        constraints = _require_mapping(evaluation.get("constraints"), "constraints")
        for constraint_id in required:
            schema_key = CONSTRAINT_KEYS[constraint_id]
            result = _require_mapping(
                constraints.get(schema_key), f"constraints.{schema_key}"
            )
            if result.get("assessment") != "met":
                errors.append(
                    f"pass or conditional-pass requires constraint {constraint_id!r} to be met"
                )

        evidence_policy = _require_mapping(
            profile.get("evidence_policy"), "profile.evidence_policy"
        )
        needs_separate_outcomes = any(
            isinstance(policy, dict)
            and policy.get("preserve_human_agent_results_separately") is True
            for policy in evidence_policy.values()
        )
        if needs_separate_outcomes:
            outcomes = _require_mapping(evaluation.get("outcomes"), "outcomes")
            outcome_policy = _require_mapping(
                profile.get("outcome_policy"), "profile.outcome_policy"
            )
            populations = _require_string_list(
                outcome_policy.get("required_populations"),
                "profile.outcome_policy.required_populations",
            )
            minimum_attempts = outcome_policy.get(
                "minimum_verified_attempts_per_population"
            )
            minimum_success_rate = outcome_policy.get("minimum_success_rate")
            if (
                not isinstance(minimum_attempts, int)
                or isinstance(minimum_attempts, bool)
                or minimum_attempts < 1
            ):
                raise ValueError(
                    "profile outcome minimum attempts must be a positive integer"
                )
            if (
                not isinstance(minimum_success_rate, (int, float))
                or isinstance(minimum_success_rate, bool)
                or not 0 <= float(minimum_success_rate) <= 1
            ):
                raise ValueError(
                    "profile outcome minimum success rate must be between 0 and 1"
                )
            for population in populations:
                attempts = outcomes.get(population)
                if not attempts:
                    errors.append(
                        f"pass or conditional-pass requires {population} outcome evidence"
                    )
                    continue
                if not isinstance(attempts, list):
                    raise ValueError(f"outcomes.{population} must contain an array")
                verified_attempts = [
                    attempt
                    for attempt in attempts
                    if isinstance(attempt, dict)
                    and attempt.get("verified") is True
                ]
                verified_successes = [
                    attempt
                    for attempt in verified_attempts
                    if attempt.get("outcome") == "success"
                    and any(
                        isinstance(item, dict)
                        and item.get("evidence_class") == "outcome-evaluation"
                        and item.get("population") == population
                        for item in attempt.get("evidence", [])
                    )
                ]
                if (
                    outcome_policy.get("unverified_attempts") == "block-pass"
                    and len(verified_attempts) != len(attempts)
                ):
                    errors.append(
                        f"pass or conditional-pass rejects unverified {population} outcomes"
                    )
                if len(verified_attempts) < minimum_attempts:
                    errors.append(
                        "pass or conditional-pass requires at least "
                        f"{minimum_attempts} verified {population} outcome attempt(s)"
                    )
                success_rate = (
                    len(verified_successes) / len(verified_attempts)
                    if verified_attempts
                    else 0.0
                )
                if success_rate < float(minimum_success_rate):
                    errors.append(
                        f"verified {population} outcome success rate {success_rate:.3f} "
                        f"is below required {float(minimum_success_rate):.3f}"
                    )

    confidence = evaluation.get("confidence")
    required = _required_by_layer(applicability)
    layer_dimensions = {
        layer_id: list(actual.get(layer_id, {}).values())
        for layer_id in quality_policy.profile_dimensions(profile)
    }
    if isinstance(confidence, (int, float)) and not isinstance(confidence, bool):
        expected_confidence = float(
            quality_policy.RULES["overall-confidence-minimum"](layer_dimensions, required)
        )
        observed_confidence = float(confidence)
        if observed_confidence != expected_confidence:
            has_required_confidence = any(
                quality_policy.required_confidences(dimensions, required.get(layer_id, set()))
                for layer_id, dimensions in layer_dimensions.items()
            )
            if not has_required_confidence:
                errors.append("overall confidence must be 0 when no dimensions are required")
            elif observed_confidence > expected_confidence:
                errors.append("overall confidence exceeds the lowest required-dimension confidence")
            else:
                errors.append("overall confidence is below the lowest required-dimension confidence")


def validate_documentation_quality_evaluation(
    evaluation: dict[str, Any], profile: dict[str, Any]
) -> list[str]:
    """Return semantic profile-validation errors for one evaluation."""
    errors: list[str] = []
    profile_ref = _require_mapping(evaluation.get("profile"), "profile")
    if profile_ref.get("id") != profile.get("id"):
        errors.append("evaluation profile ID does not match the selected profile")
    if profile_ref.get("version") != profile.get("version"):
        errors.append("evaluation profile version does not match the selected profile")
    if evaluation.get("model_version") != profile.get("model"):
        errors.append("evaluation model_version does not match the selected profile")

    _validate_target_classification(evaluation, profile, errors)
    applicability, actual = _validate_dimensions(evaluation, profile, errors)
    _validate_hard_gates(evaluation, profile, applicability, actual, errors)
    _validate_constraints(evaluation, applicability, errors)
    _validate_outcomes(evaluation, errors)
    _validate_decision(evaluation, profile, applicability, actual, errors)

    findings = evaluation.get("findings")
    if isinstance(findings, list):
        allowed_finding_dimensions = {
            dimension_id
            for dimensions in quality_policy.profile_dimensions(profile).values()
            for dimension_id in dimensions
        } | set(CONSTRAINT_KEYS)
        finding_ids = [
            finding.get("id")
            for finding in findings
            if isinstance(finding, dict) and isinstance(finding.get("id"), str)
        ]
        if len(finding_ids) != len(set(finding_ids)):
            errors.append("finding IDs must be unique")
        for index, finding in enumerate(findings):
            if not isinstance(finding, dict):
                continue
            dimension_id = finding.get("dimension_id")
            if (
                isinstance(dimension_id, str)
                and dimension_id not in allowed_finding_dimensions
            ):
                errors.append(
                    f"findings[{index}].dimension_id {dimension_id!r} is not a "
                    "profile dimension or constraint"
                )
    return errors


def main() -> int:
    """Validate schema shape and semantic profile consistency."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("artifact", type=Path)
    parser.add_argument("--schema", required=True, type=Path)
    parser.add_argument("--profile", required=True, type=Path)
    args = parser.parse_args()

    try:
        value, errors = validate_json_artifact(args.artifact, args.schema)
        profile = load_json(args.profile)
        if not isinstance(value, dict):
            raise ValueError("documentation quality evaluation must contain an object")
        if not isinstance(profile, dict):
            raise ValueError("documentation quality profile must contain an object")
        if not errors:
            errors.extend(validate_documentation_quality_evaluation(value, profile))
    except ValueError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2

    if errors:
        for error in errors:
            print(f"error: {error}", file=sys.stderr)
        return 1
    print(f"Documentation quality evaluation is valid: {args.artifact}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
