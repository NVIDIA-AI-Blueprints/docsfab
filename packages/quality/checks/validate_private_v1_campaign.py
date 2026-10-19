#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.

"""Validate the frozen private-v1 campaign plan or retained campaign evidence."""

from __future__ import annotations

import argparse
from datetime import datetime
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import stat
import sys
from typing import Any

from validate_audience_understanding_evaluation import (
    validate_audience_understanding_evaluation,
)
from validate_documentation_quality_evaluation import (
    validate_documentation_quality_evaluation,
)
from validate_json_artifact import validate_json_schema


SCHEMA_VERSION = "docsfab.quality.private-v1-campaign/v1"
CASE_SCHEMA_VERSION = "docsfab.quality.private-v1-case/v1"
PROFILES = {"new-product", "mature-docs", "intent-gap"}
ENTRY_POINTS = {"direct-cli", "live-agent-cli", "automatic-gitlab-ci"}
JOURNEYS = {
    "audience-validation",
    "change-review",
    "change-update",
    "feature-docs",
    "first-docs",
    "health-baseline",
    "missing-intent",
}
SUPPORTED_ARTIFACT_KINDS = {
    "automatic-trigger",
    "audience-understanding-evaluation",
    "case-observation",
    "documentation-quality-evaluation",
    "independent-review",
    "knowledge-answer",
    "run-manifest",
    "task-continuation",
    "task-state-record",
}
SUPPORTED_DOCUMENTATION_WORKFLOWS = {"create-documentation", "update-documentation"}
SHA256_PREFIX = "sha256:"
MAX_ARTIFACT_BYTES = 8 * 1024 * 1024


