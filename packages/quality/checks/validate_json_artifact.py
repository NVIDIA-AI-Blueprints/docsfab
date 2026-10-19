#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.

"""Validate a JSON artifact against the JSON Schema subset used by DocsFab."""

from __future__ import annotations

import argparse
from calendar import monthrange
import json
import math
import re
import sys
import unicodedata
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


RFC3339_DATE_TIME = re.compile(
    r"^(?P<date>\d{4}-\d{2}-\d{2})T(?P<hour>\d{2}):(?P<minute>\d{2}):"
    r"(?P<second>\d{2})(?P<fraction>\.\d+)?"
    r"(?P<offset>Z|[+-]\d{2}:\d{2})$",
    re.IGNORECASE,
)
READER_CONTEXT_OVERLAP_FIELDS = (
    "target_audience",
    "change_scope",
    "source_priority",
    "required_content",
    "excluded_content",
    "unresolved_questions",
    "known_limitations",
)
READER_CONTEXT_CANONICAL_JSON_CONTRACT = {
    "serializer": "canonicalArtifactJson",
    "maxUtf8Bytes": 65536,
    "preserveArrayOrder": True,
}


def reject_json_constant(constant: str) -> None:
    raise ValueError(f"non-finite JSON number: {constant}")


def load_json(path: Path) -> Any:
    """Load strict JSON from *path* or raise an actionable value error."""
    try:
        return json.loads(
            path.read_text(encoding="utf-8"),
            parse_constant=reject_json_constant,
        )
    except OSError as exc:
        raise ValueError(f"unable to read JSON file {path}: {exc}") from exc
    except (json.JSONDecodeError, ValueError) as exc:
        raise ValueError(f"invalid JSON in {path}: {exc}") from exc


def _is_number(value: object) -> bool:
    if isinstance(value, bool):
        return False
    if isinstance(value, int):
        return True
    return isinstance(value, float) and math.isfinite(value)


def _matches_type(value: object, expected: str) -> bool:
    if expected == "object":
        return isinstance(value, dict)
    if expected == "array":
        return isinstance(value, list)
    if expected == "string":
        return isinstance(value, str)
    if expected == "number":
        return _is_number(value)
    if expected == "integer":
        return isinstance(value, int) and not isinstance(value, bool)
    if expected == "boolean":
        return isinstance(value, bool)
    if expected == "null":
        return value is None
    raise ValueError(f"unsupported JSON Schema type: {expected}")


def _child_location(location: str, child: str | int) -> str:
    if isinstance(child, int):
        return f"{location}[{child}]"
    return f"{location}.{child}"


def _resolve_local_reference(root_schema: dict[str, Any], reference: str) -> dict[str, Any]:
    if not reference.startswith("#/"):
        raise ValueError(f"unsupported non-local JSON Schema reference: {reference}")
    current: object = root_schema
    for raw_token in reference[2:].split("/"):
        token = raw_token.replace("~1", "/").replace("~0", "~")
        if not isinstance(current, dict) or token not in current:
            raise ValueError(f"unresolved JSON Schema reference: {reference}")
        current = current[token]
    if not isinstance(current, dict):
        raise ValueError(f"JSON Schema reference does not resolve to an object: {reference}")
    return current


def _date_time_is_valid(value: str) -> bool:
    match = RFC3339_DATE_TIME.fullmatch(value)
    if match is None:
        return False
    second = int(match.group("second"))
    if second > 60:
        return False
    normalized_second = "59" if second == 60 else match.group("second")
    normalized_fraction = ".000000" if match.group("fraction") else ""
    offset = match.group("offset")
    normalized_offset = "+00:00" if offset.lower() == "z" else offset
    normalized = (
        f"{match.group('date')}T{match.group('hour')}:{match.group('minute')}:"
        f"{normalized_second}{normalized_fraction}{normalized_offset}"
    )
    try:
        parsed = datetime.fromisoformat(normalized)
    except ValueError:
        return False
    if parsed.tzinfo is None:
        return False
    if second != 60:
        return True

    # RFC 3339 places an inserted leap second at the end of a UTC month.
    # A numeric offset can therefore place local :60 in a different minute,
    # hour, day, or month from 23:59:60Z.
    try:
        utc_preceding_second = parsed.astimezone(timezone.utc)
    except (OverflowError, ValueError):
        return False
    return (
        utc_preceding_second.hour == 23
        and utc_preceding_second.minute == 59
        and utc_preceding_second.day
        == monthrange(utc_preceding_second.year, utc_preceding_second.month)[1]
    )


