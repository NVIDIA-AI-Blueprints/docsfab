#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.

"""Validate DocsFab quality-score structure and decision semantics."""

from __future__ import annotations

import argparse
import json
import math
import sys
from pathlib import Path
from typing import Any

import quality_decision_policy as quality_policy


RUBRICS = {
    "task-guide-v0.1": {
        "threshold": 90,
        "allow_conditional_pass": False,
        "maxima": {
            "technical_accuracy": 30,
            "completeness": 20,
            "task_success": 20,
            "source_grounding": 15,
            "clarity": 10,
            "style_compliance": 5,
        },
    },
    "concept-guide-v0.1": {
        "threshold": 90,
        "allow_conditional_pass": False,
        "maxima": {
            "technical_accuracy": 30,
            "completeness": 20,
            "task_success": 10,
            "source_grounding": 20,
            "clarity": 15,
            "style_compliance": 5,
        },
    },
    "api-reference-v0.1": {
        "threshold": 92,
        "allow_conditional_pass": False,
        "maxima": {
            "technical_accuracy": 35,
            "completeness": 25,
            "task_success": 10,
            "source_grounding": 20,
            "clarity": 5,
            "style_compliance": 5,
        },
    },
}
HARD_GATES = {
    "critical_factual_errors",
    "unsupported_critical_claims",
    "broken_required_examples",
    "missing_mandatory_content",
    "security_compliance_violations",
    "invalid_required_artifacts",
}
TOP_LEVEL_FIELDS = {
    "rubric",
    "scores",
    "total",
    "hard_gates",
    "decision",
    "confidence",
    "rationale",
}
DECISIONS = {"pass", "conditional-pass", "fail", "human-review"}


def reject_json_constant(constant: str) -> None:
    raise ValueError(f"non-finite JSON number: {constant}")


def is_number(value: object) -> bool:
    if isinstance(value, bool):
        return False
    if isinstance(value, int):
        return True
    return isinstance(value, float) and math.isfinite(value)


def exact_fields(value: dict[str, Any], expected: set[str], label: str) -> list[str]:
    errors = [
        f"{label} is missing required field: {field}"
        for field in sorted(expected - value.keys())
    ]
    errors.extend(
        f"{label} contains unsupported field: {field}"
        for field in sorted(value.keys() - expected)
    )
    return errors


def validate_quality_score(value: object) -> list[str]:
    """Return all structural and semantic errors in a quality score."""
    if not isinstance(value, dict):
        return ["quality score must be a JSON object"]

    errors = exact_fields(value, TOP_LEVEL_FIELDS, "quality score")
    rubric_id = value.get("rubric")
    rubric = RUBRICS.get(rubric_id) if isinstance(rubric_id, str) else None
    if rubric is None:
        errors.append(f"unsupported rubric: {rubric_id!r}")

    scores = value.get("scores")
    if not isinstance(scores, dict):
        errors.append("scores must be an object")
    elif rubric is not None:
        maxima = rubric["maxima"]
        errors.extend(exact_fields(scores, set(maxima), "scores"))
        for dimension, maximum in maxima.items():
            score = scores.get(dimension)
            if not is_number(score):
                errors.append(f"score {dimension} must be a number")
            elif score < 0 or score > maximum:
                errors.append(f"score {dimension} must be between 0 and {maximum}")

    total = value.get("total")
    if not is_number(total) or total < 0 or total > 100:
        errors.append("total must be a number between 0 and 100")
    elif isinstance(scores, dict) and all(
        is_number(score) for score in scores.values()
    ):
        calculated_total = quality_policy.RULES["score-total"](scores)
        if not math.isclose(total, calculated_total, rel_tol=0, abs_tol=1e-9):
            errors.append(f"total {total} does not equal the score sum {calculated_total}")

    gates = value.get("hard_gates")
    gate_failed = False
    if not isinstance(gates, dict):
        errors.append("hard_gates must be an object")
    else:
        errors.extend(exact_fields(gates, HARD_GATES, "hard_gates"))
        for gate_name in sorted(HARD_GATES):
            count = gates.get(gate_name)
            if not isinstance(count, int) or isinstance(count, bool) or count < 0:
                errors.append(
                    f"hard gate {gate_name} must be a nonnegative integer"
                )
            elif count > 0:
                gate_failed = True

    decision = value.get("decision")
    if decision not in DECISIONS:
        errors.append(f"unsupported decision: {decision!r}")
    elif gate_failed and decision != "fail":
        errors.append("a nonzero hard gate requires decision 'fail'")
    elif rubric is not None and decision == "pass" and is_number(total):
        if total < rubric["threshold"]:
            errors.append(
                f"decision 'pass' requires total >= {rubric['threshold']} "
                f"for {rubric_id}"
            )
    elif rubric is not None and decision == "conditional-pass":
        if not rubric["allow_conditional_pass"]:
            errors.append(f"rubric {rubric_id} does not allow conditional-pass")

    confidence = value.get("confidence")
    if not is_number(confidence) or confidence < 0 or confidence > 1:
        errors.append("confidence must be a number between 0 and 1")
    rationale = value.get("rationale")
    if not isinstance(rationale, str) or not rationale.strip():
        errors.append("rationale must be a non-empty string")
    return errors


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("quality_score", type=Path)
    args = parser.parse_args()
    try:
        value = json.loads(
            args.quality_score.read_text(encoding="utf-8"),
            parse_constant=reject_json_constant,
        )
    except OSError as exc:
        print(f"error: unable to read {args.quality_score}: {exc}", file=sys.stderr)
        return 2
    except json.JSONDecodeError as exc:
        print(f"error: invalid JSON in {args.quality_score}: {exc}", file=sys.stderr)
        return 2
    except ValueError as exc:
        print(f"error: invalid JSON in {args.quality_score}: {exc}", file=sys.stderr)
        return 2

    errors = validate_quality_score(value)
    if errors:
        for error in errors:
            print(f"error: {error}", file=sys.stderr)
        return 1
    print(f"Quality score is valid: {args.quality_score}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
