#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.

"""Implement each documentation-quality decision rule once, by its declared name.

``RULES`` maps every ``quality:*`` rule name in the quality-evaluation response
contract to its one implementation. The deriver computes host-derived members
with these functions, and the validators check those members with the same
functions, so a derived value and its check cannot drift. Rule data stays in
the profile; this module holds only the arithmetic and precedence.
"""

from __future__ import annotations

from typing import Any, Callable, Iterable, Mapping


CONSTRAINT_KEYS = {
    "accessibility-and-inclusion": "accessibility_and_inclusion",
    "global-and-localization-readiness": "global_and_localization_readiness",
    "safety-security-privacy": "safety_security_privacy",
    "legal-policy-support": "legal_policy_support",
    "human-agent-representation-parity": "human_agent_representation_parity",
}

# The only values a model may judge for a layer the rules leave open (D3, O2).
D3_RESIDUAL_DECISIONS = ("fail", "human-review")

# Overall precedence after hard gates (O3). The experimental cap applies last.
DECISION_PRECEDENCE = ("fail", "insufficient-evidence", "human-review", "pass")
FAVORABLE_DECISIONS = ("pass", "conditional-pass")

ESTABLISHED_ASSESSMENT = "met"
JUDGED_SHORTFALL_ASSESSMENTS = ("partially-met", "not-met")
MATERIAL_FINDING_SEVERITIES = ("critical", "major")

RECORD_TYPES = (
    "target-judgment",
    "dimension",
    "finding",
    "layer-note",
    "evaluation-note",
    "quality-score",
)

PROFILE_CEILING_LIMITATION = (
    "The selected quality profile caps decisions at insufficient-evidence while "
    "it remains experimental."
)
AUDIENCE_PREREQUISITES_LIMITATION = (
    "The selected quality profile has pending human and agent outcome baselines."
)


