#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.

"""Validate a quality report and bind its claims to validated JSON artifacts."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import re
import sys
from pathlib import Path
from typing import Any


# Keep edge validation identical to the ECMAScript String.trim() contract used
# by the runtime source-obligation validator and projection decoder. Python's
# str.isspace() differs for characters such as U+001C and U+FEFF.
_ECMASCRIPT_TRIM_WHITESPACE = frozenset(
    "\u0009\u000a\u000b\u000c\u000d\u0020\u00a0\u1680"
    "\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a"
    "\u2028\u2029\u202f\u205f\u3000\ufeff"
)


def _has_ecmascript_edge_whitespace(value: str) -> bool:
    return value[0] in _ECMASCRIPT_TRIM_WHITESPACE or value[-1] in _ECMASCRIPT_TRIM_WHITESPACE


CHECKS_ROOT = Path(__file__).resolve().parent
QUALITY_ROOT = CHECKS_ROOT.parent
sys.path.insert(0, str(CHECKS_ROOT))

from quality_decision_policy import (  # noqa: E402
    AUDIENCE_PREREQUISITES_LIMITATION,
    PROFILE_CEILING_LIMITATION,
    RULES,
)
from validate_documentation_quality_evaluation import (  # noqa: E402
    validate_documentation_quality_evaluation,
)
from validate_json_artifact import validate_json_schema  # noqa: E402
from validate_quality_score import validate_quality_score  # noqa: E402


SUMMARY_PATTERN = re.compile(
    r"^## Validated result summary\s+.*?^```json\s*$\n(?P<json>\{.*?\})\n^```\s*$",
    re.MULTILINE | re.DOTALL | re.IGNORECASE,
)


def _load_json(path: Path) -> object:
    try:
        return json.loads(
            path.read_text(encoding="utf-8"),
            parse_constant=lambda value: (_ for _ in ()).throw(
                ValueError(f"non-finite JSON number: {value}")
            ),
        )
    except OSError as exc:
        raise ValueError(f"unable to read {path}: {exc}") from exc
    except (json.JSONDecodeError, ValueError) as exc:
        raise ValueError(f"invalid JSON in {path}: {exc}") from exc


def _mapping(value: object, label: str, errors: list[str]) -> dict[str, Any]:
    if not isinstance(value, dict):
        errors.append(f"{label} must be an object")
        return {}
    return value


def _exact_fields(
    value: dict[str, Any], expected: set[str], label: str
) -> list[str]:
    errors = [
        f"{label} is missing field {field!r}" for field in sorted(expected - value.keys())
    ]
    errors.extend(
        f"{label} contains unsupported field {field!r}"
        for field in sorted(value.keys() - expected)
    )
    return errors


RETAINED_GAP_REASONS = {
    "experimental-profile-ceiling",
    "audience-prerequisites-missing",
}

def _validate_retained_gap_evidence(
    summary: dict[str, Any],
    profile: dict[str, Any],
    report_limitations: list[str] | None,
    profile_artifact_sha256: str | None,
) -> list[str]:
    errors: list[str] = []
    limitations = summary.get("limitations")
    entries = summary.get("retained_gap_evidence")
    if not isinstance(limitations, list) or not all(
        isinstance(item, str) for item in limitations
    ):
        return ["v0.2 report limitations must be a string array"]
    if report_limitations is None:
        errors.append("v0.2 report validation requires the Markdown limitation collection")
    elif (
        len(report_limitations) != len(set(report_limitations))
        or len(limitations) != len(set(limitations))
        or limitations != report_limitations
    ):
        errors.append("report limitations do not exactly match the Markdown limitation collection")
    if not isinstance(entries, list):
        return errors + ["v0.2 retained gap evidence must be an array"]

    evaluation = _mapping(summary.get("evaluation"), "report evaluation", errors)
    expected_limitations = set(
        RULES["host-limitations"](evaluation.get("decision"), profile)
    )

    if profile_artifact_sha256 is None:
        errors.append("v0.2 report validation requires the profile artifact digest")
    expected_sha256 = profile_artifact_sha256
    expected_locator = "profiles/docsfab-documentation-quality/profile.json"
    retained: set[str] = set()
    reasons: set[str] = set()
    for index, raw_entry in enumerate(entries):
        label = f"retained gap evidence[{index}]"
        entry = _mapping(raw_entry, label, errors)
        errors.extend(_exact_fields(entry, {"limitation", "reason", "evidence"}, label))
        limitation = entry.get("limitation")
        reason = entry.get("reason")
        if limitation not in limitations:
            errors.append(f"{label} limitation is absent from report limitations")
        if limitation in retained:
            errors.append(f"{label} duplicates a retained limitation")
        if isinstance(limitation, str):
            retained.add(limitation)
        if reason not in RETAINED_GAP_REASONS:
            errors.append(f"{label} has an unsupported reason")
        if isinstance(reason, str) and reason in reasons:
            errors.append(f"{label} duplicates retained reason {reason!r}")
        if isinstance(reason, str):
            reasons.add(reason)

        evidence = _mapping(entry.get("evidence"), f"{label} evidence", errors)
        common = {
            "kind",
            "artifact_locator",
            "artifact_sha256",
            "profile_id",
            "profile_version",
        }
        if reason == "experimental-profile-ceiling":
            expected_fields = common | {
                "profile_status",
                "release_gate_eligible",
                "decision_policy_field",
                "decision_policy_value",
            }
            errors.extend(_exact_fields(evidence, expected_fields, f"{label} evidence"))
            if limitation != PROFILE_CEILING_LIMITATION:
                errors.append(f"{label} does not use the canonical profile-ceiling limitation")
            if limitation not in expected_limitations:
                errors.append(f"{label} is not required by the host-limitations rule")
            expected_evidence = {
                "kind": "profile-decision-policy",
                "artifact_locator": expected_locator,
                "artifact_sha256": expected_sha256,
                "profile_id": profile.get("id"),
                "profile_version": profile.get("version"),
                "profile_status": profile.get("status"),
                "release_gate_eligible": profile.get("release_gate_eligible"),
                "decision_policy_field": "experimental_profile_maximum_decision",
                "decision_policy_value": _mapping(
                    profile.get("decision_policy"), "profile decision policy", errors
                ).get("experimental_profile_maximum_decision"),
            }
            if evidence != expected_evidence or expected_evidence["profile_status"] != "experimental" or expected_evidence["release_gate_eligible"] is not False or expected_evidence["decision_policy_value"] != "insufficient-evidence":
                errors.append(f"{label} does not match the verified profile ceiling")
        elif reason == "audience-prerequisites-missing":
            expected_fields = common | {"prerequisites"}
            errors.extend(_exact_fields(evidence, expected_fields, f"{label} evidence"))
            if limitation != AUDIENCE_PREREQUISITES_LIMITATION:
                errors.append(f"{label} does not use the canonical audience-prerequisite limitation")
            calibration = _mapping(profile.get("calibration"), "profile calibration", errors)
            expected_evidence = {
                "kind": "audience-prerequisite-policy",
                "artifact_locator": expected_locator,
                "artifact_sha256": expected_sha256,
                "profile_id": profile.get("id"),
                "profile_version": profile.get("version"),
                "prerequisites": [
                    {
                        "field": "calibration.human_outcome_baseline",
                        "value": calibration.get("human_outcome_baseline"),
                    },
                    {
                        "field": "calibration.agent_outcome_baseline",
                        "value": calibration.get("agent_outcome_baseline"),
                    },
                ],
            }
            if evidence != expected_evidence or any(
                item["value"] != "pending" for item in expected_evidence["prerequisites"]
            ):
                errors.append(f"{label} does not match verified pending audience prerequisites")
    return errors


def extract_report_summary(report: str) -> dict[str, Any]:
    """Return the report's single machine-checkable visible JSON summary."""
    matches = list(SUMMARY_PATTERN.finditer(report))
    if len(matches) != 1:
        raise ValueError(
            "quality report must contain exactly one JSON object under "
            "'## Validated result summary'"
        )
    try:
        value = json.loads(
            matches[0].group("json"),
            parse_constant=lambda item: (_ for _ in ()).throw(
                ValueError(f"non-finite JSON number: {item}")
            ),
        )
    except (json.JSONDecodeError, ValueError) as exc:
        raise ValueError(f"invalid report summary JSON: {exc}") from exc
    if not isinstance(value, dict):
        raise ValueError("report summary must be a JSON object")
    return value


