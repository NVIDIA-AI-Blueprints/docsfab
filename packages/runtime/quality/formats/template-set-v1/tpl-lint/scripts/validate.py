#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# Copyright (c) 2025, NVIDIA CORPORATION. All rights reserved.
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

"""Validate a documentation page against a template schema.

Checks headings, section order, and structural elements against a YAML
schema definition. Reports violations with configurable severity levels.

Usage:
    python validate.py --file docs/quickstart.md --schema quickstart
    python validate.py --file docs/quickstart.md --auto-detect
    python validate.py --self-test  # Validate all schemas are loadable
    python validate.py --list       # List available schemas
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

try:
    import yaml
except ImportError:
    yaml = None  # type: ignore[assignment]

DEFAULT_AUTO_DETECT_MIN_CONFIDENCE = 0.75
GENERIC_HEADING_PATTERNS = {".+", "^.+$", ".*", "^.*$"}


def is_generic_heading_pattern(pattern: str) -> bool:
    """Return true for heading patterns that cannot identify a schema."""
    return pattern.strip() in GENERIC_HEADING_PATTERNS


def confidence_arg(value: str) -> float:
    """Parse an argparse confidence threshold in the inclusive 0-1 range."""
    try:
        confidence = float(value)
    except ValueError as exc:
        raise argparse.ArgumentTypeError("--min-confidence must be a number") from exc

    if not 0.0 <= confidence <= 1.0:
        raise argparse.ArgumentTypeError("--min-confidence must be between 0.0 and 1.0")
    return confidence


def find_schema_root() -> Path | None:
    """Find the schemas directory.

    Checks assets/schemas/ first (published mode), then walks up to find
    the repo-level schemas/ directory (development mode).
    """
    script_dir = Path(__file__).resolve().parent
    skill_dir = script_dir.parent

    assets_dir = skill_dir / "assets" / "schemas"
    if assets_dir.is_dir():
        return assets_dir

    for ancestor in [skill_dir] + list(skill_dir.parents):
        candidate = ancestor / "schemas"
        if candidate.is_dir() and any(candidate.glob("*.yaml")):
            return candidate

    return None


def load_schema(schema_root: Path, schema_name: str) -> dict | None:
    """Load a schema by name."""
    schema_file = schema_root / f"{schema_name}.yaml"
    if not schema_file.is_file():
        return None

    if yaml is None:
        print("Error: PyYAML is required. Install with: pip install pyyaml", file=sys.stderr)
        return None

    with open(schema_file, encoding="utf-8") as f:
        return yaml.safe_load(f)


def list_schemas(schema_root: Path) -> list[str]:
    """List available schema names (excluding the spec itself)."""
    return sorted(
        p.stem for p in schema_root.glob("*.yaml")
        if p.stem != "schema-spec"
    )


def markdown_body_start_index(lines: list[str]) -> int:
    """Return the first body line after YAML frontmatter, if present."""
    if not lines or lines[0].strip() != "---":
        return 0

    for i, line in enumerate(lines[1:], start=1):
        if line.strip() in {"---", "..."}:
            return i + 1

    return 0


def markdown_fence_marker(stripped_line: str) -> str | None:
    """Return the opening fence marker for Markdown code fences."""
    if stripped_line.startswith("```"):
        return "```"
    if stripped_line.startswith("~~~"):
        return "~~~"
    return None


def extract_headings(content: str) -> list[dict]:
    """Extract Markdown headings with their level, text, and source line."""
    headings = []
    lines = content.splitlines()
    body_start = markdown_body_start_index(lines)
    in_fence = False
    fence_marker: str | None = None

    for i, line in enumerate(lines):
        if i < body_start:
            continue

        stripped = line.strip()

        if in_fence:
            if fence_marker and stripped.startswith(fence_marker):
                in_fence = False
                fence_marker = None
            continue

        fence_marker = markdown_fence_marker(stripped)
        if fence_marker:
            in_fence = True
            continue

        match = re.match(r"^(#{1,6})\s+(.+)$", line.strip())
        if match:
            level = len(match.group(1))
            text = match.group(2).strip()
            headings.append({"level": level, "text": text, "line": i + 1})
    return headings


def extract_headings_rst(content: str) -> list[dict]:
    """Extract RST headings (title underlined with =, -, ~, ^, etc.)."""
    headings = []
    lines = content.splitlines()
    underline_chars = "=-~^`"

    for i, line in enumerate(lines):
        if i == 0:
            continue
        stripped = line.strip()
        if stripped and len(set(stripped)) == 1 and stripped[0] in underline_chars and len(stripped) >= 3:
            title_line = lines[i - 1].strip() if i > 0 else ""
            if title_line and not title_line.startswith(".."):
                level = underline_chars.index(stripped[0]) + 1
                headings.append({"level": level, "text": title_line, "line": i})

    return headings


def check_headings(headings: list[dict], schema: dict) -> list[dict]:
    """Check headings against schema requirements."""
    findings = []
    structure = schema.get("structure", {})
    heading_reqs = structure.get("headings", {})
    severity_map = schema.get("severity", {})

    for level_key, reqs in heading_reqs.items():
        level = int(level_key.replace("h", ""))
        level_headings = [h for h in headings if h["level"] == level]
        level_texts = [h["text"] for h in level_headings]

        max_count = reqs.get("max_count")
        if max_count is not None and len(level_headings) > max_count:
            findings.append({
                "rule": f"duplicate_{level_key}",
                "message": f"Found {len(level_headings)} {level_key} headings (max {max_count})",
                "severity": severity_map.get(f"duplicate_{level_key}", "error"),
            })

        for req in reqs.get("required", []):
            pattern = req["pattern"]
            desc = req.get("description", pattern)
            matched = any(re.search(pattern, text, re.IGNORECASE) for text in level_texts)
            if not matched:
                findings.append({
                    "rule": "missing_required_section",
                    "section": desc,
                    "pattern": pattern,
                    "severity": severity_map.get("missing_required_section", "error"),
                })

        for req in reqs.get("optional", []):
            pattern = req["pattern"]
            desc = req.get("description", pattern)
            matched = any(re.search(pattern, text, re.IGNORECASE) for text in level_texts)
            if not matched:
                findings.append({
                    "rule": "missing_optional_section",
                    "section": desc,
                    "pattern": pattern,
                    "severity": severity_map.get("missing_optional_section", "info"),
                })

    return findings


_ORPHAN_HEADING_DEFAULT_MODE = "warning"

# Patterns that indicate the next non-blank line is NOT a paragraph.
# Each entry is (regex, reason). Order matters — first match wins.
_ORPHAN_NEXT_TOKENS = (
    (re.compile(r"^#{1,6}\s+"), "another heading"),
    (re.compile(r"^([-*+]|\d+\.)\s+"), "a list"),
    (re.compile(r"^```"), "a code fence"),
    (re.compile(r"^~~~"), "a code fence"),
    (re.compile(r"^::::"), "a MyST directive"),
    (re.compile(r"^:::"), "a MyST directive"),
    (re.compile(r"^\.\.\s"), "an RST directive"),
    (re.compile(r"^<[A-Z][A-Za-z0-9]*[\s>/]"), "an MDX component"),
    (re.compile(r"^\|"), "a table row"),
)

_LINT_DISABLE_RE = re.compile(r"<!--\s*lint-disable:\s*orphan-heading\s*-->", re.IGNORECASE)


def check_orphan_headings(content: str, schema: dict) -> list[dict]:
    """Flag headings whose next non-blank token is not a paragraph.

    Every heading should be followed by at least one sentence of explanatory
    prose. Lists, code, sub-headings, and directives don't count: they jump
    straight into structure without telling the reader what the section is for.

    Configurable via schema:
        lint:
          orphan_heading:
            mode: error | warning | info | skip   # default: warning
            skip_patterns:                        # heading-text regex allowlist
              - "^[A-Z]$"                         # e.g., glossary letter sections

    Inline escape: place `<!-- lint-disable: orphan-heading -->` as the line
    immediately after a heading to skip that heading's check.
    """
    lint_cfg = (schema.get("lint") or {}).get("orphan_heading") or {}
    mode = lint_cfg.get("mode", _ORPHAN_HEADING_DEFAULT_MODE)
    if mode == "skip":
        return []

    skip_patterns = [re.compile(p, re.IGNORECASE) for p in lint_cfg.get("skip_patterns", [])]

    findings: list[dict] = []
    lines = content.splitlines()
    body_start = markdown_body_start_index(lines)
    in_fence = False
    fence_marker: str | None = None

    for i, raw_line in enumerate(lines):
        if i < body_start:
            continue

        stripped = raw_line.strip()

        if in_fence:
            if fence_marker and stripped.startswith(fence_marker):
                in_fence = False
                fence_marker = None
            continue

        marker = markdown_fence_marker(stripped)
        if marker:
            in_fence = True
            fence_marker = marker
            continue

        m = re.match(r"^(#{1,6})\s+(.+?)\s*$", stripped)
        if not m:
            continue
        heading_text = m.group(2).strip()

        if any(p.search(heading_text) for p in skip_patterns):
            continue

        # Find next non-blank line.
        j = i + 1
        while j < len(lines) and not lines[j].strip():
            j += 1

        if j >= len(lines):
            findings.append({
                "rule": "orphan_heading",
                "heading": heading_text,
                "line": i + 1,
                "reason": "heading has no following content",
                "severity": mode,
            })
            continue

        next_line = lines[j].strip()

        if _LINT_DISABLE_RE.search(next_line):
            continue

        reason = None
        for pattern, label in _ORPHAN_NEXT_TOKENS:
            if pattern.match(next_line):
                reason = f"next non-blank token is {label}"
                break
        if reason is None:
            continue  # paragraph — OK

        findings.append({
            "rule": "orphan_heading",
            "heading": heading_text,
            "line": i + 1,
            "reason": reason,
            "severity": mode,
        })

    return findings


_LONG_FILE_DEFAULTS = {
    "mode": "info",
    "max_lines": 600,
    "max_h2_subtrees": 4,
    "min_subtree_lines": 80,
}


def check_long_file(content: str, headings: list[dict], schema: dict) -> list[dict]:
    """Flag oversized files that should be decomposed into overview.md + children.

    Two signals, either of which fires the rule:

    1. Total line count exceeds ``max_lines`` (default 600).
    2. The page has ``max_h2_subtrees`` or more H2 sections whose content blocks
       each exceed ``min_subtree_lines`` lines. A long page with several
       substantive H2 subtrees usually contains multiple topics in disguise.

    Configurable via schema:
        lint:
          long_file:
            mode: error | warning | info | skip   # default: info
            max_lines: 600
            max_h2_subtrees: 4
            min_subtree_lines: 80
    """
    lint_cfg = (schema.get("lint") or {}).get("long_file") or {}
    mode = lint_cfg.get("mode", _LONG_FILE_DEFAULTS["mode"])
    if mode == "skip":
        return []

    max_lines = int(lint_cfg.get("max_lines", _LONG_FILE_DEFAULTS["max_lines"]))
    max_h2 = int(lint_cfg.get("max_h2_subtrees", _LONG_FILE_DEFAULTS["max_h2_subtrees"]))
    min_subtree = int(lint_cfg.get("min_subtree_lines", _LONG_FILE_DEFAULTS["min_subtree_lines"]))

    lines = content.splitlines()
    total_lines = len(lines)

    # Measure H2 subtrees using the already-cleaned heading stream, so
    # frontmatter comments and fenced examples do not become split candidates.
    h2_positions: list[int] = []
    for heading in headings:
        if heading["level"] != 2:
            continue
        line = heading.get("line")
        if isinstance(line, int) and line > 0:
            h2_positions.append(line - 1)

    substantive_h2 = 0
    for idx, start in enumerate(h2_positions):
        end = h2_positions[idx + 1] if idx + 1 < len(h2_positions) else total_lines
        if (end - start) >= min_subtree:
            substantive_h2 += 1

    findings: list[dict] = []
    triggered_by = []
    if total_lines > max_lines:
        triggered_by.append(f"{total_lines} lines (limit {max_lines})")
    if substantive_h2 >= max_h2:
        triggered_by.append(
            f"{substantive_h2} substantive H2 subtrees (limit {max_h2 - 1})"
        )

    if triggered_by:
        findings.append({
            "rule": "long_file",
            "severity": mode,
            "lines": total_lines,
            "substantive_h2_subtrees": substantive_h2,
            "reason": "; ".join(triggered_by),
            "recommendation": (
                "Decompose into an overview.md plus per-topic child pages. "
                "Each H2 with a substantive subtree is a candidate child."
            ),
        })

    return findings


def check_section_order(headings: list[dict], schema: dict) -> list[dict]:
    """Check that H2 sections appear in the expected order."""
    findings = []
    structure = schema.get("structure", {})
    expected_order = structure.get("section_order", [])
    severity_map = schema.get("severity", {})

    if not expected_order:
        return findings

    h2_headings = [h["text"] for h in headings if h["level"] == 2]

    last_index = -1
    for heading_text in h2_headings:
        for i, expected in enumerate(expected_order):
            if re.search(re.escape(expected), heading_text, re.IGNORECASE) or expected.lower() in heading_text.lower():
                if i < last_index:
                    findings.append({
                        "rule": "wrong_section_order",
                        "message": f"'{heading_text}' appears after a section that should come later",
                        "expected": f"'{expected}' should come before later sections",
                        "severity": severity_map.get("wrong_section_order", "warning"),
                    })
                last_index = max(last_index, i)
                break

    return findings


def auto_detect_schema(content: str, schema_root: Path) -> tuple[str | None, float]:
    """Auto-detect the best matching schema for a file.

    Scores each schema by how many of its required heading patterns match
    headings at the correct level. Ties are broken by pattern specificity
    (longer patterns are more specific, so schemas with generic patterns
    like ".+" rank lower).

    Returns (schema_name, confidence) where confidence is 0.0-1.0.
    """
    headings = extract_headings(content)
    texts_by_level: dict[int, list[str]] = {}
    for h in headings:
        texts_by_level.setdefault(h["level"], []).append(h["text"])

    best_schema = None
    best_score = 0.0
    best_specificity = 0

    for schema_name in list_schemas(schema_root):
        schema = load_schema(schema_root, schema_name)
        if not schema:
            continue

        structure = schema.get("structure", {})
        heading_reqs = structure.get("headings", {})

        total_scored_required = 0
        matched_scored_required = 0
        total_pattern_len = 0
        generic_required_unmatched = False

        for level_key, reqs in heading_reqs.items():
            level = int(level_key.replace("h", ""))
            level_texts = texts_by_level.get(level, [])

            for req in reqs.get("required", []):
                pattern = req["pattern"]
                matched = any(re.search(pattern, text, re.IGNORECASE) for text in level_texts)
                if is_generic_heading_pattern(pattern):
                    if not matched:
                        generic_required_unmatched = True
                    continue

                total_scored_required += 1
                total_pattern_len += len(pattern)
                if matched:
                    matched_scored_required += 1

        if (
            total_scored_required > 0
            and matched_scored_required > 0
            and not generic_required_unmatched
        ):
            score = matched_scored_required / total_scored_required
            specificity = total_pattern_len
            if score > best_score or (score == best_score and specificity > best_specificity):
                best_score = score
                best_schema = schema_name
                best_specificity = specificity

    return best_schema, best_score


def validate_file(file_path: Path, schema: dict, schema_name: str) -> dict:
    """Validate a file against a schema and return the full report."""
    content = file_path.read_text(encoding="utf-8")

    if file_path.suffix == ".rst":
        headings = extract_headings_rst(content)
    else:
        headings = extract_headings(content)

    findings = []
    findings.extend(check_headings(headings, schema))
    findings.extend(check_section_order(headings, schema))
    if file_path.suffix != ".rst":
        findings.extend(check_orphan_headings(content, schema))
    findings.extend(check_long_file(content, headings, schema))

    errors = [f for f in findings if f["severity"] == "error"]
    warnings = [f for f in findings if f["severity"] == "warning"]
    info = [f for f in findings if f["severity"] == "info"]

    return {
        "valid": len(errors) == 0,
        "schema": schema_name,
        "file": str(file_path),
        "errors": errors,
        "warnings": warnings,
        "info": info,
        "summary": {
            "errors": len(errors),
            "warnings": len(warnings),
            "info": len(info),
            "total": len(findings),
        },
    }


def self_test(schema_root: Path) -> int:
    """Validate that all schemas are loadable, well-formed, and correctly sourced."""
    schemas = list_schemas(schema_root)
    if not schemas:
        print("No schemas found.", file=sys.stderr)
        return 1

    # source_template is repo-relative. In a source checkout, validate it
    # against the canonical templates/ tree. In a published skill pack, the
    # templates live in the sibling tpl-new-page asset bundle instead. Two
    # schemas shipped paths that predated the reference/ grouping, so a missing,
    # malformed, or unresolvable source_template is a failure, not a warning.
    script_path = Path(__file__).resolve()
    repo_root = script_path.parents[3]
    if (repo_root / "templates").is_dir():
        source_root = repo_root
    else:
        source_root = script_path.parents[2] / "tpl-new-page" / "assets"

    ok = True
    for name in schemas:
        schema = load_schema(schema_root, name)
        if schema is None:
            print(f"  FAIL: {name} — could not load")
            ok = False
            continue

        source = schema.get("source_template")
        if not isinstance(source, str):
            # A non-string here would raise TypeError inside the path join and
            # abort the whole run, hiding which schema is malformed. Missing is
            # also invalid: source_template is required by schema-spec.yaml.
            actual_type = "missing" if source is None else type(source).__name__
            print(f"  FAIL: {name} — source_template must be a string, got {actual_type}")
            ok = False
            continue
        if not source.strip():
            print(f"  FAIL: {name} — source_template must not be empty")
            ok = False
            continue

        source_path = Path(source)
        if (
            source_path.is_absolute()
            or not source_path.parts
            or ".." in source_path.parts
            or source_path.parts[0] != "templates"
        ):
            print(
                f"  FAIL: {name} — source_template {source} must be a repo-relative path "
                "under templates/"
            )
            ok = False
            continue
        if not (source_root / source_path).is_file():
            print(f"  FAIL: {name} — source_template {source} does not exist")
            ok = False
            continue

        has_structure = "structure" in schema
        has_headings = "headings" in schema.get("structure", {})
        if has_structure and has_headings:
            print(f"  OK:   {name} — {schema.get('description', 'no description')}")
        else:
            print(f"  WARN: {name} — missing structure.headings")

    return 0 if ok else 1


def main() -> int:
    parser = argparse.ArgumentParser(description="Validate a doc page against a template schema")
    parser.add_argument("--file", "-f", help="Path to the file to validate")
    parser.add_argument("--schema", "-s", help="Schema name (e.g., quickstart, installation)")
    parser.add_argument("--auto-detect", action="store_true", help="Auto-detect the best matching schema")
    parser.add_argument(
        "--min-confidence",
        type=confidence_arg,
        default=DEFAULT_AUTO_DETECT_MIN_CONFIDENCE,
        help=(
            "Minimum auto-detect confidence required before validating "
            f"(default: {DEFAULT_AUTO_DETECT_MIN_CONFIDENCE:.2f})"
        ),
    )
    parser.add_argument("--list", "-l", action="store_true", help="List available schemas")
    parser.add_argument("--self-test", action="store_true", help="Validate all schemas are loadable")
    parser.add_argument("--json", action="store_true", help="Output as JSON (default for --file)")

    args = parser.parse_args()

    if yaml is None:
        print("Error: PyYAML is required. Install with: pip install pyyaml", file=sys.stderr)
        return 1

    schema_root = find_schema_root()
    if not schema_root:
        print("Error: Could not find schemas directory.", file=sys.stderr)
        return 1

    if args.list:
        print("Available schemas:\n")
        for name in list_schemas(schema_root):
            schema = load_schema(schema_root, name)
            desc = schema.get("description", "") if schema else ""
            print(f"  {name:<20} {desc}")
        return 0

    if args.self_test:
        print(f"Validating schemas in {schema_root}:\n")
        return self_test(schema_root)

    if not args.file:
        print("Error: --file is required (or use --list / --self-test).", file=sys.stderr)
        return 1

    file_path = Path(args.file)
    if not file_path.is_file():
        print(f"Error: File not found: {file_path}", file=sys.stderr)
        return 1

    schema_name = args.schema
    if args.auto_detect or not schema_name:
        content = file_path.read_text(encoding="utf-8")
        detected_name, confidence = auto_detect_schema(content, schema_root)
        if detected_name and confidence >= args.min_confidence:
            schema_name = detected_name
            if not args.schema:
                sys.stderr.write(f"Auto-detected schema: {schema_name} (confidence: {confidence:.0%})\n")
        elif detected_name:
            print(
                f"Error: Auto-detected schema '{detected_name}' at {confidence:.0%} confidence, "
                f"below --min-confidence {args.min_confidence:.0%}. Use --schema to specify.",
                file=sys.stderr,
            )
            return 1
        else:
            print("Error: Could not auto-detect schema. Use --schema to specify.", file=sys.stderr)
            return 1

    schema = load_schema(schema_root, schema_name)
    if schema is None:
        print(f"Error: Schema '{schema_name}' not found. Use --list to see available schemas.", file=sys.stderr)
        return 1

    report = validate_file(file_path, schema, schema_name)

    print(json.dumps(report, indent=2))

    return 0 if report["valid"] else 1


if __name__ == "__main__":
    sys.exit(main())