def _mapping(value: object, label: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ValueError(f"{label} must contain an object")
    return value


def _array(value: object, label: str) -> list[Any]:
    if not isinstance(value, list):
        raise ValueError(f"{label} must contain an array")
    return value


def _string(value: object, label: str) -> str:
    if not isinstance(value, str) or not value:
        raise ValueError(f"{label} must contain a non-empty string")
    return value


def _duplicate_rejector(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError(f"duplicate JSON object key {key!r}")
        result[key] = value
    return result


def _reject_constant(value: str) -> None:
    raise ValueError(f"non-finite JSON number {value!r}")


def _load_json_bytes(content: bytes, label: str) -> Any:
    try:
        return json.loads(
            content.decode("utf-8"),
            object_pairs_hook=_duplicate_rejector,
            parse_constant=_reject_constant,
        )
    except (UnicodeDecodeError, json.JSONDecodeError, ValueError) as exc:
        raise ValueError(f"invalid JSON in {label}: {exc}") from exc


def _load_manifest(path: Path) -> dict[str, Any]:
    try:
        content = path.read_bytes()
    except OSError as exc:
        raise ValueError(f"unable to read campaign manifest {path}: {exc}") from exc
    if len(content) > MAX_ARTIFACT_BYTES:
        raise ValueError("campaign manifest exceeds the supported byte limit")
    return _mapping(_load_json_bytes(content, str(path)), "campaign manifest")


def _digest(content: bytes) -> str:
    return f"{SHA256_PREFIX}{hashlib.sha256(content).hexdigest()}"


def _is_sha256(value: object) -> bool:
    return (
        isinstance(value, str)
        and value.startswith(SHA256_PREFIX)
        and len(value) == 71
        and all(character in "0123456789abcdef" for character in value[len(SHA256_PREFIX) :])
    )


class ApprovedRootLoader:
    """Load one verified regular file beneath a caller-approved root."""

    def __init__(self, root: Path):
        try:
            if stat.S_ISLNK(os.lstat(root).st_mode):
                raise ValueError("approved evidence root must not be a symbolic link")
            self.root = root.resolve(strict=True)
        except OSError as exc:
            raise ValueError(f"approved evidence root is unavailable: {exc}") from exc
        if not self.root.is_dir():
            raise ValueError("approved evidence root must be a directory")

    def load(self, reference: dict[str, Any], label: str) -> tuple[bytes, Any]:
        relative_path = _string(reference.get("path"), f"{label}.path")
        expected_digest = _string(reference.get("sha256"), f"{label}.sha256")
        if not expected_digest.startswith(SHA256_PREFIX) or len(expected_digest) != 71:
            raise ValueError(f"{label}.sha256 must contain one sha256 digest")
        if "\\" in relative_path or PurePosixPath(relative_path).is_absolute():
            raise ValueError(f"{label}.path must be a relative POSIX path")
        parts = PurePosixPath(relative_path).parts
        if not parts or any(part in {"", ".", ".."} for part in parts):
            raise ValueError(f"{label}.path must not traverse the approved root")

        current = self.root
        try:
            for part in parts:
                current = current / part
                metadata = os.lstat(current)
                if stat.S_ISLNK(metadata.st_mode):
                    raise ValueError(f"{label}.path must not traverse a symbolic link")
            resolved = current.resolve(strict=True)
        except OSError as exc:
            raise ValueError(f"{label}.path does not identify retained evidence") from exc
        try:
            resolved.relative_to(self.root)
        except ValueError as exc:
            raise ValueError(f"{label}.path escapes the approved evidence root") from exc
        if not resolved.is_file():
            raise ValueError(f"{label}.path must identify a retained regular file")
        content = resolved.read_bytes()
        if len(content) > MAX_ARTIFACT_BYTES:
            raise ValueError(f"{label}.path exceeds the supported byte limit")
        actual_digest = _digest(content)
        if actual_digest != expected_digest:
            raise ValueError(
                f"{label}.sha256 does not match retained bytes: "
                f"expected {expected_digest}, found {actual_digest}"
            )
        return content, _load_json_bytes(content, relative_path)


def _schema() -> dict[str, Any]:
    schema_path = Path(__file__).resolve().parent.parent / "schemas" / "private-v1-campaign.schema.json"
    return _mapping(_load_manifest(schema_path), "private-v1 campaign schema")


def _prefixed_reference(reference: dict[str, Any], prefix: PurePosixPath) -> dict[str, Any]:
    path = _string(reference.get("path"), "case reference path")
    joined = prefix / PurePosixPath(path) if str(prefix) != "." else PurePosixPath(path)
    return {**reference, "path": joined.as_posix()}


def _load_cases(
    plan: dict[str, Any], loader: ApprovedRootLoader, prefix: PurePosixPath
) -> tuple[dict[str, dict[str, Any]], list[str]]:
    errors: list[str] = []
    cases: dict[str, dict[str, Any]] = {}
    for index, raw_reference in enumerate(_array(plan.get("case_files"), "case_files")):
        try:
            reference = _mapping(raw_reference, f"case_files[{index}]")
            _, value = loader.load(
                _prefixed_reference(reference, prefix), f"case_files[{index}]"
            )
            case = _mapping(value, f"case_files[{index}] artifact")
            schema = _schema()
            shape_errors = validate_json_schema(
                case, _mapping(schema["$defs"]["case"], "case schema"), root_schema=schema
            )
            if shape_errors:
                errors.extend(
                    f"case_files[{index}]: {error}" for error in shape_errors
                )
                continue
            case_id = _string(case.get("case_id"), f"case_files[{index}].case_id")
            if case_id in cases:
                errors.append(f"case_files repeat case_id {case_id!r}")
            cases[case_id] = case
        except ValueError as exc:
            errors.append(str(exc))
    return cases, errors


def _validate_cases(plan: dict[str, Any], cases: dict[str, dict[str, Any]]) -> list[str]:
    errors: list[str] = []
    covered_profiles: set[str] = set()
    covered_entries: set[str] = set()
    covered_journeys: set[str] = set()
    for case_id, case in sorted(cases.items()):
        if case.get("schema_version") != CASE_SCHEMA_VERSION:
            errors.append(f"case {case_id!r} uses an unsupported schema_version")
        profile = case.get("profile")
        entry_point = case.get("entry_point")
        journeys = case.get("journeys")
        if not isinstance(profile, str) or profile not in PROFILES:
            errors.append(f"case {case_id!r} has unsupported profile {profile!r}")
        else:
            covered_profiles.add(profile)
        if not isinstance(entry_point, str) or entry_point not in ENTRY_POINTS:
            errors.append(f"case {case_id!r} has unsupported entry point {entry_point!r}")
        else:
            covered_entries.add(entry_point)
        if not isinstance(journeys, list) or not journeys:
            errors.append(f"case {case_id!r} must cover at least one journey")
        else:
            unknown = set(journeys) - JOURNEYS
            if unknown:
                errors.append(f"case {case_id!r} has unsupported journeys {sorted(unknown)!r}")
            covered_journeys.update(item for item in journeys if item in JOURNEYS)
        for field in (
            "expected_outcomes",
            "required_evidence",
            "freeze_subjects",
            "scenario_ids",
        ):
            value = case.get(field)
            if not isinstance(value, list) or not value or not all(
                isinstance(item, str) and item for item in value
            ):
                errors.append(f"case {case_id!r} {field} must contain non-empty strings")
        required_artifacts = case.get("required_artifacts")
        if not isinstance(required_artifacts, list) or not all(
            isinstance(item, str) and item for item in required_artifacts
        ):
            errors.append(f"case {case_id!r} required_artifacts must contain strings")
        elif not set(required_artifacts).issubset(SUPPORTED_ARTIFACT_KINDS):
            errors.append(f"case {case_id!r} requires an unsupported artifact kind")
        if entry_point == "automatic-gitlab-ci":
            required = {
                "automatic-trigger",
                "failed-ci-suppression",
                "replay-deduplication",
                "queued-later-source",
            }
            missing = required - set(case.get("required_evidence", []))
            if missing:
                errors.append(
                    f"automatic case {case_id!r} lacks evidence {sorted(missing)!r}"
                )
        if profile == "intent-gap":
            required = {"attributed-knowledge-answer", "original-task-continuation"}
            missing = required - set(case.get("required_evidence", []))
            if missing:
                errors.append(f"intent-gap case {case_id!r} lacks evidence {sorted(missing)!r}")

    if covered_profiles != PROFILES:
        errors.append(f"case union must cover profiles {sorted(PROFILES)!r}")
    if covered_entries != ENTRY_POINTS:
        errors.append(f"case union must cover entry points {sorted(ENTRY_POINTS)!r}")
    if covered_journeys != JOURNEYS:
        errors.append(f"case union must cover journeys {sorted(JOURNEYS)!r}")
    if "mature-restructure" not in cases:
        errors.append("case union must include the selected mature-restructure proof")
    return errors


def _validate_plan(
    plan: dict[str, Any],
    loader: ApprovedRootLoader,
    prefix: PurePosixPath = PurePosixPath("."),
    allow_unresolved: bool = True,
) -> tuple[list[str], dict[str, dict[str, Any]]]:
    errors: list[str] = []
    if plan.get("schema_version") != SCHEMA_VERSION or plan.get("mode") != "plan":
        errors.append("referenced plan must use the private-v1 plan contract")
    slots = _array(plan.get("profile_slots"), "profile_slots")
    slot_profiles = [item.get("profile") for item in slots if isinstance(item, dict)]
    if len(slots) != 3 or set(slot_profiles) != PROFILES:
        errors.append("plan must contain exactly the three frozen repository profiles")
    for index, raw_slot in enumerate(slots):
        slot = _mapping(raw_slot, f"profile_slots[{index}]")
        repository = _mapping(slot.get("repository"), f"profile_slots[{index}].repository")
        status = repository.get("status")
        if status == "unresolved":
            if not allow_unresolved:
                errors.append(
                    f"evidence mode rejects unresolved repository for profile {slot.get('profile')!r}"
                )
            if not repository.get("owner_issue") or not repository.get("owner"):
                errors.append("unresolved repository slots require an owner and owner_issue")
        elif status == "resolved":
            for field in ("canonical_id", "owner", "allowed_inputs"):
                if not repository.get(field):
                    errors.append(
                        f"resolved repository for profile {slot.get('profile')!r} lacks {field}"
                    )
        else:
            errors.append("repository status must be resolved or unresolved")
    entries = {
        item.get("id") for item in _array(plan.get("entry_points"), "entry_points")
        if isinstance(item, dict)
    }
    if entries != ENTRY_POINTS:
        errors.append("plan must contain exactly the three selected entry points")
    allowed_kinds = set(
        _array(plan.get("allowed_evidence_kinds"), "allowed_evidence_kinds")
    )
    if allowed_kinds != SUPPORTED_ARTIFACT_KINDS:
        errors.append("plan allowed evidence kinds must match the fixed campaign adapters")
    unresolved = _array(plan.get("unresolved_inputs"), "unresolved_inputs")
    if not allow_unresolved and unresolved:
        errors.append("evidence mode rejects plans with unresolved prerequisites")
    for index, raw_item in enumerate(unresolved):
        item = _mapping(raw_item, f"unresolved_inputs[{index}]")
        if not all(item.get(field) for field in ("id", "owner", "owner_issue", "reason")):
            errors.append(f"unresolved_inputs[{index}] must identify its owner and reason")
    freeze = _mapping(plan.get("freeze"), "freeze")
    if freeze.get("status") == "unresolved":
        if not allow_unresolved:
            errors.append("evidence mode requires a resolved pre-exposure freeze contract")
    elif freeze.get("status") == "resolved":
        for field in ("scenario_digest", "oracle_digest", "protocol_digest"):
            if not isinstance(freeze.get(field), str) or not freeze[field].startswith(SHA256_PREFIX):
                errors.append(f"resolved freeze contract lacks {field}")
        for field in ("scenario_reference", "oracle_reference", "protocol_reference"):
            if not isinstance(freeze.get(field), dict):
                errors.append(f"resolved freeze contract lacks {field}")
    else:
        errors.append("freeze status must be resolved or unresolved")
    deferred = _mapping(plan.get("non_gates"), "non_gates")
    if deferred.get("page_polish") != "catalog-smoke":
        errors.append("page polish must remain a catalog smoke")
    if deferred.get("signal_followup") != "deferred:#109":
        errors.append("signal followup must remain deferred under #109")
    cases, case_errors = _load_cases(plan, loader, prefix)
    errors.extend(case_errors)
    errors.extend(_validate_cases(plan, cases))
    indexed_case_ids = {
        case_id
        for raw_slot in slots
        if isinstance(raw_slot, dict)
        for case_id in raw_slot.get("case_ids", [])
        if isinstance(case_id, str)
    }
    if indexed_case_ids != set(cases):
        errors.append("profile slots must index every case exactly by its frozen profile")
    for case_id, case in cases.items():
        matching_slots = [
            slot
            for slot in slots
            if isinstance(slot, dict) and case_id in slot.get("case_ids", [])
        ]
        if len(matching_slots) != 1 or matching_slots[0].get("profile") != case.get("profile"):
            errors.append(f"case {case_id!r} is indexed under the wrong profile slot")
    return errors, cases


def _repository_key(value: str) -> str:
    normalized = value.strip().lower().replace("\\", "/")
    for prefix in ("https://", "http://", "ssh://", "git@"):
        if normalized.startswith(prefix):
            normalized = normalized[len(prefix) :]
    normalized = normalized.replace(":", "/", 1) if ":" in normalized.split("/")[0] else normalized
    return normalized.removesuffix(".git").rstrip("/")


def _validate_repository_identity(repositories: list[Any]) -> tuple[list[str], dict[str, dict[str, Any]]]:
    errors: list[str] = []
    by_profile: dict[str, dict[str, Any]] = {}
    identities: dict[str, str] = {}
    if len(repositories) != 3:
        errors.append("evidence must identify exactly three repositories")
    for index, raw_repository in enumerate(repositories):
        repository = _mapping(raw_repository, f"repositories[{index}]")
        profile = _string(repository.get("profile"), f"repositories[{index}].profile")
        canonical_id = _string(
            repository.get("canonical_id"), f"repositories[{index}].canonical_id"
        )
        if profile in by_profile:
            errors.append(f"repositories repeat profile {profile!r}")
        by_profile[profile] = repository
        names = [canonical_id, *_array(repository.get("aliases", []), "repository aliases")]
        for name in names:
            key = _repository_key(_string(name, "repository identity"))
            previous = identities.get(key)
            if previous is not None and previous != profile:
                errors.append(
                    f"repository profiles {previous!r} and {profile!r} identify the same project"
                )
            identities[key] = profile
    if set(by_profile) != PROFILES:
        errors.append("evidence repositories must resolve all three frozen profiles")
    return errors, by_profile


def _parse_time(value: object, label: str) -> datetime:
    text = _string(value, label)
    try:
        return datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError as exc:
        raise ValueError(f"{label} must contain an RFC 3339 timestamp") from exc


def _validate_freeze(
    freeze_record: dict[str, Any],
    plan_digest: str,
    plan: dict[str, Any],
    loader: ApprovedRootLoader,
    plan_prefix: PurePosixPath,
    cases: dict[str, dict[str, Any]],
) -> tuple[list[str], dict[str, dict[str, Any]]]:
    errors: list[str] = []
    retained_freeze: dict[str, dict[str, Any]] = {}
    if freeze_record.get("kind") != "private-v1-pre-exposure-freeze/v1":
        errors.append("freeze record has the wrong kind")
    if freeze_record.get("plan_sha256") != plan_digest:
        errors.append("freeze record does not bind the retained plan bytes")
    try:
        frozen = _parse_time(freeze_record.get("frozen_at"), "freeze_record.frozen_at")
        exposed = _parse_time(
            freeze_record.get("exposure_started_at"), "freeze_record.exposure_started_at"
        )
        if frozen.tzinfo is None or exposed.tzinfo is None:
            errors.append("freeze and exposure timestamps must include UTC offsets")
        elif frozen >= exposed:
            errors.append("scenario, oracle, and protocol must be frozen before exposure")
    except ValueError as exc:
        errors.append(str(exc))
    plan_freeze = _mapping(plan.get("freeze"), "plan.freeze")
    for field in ("scenario_digest", "oracle_digest", "protocol_digest"):
        if freeze_record.get(field) != plan_freeze.get(field):
            errors.append(f"freeze record {field} differs from the resolved plan")
        reference_field = field.replace("_digest", "_reference")
        try:
            reference = _mapping(plan_freeze.get(reference_field), f"plan.freeze.{reference_field}")
            content, retained_value = loader.load(
                _prefixed_reference(reference, plan_prefix), f"plan.freeze.{reference_field}"
            )
            if _digest(content) != plan_freeze.get(field):
                errors.append(f"plan freeze {field} does not bind retained bytes")
            retained = _mapping(retained_value, f"retained freeze {reference_field}")
            retained_freeze[field] = retained
            if field == "scenario_digest":
                expected_scenarios = sorted(
                    {
                        scenario_id
                        for case in cases.values()
                        for scenario_id in case.get("scenario_ids", [])
                        if isinstance(scenario_id, str)
                    }
                )
                if retained.get("scenario_ids") != expected_scenarios:
                    errors.append("retained scenario freeze does not bind the indexed scenarios")
                definitions = retained.get("scenario_definitions")
                definition_ids: list[str] = []
                if not isinstance(definitions, list):
                    errors.append("retained scenario freeze lacks the indexed definitions")
                else:
                    scenario_schema = _mapping(
                        _mapping(
                            _fixed_schema("audience-understanding-evaluation.schema.json").get(
                                "$defs"
                            ),
                            "audience schema definitions",
                        ).get("scenario"),
                        "audience scenario schema",
                    )
                    for index, item in enumerate(definitions):
                        if not isinstance(item, dict):
                            errors.append(
                                f"retained scenario definition {index} must be an object"
                            )
                            continue
                        item_errors = validate_json_schema(item, scenario_schema)
                        errors.extend(
                            f"retained scenario definition {index}: {error}"
                            for error in item_errors
                        )
                        scenario_id = item.get("scenario_id")
                        if isinstance(scenario_id, str) and scenario_id:
                            definition_ids.append(scenario_id)
                    if (
                        sorted(definition_ids) != expected_scenarios
                        or len(definition_ids) != len(set(definition_ids))
                        or len(definitions) != len(expected_scenarios)
                    ):
                        errors.append(
                            "retained scenario freeze requires typed unique indexed definitions"
                        )
            elif field == "oracle_digest":
                if retained.get("case_ids") != sorted(cases):
                    errors.append("retained oracle freeze does not bind every indexed case")
                expected_scenarios = {
                    scenario_id
                    for case in cases.values()
                    for scenario_id in case.get("scenario_ids", [])
                    if isinstance(scenario_id, str)
                }
                oracles = retained.get("oracle_definitions")
                oracle_ids: list[str] = []
                if not isinstance(oracles, list):
                    errors.append("retained oracle freeze lacks the indexed definitions")
                else:
                    required_oracle_fields = {
                        "scenario_id",
                        "oracle_locator",
                        "acceptance_criteria_locator",
                    }
                    for index, item in enumerate(oracles):
                        if not isinstance(item, dict):
                            errors.append(
                                f"retained oracle definition {index} must be an object"
                            )
                            continue
                        if set(item) != required_oracle_fields or any(
                            not isinstance(item.get(name), str) or not item.get(name)
                            for name in required_oracle_fields
                        ):
                            errors.append(
                                f"retained oracle definition {index} requires typed locator fields"
                            )
                            continue
                        oracle_ids.append(item["scenario_id"])
                    if (
                        set(oracle_ids) != expected_scenarios
                        or len(oracle_ids) != len(set(oracle_ids))
                        or len(oracles) != len(expected_scenarios)
                    ):
                        errors.append(
                            "retained oracle freeze requires typed unique indexed definitions"
                        )
            elif field == "protocol_digest":
                expected_protocol = _mapping(plan.get("audience"), "plan.audience").get(
                    "protocol_id"
                )
                if retained.get("protocol_id") != expected_protocol:
                    errors.append("retained protocol freeze does not bind the campaign protocol")
                protocol_definition = retained.get("protocol_definition")
                if not isinstance(protocol_definition, dict):
                    errors.append("retained protocol freeze lacks its measured definition")
                else:
                    protocol_schema = _mapping(
                        _mapping(
                            _fixed_schema("audience-understanding-evaluation.schema.json").get(
                                "properties"
                            ),
                            "audience schema properties",
                        ).get("protocol"),
                        "audience protocol schema",
                    )
                    measured_protocol = dict(protocol_definition)
                    measured_protocol.update(
                        {
                            "scenario_frozen_at": freeze_record.get("frozen_at"),
                            "exposure_started_at": freeze_record.get("exposure_started_at"),
                            "measured_phase_ended_at": freeze_record.get(
                                "exposure_started_at"
                            ),
                            "scored_at": freeze_record.get("exposure_started_at"),
                        }
                    )
                    protocol_errors = validate_json_schema(
                        measured_protocol, protocol_schema
                    )
                    errors.extend(
                        f"retained protocol definition: {error}"
                        for error in protocol_errors
                    )
                    if (
                        protocol_definition.get("scenario_corpus_id")
                        != plan.get("campaign_id")
                        or protocol_definition.get("scenario_corpus_version")
                        != plan_freeze.get("scenario_digest")
                    ):
                        errors.append(
                            "retained protocol definition does not bind the frozen scenario corpus"
                        )
        except ValueError as exc:
            errors.append(str(exc))
    return errors, retained_freeze


def _fixed_schema(name: str) -> dict[str, Any]:
    path = Path(__file__).resolve().parent.parent / "schemas" / name
    return _mapping(_load_manifest(path), f"fixed schema {name}")


def _validate_quality_artifact(
    artifact: dict[str, Any],
    reference: dict[str, Any],
    loader: ApprovedRootLoader,
    run: dict[str, Any],
) -> list[str]:
    errors = validate_json_schema(
        artifact, _fixed_schema("documentation-quality-evaluation.schema.json")
    )
    profile_reference = _mapping(reference.get("profile"), "quality artifact profile")
    _, profile_value = loader.load(profile_reference, "quality artifact profile")
    profile = _mapping(profile_value, "quality artifact profile")
    if errors:
        return errors
    errors.extend(validate_documentation_quality_evaluation(artifact, profile))
    if artifact.get("overall_decision") not in {"pass", "conditional-pass"}:
        errors.append("documentation quality evidence does not report a qualifying decision")
    target = artifact.get("target")
    if not isinstance(target, dict) or target.get("repository_revision") != run.get("revision"):
        errors.append("documentation quality evidence targets the wrong repository revision")
    if not isinstance(target, dict) or target.get("documentation_revision") != run.get("candidate"):
        errors.append("documentation quality evidence targets the wrong candidate")
    return errors


def _validate_audience_artifact(
    artifact: dict[str, Any],
    reference: dict[str, Any],
    run: dict[str, Any],
    case: dict[str, Any],
    plan: dict[str, Any],
    freeze_record: dict[str, Any],
    retained_freeze: dict[str, dict[str, Any]],
) -> list[str]:
    errors = validate_json_schema(
        artifact, _fixed_schema("audience-understanding-evaluation.schema.json")
    )
    if errors:
        return errors
    errors.extend(validate_audience_understanding_evaluation(artifact))
    population = reference.get("population")
    participants = artifact.get("participants", [])
    if population not in {"agent", "human"}:
        errors.append("audience artifact must declare agent or human population")
    elif not any(
        isinstance(item, dict)
        and item.get("population") == population
        and item.get("evidence_status") == "direct-outcome-evidence"
        for item in participants
    ):
        errors.append(f"audience artifact lacks clean direct evidence for {population!r}")
    qualifying = [
        item
        for item in participants
        if isinstance(item, dict) and item.get("population") == population
    ]
    for participant in qualifying:
        attempts = participant.get("attempts", [])
        if not attempts or any(
            not isinstance(attempt, dict)
            or attempt.get("outcome") != "success"
            or any(
                attempt.get(dimension) != "met"
                for dimension in (
                    "correctness",
                    "relationship_fidelity",
                    "boundary_recognition",
                    "prediction_or_transfer",
                    "evidence_location_success",
                )
            )
            for attempt in attempts
        ):
            errors.append(f"audience evidence does not establish a useful {population!r} outcome")
    target = artifact.get("target")
    if not isinstance(target, dict) or target.get("repository_revision") != run.get("revision"):
        errors.append("audience evidence targets the wrong repository revision")
    if not isinstance(target, dict) or target.get("documentation_revision") != run.get("candidate"):
        errors.append("audience evidence targets the wrong candidate")
    protocol = artifact.get("protocol")
    expected_protocol = _mapping(plan.get("audience"), "plan.audience").get("protocol_id")
    if not isinstance(protocol, dict) or protocol.get("protocol_version") != expected_protocol:
        errors.append("audience evidence does not use the frozen campaign protocol")
    if isinstance(protocol, dict):
        if protocol.get("scenario_corpus_id") != plan.get("campaign_id"):
            errors.append("audience evidence does not bind the frozen campaign scenario corpus")
        if protocol.get("scenario_corpus_version") != _mapping(
            plan.get("freeze"), "plan.freeze"
        ).get("scenario_digest"):
            errors.append("audience evidence does not bind the retained scenario freeze")
        try:
            campaign_frozen = _parse_time(
                freeze_record.get("frozen_at"), "freeze_record.frozen_at"
            )
            campaign_exposed = _parse_time(
                freeze_record.get("exposure_started_at"), "freeze_record.exposure_started_at"
            )
            audience_frozen = _parse_time(
                protocol.get("scenario_frozen_at"), "audience.protocol.scenario_frozen_at"
            )
            audience_exposed = _parse_time(
                protocol.get("exposure_started_at"), "audience.protocol.exposure_started_at"
            )
            if any(
                value.tzinfo is None
                for value in (
                    campaign_frozen,
                    campaign_exposed,
                    audience_frozen,
                    audience_exposed,
                )
            ):
                errors.append("campaign and audience exposure timestamps must include UTC offsets")
            elif audience_frozen != campaign_frozen or audience_exposed < campaign_exposed:
                errors.append("audience evidence predates or differs from the campaign freeze")
        except ValueError as exc:
            errors.append(str(exc))
    scenario_ids = {
        item.get("scenario_id")
        for item in artifact.get("scenarios", [])
        if isinstance(item, dict)
    }
    expected_scenarios = set(case.get("scenario_ids", []))
    if scenario_ids != expected_scenarios:
        errors.append("audience evidence scenarios do not match the indexed case")
    frozen_scenario_values = retained_freeze.get("scenario_digest", {}).get(
        "scenario_definitions", []
    )
    if not isinstance(frozen_scenario_values, list):
        frozen_scenario_values = []
    frozen_scenarios = {
        item.get("scenario_id"): item
        for item in frozen_scenario_values
        if isinstance(item, dict) and isinstance(item.get("scenario_id"), str)
    }
    frozen_oracle_values = retained_freeze.get("oracle_digest", {}).get(
        "oracle_definitions", []
    )
    if not isinstance(frozen_oracle_values, list):
        frozen_oracle_values = []
    frozen_oracles = {
        item.get("scenario_id"): item
        for item in frozen_oracle_values
        if isinstance(item, dict) and isinstance(item.get("scenario_id"), str)
    }
    for scenario in artifact.get("scenarios", []):
        if not isinstance(scenario, dict):
            continue
        scenario_id = scenario.get("scenario_id")
        if scenario != frozen_scenarios.get(scenario_id):
            errors.append(f"audience scenario {scenario_id!r} differs from its frozen definition")
        oracle = frozen_oracles.get(scenario_id)
        if not isinstance(oracle, dict) or any(
            scenario.get(field) != oracle.get(field)
            for field in ("oracle_locator", "acceptance_criteria_locator")
        ):
            errors.append(f"audience scenario {scenario_id!r} differs from its frozen oracle")
    if isinstance(protocol, dict):
        frozen_protocol = retained_freeze.get("protocol_digest", {}).get(
            "protocol_definition"
        )
        if not isinstance(frozen_protocol, dict) or any(
            protocol.get(field) != value for field, value in frozen_protocol.items()
        ):
            errors.append("audience evidence protocol differs from its frozen definition")
    return errors


def _validate_run_manifest(
    manifest: dict[str, Any], run: dict[str, Any], repository: dict[str, Any]
) -> list[str]:
    errors = validate_json_schema(manifest, _fixed_schema("run-manifest.schema.json"))
    if errors:
        return errors
    identities = _mapping(run.get("identities"), "run.identities")
    if manifest.get("run_id") != run.get("run_id"):
        errors.append("retained run manifest does not bind the indexed run ID")
    if manifest.get("model") != identities.get("model"):
        errors.append("retained run manifest does not bind the indexed model")
    if manifest.get("profile") != identities.get("profile"):
        errors.append("retained run manifest does not bind the indexed quality profile")
    if manifest.get("blueprint_version") != identities.get("composition"):
        errors.append("retained run manifest does not bind the indexed composition")
    required_sources = {
        f"repository:{repository.get('canonical_id')}@{run.get('revision')}",
        f"source-range:{run.get('source_range')}",
    }
    if not required_sources.issubset(set(manifest.get("sources", []))):
        errors.append("retained run manifest does not bind repository revision and source range")
    required_artifacts = {
        f"candidate:{run.get('candidate')}",
        f"package:{identities.get('package')}",
        f"quality-pack:{identities.get('quality_pack')}",
    }
    if not required_artifacts.issubset(set(manifest.get("artifacts", []))):
        errors.append("retained run manifest does not bind candidate, package, and quality pack")
    return errors


def _validate_review(
    review: dict[str, Any], reference: dict[str, Any], run_id: str
) -> list[str]:
    errors = validate_json_schema(review, _fixed_schema("review-result.schema.json"))
    if errors:
        return errors
    if reference.get("run_id") != run_id:
        errors.append("independent review does not bind the campaign run")
    if reference.get("independent_of_authors") is not True or review.get("verdict") != "pass":
        errors.append("campaign coverage requires a passing independent review")
    return errors


def _validate_case_observations(
    observations: list[tuple[dict[str, Any], dict[str, Any]]],
    run: dict[str, Any],
    repository: dict[str, Any],
    case: dict[str, Any],
    retained_digests: set[str],
    digests_by_kind: dict[str, set[str]],
    loader: ApprovedRootLoader,
) -> list[str]:
    errors: list[str] = []
    seen: set[str] = set()
    for reference, observation in observations:
        claim = observation.get("claim")
        if observation.get("kind") != "private-v1-case-observation/v1":
            errors.append("case observation has the wrong kind")
        if not isinstance(claim, str) or not claim:
            errors.append("case observation must identify one required evidence claim")
            continue
        if claim in seen:
            errors.append(f"case observations repeat claim {claim!r}")
        seen.add(claim)
        expected = {
            "run_id": run.get("run_id"),
            "case_id": case.get("case_id"),
            "repository_id": repository.get("canonical_id"),
            "revision": run.get("revision"),
            "candidate": run.get("candidate"),
            "source_range": run.get("source_range"),
        }
        for field, value in expected.items():
            actual = observation.get(field)
            if not isinstance(actual, str) or not actual or actual != value:
                errors.append(f"case observation {claim!r} has missing or mismatched {field}")
        provenance = observation.get("provenance")
        if not isinstance(provenance, dict) or not all(
            isinstance(provenance.get(field), str) and provenance[field]
            for field in ("collector_id", "collector_issue", "record_id", "observed_at")
        ):
            errors.append(f"case observation {claim!r} lacks attributable provenance")
        if observation.get("evidence_origin") != "retained-live-observation":
            errors.append(f"case observation {claim!r} is a fixture-only substitute")
        source_digest = observation.get("source_artifact_sha256")
        if not _is_sha256(source_digest) or source_digest == reference.get("sha256"):
            errors.append(f"case observation {claim!r} does not link another retained artifact")
        expected_kind = None
        if claim in {
            "automatic-trigger",
            "failed-ci-suppression",
            "replay-deduplication",
            "queued-later-source",
            "proposal-or-validated-no-change",
            "issue:#746",
        }:
            expected_kind = "automatic-trigger"
        elif claim in {"agent-audience-result", "human-audience-result"}:
            expected_kind = "audience-understanding-evaluation"
        elif claim == "attributed-knowledge-answer":
            expected_kind = "knowledge-answer"
        elif claim == "original-task-continuation":
            expected_kind = "task-continuation"
        if expected_kind and (
            not _is_sha256(source_digest)
            or source_digest not in digests_by_kind.get(expected_kind, set())
        ):
            errors.append(
                f"case observation {claim!r} does not link retained {expected_kind!r} evidence"
            )
        facts = observation.get("facts")
        if not isinstance(facts, dict):
            errors.append(f"case observation {claim!r} must retain structured facts")
            continue
        if expected_kind is None:
            try:
                subject_reference = _mapping(
                    observation.get("source_artifact_reference"),
                    f"case observation {claim!r} source_artifact_reference",
                )
                _, subject_value = loader.load(
                    subject_reference, f"case observation {claim!r} subject"
                )
                subject = _mapping(subject_value, f"case observation {claim!r} subject")
                expected_subject = {
                    "kind": "private-v1-claim-subject/v1",
                    "claim": claim,
                    "run_id": run.get("run_id"),
                    "case_id": case.get("case_id"),
                    "repository_id": repository.get("canonical_id"),
                    "revision": run.get("revision"),
                    "candidate": run.get("candidate"),
                    "source_range": run.get("source_range"),
                    "facts": facts,
                }
                if source_digest != subject_reference.get("sha256") or any(
                    subject.get(field) != value for field, value in expected_subject.items()
                ):
                    errors.append(
                        f"case observation {claim!r} does not bind its retained claim subject"
                    )
            except ValueError as exc:
                errors.append(str(exc))
        if claim == "named-workflow-receipt" and not (
            facts.get("named_direct_cli") is True
            and isinstance(facts.get("workflow_id"), str)
            and facts.get("workflow_id") in SUPPORTED_DOCUMENTATION_WORKFLOWS
        ):
            errors.append("direct CLI evidence lacks a named workflow")
        if claim == "live-agent-delegation" and not (
            facts.get("unscripted") is True
            and facts.get("delegated") is True
            and isinstance(facts.get("workflow_id"), str)
            and facts.get("workflow_id") in SUPPORTED_DOCUMENTATION_WORKFLOWS
        ):
            errors.append("live-agent evidence lacks real supported workflow delegation")
        if claim == "supported-workflow-result" and facts.get("result") != "succeeded":
            errors.append("live-agent delegation lacks a successful supported workflow result")
        grounded_claim_count = facts.get("grounded_claim_count")
        if claim == "grounded-output" and not (
            isinstance(grounded_claim_count, int)
            and not isinstance(grounded_claim_count, bool)
            and grounded_claim_count > 0
            and _is_sha256(facts.get("output_sha256"))
        ):
            errors.append("grounded output evidence lacks claims or retained output identity")
        if claim == "grounded-output":
            try:
                output_reference = _mapping(
                    facts.get("output_reference"), "grounded output reference"
                )
                output_bytes, output_value = loader.load(output_reference, "grounded output")
                output = _mapping(output_value, "grounded output")
                grounded_claims = output.get("grounded_claims")
                if (
                    facts.get("output_sha256") != _digest(output_bytes)
                    or output.get("kind") != "private-v1-grounded-output/v1"
                    or output.get("run_id") != run.get("run_id")
                    or output.get("candidate") != run.get("candidate")
                    or not isinstance(grounded_claims, list)
                    or len(grounded_claims) != grounded_claim_count
                    or not all(isinstance(item, str) and item for item in grounded_claims)
                ):
                    errors.append("grounded output digest does not bind retained output bytes")
            except ValueError as exc:
                errors.append(str(exc))
        if claim in {
            "setup-preservation",
            "unrelated-content-preservation",
            "content-preservation",
            "route-preservation",
            "navigation-preservation",
        } and not (
            facts.get("preserved") is True
            and _is_sha256(facts.get("before_sha256"))
            and facts.get("before_sha256") == facts.get("after_sha256")
        ):
            errors.append(f"preservation evidence {claim!r} lacks matching before/after identity")
        if claim in {
            "setup-preservation",
            "unrelated-content-preservation",
            "content-preservation",
            "route-preservation",
            "navigation-preservation",
        }:
            try:
                before_reference = _mapping(
                    facts.get("before_reference"), f"preservation {claim!r} before_reference"
                )
                after_reference = _mapping(
                    facts.get("after_reference"), f"preservation {claim!r} after_reference"
                )
                before_bytes, before_value = loader.load(
                    before_reference, f"preservation {claim!r} before artifact"
                )
                after_bytes, after_value = loader.load(
                    after_reference, f"preservation {claim!r} after artifact"
                )
                before = _mapping(before_value, f"preservation {claim!r} before artifact")
                after = _mapping(after_value, f"preservation {claim!r} after artifact")
                expected_snapshot = {
                    "kind": "private-v1-preservation-snapshot/v1",
                    "claim": claim,
                    "run_id": run.get("run_id"),
                    "repository_id": repository.get("canonical_id"),
                    "revision": run.get("revision"),
                    "candidate": run.get("candidate"),
                    "source_range": run.get("source_range"),
                }
                if (
                    facts.get("before_sha256") != _digest(before_bytes)
                    or facts.get("after_sha256") != _digest(after_bytes)
                    or before != after
                    or any(before.get(field) != value for field, value in expected_snapshot.items())
                    or not isinstance(before.get("inventory"), list)
                    or not before.get("inventory")
                    or not all(
                        isinstance(item, str) and item for item in before.get("inventory", [])
                    )
                ):
                    errors.append(
                        f"preservation evidence {claim!r} does not bind retained before/after bytes"
                    )
            except ValueError as exc:
                errors.append(str(exc))
        if claim == "exact-revision-findings" and not (
            facts.get("revision") == run.get("revision")
            and isinstance(facts.get("finding_count"), int)
        ):
            errors.append("review findings do not bind the exact revision")
        if claim == "read-only-operation" and facts.get("repository_mutated") is not False:
            errors.append("read-only evidence does not prove that repository mutation was absent")
        if claim == "lens-separated-baseline":
            lens_ids = facts.get("lens_ids")
            if not isinstance(lens_ids, list) or not all(
                isinstance(item, str) and item for item in lens_ids
            ) or len(set(lens_ids)) < 2:
                errors.append("health baseline does not retain distinct quality lenses")
        if claim == "issue:#570" and facts.get("issue_iid") != 570:
            errors.append("restructure evidence does not bind selected Task #570")
        if claim == "issue:#746" and facts.get("issue_iid") != 746:
            errors.append("automatic evidence does not bind collector Task #746")
        if claim == "insufficient-answer-block" and not (
            facts.get("coverage_advanced") is False and facts.get("state") == "blocked"
        ):
            errors.append("insufficient intent evidence must remain blocked without coverage advance")
    expected_claims = set(case.get("required_evidence", []))
    if seen != expected_claims:
        errors.append(
            f"case observations must cover required claims {sorted(expected_claims)!r}"
        )
    return errors


def _validate_automatic(artifact: dict[str, Any], run: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    if artifact.get("kind") != "private-v1-automatic-trigger/v1":
        errors.append("automatic trigger evidence has the wrong kind")
    if artifact.get("submission_mode") != "automatic-observer":
        errors.append("manual submission or CLI-in-CI cannot prove automatic observation")
    if artifact.get("pipeline_status") != "success":
        errors.append("automatic observation requires a successful eligible pipeline")
    if _repository_key(str(artifact.get("repository_id", ""))) != _repository_key(
        str(run.get("repository_id", ""))
    ):
        errors.append("automatic trigger evidence binds the wrong repository")
    for field in ("revision", "candidate", "source_range"):
        if artifact.get(field) != run.get(field):
            errors.append(f"automatic trigger {field} does not match the campaign run")
    proposal_outcome = artifact.get("proposal_outcome")
    if proposal_outcome == "unknown":
        errors.append("unknown outcome cannot advance automatic change coverage")
    if not isinstance(proposal_outcome, str) or proposal_outcome not in {
        "proposal",
        "validated-no-change",
    }:
        errors.append("automatic observation lacks a qualifying proposal or no-change outcome")
    events = artifact.get("events")
    if not isinstance(events, list):
        return [*errors, "automatic trigger evidence must retain linked lifecycle events"]
    by_kind: dict[str, dict[str, Any]] = {}
    event_ids: set[str] = set()
    for event in events:
        if not isinstance(event, dict):
            errors.append("automatic trigger events must contain objects")
            continue
        kind = event.get("kind")
        event_id = event.get("event_id")
        if not isinstance(kind, str) or not isinstance(event_id, str) or not event_id:
            errors.append("automatic trigger events require kind and event_id")
            continue
        if kind in by_kind:
            errors.append(f"automatic trigger repeats event kind {kind!r}")
        if event_id in event_ids:
            errors.append(f"automatic trigger repeats event_id {event_id!r}")
        by_kind[kind] = event
        event_ids.add(event_id)
    required_kinds = {"eligible-success", "failed-ci", "replay", "later-change"}
    if proposal_outcome == "validated-no-change":
        required_kinds.add("validated-no-change")
    if set(by_kind) != required_kinds:
        errors.append(f"automatic trigger must retain events {sorted(required_kinds)!r}")
        return errors
    success = by_kind["eligible-success"]
    if not all(
        isinstance(success.get(field), str) and bool(success.get(field))
        for field in ("project_id", "pipeline_id", "trigger_id", "proposal_id")
    ):
        if proposal_outcome == "proposal":
            errors.append(
                "eligible automatic event lacks project, pipeline, trigger, or proposal identity"
            )
        elif proposal_outcome == "validated-no-change" and not all(
            isinstance(success.get(field), str) and bool(success.get(field))
            for field in ("project_id", "pipeline_id", "trigger_id")
        ):
            errors.append("eligible automatic event lacks project, pipeline, or trigger identity")
    if success.get("outcome") != proposal_outcome:
        errors.append("eligible automatic event does not bind the indexed proposal outcome")
    if _repository_key(str(success.get("project_id", ""))) != _repository_key(
        str(run.get("repository_id", ""))
    ):
        errors.append("eligible automatic event binds the wrong GitLab project")
    default_branch = success.get("default_branch")
    if (
        not isinstance(default_branch, str)
        or not default_branch
        or success.get("ref") != default_branch
        or success.get("pipeline_source") != "push"
    ):
        errors.append("eligible automatic event is not a default-branch push pipeline")
    if success.get("source_range") != run.get("source_range") or success.get("candidate") != run.get("candidate"):
        errors.append("eligible automatic event does not bind the indexed source and candidate")
    failed = by_kind["failed-ci"]
    if failed.get("pipeline_status") != "failed" or failed.get("proposal_id") is not None:
        errors.append("failed CI event must retain suppression with no proposal")
    replay = by_kind["replay"]
    if proposal_outcome == "proposal":
        if not (
            replay.get("original_trigger_id") == success.get("trigger_id")
            and replay.get("proposal_id") == success.get("proposal_id")
            and replay.get("duplicate_created") is False
        ):
            errors.append("replay event does not prove deduplication against the original proposal")
    elif proposal_outcome == "validated-no-change":
        no_change = by_kind.get("validated-no-change", {})
        if not (
            no_change.get("project_id") == success.get("project_id")
            and no_change.get("revision") == run.get("revision")
            and no_change.get("candidate") == run.get("candidate")
            and no_change.get("source_range") == run.get("source_range")
            and isinstance(no_change.get("independent_check_id"), str)
            and bool(no_change.get("independent_check_id"))
            and success.get("proposal_id") is None
            and success.get("no_change_record_id") == no_change.get("event_id")
        ):
            errors.append("validated no-change outcome lacks a bound independent result record")
        if not (
            replay.get("original_trigger_id") == success.get("trigger_id")
            and replay.get("original_result_id") == no_change.get("event_id")
            and replay.get("duplicate_created") is False
        ):
            errors.append("replay event does not prove deduplication against the no-change result")
    later = by_kind["later-change"]
    if proposal_outcome == "proposal":
        active_draft_is_bound = later.get("active_draft_id") == success.get("proposal_id")
    elif proposal_outcome == "validated-no-change":
        active_draft_is_bound = (
            isinstance(later.get("active_draft_id"), str)
            and bool(later.get("active_draft_id"))
            and later.get("prior_result_id")
            == by_kind.get("validated-no-change", {}).get("event_id")
        )
    else:
        active_draft_is_bound = False
    if not (
        active_draft_is_bound
        and later.get("queued") is True
        and isinstance(later.get("queued_source_range"), str)
        and bool(later.get("queued_source_range"))
        and later.get("queued_source_range") != run.get("source_range")
    ):
        errors.append("later-change event does not prove queuing behind the active draft")
    return errors


def _validate_intent_artifacts(
    answer: dict[str, Any],
    continuation: dict[str, Any],
    run: dict[str, Any],
    retained_digests: set[str],
    digests_by_kind: dict[str, set[str]],
    state_records: list[tuple[dict[str, Any], dict[str, Any]]],
) -> list[str]:
    errors: list[str] = []
    if answer.get("kind") != "private-v1-knowledge-answer/v1":
        errors.append("knowledge answer has the wrong kind")
    if answer.get("attributed") is not True or answer.get("sufficient") is not True:
        errors.append("missing intent requires a sufficient attributed knowledge answer")
    for field in ("answer_id", "question_id", "knowledge_snapshot", "attributed_by"):
        if not isinstance(answer.get(field), str) or not answer[field]:
            errors.append(f"knowledge answer requires non-empty {field}")
    source_references = answer.get("source_references")
    if not isinstance(source_references, list) or not source_references:
        errors.append("knowledge answer requires retained attributed source references")
    elif any(
        not isinstance(reference, str) or reference not in retained_digests
        for reference in source_references
    ):
        errors.append("knowledge answer contains an unretained source reference")
    if continuation.get("kind") != "private-v1-task-continuation/v1":
        errors.append("task continuation has the wrong kind")
    for field in (
        "original_task_id",
        "resumed_task_id",
        "workflow_id",
        "original_instruction_sha256",
        "resumed_instruction_sha256",
        "knowledge_snapshot",
    ):
        if not isinstance(continuation.get(field), str) or not continuation[field]:
            errors.append(f"task continuation requires non-empty {field}")
    if continuation.get("original_task_id") != continuation.get("resumed_task_id"):
        errors.append("missing-intent continuation substituted a different Task")
    if continuation.get("original_instruction_sha256") != continuation.get(
        "resumed_instruction_sha256"
    ):
        errors.append("missing-intent continuation changed the original instruction")
    if continuation.get("original_run_id") != run.get("run_id"):
        errors.append("missing-intent continuation does not bind the original run")
    if continuation.get("source_context_revision") != run.get("revision"):
        errors.append("missing-intent continuation changed the source context")
    if not isinstance(continuation.get("entry_point"), str) or continuation.get(
        "entry_point"
    ) not in {"direct-cli", "live-agent-cli"}:
        errors.append("missing-intent continuation requires a human-directed entry point")
    if continuation.get("knowledge_snapshot") != answer.get("knowledge_snapshot"):
        errors.append("continued Task does not bind the attributed knowledge snapshot")
    knowledge = run.get("knowledge")
    if not isinstance(knowledge, dict) or knowledge.get("snapshot") != answer.get(
        "knowledge_snapshot"
    ):
        errors.append("knowledge answer does not bind the indexed run snapshot")
    for field in ("before_pause_record_sha256", "answer_record_sha256", "resume_record_sha256"):
        value = continuation.get(field)
        if not isinstance(value, str) or not value or value not in retained_digests:
            errors.append(f"task continuation {field} does not link retained evidence")
    if continuation.get("answer_record_sha256") not in digests_by_kind.get(
        "knowledge-answer", set()
    ):
        errors.append("task continuation answer record does not bind the retained answer")
    states: dict[str, tuple[str, dict[str, Any]]] = {}
    for reference, state_record in state_records:
        phase = state_record.get("phase")
        if not isinstance(phase, str) or phase not in {"paused", "resumed"}:
            errors.append("task state record phase must be paused or resumed")
            continue
        if phase in states:
            errors.append(f"task continuation repeats {phase!r} state records")
        states[phase] = (str(reference.get("sha256", "")), state_record)
        if state_record.get("kind") != "private-v1-task-state-record/v1":
            errors.append("task state record has the wrong kind")
        for field in ("record_id", "collector_id", "observed_at"):
            if not isinstance(state_record.get(field), str) or not state_record[field]:
                errors.append(f"{phase} task state record requires non-empty {field}")
        expected_state = {
            "run_id": run.get("run_id"),
            "task_id": continuation.get("original_task_id"),
            "workflow_id": continuation.get("workflow_id"),
            "instruction_sha256": continuation.get("original_instruction_sha256"),
            "source_context_revision": run.get("revision"),
        }
        for field, value in expected_state.items():
            if not isinstance(state_record.get(field), str) or state_record.get(field) != value:
                errors.append(f"{phase} task state record has missing or mismatched {field}")
        if phase == "paused" and state_record.get("coverage_advanced") is not False:
            errors.append("paused task state must not advance campaign coverage")
        if phase == "resumed" and not (
            state_record.get("answer_id") == answer.get("answer_id")
            and state_record.get("knowledge_snapshot") == answer.get("knowledge_snapshot")
        ):
            errors.append("resumed task state does not bind the attributed answer and snapshot")
    if set(states) != {"paused", "resumed"}:
        errors.append("task continuation requires distinct retained paused and resumed states")
    else:
        paused_state = states["paused"][1]
        resumed_state = states["resumed"][1]
        if not (
            paused_state.get("entry_point") == "automatic-gitlab-ci"
            and paused_state.get("submission_mode") == "automatic-observer"
            and isinstance(resumed_state.get("entry_point"), str)
            and resumed_state.get("entry_point") in {"direct-cli", "live-agent-cli"}
            and resumed_state.get("submission_mode") == "human-directed"
        ):
            errors.append(
                "task continuation requires an automatic pause and human-directed resume"
            )
        if continuation.get("before_pause_record_sha256") != states["paused"][0]:
            errors.append("task continuation does not bind the retained paused state")
        if continuation.get("resume_record_sha256") != states["resumed"][0]:
            errors.append("task continuation does not bind the retained resumed state")
    return errors


def _validate_evidence(
    manifest: dict[str, Any], manifest_path: Path, evidence_root: Path | None
) -> list[str]:
    if evidence_root is None:
        return ["evidence mode requires --evidence-root"]
    loader = ApprovedRootLoader(evidence_root)
    errors: list[str] = []
    if manifest.get("evidence_origin") != "retained-live-campaign":
        errors.append("synthetic or fixture-only campaign evidence cannot advance coverage")
    plan_reference = _mapping(manifest.get("plan_reference"), "plan_reference")
    plan_bytes, plan_value = loader.load(plan_reference, "plan_reference")
    plan = _mapping(plan_value, "retained plan")
    plan_prefix = PurePosixPath(_string(plan_reference.get("path"), "plan_reference.path")).parent
    plan_errors = validate_json_schema(plan, _schema())
    cases: dict[str, dict[str, Any]] = {}
    if not plan_errors:
        semantic_plan_errors, cases = _validate_plan(
            plan, loader, plan_prefix, allow_unresolved=False
        )
        plan_errors.extend(semantic_plan_errors)
    errors.extend(plan_errors)
    if plan_errors:
        return errors
    freeze_reference = _mapping(manifest.get("freeze_reference"), "freeze_reference")
    _, freeze_value = loader.load(freeze_reference, "freeze_reference")
    freeze_record = _mapping(freeze_value, "freeze record")
    freeze_errors, retained_freeze = _validate_freeze(
            freeze_record,
            _digest(plan_bytes),
            plan,
            loader,
            plan_prefix,
            cases,
        )
    errors.extend(freeze_errors)

    repository_errors, repositories = _validate_repository_identity(
        _array(manifest.get("repositories"), "repositories")
    )
    errors.extend(repository_errors)
    plan_slots = {
        item.get("profile"): item.get("repository")
        for item in plan.get("profile_slots", [])
        if isinstance(item, dict) and isinstance(item.get("repository"), dict)
    }
    for profile, repository in repositories.items():
        planned = plan_slots.get(profile)
        if not isinstance(planned, dict):
            continue
        for field in ("canonical_id", "owner", "allowed_inputs"):
            if repository.get(field) != planned.get(field):
                errors.append(
                    f"evidence repository {profile!r} {field} differs from the resolved plan"
                )
    runs = _array(manifest.get("runs"), "runs")
    run_cases: set[str] = set()
    run_ids: set[str] = set()
    audience_populations: set[str] = set()
    for index, raw_run in enumerate(runs):
        run = _mapping(raw_run, f"runs[{index}]")
        case_id = _string(run.get("case_id"), f"runs[{index}].case_id")
        run_id = _string(run.get("run_id"), f"runs[{index}].run_id")
        if run_id in run_ids:
            errors.append(f"campaign repeats run_id {run_id!r}")
        run_ids.add(run_id)
        case = cases.get(case_id)
        if case is None:
            errors.append(f"run references unknown case {case_id!r}")
            continue
        if case_id in run_cases:
            errors.append(f"campaign repeats run coverage for case {case_id!r}")
        run_cases.add(case_id)
        if run.get("status") != "passed":
            errors.append(f"case {case_id!r} is not a completed passing observation")
        if run.get("entry_point") != case.get("entry_point"):
            errors.append(f"case {case_id!r} uses the wrong entry point")
        repository = repositories.get(str(case.get("profile")))
        if repository is None:
            errors.append(f"case {case_id!r} lacks its repository profile")
            continue
        if _repository_key(str(run.get("repository_id", ""))) != _repository_key(
            str(repository.get("canonical_id", ""))
        ):
            errors.append(f"case {case_id!r} uses the wrong repository identity")
        if run.get("revision") != repository.get("revision"):
            errors.append(f"case {case_id!r} uses the wrong repository revision")
        if run.get("candidate") != repository.get("candidate"):
            errors.append(f"case {case_id!r} uses the wrong candidate identity")
        knowledge = run.get("knowledge")
        if not isinstance(knowledge, dict) or not (
            knowledge.get("snapshot") or knowledge.get("unavailable_reason")
        ):
            errors.append(f"case {case_id!r} must bind a knowledge snapshot or unavailable reason")
        usage = run.get("usage")
        if not isinstance(usage, dict) or not (
            usage.get("unavailable_reason")
            or all(field in usage for field in ("elapsed_seconds", "tokens", "cost"))
        ):
            errors.append(f"case {case_id!r} must retain usage or an unavailable reason")
        disposition = run.get("human_disposition")
        if not isinstance(disposition, dict) or disposition.get("status") not in {
            "accepted",
            "rejected",
            "pending",
        }:
            errors.append(f"case {case_id!r} must preserve human disposition")

        artifacts: dict[str, list[tuple[dict[str, Any], dict[str, Any]]]] = {}
        allowed_kinds = set(plan.get("allowed_evidence_kinds", []))
        for artifact_index, raw_reference in enumerate(
            _array(run.get("artifacts"), f"runs[{index}].artifacts")
        ):
            reference = _mapping(raw_reference, f"runs[{index}].artifacts[{artifact_index}]")
            kind = _string(reference.get("kind"), "artifact kind")
            if kind not in allowed_kinds:
                errors.append(f"run {case_id!r} uses unsupported artifact kind {kind!r}")
            try:
                _, artifact_value = loader.load(reference, f"run {case_id!r} artifact {kind!r}")
                artifact = _mapping(artifact_value, f"run {case_id!r} artifact {kind!r}")
                artifacts.setdefault(kind, []).append((reference, artifact))
            except ValueError as exc:
                errors.append(str(exc))
        retained_digests = {
            reference.get("sha256")
            for entries in artifacts.values()
            for reference, _ in entries
            if isinstance(reference.get("sha256"), str)
        }
        digests_by_kind = {
            kind: {
                reference.get("sha256")
                for reference, _ in entries
                if isinstance(reference.get("sha256"), str)
            }
            for kind, entries in artifacts.items()
        }
        required_kinds = {
            "run-manifest",
            "independent-review",
            "documentation-quality-evaluation",
            "case-observation",
        }
        required_kinds.update(case.get("required_artifacts", []))
        for missing in sorted(required_kinds - set(artifacts)):
            errors.append(f"case {case_id!r} lacks required retained artifact {missing!r}")
        for kind, entries in artifacts.items():
            if kind not in {"case-observation", "task-state-record"} and len(entries) != 1:
                errors.append(f"case {case_id!r} must retain exactly one {kind!r} artifact")
        for reference, artifact in artifacts.get("run-manifest", []):
            errors.extend(_validate_run_manifest(artifact, run, repository))
        for reference, artifact in artifacts.get("independent-review", []):
            errors.extend(_validate_review(artifact, reference, str(run.get("run_id", ""))))
        for reference, artifact in artifacts.get("documentation-quality-evaluation", []):
            errors.extend(_validate_quality_artifact(artifact, reference, loader, run))
        for reference, artifact in artifacts.get("audience-understanding-evaluation", []):
            population = reference.get("population")
            if isinstance(population, str):
                audience_populations.add(population)
            errors.extend(
                _validate_audience_artifact(
                    artifact,
                    reference,
                    run,
                    case,
                    plan,
                    freeze_record,
                    retained_freeze,
                )
            )
        errors.extend(
            _validate_case_observations(
                artifacts.get("case-observation", []),
                run,
                repository,
                case,
                retained_digests,
                digests_by_kind,
                loader,
            )
        )
        if case.get("entry_point") == "automatic-gitlab-ci" and artifacts.get("automatic-trigger"):
            errors.extend(_validate_automatic(artifacts["automatic-trigger"][0][1], run))
        if case.get("profile") == "intent-gap":
            if artifacts.get("knowledge-answer") and artifacts.get("task-continuation"):
                errors.extend(
                    _validate_intent_artifacts(
                        artifacts["knowledge-answer"][0][1],
                        artifacts["task-continuation"][0][1],
                        run,
                        retained_digests,
                        digests_by_kind,
                        artifacts.get("task-state-record", []),
                    )
                )
    missing_cases = set(cases) - run_cases
    if missing_cases:
        errors.append(f"campaign lacks passing observations for cases {sorted(missing_cases)!r}")
    required_populations = set(
        _array(_mapping(plan.get("audience"), "plan.audience").get("required_populations"), "required populations")
    )
    if audience_populations != required_populations:
        errors.append(
            f"campaign audience evidence must cover populations {sorted(required_populations)!r}"
        )
    return errors


def validate_private_v1_campaign(
    manifest_path: Path, mode: str, evidence_root: Path | None = None
) -> list[str]:
    """Return deterministic semantic errors for a campaign plan or evidence index."""
    manifest = _load_manifest(manifest_path)
    errors = validate_json_schema(manifest, _schema())
    if manifest.get("schema_version") != SCHEMA_VERSION:
        errors.append("campaign manifest uses an unsupported schema_version")
    if manifest.get("mode") != mode:
        errors.append("campaign manifest mode does not match --mode")
    if errors:
        return errors
    if mode == "plan":
        loader = ApprovedRootLoader(manifest_path.parent)
        plan_errors, _ = _validate_plan(manifest, loader)
        return plan_errors
    return _validate_evidence(manifest, manifest_path, evidence_root)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", required=True, type=Path)
    parser.add_argument("--mode", required=True, choices=("plan", "evidence"))
    parser.add_argument("--evidence-root", type=Path)
    args = parser.parse_args()
    try:
        errors = validate_private_v1_campaign(args.manifest, args.mode, args.evidence_root)
    except ValueError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    if errors:
        for error in errors:
            print(f"error: {error}", file=sys.stderr)
        return 1
    print(f"Private-v1 campaign {args.mode} is valid: {args.manifest}")
    if args.mode == "plan":
        print("Plan validation freezes collection shape; it does not establish live campaign success.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