def extract_report_limitations(report: str) -> list[str]:
    """Return the ordered explicit limitation rows from the evidence-gap section."""
    headings = list(
        re.finditer(
            r"^## Evidence gaps and limitations[ \t]*$",
            report,
            re.MULTILINE | re.IGNORECASE,
        )
    )
    if len(headings) != 1:
        raise ValueError("v0.2 report must contain exactly one limitation section")
    heading = headings[0]
    following = report[heading.end() :]
    next_heading = re.search(r"^##\s+", following, re.MULTILINE)
    section = following[: next_heading.start()] if next_heading else following
    limitations: list[str] = []
    row = re.compile(
        r"^- (?:(?:Limitation|Evidence gap):|\*\*(?:Limitation|Evidence gap):\*\*)"
        r"\s*(\S(?:.*\S)?)$",
        re.IGNORECASE,
    )
    encoded_row = re.compile(r"^- Limitation \(JSON\): (.+)$")
    for line in section.splitlines():
        if not line.strip():
            continue
        encoded_match = encoded_row.fullmatch(line)
        if encoded_match is not None:
            try:
                limitation = json.loads(encoded_match.group(1))
            except json.JSONDecodeError as error:
                raise ValueError("v0.2 JSON limitation row is invalid") from error
            if (
                not isinstance(limitation, str)
                or not limitation
                or _has_ecmascript_edge_whitespace(limitation)
            ):
                raise ValueError("v0.2 JSON limitation row has an invalid value")
            limitations.append(limitation)
            continue
        match = row.fullmatch(line)
        if match is None:
            raise ValueError("v0.2 report limitation section is ambiguous")
        limitation = match.group(1)
        if _has_ecmascript_edge_whitespace(limitation):
            raise ValueError("v0.2 report limitation row has an invalid value")
        limitations.append(limitation)
    if len(limitations) != len(set(limitations)):
        raise ValueError("v0.2 report limitation section contains duplicate values")
    return limitations


