#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.

"""Collect deterministic risk signals from Markdown documentation."""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import re
import subprocess
import sys
from urllib.parse import unquote, urlsplit


WORD_RE = re.compile(r"\b[\w'-]+\b", re.UNICODE)
SENTENCE_RE = re.compile(r"[.!?]+(?:\s|$)")
LINK_RE = re.compile(r"(!?)\[([^\]]*)\]\(([^)]+)\)")
HEADING_RE = re.compile(r"^#{1,6}\s+\S", re.MULTILINE)
TODO_RE = re.compile(r"\b(?:TODO|TBD|FIXME|XXX)\b")
FENCE_RE = re.compile(r"^```.*?^```\s*$", re.MULTILINE | re.DOTALL)
INLINE_CODE_RE = re.compile(r"`[^`]*`")
HTML_TAG_RE = re.compile(r"<[^>]+>")
VOWELS = set("aeiouy")


def git_output(repo_hint: Path, *arguments: str) -> str:
    """Return stripped output from a bounded Git command."""
    result = subprocess.run(
        ["git", *arguments],
        cwd=repo_hint,
        text=True,
        capture_output=True,
        check=True,
        timeout=10,
    )
    return result.stdout.strip()


def repository_root(repo_hint: Path) -> Path:
    """Resolve the repository root through Git."""
    return Path(git_output(repo_hint, "rev-parse", "--show-toplevel")).resolve()


def split_frontmatter(text: str) -> tuple[dict[str, str], str]:
    """Return simple scalar frontmatter and Markdown body."""
    lines = text.splitlines()
    if not lines or lines[0].strip() != "---":
        return {}, text

    closing_index = None
    for index, line in enumerate(lines[1:], start=1):
        if line.strip() == "---":
            closing_index = index
            break
    if closing_index is None:
        raise ValueError("Markdown frontmatter opens with --- but never closes")

    metadata: dict[str, str] = {}
    for line in lines[1:closing_index]:
        if ":" not in line:
            continue
        key, value = line.split(":", 1)
        metadata[key.strip()] = value.strip().strip('"\'')
    return metadata, "\n".join(lines[closing_index + 1 :])


def markdown_plain_text(body: str) -> str:
    """Remove common Markdown constructs for approximate readability signals."""
    without_fences = FENCE_RE.sub(" ", body)
    without_code = INLINE_CODE_RE.sub(" ", without_fences)
    without_links = LINK_RE.sub(lambda match: f" {match.group(2)} ", without_code)
    without_html = HTML_TAG_RE.sub(" ", without_links)
    return re.sub(r"[#>*_~|=-]", " ", without_html)


def syllable_count(word: str) -> int:
    """Estimate English syllables for a diagnostic reading-grade signal."""
    letters = re.sub(r"[^a-z]", "", word.lower())
    if not letters:
        return 0

    groups = 0
    previous_was_vowel = False
    for letter in letters:
        is_vowel = letter in VOWELS
        if is_vowel and not previous_was_vowel:
            groups += 1
        previous_was_vowel = is_vowel

    if letters.endswith("e") and groups > 1 and not letters.endswith(("le", "ye")):
        groups -= 1
    return max(1, groups)


def reading_signals(body: str) -> tuple[int, int, float | None]:
    """Return word count, sentence count, and approximate Flesch-Kincaid grade."""
    plain_text = markdown_plain_text(body)
    words = WORD_RE.findall(plain_text)
    sentence_count = len(SENTENCE_RE.findall(plain_text))
    if words and sentence_count == 0:
        sentence_count = 1
    if not words or sentence_count == 0:
        return len(words), sentence_count, None

    syllables = sum(syllable_count(word) for word in words)
    grade = 0.39 * (len(words) / sentence_count)
    grade += 11.8 * (syllables / len(words)) - 15.59
    return len(words), sentence_count, round(max(0.0, grade), 2)


def link_target(raw_target: str) -> str:
    """Remove an optional Markdown link title from a target."""
    target = raw_target.strip()
    if target.startswith("<") and ">" in target:
        return target[1 : target.index(">")]
    return target.split(maxsplit=1)[0]


def candidate_exists(candidate: Path) -> bool:
    """Return whether a relative documentation locator resolves to a file."""
    if candidate.is_file():
        return True
    if candidate.is_dir() and any(
        (candidate / filename).is_file() for filename in ("README.md", "index.md")
    ):
        return True
    if not candidate.suffix and candidate.with_suffix(".md").is_file():
        return True
    return False


def analyze_links(
    body: str, source_path: Path, repo_root: Path
) -> tuple[int, int, list[str], list[str]]:
    """Return link counts plus broken and unverifiable local locators."""
    targets = [link_target(match.group(3)) for match in LINK_RE.finditer(body)]
    relative_count = 0
    broken: list[str] = []
    unverifiable: list[str] = []

    for target in targets:
        if not target or target.startswith("#"):
            continue
        parsed = urlsplit(target)
        if parsed.scheme or parsed.netloc:
            continue
        if target.startswith("/") or "{" in target or "}" in target:
            unverifiable.append(target)
            continue

        relative_count += 1
        decoded_path = unquote(parsed.path)
        if not decoded_path:
            continue
        candidate = (source_path.parent / decoded_path).resolve()
        if not candidate.is_relative_to(repo_root):
            unverifiable.append(target)
            continue
        if not candidate_exists(candidate):
            broken.append(target)

    return len(targets), relative_count, sorted(set(broken)), sorted(set(unverifiable))


