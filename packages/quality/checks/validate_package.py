#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.

"""Validate the shared DocsFab skill and quality packages."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import package_inputs
from validate_html import validate_html
from validate_quality_score import validate_quality_score


REQUIRED_SKILLS = {
    "assess-documentation-readiness",
    "audit-documentation",
    "doc-context-analyzer",
    "evaluate-document-quality",
    "lint-documentation",
    "review-documentation",
    "plan-documentation",
    "repo-bootstrap",
    "template-scaffold-site",
    "test-audience-understanding",
    "tpl-design-ia",
    "verify-technical-accuracy",
    "write-documentation",
}

REQUIRED_FILES = {
    "packages/skills/EXECUTION_CONTRACT.md",
    "packages/skills/workflows/create-documentation.md",
    "packages/skills/workflows/update-documentation.md",
    "packages/quality/checks/validate_quality_report.py",
    "packages/quality/checks/validate_quality_score.py",
    "packages/quality/checks/collect_doc_quality_signals.py",
    "packages/quality/checks/derive_documentation_quality_evaluation.py",
    "packages/quality/checks/quality_decision_policy.py",
    "packages/quality/checks/validate_audience_understanding_evaluation.py",
    "packages/quality/checks/validate_documentation_quality_evaluation.py",
    "packages/quality/checks/validate_documentation_partial.py",
    "packages/quality/checks/validate_json_artifact.py",
    "packages/quality/formats/html/task-guide.html",
    "packages/quality/formats/html/concept-guide.html",
    "packages/quality/formats/html/api-reference.html",
    "packages/quality/formats/html/base.css",
    "packages/quality/rubrics/task-guide.yaml",
    "packages/quality/rubrics/concept-guide.yaml",
    "packages/quality/rubrics/api-reference.yaml",
    "packages/quality/profiles/example-public-docs/profile.yaml",
    "packages/quality/profiles/docsfab-documentation-quality/profile.json",
    "packages/quality/schemas/assurance-system-measurement.schema.json",
    "packages/quality/schemas/audience-understanding-evaluation.schema.json",
    "packages/quality/schemas/doc-quality-signals.schema.json",
    "packages/quality/schemas/documentation-quality-evaluation.schema.json",
    "packages/quality/schemas/documentation-partial-result.schema.json",
}

FORBIDDEN_PATHS = {
    ".claude-plugin",
    "packages/quality/adapters",
    "packages/quality/blueprint",
    "packages/quality/examples",
    "packages/quality/style-profiles",
    "packages/skills/dab-guided-demo",
    "packages/skills/fill-srd",
    "packages/skills/guided-demo",
    "experiments/pi-in-openshell",
}


def validate_skill(skill_dir: Path) -> list[str]:
    errors: list[str] = []
    skill_file = skill_dir / "SKILL.md"
    metadata_file = skill_dir / "agents" / "openai.yaml"
    if not skill_file.is_file():
        return [f"Missing {skill_file}"]
    text = skill_file.read_text(encoding="utf-8")
    if not text.startswith("---\n") or "\n---\n" not in text[4:]:
        errors.append(f"Invalid frontmatter in {skill_file}")
    if f"name: {skill_dir.name}" not in text:
        errors.append(f"Skill name does not match directory in {skill_file}")
    if "description:" not in text:
        errors.append(f"Missing description in {skill_file}")
    if "TODO" in text:
        errors.append(f"Unresolved TODO in {skill_file}")
    if not metadata_file.is_file():
        errors.append(f"Missing {metadata_file}")
    return errors


def distribution_errors(distribution: str) -> list[str]:
    if distribution not in {"internal", "public"}:
        return [f"Unknown package distribution: {distribution}"]
    if package_inputs.DISTRIBUTION not in {"internal", "public"}:
        return [f"Invalid package input distribution: {package_inputs.DISTRIBUTION}"]
    if distribution == "internal" and (
        package_inputs.DISTRIBUTION != "internal"
        or not package_inputs.INTERNAL_REQUIRED_FILES
        or not package_inputs.EXPECTED_QUALITY_SCORE
    ):
        return [
            "Internal package validation requires the internal source checkout and "
            "its retained QA inputs; use --distribution public for this distribution."
        ]
    return []


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("root", nargs="?", default=".", type=Path)
    parser.add_argument(
        "--distribution",
        choices=("internal", "public"),
        default=package_inputs.DISTRIBUTION,
        help="Validation scope declared by this source distribution.",
    )
    args = parser.parse_args()
    root = args.root.resolve()
    quality_root = root / "packages" / "quality"
    skills_root = root / "packages" / "skills"
    errors = distribution_errors(args.distribution)

    required_files = REQUIRED_FILES
    if args.distribution == "internal":
        required_files = required_files | package_inputs.INTERNAL_REQUIRED_FILES
    for relative in sorted(required_files):
        if not (root / relative).is_file():
            errors.append(f"Missing required file: {relative}")

    for relative in sorted(FORBIDDEN_PATHS):
        if (root / relative).exists():
            errors.append(f"Legacy or noncanonical path must not exist: {relative}")

    for schema in sorted((quality_root / "schemas").glob("*.json")):
        try:
            data = json.loads(schema.read_text(encoding="utf-8"))
        except json.JSONDecodeError as exc:
            errors.append(f"Invalid JSON in {schema.relative_to(root)}: {exc}")
            continue
        if data.get("$schema") != "https://json-schema.org/draft/2020-12/schema":
            errors.append(f"Unexpected JSON Schema version in {schema.relative_to(root)}")

    schema_count = len(list((quality_root / "schemas").glob("*.json")))
    if schema_count < 11:
        errors.append(f"Expected at least 11 schemas; found {schema_count}")

    actual_skills = {path.parent.name for path in skills_root.glob("*/SKILL.md")}
    if actual_skills != REQUIRED_SKILLS:
        errors.append(
            "Central skill inventory must match the canonical skill ids: "
            f"missing={sorted(REQUIRED_SKILLS - actual_skills)}, "
            f"unexpected={sorted(actual_skills - REQUIRED_SKILLS)}"
        )
    for skill_name in sorted(actual_skills):
        errors.extend(validate_skill(skills_root / skill_name))

    for doc_type in ("task-guide", "concept-guide", "api-reference"):
        result = validate_html(
            quality_root / "formats" / "html" / f"{doc_type}.html",
            doc_type,
            allow_placeholders=True,
        )
        if not result["passed"]:
            failed = [item["id"] for item in result["checks"] if item["status"] == "fail"]
            errors.append(f"Invalid {doc_type} format: {', '.join(failed)}")

    if args.distribution == "internal" and package_inputs.EXPECTED_QUALITY_SCORE:
        quality_score_path = root / package_inputs.EXPECTED_QUALITY_SCORE
        try:
            quality_score = json.loads(quality_score_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            errors.append(f"Invalid expected quality score: {exc}")
        else:
            errors.extend(
                f"Invalid expected quality score: {error}"
                for error in validate_quality_score(quality_score)
            )

    if errors:
        print("DocsFab package validation failed:")
        for error in errors:
            print(f"- {error}")
        return 1

    print(
        f"DocsFab {args.distribution} package validation passed: "
        f"{len(actual_skills)} active skills, "
        f"{schema_count} schemas, 3 HTML formats"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
