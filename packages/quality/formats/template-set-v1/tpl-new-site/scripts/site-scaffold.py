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

"""Bootstrap a complete documentation site from the canonical IA.

Reads the site-map.yaml definition and calls scaffold.py for each page
to generate a full directory structure with placeholder content.

Usage:
    python site-scaffold.py --product "NeMo Curator" --format gfm --output docs/
    python site-scaffold.py --product "Morpheus" --format mdx --output docs/ --include-optional
    python site-scaffold.py --product "TensorRT" --format myst --output docs/ --use-cases "Inference,Optimization"
    python site-scaffold.py --list  # Show the site map
    python site-scaffold.py --dry-run --product "Test" --format gfm --output /tmp/test
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from pathlib import Path

try:
    import yaml
except ImportError:
    yaml = None  # type: ignore[assignment]


def skills_subdirs() -> list[str]:
    """Skill directories searched under each ancestor of this skill.

    `skills` is the template set's own layout. An installer that nests packs
    elsewhere names its directories in TPL_SKILLS_SUBDIRS, separated by
    os.pathsep; empty entries are ignored rather than read as the ancestor.
    """
    extra = os.environ.get("TPL_SKILLS_SUBDIRS", "").split(os.pathsep)
    return ["skills", *(entry for entry in extra if entry)]



def find_site_map() -> Path | None:
    """Find site-map.yaml in assets/ or by walking up."""
    script_dir = Path(__file__).resolve().parent
    skill_dir = script_dir.parent

    assets = skill_dir / "assets" / "site-map.yaml"
    if assets.is_file():
        return assets

    for ancestor in [skill_dir] + list(skill_dir.parents):
        for skills_subdir in skills_subdirs():
            candidate = ancestor / skills_subdir / "tpl-new-site" / "assets" / "site-map.yaml"
            if candidate.is_file():
                return candidate

    return None


def find_scaffold_script() -> Path | None:
    """Find scaffold.py in sibling skill directory."""
    script_dir = Path(__file__).resolve().parent
    skill_dir = script_dir.parent
    skills_dir = skill_dir.parent

    candidate = skills_dir / "tpl-new-page" / "scripts" / "scaffold.py"
    if candidate.is_file():
        return candidate

    for ancestor in [skill_dir] + list(skill_dir.parents):
        for skills_subdir in skills_subdirs():
            candidate = ancestor / skills_subdir / "tpl-new-page" / "scripts" / "scaffold.py"
            if candidate.is_file():
                return candidate

    return None


def load_site_map(path: Path) -> dict:
    """Load and return the site map definition."""
    if yaml is None:
        print("Error: PyYAML required. Install with: pip install pyyaml", file=sys.stderr)
        sys.exit(1)
    with open(path, encoding="utf-8") as f:
        return yaml.safe_load(f)


def collect_pages(
    sections: dict,
    include_optional: bool = False,
    use_cases: list[str] | None = None,
    parent_path: str = "",
) -> list[dict]:
    """Walk the site map and collect pages to scaffold.

    Returns a list of dicts with keys: path, template, description.
    """
    pages: list[dict] = []

    for section_name, section in sections.items():
        if section is None:
            continue

        is_repeatable = section.get("repeatable", False)
        is_required = section.get("required", True)

        if not is_required and not include_optional and not is_repeatable:
            continue

        if is_repeatable:
            case_names = use_cases or []
            if not case_names and not include_optional:
                continue
            if not case_names:
                case_names = ["use-case-1"]

            for case_name in case_names:
                case_slug = case_name.lower().replace(" ", "-")
                case_path = f"{parent_path}/{case_slug}" if parent_path else case_slug

                children = section.get("children", {})
                for child_name, child in children.items():
                    if child is None:
                        continue
                    child_required = child.get("required", True)
                    if not child_required and not include_optional:
                        continue

                    # Prefix child filenames with the case slug so files become
                    # self-describing (e.g., inference-procedural.md, not the
                    # generic procedural.md). Without this, repeatable-section
                    # children inherit the literal site-map keys.
                    child_filename = f"{case_slug}-{child_name}"
                    page_path = f"{case_path}/{child_filename}"
                    pages.append({
                        "path": page_path,
                        "template": child.get("template", child_name),
                        "description": child.get("description", ""),
                    })
        else:
            section_path = f"{parent_path}/{section_name}" if parent_path else section_name

            template = section.get("template")
            children = section.get("children", {})
            landing = section.get("landing", False)
            if template:
                if children or landing:
                    page_path = f"{section_path}/overview"
                elif parent_path:
                    page_path = section_path
                else:
                    page_path = f"{section_path}/{section_name}"
                pages.append({
                    "path": page_path,
                    "template": template,
                    "description": section.get("description", ""),
                })

            if children:
                child_pages = collect_pages(
                    children,
                    include_optional=include_optional,
                    parent_path=section_path,
                )
                pages.extend(child_pages)

            # Leaf nodes without a template still become standalone pages.
            if not children and not template:
                pages.append({
                    "path": section_path,
                    "template": section_name,
                    "description": section.get("description", ""),
                })

    return pages


def scaffold_page(
    scaffold_script: Path,
    template: str,
    fmt: str,
    product: str,
    output_path: Path,
    dry_run: bool = False,
) -> dict:
    """Call scaffold.py to create a single page. Returns result dict."""
    if dry_run:
        return {
            "path": str(output_path),
            "template": template,
            "status": "dry-run",
        }

    cmd = [
        sys.executable,
        str(scaffold_script),
        "--template", template,
        "--format", fmt,
        "--product", product,
        "--output", str(output_path),
        "--json",
        # site-scaffold drives canonical IA — its paths intentionally use the
        # site-map keys (e.g., overview, quickstart) so the generic-name guard
        # doesn't apply here.
        "--allow-generic-name",
    ]

    try:
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=60,
        )
    except subprocess.TimeoutExpired as e:
        return {
            "path": str(output_path),
            "template": template,
            "status": "error",
            "error": f"scaffold.py timed out after {e.timeout} seconds",
        }

    if result.returncode != 0:
        return {
            "path": str(output_path),
            "template": template,
            "status": "error",
            "error": result.stderr.strip(),
        }

    try:
        return json.loads(result.stdout)
    except json.JSONDecodeError:
        return {
            "path": str(output_path),
            "template": template,
            "status": "created",
            "output": result.stdout.strip(),
        }


def format_extension(fmt: str) -> str:
    """Return file extension for a format."""
    extensions = {
        "myst": ".md",
        "gfm": ".md",
        "rst": ".rst",
        "mdx": ".mdx",
    }
    return extensions.get(fmt, ".md")


def print_site_map(site_map: dict, indent: int = 0) -> None:
    """Pretty-print the site map."""
    sections = site_map.get("sections", {})
    for name, section in sections.items():
        if section is None:
            continue
        prefix = "  " * indent
        required = "required" if section.get("required", True) else "optional"
        repeatable = " (repeatable)" if section.get("repeatable", False) else ""
        template = section.get("template", "")
        desc = section.get("description", "")

        tpl_str = f"  [{template}]" if template else ""
        print(f"{prefix}- {name}{tpl_str}  ({required}{repeatable})")
        if desc:
            print(f"{prefix}  {desc}")

        children = section.get("children", {})
        if children:
            _print_children(children, indent + 1)


def _print_children(children: dict, indent: int) -> None:
    """Print child sections recursively."""
    for name, child in children.items():
        if child is None:
            continue
        prefix = "  " * indent
        required = "required" if child.get("required", True) else "optional"
        template = child.get("template", "")
        desc = child.get("description", "")

        tpl_str = f"  [{template}]" if template else ""
        print(f"{prefix}- {name}{tpl_str}  ({required})")
        if desc:
            print(f"{prefix}  {desc}")

        sub_children = child.get("children", {})
        if sub_children:
            _print_children(sub_children, indent + 1)


def main() -> int:
    parser = argparse.ArgumentParser(description="Bootstrap a documentation site from the canonical IA")
    parser.add_argument("--product", "-p", help="Product name for placeholder replacement")
    parser.add_argument("--format", "-f", default="gfm", choices=["myst", "gfm", "rst", "mdx"], help="Output format")
    parser.add_argument("--output", "-o", help="Output root directory")
    parser.add_argument("--include-optional", action="store_true", help="Include optional sections")
    parser.add_argument("--use-cases", help="Comma-separated list of use case names (creates repeatable sections)")
    parser.add_argument("--list", "-l", action="store_true", help="Show the site map")
    parser.add_argument("--dry-run", action="store_true", help="Show what would be created without writing files")
    parser.add_argument("--json", action="store_true", help="Output result as JSON")

    args = parser.parse_args()

    site_map_path = find_site_map()
    if not site_map_path:
        print("Error: Could not find site-map.yaml", file=sys.stderr)
        return 1

    site_map = load_site_map(site_map_path)

    if args.list:
        print("Documentation Site Structure:\n")
        print_site_map(site_map)
        return 0

    if not args.product:
        print("Error: --product is required", file=sys.stderr)
        return 1

    if not args.output:
        print("Error: --output is required", file=sys.stderr)
        return 1

    scaffold_script = find_scaffold_script()
    if not scaffold_script:
        print("Error: Could not find scaffold.py", file=sys.stderr)
        return 1

    use_cases = [uc.strip() for uc in args.use_cases.split(",")] if args.use_cases else None

    sections = site_map.get("sections", {})
    pages = collect_pages(
        sections,
        include_optional=args.include_optional,
        use_cases=use_cases,
    )

    output_root = Path(args.output)
    ext = format_extension(args.format)

    results = []
    created = 0
    errors = 0

    for page in pages:
        page_path = page["path"]
        if page_path.endswith("/overview"):
            filename = f"overview{ext}"
            dir_path = page_path.rsplit("/overview", 1)[0]
        else:
            filename = f"{page_path.rsplit('/', 1)[-1]}{ext}"
            dir_path = page_path.rsplit("/", 1)[0] if "/" in page_path else ""

        full_path = output_root / dir_path / filename

        if not args.dry_run and not args.json:
            print(f"  Scaffolding {page['template']:30s} -> {full_path}")

        result = scaffold_page(
            scaffold_script,
            template=page["template"],
            fmt=args.format,
            product=args.product,
            output_path=full_path,
            dry_run=args.dry_run,
        )

        results.append(result)
        if result.get("status") == "error":
            errors += 1
            if not args.json:
                print(f"    ERROR: {result.get('error', 'unknown')}")
        else:
            created += 1

    summary = {
        "product": args.product,
        "format": args.format,
        "output": str(output_root),
        "pages_created": created,
        "pages_errored": errors,
        "total_pages": len(pages),
        "include_optional": args.include_optional,
        "use_cases": use_cases,
        "dry_run": args.dry_run,
        "results": results,
    }

    if args.json:
        print(json.dumps(summary, indent=2))
    else:
        prefix = "[DRY RUN] " if args.dry_run else ""
        print(f"\n{prefix}Site scaffold complete:")
        print(f"  Product: {args.product}")
        print(f"  Format: {args.format}")
        print(f"  Output: {output_root}")
        print(f"  Pages created: {created}")
        if errors:
            print(f"  Pages errored: {errors}")

    return 1 if errors > 0 else 0


if __name__ == "__main__":
    sys.exit(main())