def require_mapping(value: object, label: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ValueError(f"{label} must contain an object")
    return value


def require_string_list(value: object, label: str) -> list[str]:
    if not isinstance(value, list) or not all(isinstance(item, str) for item in value):
        raise ValueError(f"{label} must contain a string array")
    return value


def profile_dimensions(profile: Mapping[str, Any]) -> dict[str, list[str]]:
    """Return the profile's dimension IDs by layer, in profile order."""
    applicability = require_mapping(profile.get("applicability"), "profile.applicability")
    documentation_set = require_mapping(
        applicability.get("documentation_set"),
        "profile.applicability.documentation_set",
    )
    layers = require_mapping(
        documentation_set.get("required_dimensions_by_layer"),
        "profile applicability dimensions",
    )
    return {
        layer_id: require_string_list(dimensions, f"profile layer {layer_id}")
        for layer_id, dimensions in layers.items()
    }


def required_dimensions(
    target: Mapping[str, Any], profile: Mapping[str, Any]
) -> dict[str, set[str]]:
    """Return the required dimension IDs by layer for one evaluation target."""
    all_dimensions = profile_dimensions(profile)
    scope_type = target.get("scope_type")
    if scope_type == "documentation-set":
        return {layer_id: set(dimensions) for layer_id, dimensions in all_dimensions.items()}
    if scope_type != "individual-page":
        raise ValueError(f"unsupported target scope_type: {scope_type!r}")

    families = require_string_list(
        target.get("documentation_families"), "target.documentation_families"
    )
    if len(families) != 1:
        raise ValueError("individual-page evaluation must name exactly one family")
    applicability = require_mapping(profile["applicability"], "profile.applicability")
    individual_page = require_mapping(
        applicability.get("individual_page"),
        "profile.applicability.individual_page",
    )
    by_family = require_mapping(
        individual_page.get("required_dimensions_by_family"),
        "profile individual-page family dimensions",
    )
    selected_dimensions = set(
        require_string_list(by_family.get(families[0]), f"profile family {families[0]}")
    )
    for selector, profile_key in (
        ("intended_outcome_classes", "required_dimensions_by_outcome_class"),
        ("risk_classes", "required_dimensions_by_risk_class"),
    ):
        selected_values = require_string_list(target.get(selector), f"target.{selector}")
        overrides = require_mapping(
            applicability.get(profile_key), f"profile.applicability.{profile_key}"
        )
        for selected_value in selected_values:
            selected_dimensions.update(
                require_string_list(
                    overrides.get(selected_value),
                    f"profile {profile_key}.{selected_value}",
                )
            )
    dimension_layers = {
        dimension: layer_id
        for layer_id, dimensions in all_dimensions.items()
        for dimension in dimensions
    }
    required = {layer_id: set() for layer_id in all_dimensions}
    for dimension in selected_dimensions:
        layer_id = dimension_layers.get(dimension)
        if layer_id is None:
            raise ValueError(f"profile applicability references unknown dimension: {dimension}")
        required[layer_id].add(dimension)
    return required


def required_constraints(profile: Mapping[str, Any]) -> list[str]:
    """Return the profile's required constraint IDs; the conditional one is judged (D12)."""
    policy = require_mapping(profile.get("constraints"), "profile.constraints")
    required = require_string_list(policy.get("required"), "profile.constraints.required")
    for constraint_id in required:
        if constraint_id not in CONSTRAINT_KEYS:
            raise ValueError(f"profile contains unknown constraint: {constraint_id}")
    return required


def _decision_policy(profile: Mapping[str, Any]) -> dict[str, Any]:
    policy = require_mapping(profile.get("decision_policy"), "profile.decision_policy")
    if policy.get("hard_gate_precedence") is not True:
        raise ValueError("profile.decision_policy.hard_gate_precedence must be true")
    missing = policy.get("missing_required_evidence")
    if missing not in DECISION_PRECEDENCE or missing in FAVORABLE_DECISIONS:
        raise ValueError(
            "profile.decision_policy.missing_required_evidence must name an unfavorable decision"
        )
    return policy


def _is_confidence(value: object) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def required_confidences(
    dimensions: Iterable[Mapping[str, Any]], required_ids: Iterable[str]
) -> list[int | float]:
    """Return the numeric confidences of the required dimensions, in input order."""
    required = set(required_ids)
    return [
        dimension["confidence"]
        for dimension in dimensions
        if dimension.get("dimension_id") in required
        and _is_confidence(dimension.get("confidence"))
    ]


def applicability_from_profile(
    target: Mapping[str, Any], profile: Mapping[str, Any]
) -> dict[str, dict[str, Any]]:
    """Rule ``applicability-from-profile``: required members are ``required``.

    Returns ``{"dimensions": {layer: {dimension: "required"}}, "constraints":
    {constraint: "required"}}``. A member absent from the result is judged.
    """
    return {
        "dimensions": {
            layer_id: {dimension_id: "required" for dimension_id in sorted(dimensions)}
            for layer_id, dimensions in required_dimensions(target, profile).items()
        },
        "constraints": {
            constraint_id: "required" for constraint_id in required_constraints(profile)
        },
    }


def layer_confidence_minimum(
    dimensions: Iterable[Mapping[str, Any]], required_ids: Iterable[str]
) -> int | float:
    """Rule ``layer-confidence-minimum`` (O1): the lowest required confidence, else 0 (D7)."""
    return min(required_confidences(dimensions, required_ids), default=0)


def overall_confidence_minimum(
    layer_dimensions: Mapping[str, Iterable[Mapping[str, Any]]],
    required_by_layer: Mapping[str, Iterable[str]],
) -> int | float:
    """Rule ``overall-confidence-minimum`` (O1, D8): over layer dimensions only."""
    confidences: list[int | float] = []
    for layer_id, dimensions in layer_dimensions.items():
        confidences.extend(
            required_confidences(dimensions, required_by_layer.get(layer_id, ()))
        )
    return min(confidences, default=0)


def _ordered_gates(gates: Iterable[str], profile: Mapping[str, Any]) -> list[str]:
    """Return unique gates in profile vocabulary order; unknown gates follow, never dropped."""
    vocabulary = require_string_list(profile.get("hard_gates"), "profile.hard_gates")
    seen: list[str] = []
    for gate in gates:
        if gate not in seen:
            seen.append(gate)
    known = [gate for gate in vocabulary if gate in seen]
    return known + [gate for gate in seen if gate not in vocabulary]


def layer_gates_from_records(
    dimension_ids: Iterable[str],
    gate_attribution: Mapping[str, Iterable[str]],
    profile: Mapping[str, Any],
) -> list[str]:
    """Rule ``layer-gates-from-records`` (O4): the gates judged on this layer's records."""
    gates: list[str] = []
    for dimension_id in dimension_ids:
        gates.extend(gate_attribution.get(dimension_id, ()))
    return _ordered_gates(gates, profile)


def overall_gates_union(
    gate_lists: Iterable[Iterable[str]], profile: Mapping[str, Any]
) -> list[str]:
    """Rule ``overall-gates-union``: layer gates plus constraint-attributed gates."""
    return _ordered_gates((gate for gates in gate_lists for gate in gates), profile)


def layer_decision(
    hard_gate_failures: Iterable[str],
    dimensions: Iterable[Mapping[str, Any]],
    required_ids: Iterable[str],
    profile: Mapping[str, Any],
    shortfall_decision: str | None = None,
) -> str | None:
    """Rule ``layer-decision``; ``None`` means the rules leave the layer open (D3).

    Gates decide ``fail`` first. A layer with no required dimension (D7), or
    with a required dimension that is absent or not assessed as ``met``,
    ``partially-met`` or ``not-met``, takes the profile's missing-evidence
    decision (D2). Every required dimension ``met`` is ``pass``. Otherwise the
    layer is a gateless shortfall, and only the model's residual decides it.
    A residual is read, and refused when invalid, only in that last case.
    """
    policy = _decision_policy(profile)
    if list(hard_gate_failures):
        return "fail"
    required = set(required_ids)
    if not required:
        return policy["missing_required_evidence"]
    assessments = {
        dimension.get("dimension_id"): dimension.get("assessment")
        for dimension in dimensions
        if dimension.get("dimension_id") in required
    }
    judged = (ESTABLISHED_ASSESSMENT, *JUDGED_SHORTFALL_ASSESSMENTS)
    if any(assessments.get(dimension_id) not in judged for dimension_id in required):
        return policy["missing_required_evidence"]
    if all(assessments[dimension_id] == ESTABLISHED_ASSESSMENT for dimension_id in required):
        return "pass"
    if shortfall_decision is not None and shortfall_decision not in D3_RESIDUAL_DECISIONS:
        raise ValueError(
            f"layer shortfall decision must be one of {', '.join(D3_RESIDUAL_DECISIONS)}"
        )
    return shortfall_decision


def overall_decision(
    layer_decisions: Mapping[str, str | None],
    hard_gate_failures: Iterable[str],
    profile: Mapping[str, Any],
) -> str | None:
    """Rule ``overall-decision`` (O3); ``None`` while a layer is still open.

    Gates and failing layers decide ``fail``. Otherwise the least favorable
    layer decision wins (``insufficient-evidence`` > ``human-review`` >
    ``pass``). A layer decision these rules never produce counts as missing
    evidence. The experimental cap then limits only a favorable result.
    """
    policy = _decision_policy(profile)
    if list(hard_gate_failures):
        return "fail"
    decisions = list(layer_decisions.values())
    if "fail" in decisions:
        return "fail"
    if any(decision is None for decision in decisions):
        return None
    ranked = [
        decision if decision in DECISION_PRECEDENCE else policy["missing_required_evidence"]
        for decision in decisions
    ]
    if not ranked:
        return policy["missing_required_evidence"]
    decision = next(item for item in DECISION_PRECEDENCE if item in ranked)
    if decision in FAVORABLE_DECISIONS and not profile.get("release_gate_eligible"):
        maximum = policy.get("experimental_profile_maximum_decision")
        if maximum not in DECISION_PRECEDENCE or maximum in FAVORABLE_DECISIONS:
            raise ValueError(
                "profile.decision_policy.experimental_profile_maximum_decision "
                "must name an unfavorable decision"
            )
        return maximum
    return decision


def conditions_from_policy(profile: Mapping[str, Any]) -> list[Any] | None:
    """Rule ``conditions-from-policy``: ``[]`` unless the profile permits conditional-pass.

    ``None`` means conditions are possible and therefore judged, not derived.
    """
    policy = require_mapping(profile.get("decision_policy"), "profile.decision_policy")
    return None if policy.get("conditional_pass") else []


def family_paths_subset(
    evidence_paths: Iterable[str], target_paths: Iterable[str]
) -> list[str]:
    """Rule ``family-paths-subset``: return family paths unrelated to ``target.paths``.

    Both inputs are canonical repository-relative paths. A family path is
    within the target when it equals, contains, or lies under a target path.
    """
    targets = [path.rstrip("/") for path in target_paths]

    def related(path: str) -> bool:
        normalized = path.rstrip("/")
        return any(
            normalized == target
            or normalized.startswith(f"{target}/")
            or target.startswith(f"{normalized}/")
            for target in targets
        )

    return [path for path in evidence_paths if not related(path)]


def score_total(scores: Mapping[str, int | float]) -> int | float:
    """Rule ``score-total``: the rubric total is the sum of its criterion scores."""
    return sum(scores.values())


def host_limitations(decision: str | None, profile: Mapping[str, Any]) -> list[str]:
    """Rule ``host-limitations``: profile-known limitation strings, top level only (D6)."""
    limitations: list[str] = []
    policy = require_mapping(profile.get("decision_policy"), "profile.decision_policy")
    if (
        decision == "insufficient-evidence"
        and profile.get("status") == "experimental"
        and profile.get("release_gate_eligible") is False
        and policy.get("experimental_profile_maximum_decision") == "insufficient-evidence"
    ):
        limitations.append(PROFILE_CEILING_LIMITATION)
    calibration = require_mapping(profile.get("calibration"), "profile.calibration")
    if (
        calibration.get("human_outcome_baseline") == "pending"
        and calibration.get("agent_outcome_baseline") == "pending"
    ):
        limitations.append(AUDIENCE_PREREQUISITES_LIMITATION)
    return limitations


def coherence_labels(
    evaluation: Mapping[str, Any],
    gate_attribution: Mapping[str, Iterable[str]],
    profile: Mapping[str, Any],
) -> list[str]:
    """Rule ``coherence-labels`` (N15): label split judgments; never a refusal.

    Labels name only profile IDs, gates and severities, never model text.
    """
    target = require_mapping(evaluation.get("target"), "target")
    required = required_dimensions(target, profile)
    records: list[tuple[str, Mapping[str, Any], bool]] = []
    layers = require_mapping(evaluation.get("layers"), "layers")
    for layer_id, dimension_ids in profile_dimensions(profile).items():
        layer = require_mapping(layers.get(layer_id), f"layers.{layer_id}")
        present = {
            dimension.get("dimension_id"): dimension
            for dimension in layer.get("dimensions", [])
            if isinstance(dimension, dict)
        }
        for dimension_id in dimension_ids:
            if dimension_id in present:
                records.append(
                    (dimension_id, present[dimension_id], dimension_id in required[layer_id])
                )
    constraints = require_mapping(evaluation.get("constraints"), "constraints")
    required_constraint_ids = set(required_constraints(profile))
    for constraint_id, schema_key in CONSTRAINT_KEYS.items():
        result = constraints.get(schema_key)
        if isinstance(result, dict):
            records.append((constraint_id, result, constraint_id in required_constraint_ids))

    findings = [item for item in evaluation.get("findings", []) if isinstance(item, dict)]
    labels: list[str] = []
    for record_id, record, is_required in records:
        assessment = record.get("assessment")
        if assessment == ESTABLISHED_ASSESSMENT:
            for gate in _ordered_gates(gate_attribution.get(record_id, ()), profile):
                labels.append(
                    f"Coherence: hard gate {gate} is attributed on {record_id}, "
                    "which is assessed met."
                )
            for severity in MATERIAL_FINDING_SEVERITIES:
                if any(
                    finding.get("dimension_id") == record_id
                    and finding.get("severity") == severity
                    for finding in findings
                ):
                    labels.append(
                        f"Coherence: a {severity} finding names {record_id}, "
                        "which is assessed met."
                    )
        elif assessment == "not-met" and is_required and not any(
            finding.get("dimension_id") == record_id for finding in findings
        ):
            labels.append(
                f"Coherence: required dimension {record_id} is not met, "
                "and no finding names it."
            )
    return labels


def check_record(
    record_type: str,
    key: str,
    record: Mapping[str, Any],
    profile: Mapping[str, Any],
    *,
    required: bool | None = None,
) -> list[str]:
    """Return the record-local profile errors for one judgment record.

    Dimension records carry the evidence rules. ``required`` defaults to the
    documentation-set applicability of ``key``. Constraint records and the
    other record types have no record-local profile rule beyond their schema.
    """
    if record_type not in RECORD_TYPES:
        raise ValueError(f"unknown quality record type: {record_type!r}")
    if record_type != "dimension" or key in CONSTRAINT_KEYS:
        return []
    if required is None:
        layers = profile_dimensions(profile)
        if not any(key in dimensions for dimensions in layers.values()):
            raise ValueError(f"unknown quality dimension record key: {key!r}")
        required = True

    errors: list[str] = []
    evidence_policy = require_mapping(
        profile.get("evidence_policy"), "profile.evidence_policy"
    )
    assessment = record.get("assessment")
    evidence = record.get("evidence")
    if assessment == ESTABLISHED_ASSESSMENT and not evidence:
        errors.append(f"dimension {key!r} is met without evidence")
    if assessment == "not-applicable" and required:
        errors.append(f"required dimension {key!r} cannot be not-applicable")
    if isinstance(evidence, list) and assessment == ESTABLISHED_ASSESSMENT:
        if any(isinstance(item, dict) and item.get("strength") == "none" for item in evidence):
            errors.append(f"dimension {key!r} is met with evidence strength 'none'")

    policy = evidence_policy.get(key)
    if assessment == ESTABLISHED_ASSESSMENT and isinstance(policy, dict):
        minimum_class = policy.get("minimum_class")
        classes = {
            item.get("evidence_class") for item in evidence or [] if isinstance(item, dict)
        }
        if minimum_class not in classes:
            errors.append(f"dimension {key!r} lacks required evidence class {minimum_class!r}")
    return errors


RULES: dict[str, Callable[..., Any]] = {
    "applicability-from-profile": applicability_from_profile,
    "layer-confidence-minimum": layer_confidence_minimum,
    "overall-confidence-minimum": overall_confidence_minimum,
    "layer-gates-from-records": layer_gates_from_records,
    "overall-gates-union": overall_gates_union,
    "layer-decision": layer_decision,
    "overall-decision": overall_decision,
    "conditions-from-policy": conditions_from_policy,
    "family-paths-subset": family_paths_subset,
    "score-total": score_total,
    "host-limitations": host_limitations,
    "coherence-labels": coherence_labels,
}