def _parse_rubric(rubric_id: str, quality_root: Path) -> dict[str, Any]:
    """Read the small rubric YAML dialect without adding a YAML dependency."""
    for path in sorted((quality_root / "rubrics").glob("*.yaml")):
        lines = path.read_text(encoding="utf-8").splitlines()
        top_level: dict[str, str] = {}
        dimensions: dict[str, int] = {}
        hard_gates: list[str] = []
        section = ""
        pending_dimension: str | None = None
        for line in lines:
            if not line or line.lstrip().startswith("#"):
                continue
            if not line.startswith(" ") and ":" in line:
                key, raw_value = line.split(":", 1)
                section = key.strip()
                pending_dimension = None
                if raw_value.strip():
                    top_level[key.strip()] = raw_value.strip()
                continue
            if section == "dimensions" and line.startswith("  "):
                stripped = line.strip()
                if line.startswith("    ") and pending_dimension:
                    if stripped.startswith("weight:"):
                        dimensions[pending_dimension] = int(
                            stripped.split(":", 1)[1].strip()
                        )
                    continue
                if not line.startswith("    ") and ":" in stripped:
                    name, raw_value = stripped.split(":", 1)
                    pending_dimension = name.strip()
                    if raw_value.strip():
                        dimensions[pending_dimension] = int(raw_value.strip())
                continue
            if section == "hard_gates" and line.startswith("  - "):
                hard_gates.append(line[4:].strip())

        if top_level.get("id") == rubric_id:
            try:
                threshold = int(top_level["pass_threshold"])
            except (KeyError, ValueError) as exc:
                raise ValueError(f"rubric {path} has an invalid pass_threshold") from exc
            if not dimensions:
                raise ValueError(f"rubric {path} has no readable dimension weights")
            return {
                "path": path,
                "threshold": threshold,
                "allow_conditional_pass": top_level.get("allow_conditional_pass")
                == "true",
                "dimensions": dimensions,
                "hard_gates": hard_gates,
            }
    raise ValueError(f"no versioned rubric YAML has id {rubric_id!r}")