def analyze_file(path: Path, repo_root: Path) -> tuple[dict[str, object], int]:
    """Collect deterministic signals for one Markdown file."""
    text = path.read_text(encoding="utf-8")
    metadata, body = split_frontmatter(text)
    h1_count = len(re.findall(r"^#\s+\S", body, re.MULTILINE))
    if metadata.get("title"):
        title_source = "frontmatter"
    elif h1_count:
        title_source = "markdown-h1"
    else:
        title_source = "missing"

    word_count, sentence_count, reading_grade = reading_signals(body)
    link_count, relative_count, broken, unverifiable = analyze_links(
        body, path, repo_root
    )
    result: dict[str, object] = {
        "path": path.relative_to(repo_root).as_posix(),
        "word_count": word_count,
        "sentence_count": sentence_count,
        "flesch_kincaid_grade": reading_grade,
        "heading_count": len(HEADING_RE.findall(body)),
        "link_count": link_count,
        "broken_relative_links": broken,
        "unverifiable_links": unverifiable,
        "code_fence_count": len(re.findall(r"^```", body, re.MULTILINE)) // 2,
        "todo_marker_count": len(TODO_RE.findall(body)),
        "title_source": title_source,
        "duplicate_h1_after_frontmatter": bool(metadata.get("title") and h1_count),
    }
    return result, relative_count


def documentation_files(documentation_root: Path) -> list[Path]:
    """Return the Markdown files within the requested target."""
    if documentation_root.is_file():
        if documentation_root.suffix.lower() != ".md":
            raise ValueError("The documentation file must use the .md suffix")
        return [documentation_root]
    if not documentation_root.is_dir():
        raise ValueError(f"Documentation target does not exist: {documentation_root}")
    return sorted(
        path.resolve()
        for path in documentation_root.rglob("*.md")
        if path.is_file()
    )


def content_hash(paths: list[Path], repo_root: Path) -> str:
    """Hash path names and bytes for the evaluated documentation population."""
    digest = hashlib.sha256()
    for path in paths:
        relative = path.relative_to(repo_root).as_posix().encode("utf-8")
        digest.update(len(relative).to_bytes(8, "big"))
        digest.update(relative)
        content = path.read_bytes()
        digest.update(len(content).to_bytes(8, "big"))
        digest.update(content)
    return f"sha256:{digest.hexdigest()}"


def collect(repo_hint: Path, docs_argument: str) -> dict[str, object]:
    """Collect a repository-bound Markdown signal report."""
    repo_root = repository_root(repo_hint)
    documentation_root = Path(docs_argument)
    if not documentation_root.is_absolute():
        documentation_root = repo_root / documentation_root
    documentation_root = documentation_root.resolve()
    if not documentation_root.is_relative_to(repo_root):
        raise ValueError("Documentation target must be inside the Git repository")

    paths = documentation_files(documentation_root)
    file_results: list[dict[str, object]] = []
    relative_link_count = 0
    for path in paths:
        result, file_relative_links = analyze_file(path, repo_root)
        file_results.append(result)
        relative_link_count += file_relative_links

    grades = [
        result["flesch_kincaid_grade"]
        for result in file_results
        if isinstance(result["flesch_kincaid_grade"], float)
    ]
    mean_grade = round(sum(grades) / len(grades), 2) if grades else None
    return {
        "schema_version": "doc-quality-signals-v0.1",
        "collected_at": datetime.now(timezone.utc).isoformat(),
        "repository_revision": git_output(repo_root, "rev-parse", "HEAD"),
        "documentation_content_hash": content_hash(paths, repo_root),
        "worktree_dirty": bool(
            git_output(
                repo_root,
                "status",
                "--porcelain",
                "--",
                documentation_root.relative_to(repo_root).as_posix(),
            )
        ),
        "documentation_root": documentation_root.relative_to(repo_root).as_posix(),
        "files": file_results,
        "totals": {
            "document_count": len(file_results),
            "word_count": sum(int(result["word_count"]) for result in file_results),
            "mean_flesch_kincaid_grade": mean_grade,
            "relative_link_count": relative_link_count,
            "broken_relative_link_count": sum(
                len(result["broken_relative_links"]) for result in file_results
            ),
            "unverifiable_link_count": sum(
                len(result["unverifiable_links"]) for result in file_results
            ),
            "todo_marker_count": sum(
                int(result["todo_marker_count"]) for result in file_results
            ),
            "missing_title_count": sum(
                result["title_source"] == "missing" for result in file_results
            ),
            "duplicate_h1_count": sum(
                bool(result["duplicate_h1_after_frontmatter"])
                for result in file_results
            ),
        },
        "limitations": [
            "These deterministic signals do not establish factual accuracy, scoped completeness, comprehension, mental-model transfer, findability, or task success.",
            "Flesch-Kincaid grade is an English-language surface heuristic and is not proof of clarity or audience understanding.",
            "Absolute routes, templated links, anchors, and external URLs require delivery-surface checks and are not resolved by this collector.",
        ],
    }


def parse_args() -> argparse.Namespace:
    """Parse command-line arguments."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--docs",
        default="docs",
        help="Repository-relative Markdown file or directory (default: docs)",
    )
    parser.add_argument(
        "--output",
        default="-",
        help="Output JSON path, or - for stdout (default: -)",
    )
    return parser.parse_args()


def main() -> int:
    """Run the signal collector."""
    args = parse_args()
    report = collect(Path.cwd(), args.docs)
    serialized = json.dumps(report, indent=2, sort_keys=True) + "\n"
    if args.output == "-":
        sys.stdout.write(serialized)
    else:
        output_path = Path(args.output)
        if not output_path.is_absolute():
            output_path = repository_root(Path.cwd()) / output_path
        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_text(serialized, encoding="utf-8")
    return 0


if __name__ == "__main__":
    sys.exit(main())
