#!/usr/bin/env python3
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Render the finding category and severity lists from the review-result schema.

``packages/quality/schemas/review-result.schema.json`` is the one source for
the finding ``category`` and ``severity`` values and their meanings. Each
property carries an ``enum`` and an ``x-docsfab-enum-descriptions`` object
that maps every enum value to one sentence.

``verify-technical-accuracy/references/finding-categories.md`` restates both
lists between generated markers. Without ``--check`` this script rewrites the
text between the markers and keeps everything else as written. With
``--check`` it rewrites nothing and exits 1 when the file differs from the
schema, naming the command that repairs it.

The script refuses, without writing, when an enum is missing or holds a
duplicate or non-string value, when the descriptions do not name exactly the
enum values, when a description is empty or spans lines, or when a marker is
missing, repeated, or out of order.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any


SCHEMA = Path("packages/quality/schemas/review-result.schema.json")
TARGET = Path("packages/skills/verify-technical-accuracy/references/finding-categories.md")
SCRIPT = Path("packages/skills/scripts/render_finding_categories.py")
DESCRIPTIONS_KEY = "x-docsfab-enum-descriptions"
# (schema property under issues[], marker label) in file order.
REGIONS = (
    ("category", "FINDING CATEGORIES"),
    ("severity", "FINDING SEVERITIES"),
)


class RenderError(Exception):
    """The schema or the target file cannot produce a faithful rendering."""


def begin_marker(label: str) -> str:
    return f"<!-- BEGIN GENERATED {label} from {SCHEMA.name} -->"


def end_marker(label: str) -> str:
    return f"<!-- END GENERATED {label} -->"


def issue_property(schema: Any, name: str) -> dict[str, Any]:
    try:
        node = schema["properties"]["issues"]["items"]["properties"][name]
    except (KeyError, TypeError) as exc:
        raise RenderError(f"{SCHEMA}: issues[].{name} is not declared") from exc
    if not isinstance(node, dict):
        raise RenderError(f"{SCHEMA}: issues[].{name} must be an object")
    return node


def described_values(schema: Any, name: str) -> list[tuple[str, str]]:
    """Return (value, description) pairs in enum order, or refuse."""
    node = issue_property(schema, name)
    values = node.get("enum")
    if not isinstance(values, list) or not values:
        raise RenderError(f"{SCHEMA}: issues[].{name}.enum must be a non-empty list")
    if not all(isinstance(value, str) and value for value in values):
        raise RenderError(f"{SCHEMA}: issues[].{name}.enum must hold non-empty strings")
    if len(set(values)) != len(values):
        raise RenderError(f"{SCHEMA}: issues[].{name}.enum repeats a value")
    descriptions = node.get(DESCRIPTIONS_KEY)
    if not isinstance(descriptions, dict):
        raise RenderError(f"{SCHEMA}: issues[].{name}.{DESCRIPTIONS_KEY} must be an object")
    missing = [value for value in values if value not in descriptions]
    extra = sorted(set(descriptions) - set(values))
    if missing or extra:
        raise RenderError(
            f"{SCHEMA}: issues[].{name}.{DESCRIPTIONS_KEY} must describe exactly the enum values; "
            f"missing={missing}, extra={extra}"
        )
    pairs = []
    for value in values:
        text = descriptions[value]
        if not isinstance(text, str) or not text.strip() or "\n" in text or text != text.strip():
            raise RenderError(
                f"{SCHEMA}: issues[].{name}.{DESCRIPTIONS_KEY}.{value} must be one non-empty "
                "line without surrounding whitespace"
            )
        pairs.append((value, text))
    return pairs


def render_region(pairs: list[tuple[str, str]]) -> str:
    return "".join(f"- `{value}`: {text}\n" for value, text in pairs)


def render(schema: Any, current: str) -> str:
    """Return ``current`` with every generated region replaced from ``schema``."""
    output = current
    cursor = 0
    for name, label in REGIONS:
        begin, end = begin_marker(label), end_marker(label)
        for marker in (begin, end):
            count = output.count(marker + "\n")
            if count != 1:
                raise RenderError(f"{TARGET}: expected one line '{marker}', found {count}")
        start = output.index(begin + "\n") + len(begin) + 1
        stop = output.index(end + "\n")
        if start > stop or start < cursor:
            raise RenderError(f"{TARGET}: generated markers for {label} are out of order")
        region = render_region(described_values(schema, name))
        output = output[:start] + region + output[stop:]
        cursor = start + len(region)
    return output


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n", 1)[0])
    parser.add_argument(
        "--root",
        type=Path,
        default=Path(__file__).resolve().parents[3],
        help="repository root (default: the checkout holding this script)",
    )
    parser.add_argument(
        "--check",
        action="store_true",
        help="exit 1 when the file is stale instead of rewriting it",
    )
    args = parser.parse_args(argv)
    root = args.root.resolve()
    try:
        schema = json.loads((root / SCHEMA).read_text(encoding="utf-8"))
        target = root / TARGET
        current = target.read_text(encoding="utf-8")
        rendered = render(schema, current)
    except (OSError, json.JSONDecodeError, RenderError) as exc:
        print(f"render_finding_categories: {exc}", file=sys.stderr)
        return 1
    if rendered == current:
        print(f"{TARGET} matches {SCHEMA}")
        return 0
    if args.check:
        print(
            f"render_finding_categories: {TARGET} is stale against {SCHEMA}; "
            f"run `python3 {SCRIPT}` from the repository root and commit the result",
            file=sys.stderr,
        )
        return 1
    target.write_text(rendered, encoding="utf-8")
    print(f"rewrote {TARGET} from {SCHEMA}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
