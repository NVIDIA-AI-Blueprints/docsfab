#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.

"""Derive the host-owned members of a documentation quality evaluation.

The input carries the evaluation with its model-judged, host-known and
referenced members in place, the gate attribution from the dimension and
constraint records (O4), and any layer shortfall residuals (O2). The deriver
fills every host-derived member through ``quality_decision_policy.RULES`` and
returns the profile-known limitations and coherence labels for the assembler
to compose. It never reads model text and never writes stdout.
"""

from __future__ import annotations

import argparse
from copy import deepcopy
import json
import os
from pathlib import Path
import sys
from typing import Any, Mapping

import quality_decision_policy as quality_policy
from quality_decision_policy import CONSTRAINT_KEYS, require_mapping, require_string_list


INPUT_KIND = "docsfab-quality-derivation-input"
OUTPUT_KIND = "docsfab-quality-derivation-output"
SCHEMA_VERSION = 1
INPUT_FIELDS = {
    "schemaVersion",
    "kind",
    "evaluation",
    "qualityScore",
    "gateAttribution",
    "layerShortfallDecisions",
    "textPathGates",
}
REQUIRED_INPUT_FIELDS = INPUT_FIELDS - {"textPathGates"}


def _gate_attribution(value: object, record_keys: set[str]) -> dict[str, list[str]]:
    attribution = require_mapping(value, "gateAttribution")
    for key, gates in attribution.items():
        if key not in record_keys:
            raise ValueError(f"gateAttribution names an unknown record key: {key!r}")
        require_string_list(gates, f"gateAttribution.{key}")
    return attribution


