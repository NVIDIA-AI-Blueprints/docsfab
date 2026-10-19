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

"""Scaffold a new documentation page from an NVIDIA template.

Copies the selected template to the target path, replaces standard
placeholders with product-specific values, and strips author-only content.

Usage:
    python scaffold.py --template quickstart --format gfm --product "NeMo Curator" --output docs/quickstart.md
    python scaffold.py --template installation --format myst --product "Morpheus" --output docs/install.md
    python scaffold.py --list  # List available templates
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import sys
from pathlib import Path

TEMPLATE_MAP = {
    # Get Started
    "quickstart": "get-started/quickstart",
    "installation": "get-started/installation",
    "tutorial": "get-started/beginner-tutorial",
    "beginner-tutorial": "get-started/beginner-tutorial",
    "prerequisites": "get-started/prerequisites",
    "get-started-overview": "get-started/get-started-overview",
    # About
    "architecture": "about/architecture-overview",
    "feature": "about/about-feature",
    "about-feature": "about/about-feature",
    "procedural-task": "about/about-procedural-task",
    "about-procedural-task": "about/about-procedural-task",
    "ecosystem": "about/ecosystem",
    "features": "about/key-features",
    "blended-conceptual": "conceptual/blended-conceptual",
    "conceptual-blended": "conceptual/blended-conceptual",
    "about-overview": "about/overview",
    "core-concepts-overview": "about/core-concepts-overview",
    "core-concepts": "about/core-concepts-overview",
    "concepts-overview": "conceptual/overview",
    # Conceptual (standalone)
    "conceptual": "conceptual/conceptual",
    # Reference — Environment Variables
    "environment-variables": "reference/environment-variables/environment-variables",
    "env-vars": "reference/environment-variables/environment-variables",
    # Reference — Helm Chart Values
    "helm-parameters": "reference/helm-parameters/helm-parameters",
    "helm-params": "reference/helm-parameters/helm-parameters",
    # Reference — Observability
    "observability-metrics": "reference/observability/observability-metrics",
    "observability": "reference/observability/observability-metrics",
    # Reference — Performance
    "performance-benchmarks": "reference/performance/performance-benchmarks",
    "performance": "reference/performance/performance-benchmarks",
    # Procedural (standalone)
    "procedural": "procedural/single-procedural",
    "single-procedural": "procedural/single-procedural",
    "single-procedural-task": "procedural/single-procedural",
    "multiple-procedural": "procedural/multiple-procedural",
    "multiple-procedural-tasks": "procedural/multiple-procedural",
    # Reference
    "reference-overview": "reference/reference-overview",
    # Release Notes
    "release-notes": "release-notes/release-notes",
    # Resources
    "glossary": "resources/glossary",
    "support-and-faqs": "resources/support-and-faqs",
    "support": "resources/support-and-faqs",
    "faqs": "resources/support-and-faqs",
    "resources-overview": "resources/resources-overview",
    # Troubleshooting
    "troubleshooting": "troubleshooting/troubleshooting",
}

FORMAT_SUFFIXES = {
    "myst": ".md",
    "gfm": "-gfm.md",
    "rst": ".rst",
    "mdx": ".mdx",
}

# Template-descriptor keys that are NOT valid as topic filenames.
# These describe a template *category* rather than a topic — files derived from
# them must be named after the actual subject (e.g. fuzzy-deduplication.md, not
# feature.md). Singular-topic templates like quickstart/installation/glossary
# are intentionally absent: their template name *is* the topic.
GENERIC_TEMPLATE_NAMES = {
    "feature",
    "about-feature",
    "concept",
    "conceptual",
    "conceptual-blended",
    "procedural",
    "procedural-task",
    "about-procedural-task",
    "single-procedural",
    "single-procedural-task",
    "multiple-procedural",
    "multiple-procedural-tasks",
}


def find_template_root() -> Path | None:
    """Find the templates directory.

    Checks assets/templates/ first (published mode), then walks up
    to find the repo-level templates/ directory (development mode).
    """
    script_dir = Path(__file__).resolve().parent
    skill_dir = script_dir.parent

    assets_dir = skill_dir / "assets" / "templates"
    if assets_dir.is_dir():
        return assets_dir

    for ancestor in [skill_dir] + list(skill_dir.parents):
        candidate = ancestor / "templates"
        if candidate.is_dir() and (candidate / "about").is_dir():
            return candidate

    return None


def find_schema_root() -> Path | None:
    """Find the schemas directory (for validation after scaffold)."""
    script_dir = Path(__file__).resolve().parent
    skill_dir = script_dir.parent

    assets_dir = skill_dir / "assets" / "schemas"
    if assets_dir.is_dir():
        return assets_dir

    for ancestor in [skill_dir] + list(skill_dir.parents):
        candidate = ancestor / "schemas"
        if candidate.is_dir():
            return candidate

    return None


def resolve_template_path(template_root: Path, template_type: str, fmt: str) -> Path | None:
    """Resolve the template file path from type and format."""
    base = TEMPLATE_MAP.get(template_type)
    if not base:
        return None

    suffix = FORMAT_SUFFIXES.get(fmt)
    if not suffix:
        return None

    if suffix == "-gfm.md":
        filename = base.rsplit("/", 1)[-1] + suffix
        directory = base.rsplit("/", 1)[0] if "/" in base else ""
        candidate = template_root / directory / filename
    else:
        candidate = template_root / (base + suffix)

    return candidate if candidate.is_file() else None


def build_replacements(product_name: str) -> dict[str, str]:
    """Build the placeholder replacement map from a product name."""
    package_name = product_name.lower().replace(" ", "-").replace("nvidia-", "").replace("nvidia ", "")
    module_name = package_name.replace("-", "_")

    return {
        "[Product Name]": product_name,
        "[product-name]": package_name,
        "[package-name]": package_name,
        "[package_name]": module_name,
        "[Product]": product_name,
    }


def strip_author_content(content: str, fmt: str, strip_examples: bool = False) -> str:
    """Remove author-only content from a scaffolded template.

    Always strips:
      - "When to Use This Template" visible admonition (title-based match).
      - "Format Selection Guide" visible admonition (title-based match).

    If `strip_examples` is True, also strips @tpl:example author notes. Off by
    default so authors can copy from those examples; pass --strip-examples to
    opt in.
    """
    if fmt == "gfm":
        content = re.sub(
            r"> \*\*Note:\*\* Use this template.*?(?=\n---|\n## |\n# |\Z)",
            "",
            content,
            flags=re.DOTALL,
        )
        content = re.sub(
            r"<details>\s*\n\s*<summary><strong>Format Selection Guide</strong></summary>.*?</details>",
            "",
            content,
            flags=re.DOTALL,
        )
    elif fmt == "myst":
        content = re.sub(
            r":::\{admonition\} When to Use This Template.*?:::",
            "",
            content,
            flags=re.DOTALL,
        )
        content = re.sub(
            r"::::\{admonition\} Format Selection Guide.*?::::",
            "",
            content,
            flags=re.DOTALL,
        )
    elif fmt == "mdx":
        content = re.sub(
            r'<Note title="When to Use This Template">\s*.*?</Note>',
            "",
            content,
            flags=re.DOTALL,
        )
        content = re.sub(
            r'<Accordion title="Format Selection Guide">\s*.*?</Accordion>',
            "",
            content,
            flags=re.DOTALL,
        )
    elif fmt == "rst":
        content = re.sub(
            r"\.\. admonition:: When to Use This Template.*?(?=\n\S|\Z)",
            "",
            content,
            flags=re.DOTALL,
        )

    if strip_examples:
        content = _strip_tpl_block(content, fmt, "example")

    content = re.sub(r"\n{3,}", "\n\n", content)
    return content.strip() + "\n"


def _strip_tpl_block(content: str, fmt: str, verb: str) -> str:
    """Remove every `@tpl:VERB` comment (single- or multi-line) for a fmt."""
    if fmt in {"myst", "gfm"}:
        pattern = re.compile(rf"<!--\s*@tpl:{re.escape(verb)}\b.*?-->", re.DOTALL)
    elif fmt == "mdx":
        pattern = re.compile(rf"\{{/\*\s*@tpl:{re.escape(verb)}\b.*?\*/\}}", re.DOTALL)
    elif fmt == "rst":
        # An RST directive runs from `.. @tpl:VERB` until the next blank line
        # followed by an unindented line (or end of file).
        pattern = re.compile(
            rf"^[ \t]*\.\.\s+@tpl:{re.escape(verb)}\b.*?(?=^\S|\Z)",
            re.DOTALL | re.MULTILINE,
        )
    else:
        return content
    return pattern.sub("", content)


def apply_replacements(content: str, replacements: dict[str, str]) -> tuple[str, int]:
    """Apply placeholder replacements and return (new_content, count)."""
    count = 0
    for old, new in replacements.items():
        occurrences = content.count(old)
        if occurrences > 0:
            content = content.replace(old, new)
            count += occurrences
    return content, count


def count_remaining_placeholders(content: str) -> int:
    """Count remaining [Placeholder] markers in the content."""
    return len(re.findall(r"\[[A-Z][^\]]*\]", content))


def output_basename_stem(output_path: Path, fmt: str) -> str:
    """Return the bare basename used to compare against GENERIC_TEMPLATE_NAMES.

    Strips both the standard suffix (.md/.rst/.mdx) and the GFM `-gfm` infix so
    that `feature-gfm.md` and `feature.md` both resolve to `feature`.
    """
    stem = output_path.stem
    if fmt == "gfm" and stem.endswith("-gfm"):
        stem = stem[: -len("-gfm")]
    return stem


def list_templates(template_root: Path) -> None:
    """Print available templates."""
    print("Available templates:\n")
    for name, path in sorted(TEMPLATE_MAP.items()):
        formats = []
        for fmt, suffix in FORMAT_SUFFIXES.items():
            if fmt == "gfm":
                filename = path.rsplit("/", 1)[-1] + suffix
                directory = path.rsplit("/", 1)[0] if "/" in path else ""
                candidate = template_root / directory / filename
            else:
                candidate = template_root / (path + suffix)
            if candidate.is_file():
                formats.append(fmt)
        if formats:
            print(f"  {name:<25} {path:<45} [{', '.join(formats)}]")


def main() -> int:
    parser = argparse.ArgumentParser(description="Scaffold a documentation page from a template")
    parser.add_argument("--template", "-t", help="Template type (e.g., quickstart, installation, architecture)")
    parser.add_argument("--format", "-f", default="gfm", choices=["myst", "gfm", "rst", "mdx"], help="Output format")
    parser.add_argument("--product", "-p", default="", help="Product name for placeholder replacement")
    parser.add_argument("--output", "-o", help="Output file path")
    parser.add_argument("--list", "-l", action="store_true", help="List available templates")
    parser.add_argument("--json", action="store_true", help="Output result as JSON")
    parser.add_argument("--no-strip", action="store_true", help="Keep author-only content (When to Use, Format Guide)")
    parser.add_argument(
        "--strip-examples",
        action="store_true",
        help="Also strip @tpl:example author notes.",
    )
    parser.add_argument(
        "--allow-generic-name",
        action="store_true",
        help="Allow filenames that match generic template descriptors (e.g., feature.md, concept.md). "
             "By default, the script rejects these and asks for a topic slug like fuzzy-deduplication.md.",
    )

    args = parser.parse_args()

    template_root = find_template_root()
    if not template_root:
        print("Error: Could not find templates directory.", file=sys.stderr)
        return 1

    if args.list:
        list_templates(template_root)
        return 0

    if not args.template:
        print("Error: --template is required (use --list to see available templates).", file=sys.stderr)
        return 1

    if not args.output:
        print("Error: --output is required.", file=sys.stderr)
        return 1

    output_path = Path(args.output)
    basename_stem = output_basename_stem(output_path, args.format)
    if not args.allow_generic_name and basename_stem in GENERIC_TEMPLATE_NAMES:
        print(
            f"Error: '{output_path.name}' uses a generic template descriptor as its filename.\n"
            f"       Filenames must be topic slugs (e.g., 'fuzzy-deduplication.md', not "
            f"'{basename_stem}.md').\n"
            f"       Pass --allow-generic-name to override (e.g., for canonical IA scaffolding).",
            file=sys.stderr,
        )
        return 2

    template_path = resolve_template_path(template_root, args.template, args.format)
    if not template_path:
        print(f"Error: Template '{args.template}' not found for format '{args.format}'.", file=sys.stderr)
        available = [k for k in TEMPLATE_MAP if k == args.template or TEMPLATE_MAP.get(k) == TEMPLATE_MAP.get(args.template)]
        if available:
            print(f"Available formats for '{args.template}':", file=sys.stderr)
            for fmt in FORMAT_SUFFIXES:
                if resolve_template_path(template_root, args.template, fmt):
                    print(f"  --format {fmt}", file=sys.stderr)
        return 1

    content = template_path.read_text(encoding="utf-8")

    if not args.no_strip:
        content = strip_author_content(content, args.format, strip_examples=args.strip_examples)

    replaced_count = 0
    if args.product:
        replacements = build_replacements(args.product)
        content, replaced_count = apply_replacements(content, replacements)

    remaining = count_remaining_placeholders(content)

    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(content, encoding="utf-8")

    result = {
        "created": str(output_path),
        "template": template_path.name,
        "template_type": args.template,
        "format": args.format,
        "placeholders_replaced": replaced_count,
        "placeholders_remaining": remaining,
    }

    if args.json:
        print(json.dumps(result, indent=2))
    else:
        print(f"Created: {output_path}")
        print(f"Template: {template_path.name} ({args.format})")
        if args.product:
            print(f"Product: {args.product}")
        print(f"Placeholders replaced: {replaced_count}")
        print(f"Placeholders remaining: {remaining}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