def _validate_reader_context_overlap(
    value: dict[str, Any],
    contract: object,
    location: str,
) -> list[str]:
    expected_contract = {
        "contextProperty": "reader_context",
        "fields": list(READER_CONTEXT_OVERLAP_FIELDS),
        "requireIdenticalPresenceAndValue": True,
    }
    if contract != expected_contract:
        raise ValueError("unsupported reader-context overlap schema contract")
    reader_context = value.get("reader_context")
    if not isinstance(reader_context, dict):
        return []

    errors: list[str] = []
    for field in READER_CONTEXT_OVERLAP_FIELDS:
        brief_has_field = field in value
        context_has_field = field in reader_context
        if brief_has_field != context_has_field:
            errors.append(
                f"{location}.{field} and {location}.reader_context.{field} "
                "must have identical presence"
            )
        elif brief_has_field and value[field] != reader_context[field]:
            errors.append(
                f"{location}.{field} and {location}.reader_context.{field} "
                "must have identical values"
            )
    return errors


def _validate_reader_context_canonical_size(
    value: object,
    contract: object,
    location: str,
) -> list[str]:
    if contract != READER_CONTEXT_CANONICAL_JSON_CONTRACT:
        raise ValueError("unsupported reader-context canonical JSON contract")
    try:
        canonical_bytes = json.dumps(
            value,
            ensure_ascii=False,
            allow_nan=False,
            separators=(",", ":"),
            sort_keys=True,
        ).encode("utf-8")
    except (TypeError, ValueError) as exc:
        raise ValueError(f"unable to serialize reader context: {exc}") from exc
    if len(canonical_bytes) > READER_CONTEXT_CANONICAL_JSON_CONTRACT["maxUtf8Bytes"]:
        return [f"{location} exceeds the 65536-byte canonical JSON limit"]
    return []