def derive_documentation_quality_evaluation(
    derivation_input: Mapping[str, Any], profile: Mapping[str, Any]
) -> dict[str, Any]:
    """Return the derived evaluation and score, or the layers still open (D3)."""
    if not REQUIRED_INPUT_FIELDS.issubset(derivation_input) or set(derivation_input) - INPUT_FIELDS:
        raise ValueError("derivation input must contain exactly the declared fields")
    if (
        derivation_input.get("schemaVersion") != SCHEMA_VERSION
        or derivation_input.get("kind") != INPUT_KIND
    ):
        raise ValueError("derivation input has an unsupported contract")
    evaluation = deepcopy(require_mapping(derivation_input.get("evaluation"), "evaluation"))
    target = require_mapping(evaluation.get("target"), "target")
    layers = require_mapping(evaluation.get("layers"), "layers")
    constraints = require_mapping(evaluation.get("constraints"), "constraints")
    profile_layers = quality_policy.profile_dimensions(profile)
    if set(layers) != set(profile_layers):
        raise ValueError("evaluation layers must equal the profile layers")

    dimensions_by_layer: dict[str, list[dict[str, Any]]] = {}
    for layer_id in profile_layers:
        layer = require_mapping(layers[layer_id], f"layers.{layer_id}")
        dimensions = layer.get("dimensions")
        if not isinstance(dimensions, list):
            raise ValueError(f"layers.{layer_id}.dimensions must contain an array")
        dimensions_by_layer[layer_id] = [
            require_mapping(item, f"layers.{layer_id}.dimensions item") for item in dimensions
        ]
    dimension_keys = [
        dimension.get("dimension_id")
        for dimensions in dimensions_by_layer.values()
        for dimension in dimensions
    ]
    if len(dimension_keys) != len(set(dimension_keys)):
        raise ValueError("evaluation repeats a dimension record key")
    record_keys = set(dimension_keys) | set(CONSTRAINT_KEYS)
    attribution = _gate_attribution(derivation_input.get("gateAttribution"), record_keys)
    raw_text_path_gates = derivation_input.get("textPathGates")
    text_path_gates: dict[str, list[str]] | None = None
    top_level_gates: list[str] = []
    if raw_text_path_gates is not None:
        text_path = require_mapping(raw_text_path_gates, "textPathGates")
        if set(text_path) != {"layers", "overall"}:
            raise ValueError("textPathGates must contain exactly layers and overall")
        layer_values = require_mapping(text_path.get("layers"), "textPathGates.layers")
        if set(layer_values) != set(profile_layers):
            raise ValueError("textPathGates.layers must equal the profile layers")
        text_path_gates = {}
        for layer_id, gates in layer_values.items():
            text_path_gates[layer_id] = require_string_list(
                gates, f"textPathGates.layers.{layer_id}"
            )
        top_level_gates = require_string_list(
            text_path.get("overall"), "textPathGates.overall"
        )
    residuals = require_mapping(
        derivation_input.get("layerShortfallDecisions"), "layerShortfallDecisions"
    )
    for layer_id in residuals:
        if layer_id not in profile_layers:
            raise ValueError(f"layerShortfallDecisions names an unknown layer: {layer_id!r}")

    applicability = quality_policy.RULES["applicability-from-profile"](target, profile)
    required = {
        layer_id: set(dimensions)
        for layer_id, dimensions in applicability["dimensions"].items()
    }
    for layer_id, dimensions in dimensions_by_layer.items():
        for dimension in dimensions:
            derived = applicability["dimensions"][layer_id].get(dimension.get("dimension_id"))
            if derived is not None:
                dimension["applicability"] = derived
    for constraint_id, derived in applicability["constraints"].items():
        require_mapping(
            constraints.get(CONSTRAINT_KEYS[constraint_id]),
            f"constraints.{CONSTRAINT_KEYS[constraint_id]}",
        )["applicability"] = derived

    layer_gates: dict[str, list[str]] = {}
    layer_decisions: dict[str, str | None] = {}
    open_layers: list[str] = []
    ignored_residuals: list[str] = []
    for layer_id, dimensions in dimensions_by_layer.items():
        dimension_ids = [dimension.get("dimension_id") for dimension in dimensions]
        layer_gates[layer_id] = (
            quality_policy.RULES["layer-gates-from-records"](
                dimension_ids, attribution, profile
            )
            if text_path_gates is None
            else quality_policy.RULES["layer-gates-from-records"](
                [layer_id], {layer_id: text_path_gates[layer_id]}, profile
            )
        )
        ruled = quality_policy.RULES["layer-decision"](
            layer_gates[layer_id], dimensions, required[layer_id], profile
        )
        residual = residuals.get(layer_id)
        decision = ruled
        if residual is not None and ruled is not None:
            # The rules decide this layer, so its residual is ignored unread.
            ignored_residuals.append(layer_id)
        elif residual is not None:
            if text_path_gates is not None and residual not in quality_policy.D3_RESIDUAL_DECISIONS:
                # Keep an invalid residual open for the runtime adapter to
                # issue the catalogued, host-authored correctable refusal.
                decision = None
            else:
                decision = quality_policy.RULES["layer-decision"](
                    layer_gates[layer_id], dimensions, required[layer_id], profile, residual
                )
        layer_decisions[layer_id] = decision
        if decision is None:
            open_layers.append(layer_id)

    constraint_gates = (
        [gate for constraint_id in CONSTRAINT_KEYS for gate in attribution.get(constraint_id, ())]
        if text_path_gates is None
        else top_level_gates
    )
    overall_gates = quality_policy.RULES["overall-gates-union"](
        [*layer_gates.values(), constraint_gates], profile
    )
    overall = quality_policy.RULES["overall-decision"](layer_decisions, overall_gates, profile)

    if open_layers:
        return {
            "schemaVersion": SCHEMA_VERSION,
            "kind": OUTPUT_KIND,
            "status": "open",
            "openLayers": open_layers,
            "ignoredShortfallDecisions": ignored_residuals,
            "evaluation": None,
            "qualityScore": None,
            "hostLimitations": [],
            "coherenceLabels": [],
        }

    for layer_id, dimensions in dimensions_by_layer.items():
        layer = layers[layer_id]
        layer["confidence"] = quality_policy.RULES["layer-confidence-minimum"](
            dimensions, required[layer_id]
        )
        layer["hard_gate_failures"] = layer_gates[layer_id]
        layer["decision"] = layer_decisions[layer_id]
    evaluation["confidence"] = quality_policy.RULES["overall-confidence-minimum"](
        dimensions_by_layer, required
    )
    evaluation["hard_gate_failures"] = overall_gates
    evaluation["overall_decision"] = overall
    conditions = quality_policy.RULES["conditions-from-policy"](profile)
    if conditions is None:
        raise ValueError("the profile permits conditional-pass, so conditions are judged")
    evaluation["conditions"] = conditions

    score = derivation_input.get("qualityScore")
    if score is not None:
        score = deepcopy(require_mapping(score, "qualityScore"))
        scores = require_mapping(score.get("scores"), "qualityScore.scores")
        if not all(
            isinstance(value, (int, float)) and not isinstance(value, bool)
            for value in scores.values()
        ):
            raise ValueError("qualityScore.scores must contain only numbers")
        score["total"] = quality_policy.RULES["score-total"](scores)

    return {
        "schemaVersion": SCHEMA_VERSION,
        "kind": OUTPUT_KIND,
        "status": "derived",
        "openLayers": [],
        "ignoredShortfallDecisions": ignored_residuals,
        "evaluation": evaluation,
        "qualityScore": score,
        "hostLimitations": quality_policy.RULES["host-limitations"](overall, profile),
        "coherenceLabels": (
            quality_policy.RULES["coherence-labels"](evaluation, attribution, profile)
            if text_path_gates is None
            else []
        ),
    }


def _load_json(path: Path) -> object:
    return json.loads(
        path.read_text(encoding="utf-8"),
        parse_constant=lambda value: (_ for _ in ()).throw(
            ValueError(f"non-finite JSON number: {value}")
        ),
    )


def main() -> int:
    """Derive one evaluation and write the result to a new private file."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("derivation_input", type=Path)
    parser.add_argument("--profile", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()

    try:
        derivation_input = require_mapping(_load_json(args.derivation_input), "input")
        profile = require_mapping(_load_json(args.profile), "profile")
        result = derive_documentation_quality_evaluation(derivation_input, profile)
    except (OSError, ValueError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2

    payload = json.dumps(result, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    try:
        descriptor = os.open(
            args.output,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0),
            0o600,
        )
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            handle.write(payload)
    except OSError as exc:
        print(f"error: unable to write the derivation output: {exc.strerror}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