def _score_yaml_errors(
    score: dict[str, Any], rubric: dict[str, Any]
) -> list[str]:
    errors: list[str] = []
    scores = score.get("scores")
    if not isinstance(scores, dict):
        return errors
    maxima = rubric["dimensions"]
    errors.extend(_exact_fields(scores, set(maxima), "quality-score scores"))
    for dimension, maximum in maxima.items():
        value = scores.get(dimension)
        if (
            not isinstance(value, (int, float))
            or isinstance(value, bool)
            or not math.isfinite(value)
            or value < 0
            or value > maximum
        ):
            errors.append(
                f"quality-score dimension {dimension!r} must be between 0 and "
                f"the selected YAML maximum {maximum}"
            )
    hard_gates = score.get("hard_gates")
    if isinstance(hard_gates, dict):
        for gate in rubric["hard_gates"]:
            if gate not in hard_gates:
                errors.append(
                    f"quality-score hard gates omit selected YAML gate {gate!r}"
                )
    total = score.get("total")
    decision = score.get("decision")
    if (
        decision == "pass"
        and isinstance(total, (int, float))
        and not isinstance(total, bool)
        and total < rubric["threshold"]
    ):
        errors.append(
            "quality-score decision 'pass' is below the selected YAML threshold "
            f"{rubric['threshold']}"
        )
    if decision == "conditional-pass" and not rubric["allow_conditional_pass"]:
        errors.append(
            "quality-score decision 'conditional-pass' is disallowed by the selected "
            "YAML rubric"
        )
    return errors


def _interpretation_band(total: object) -> str | None:
    if not isinstance(total, (int, float)) or isinstance(total, bool):
        return None
    if total >= 80:
        return "Green"
    if total >= 60:
        return "Yellow"
    return "Red"