def validate_json_schema(
    value: object,
    schema: dict[str, Any],
    location: str = "$",
    root_schema: dict[str, Any] | None = None,
) -> list[str]:
    """Return deterministic validation errors for the supported schema subset."""
    errors: list[str] = []
    if root_schema is None:
        root_schema = schema

    reference = schema.get("$ref")
    if reference is not None:
        if not isinstance(reference, str):
            raise ValueError(f"JSON Schema reference must be a string at {location}")
        reference_root = root_schema
        if reference == "reader-context.schema.json" or reference.startswith(
            "reader-context.schema.json#/"
        ):
            # This one governed package dependency is resolved from installed
            # quality assets, never from artifact input or a network location.
            reference_root = load_json(
                Path(__file__).resolve().parents[1] / "schemas/reader-context.schema.json"
            )
            if not isinstance(reference_root, dict):
                raise ValueError("reader-context schema must contain an object")
            fragment = reference[len("reader-context.schema.json"):]
            referenced_schema = (
                _resolve_local_reference(reference_root, fragment)
                if fragment else reference_root
            )
        else:
            referenced_schema = _resolve_local_reference(root_schema, reference)
        errors.extend(
            validate_json_schema(value, referenced_schema, location, reference_root)
        )
        sibling_schema = {key: item for key, item in schema.items() if key != "$ref"}
        if sibling_schema:
            errors.extend(
                validate_json_schema(value, sibling_schema, location, root_schema)
            )
        return errors

    if "const" in schema and value != schema["const"]:
        errors.append(f"{location} must equal {schema['const']!r}")
    if "enum" in schema and value not in schema["enum"]:
        errors.append(f"{location} must be one of {schema['enum']!r}")

    expected_type = schema.get("type")
    if expected_type is not None:
        expected_types = (
            [expected_type] if isinstance(expected_type, str) else expected_type
        )
        if not isinstance(expected_types, list) or not all(
            isinstance(item, str) for item in expected_types
        ):
            raise ValueError(f"unsupported JSON Schema type declaration at {location}")
        if not any(_matches_type(value, item) for item in expected_types):
            errors.append(f"{location} must have type {' or '.join(expected_types)}")
            return errors

    if isinstance(value, dict):
        required = schema.get("required", [])
        for field in required:
            if field not in value:
                errors.append(f"{location} is missing required field {field!r}")

        properties = schema.get("properties", {})
        if schema.get("additionalProperties") is False:
            for field in sorted(value.keys() - properties.keys()):
                errors.append(f"{location} contains unsupported field {field!r}")
        for field, child_schema in properties.items():
            if field in value:
                errors.extend(
                    validate_json_schema(
                        value[field],
                        child_schema,
                        _child_location(location, field),
                        root_schema,
                    )
                )
        overlap_contract = schema.get("x-docsfab-reader-context-overlap")
        if overlap_contract is not None:
            errors.extend(
                _validate_reader_context_overlap(value, overlap_contract, location)
            )

    if isinstance(value, list):
        minimum_items = schema.get("minItems")
        if isinstance(minimum_items, int) and len(value) < minimum_items:
            errors.append(f"{location} must contain at least {minimum_items} items")
        maximum_items = schema.get("maxItems")
        if isinstance(maximum_items, int) and len(value) > maximum_items:
            errors.append(f"{location} must contain at most {maximum_items} items")
        if schema.get("uniqueItems") is True:
            serialized = [
                json.dumps(item, sort_keys=True, allow_nan=False) for item in value
            ]
            if len(serialized) != len(set(serialized)):
                errors.append(f"{location} must contain unique items")
        item_schema = schema.get("items")
        if isinstance(item_schema, dict):
            for index, item in enumerate(value):
                errors.extend(
                    validate_json_schema(
                        item,
                        item_schema,
                        _child_location(location, index),
                        root_schema,
                    )
                )

    if isinstance(value, str):
        minimum_length = schema.get("minLength")
        if isinstance(minimum_length, int) and len(value) < minimum_length:
            errors.append(
                f"{location} must contain at least {minimum_length} characters"
            )
        maximum_length = schema.get("maxLength")
        if isinstance(maximum_length, int) and len(value) > maximum_length:
            errors.append(
                f"{location} must contain at most {maximum_length} characters"
            )
        pattern = schema.get("pattern")
        if isinstance(pattern, str) and re.search(pattern, value) is None:
            errors.append(f"{location} does not match required pattern {pattern!r}")
        if schema.get("format") == "date-time" and not _date_time_is_valid(value):
            errors.append(f"{location} must be an RFC 3339 date-time with an offset")
        normalization = schema.get("x-docsfab-unicode-normalization")
        if normalization is not None:
            if normalization != "NFC":
                raise ValueError("unsupported reader-context Unicode normalization")
            if unicodedata.normalize("NFC", value) != value:
                errors.append(f"{location} must use Unicode NFC normalization")
        line_endings = schema.get("x-docsfab-line-endings")
        if line_endings is not None:
            if line_endings != "LF":
                raise ValueError("unsupported reader-context line-ending contract")
            if "\r" in value:
                errors.append(f"{location} must use LF line endings")

    if _is_number(value):
        minimum = schema.get("minimum")
        maximum = schema.get("maximum")
        if isinstance(minimum, (int, float)) and value < minimum:
            errors.append(f"{location} must be >= {minimum}")
        if isinstance(maximum, (int, float)) and value > maximum:
            errors.append(f"{location} must be <= {maximum}")
        exclusive_minimum = schema.get("exclusiveMinimum")
        if isinstance(exclusive_minimum, (int, float)) and value <= exclusive_minimum:
            errors.append(f"{location} must be > {exclusive_minimum}")

    for child_schema in schema.get("allOf", []):
        errors.extend(validate_json_schema(value, child_schema, location, root_schema))

    conditional = schema.get("if")
    consequence = schema.get("then")
    if isinstance(conditional, dict) and isinstance(consequence, dict):
        if not validate_json_schema(value, conditional, location, root_schema):
            errors.extend(
                validate_json_schema(value, consequence, location, root_schema)
            )

    canonical_contract = schema.get("x-docsfab-canonical-json")
    if canonical_contract is not None:
        errors.extend(
            _validate_reader_context_canonical_size(
                value,
                canonical_contract,
                location,
            )
        )

    return errors


def validate_json_artifact(path: Path, schema_path: Path) -> tuple[Any, list[str]]:
    """Load and validate one artifact, returning its value and errors."""
    value = load_json(path)
    schema = load_json(schema_path)
    if not isinstance(schema, dict):
        raise ValueError(f"JSON Schema must contain an object: {schema_path}")
    return value, validate_json_schema(value, schema)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("artifact", type=Path)
    parser.add_argument("--schema", required=True, type=Path)
    args = parser.parse_args()

    try:
        _, errors = validate_json_artifact(args.artifact, args.schema)
    except ValueError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    if errors:
        for error in errors:
            print(f"error: {error}", file=sys.stderr)
        return 1
    print(f"JSON artifact is valid: {args.artifact}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
