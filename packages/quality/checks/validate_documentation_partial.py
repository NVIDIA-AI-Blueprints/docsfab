#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.

"""Validate a documentation partial-result envelope against schema and policy."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path
from typing import Any

from validate_json_artifact import load_json, validate_json_artifact, validate_json_schema


SCHEMA = Path(__file__).resolve().parents[1] / "schemas" / "documentation-partial-result.schema.json"
NO_DRAFT_APPLICABILITIES = {
    "no-useful-deliverable",
    "cancellation",
    "execution-failure",
}
PRODUCT_CLAIM_DELIVERABLES = {"included-supported"}


def _require_mapping(value: object, label: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ValueError(f"{label} must contain an object")
    return value


def validate_documentation_partial_policy(value: dict[str, Any]) -> list[str]:
    """Reject publication, unsupported included claims, and empty useful-partials."""
    errors: list[str] = []
    if value.get("publicationEligible") is not False:
        errors.append("$.publicationEligible must be false")

    applicability = value.get("applicability")
    obligations = value.get("obligations")
    if not isinstance(obligations, list):
        return errors

    included = [
        item
        for item in obligations
        if isinstance(item, dict) and item.get("proposedDeliverable") == "included-supported"
    ]
    if applicability == "useful-partial" and len(included) == 0:
        errors.append("$.applicability useful-partial requires at least one included-supported obligation")

    draft = value.get("draft")
    if applicability in NO_DRAFT_APPLICABILITIES:
        if draft not in (None, {}):
            if isinstance(draft, dict) and draft:
                errors.append(
                    f"$.draft must be omitted or null when applicability is {applicability!r}"
                )
    elif applicability in {"useful-partial", "scaffold-only"} and not isinstance(draft, dict):
        errors.append(f"$.draft is required when applicability is {applicability!r}")

    for index, item in enumerate(obligations):
        if not isinstance(item, dict):
            continue
        location = f"$.obligations[{index}]"
        deliverable = item.get("proposedDeliverable")
        status = item.get("status")
        if deliverable == "included-supported" and status != "supported":
            errors.append(
                f"{location} cannot mark unsupported status {status!r} as included-supported"
            )
        if deliverable == "template-structure" and status == "supported":
            errors.append(
                f"{location} cannot use template-structure as product evidence"
            )
        if (
            deliverable in PRODUCT_CLAIM_DELIVERABLES
            and status == "supported"
            and item.get("requiredSourceSupport") is False
            and item.get("origin") == "workflow"
            and str(item.get("id", "")).startswith("workflow-target")
        ):
            # Scope rows are not product claims; included-supported is allowed
            # only when they stay non-product. No extra error.
            pass
    return errors


def validate_documentation_partial(value: object) -> list[str]:
    schema = load_json(SCHEMA)
    if not isinstance(schema, dict):
        raise ValueError("documentation partial schema must contain an object")
    errors = validate_json_schema(value, schema)
    if errors:
        return errors
    return validate_documentation_partial_policy(_require_mapping(value, "$"))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("artifact", type=Path)
    args = parser.parse_args()
    try:
        value, schema_errors = validate_json_artifact(args.artifact, SCHEMA)
    except ValueError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    errors = list(schema_errors)
    if not schema_errors and isinstance(value, dict):
        errors.extend(validate_documentation_partial_policy(value))
    if errors:
        for error in errors:
            print(f"error: {error}", file=sys.stderr)
        return 1
    print(f"documentation partial result is valid: {args.artifact}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