def validate_quality_report(
    evaluation: object,
    profile: object,
    report_summary: object,
    *,
    quality_score: object | None = None,
    report_limitations: list[str] | None = None,
    profile_artifact_sha256: str | None = None,
    quality_root: Path = QUALITY_ROOT,
) -> list[str]:
    """Return structural, semantic, and cross-artifact report errors."""
    errors: list[str] = []
    evaluation_value = _mapping(evaluation, "evaluation", errors)
    profile_value = _mapping(profile, "profile", errors)
    summary = _mapping(report_summary, "report summary", errors)
    if errors:
        return errors

    report_schema = _load_json(quality_root / "schemas" / "quality-report.schema.json")
    if not isinstance(report_schema, dict):
        return ["quality report schema must be an object"]
    report_schema_errors = validate_json_schema(summary, report_schema)
    if report_schema_errors:
        return [
            f"quality-report.schema.json: {error}" for error in report_schema_errors
        ]

    schema = _load_json(
        quality_root / "schemas" / "documentation-quality-evaluation.schema.json"
    )
    if not isinstance(schema, dict):
        return ["documentation quality evaluation schema must be an object"]
    errors.extend(validate_json_schema(evaluation_value, schema))
    if not errors:
        errors.extend(
            validate_documentation_quality_evaluation(evaluation_value, profile_value)
        )
    if errors:
        return [f"evaluation.json: {error}" for error in errors]

    target = _mapping(summary.get("target"), "report target", errors)
    errors.extend(
        _exact_fields(
            target,
            {"paths", "repository_revision", "documentation_revision"},
            "report target",
        )
    )
    expected_target = evaluation_value["target"]
    for field in ("paths", "repository_revision", "documentation_revision"):
        if target.get(field) != expected_target.get(field):
            errors.append(f"report target {field} does not match evaluation.json")

    report_profile = _mapping(summary.get("profile"), "report profile", errors)
    if report_profile != evaluation_value["profile"]:
        errors.append("report profile does not match evaluation.json")

    report_evaluation = _mapping(
        summary.get("evaluation"), "report evaluation", errors
    )
    expected_evaluation = {
        "decision": evaluation_value["overall_decision"],
        "confidence": evaluation_value["confidence"],
        "hard_gate_failures": evaluation_value["hard_gate_failures"],
    }
    if report_evaluation != expected_evaluation:
        errors.append(
            "report evaluation decision, confidence, or hard-gate summary does not "
            "match evaluation.json"
        )

    contract = summary.get("report_contract")
    expected_summary_fields = {
        "report_contract",
        "target",
        "profile",
        "evaluation",
        "rubric",
        "validation",
        "artifact_locators",
    }
    if contract == "docsfab-quality-report-v0.2":
        expected_summary_fields |= {"limitations", "retained_gap_evidence"}
        errors.extend(
            _validate_retained_gap_evidence(
                summary, profile_value, report_limitations, profile_artifact_sha256
            )
        )
    elif contract != "docsfab-quality-report-v0.1":
        errors.append("report contract is unsupported")
    errors.extend(_exact_fields(summary, expected_summary_fields, "report summary"))

    validation = _mapping(summary.get("validation"), "report validation", errors)
    locators = _mapping(
        summary.get("artifact_locators"), "report artifact locators", errors
    )
    errors.extend(
        _exact_fields(
            validation,
            {"evaluation", "quality_score", "report_binding"},
            "report validation",
        )
    )
    errors.extend(
        _exact_fields(
            locators,
            {"evaluation", "quality_score", "quality_report"},
            "report artifact locators",
        )
    )
    if validation.get("evaluation") != "passed":
        errors.append("report must record evaluation validation as passed")
    if validation.get("report_binding") != "passed":
        errors.append("report must record report binding validation as passed")
    for field in ("evaluation", "quality_report"):
        if not isinstance(locators.get(field), str) or not locators[field].strip():
            errors.append(f"report artifact locator {field!r} must be non-empty")

    report_rubric = _mapping(summary.get("rubric"), "report rubric", errors)
    if quality_score is None:
        if set(report_rubric) != {"status", "reason"}:
            errors.append(
                "an unavailable report rubric must contain only status and reason"
            )
        if report_rubric.get("status") != "unavailable":
            errors.append("missing quality-score.json requires rubric status unavailable")
        if not isinstance(report_rubric.get("reason"), str) or not report_rubric[
            "reason"
        ].strip():
            errors.append("an unavailable rubric score requires a non-empty reason")
        if validation.get("quality_score") != "unavailable":
            errors.append("missing quality-score.json must be recorded as unavailable")
        if locators.get("quality_score") is not None:
            errors.append("missing quality-score.json must have a null report locator")
        return errors

    score = _mapping(quality_score, "quality score", errors)
    score_errors = validate_quality_score(score)
    if score_errors:
        errors.extend(f"quality-score.json: {error}" for error in score_errors)
        return errors
    try:
        rubric = _parse_rubric(score["rubric"], quality_root)
    except ValueError as exc:
        errors.append(str(exc))
        return errors
    errors.extend(_score_yaml_errors(score, rubric))

    expected_rubric = {
        "status": "available",
        "id": score["rubric"],
        "dimension_scores": score["scores"],
        "total": score["total"],
        "threshold": rubric["threshold"],
        "interpretation_band": _interpretation_band(score["total"]),
        "decision": score["decision"],
        "confidence": score["confidence"],
        "hard_gates": score["hard_gates"],
    }
    if report_rubric != expected_rubric:
        errors.append(
            "report rubric id, dimensions, total, threshold, band, decision, "
            "confidence, or hard-gate summary does not match quality-score.json "
            "and the selected YAML rubric"
        )
    if validation.get("quality_score") != "passed":
        errors.append("report must record quality-score validation as passed")
    if not isinstance(locators.get("quality_score"), str) or not locators[
        "quality_score"
    ].strip():
        errors.append("available quality-score.json requires a non-empty locator")
    return errors


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("evaluation", type=Path)
    parser.add_argument("report", type=Path)
    parser.add_argument("--profile", required=True, type=Path)
    parser.add_argument("--quality-score", type=Path)
    args = parser.parse_args()
    try:
        evaluation = _load_json(args.evaluation)
        profile = _load_json(args.profile)
        profile_artifact_sha256 = hashlib.sha256(args.profile.read_bytes()).hexdigest()
        report = args.report.read_text(encoding="utf-8")
        summary = extract_report_summary(report)
        score = _load_json(args.quality_score) if args.quality_score else None
        report_limitations = (
            extract_report_limitations(report)
            if summary.get("report_contract") == "docsfab-quality-report-v0.2"
            else None
        )
        errors = validate_quality_report(
            evaluation,
            profile,
            summary,
            quality_score=score,
            report_limitations=report_limitations,
            profile_artifact_sha256=profile_artifact_sha256,
        )
    except (OSError, ValueError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    if errors:
        for error in errors:
            print(f"error: {error}", file=sys.stderr)
        return 1
    print(f"Quality report is valid: {args.report}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
