#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.

"""Validate blueprint HTML formats and generated documents with the standard library."""

from __future__ import annotations

import argparse
import json
import re
import sys
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import unquote, urlsplit


REQUIRED_IDS = {
    "task-guide": {
        "title",
        "metadata",
        "prerequisites",
        "procedure",
        "expected-result",
        "troubleshooting",
        "next-steps",
    },
    "concept-guide": {
        "title",
        "overview",
        "mental-model",
        "key-concepts",
        "boundaries",
        "related-tasks",
    },
    "api-reference": {
        "title",
        "endpoint",
        "authentication",
        "parameters",
        "request-example",
        "response",
        "errors",
    },
}
CSS_COMMENT = re.compile(r"/\*.*?\*/", re.DOTALL)
CSS_LINE_CONTINUATION = re.compile(r"\\(?:\r\n|[\n\r\f])")
CSS_IMPORT = re.compile(r"@import\b", re.IGNORECASE)
CSS_ESCAPE = re.compile(r"\\([0-9a-fA-F]{1,6}[ \t\r\n\f]?|.)", re.DOTALL)
CSS_EXTERNAL_REFERENCE = re.compile(
    r"(?:https?|ftp|file|javascript|vbscript)\s*:|//",
    re.IGNORECASE,
)
CSS_URL = re.compile(
    r"url\(\s*(?P<quote>['\"]?)(?P<target>.*?)(?P=quote)\s*\)",
    re.IGNORECASE | re.DOTALL,
)
FORBIDDEN_ELEMENTS = {
    "base",
    "embed",
    "form",
    "iframe",
    "math",
    "object",
    "script",
    "style",
    "svg",
}
AUTO_FETCH_ATTRIBUTES = {
    "audio": {"src"},
    "body": {"background"},
    "img": {"lowsrc", "src", "srcset"},
    "image": {"src", "srcset"},
    "input": {"dynsrc", "lowsrc", "src"},
    "link": {"href"},
    "source": {"src", "srcset"},
    "table": {"background"},
    "td": {"background"},
    "th": {"background"},
    "track": {"src"},
    "video": {"poster", "src"},
}
ALLOWED_LINK_SCHEMES = {"", "http", "https", "mailto"}


class DocumentParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.doc_type: str | None = None
        self.ids: list[str] = []
        self.h1_count = 0
        self.main_count = 0
        self.lang: str | None = None
        self.has_title = False
        self.script_count = 0
        self.event_attributes: list[str] = []
        self.inline_styles: list[str] = []
        self.empty_links: list[str] = []
        self.stylesheet_hrefs: list[str] = []
        self.forbidden_elements: list[str] = []
        self.unsafe_links: list[str] = []
        self.remote_resources: list[str] = []
        self.meta_redirects: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        attributes = dict(attrs)
        if tag in FORBIDDEN_ELEMENTS:
            self.forbidden_elements.append(tag)
        if tag == "html":
            self.doc_type = attributes.get("data-doc-type")
            self.lang = attributes.get("lang")
        if tag == "h1":
            self.h1_count += 1
        if tag == "main":
            self.main_count += 1
        if tag == "title":
            self.has_title = True
        if tag == "script":
            self.script_count += 1
        if "id" in attributes and attributes["id"]:
            self.ids.append(str(attributes["id"]))
        for name in attributes:
            if name.lower().startswith("on"):
                self.event_attributes.append(name)
        if "style" in attributes:
            self.inline_styles.append(tag)
        if tag == "a" and not attributes.get("href"):
            self.empty_links.append(attributes.get("id") or "a")
        if tag == "a" and attributes.get("href"):
            href = str(attributes["href"]).strip()
            parsed = urlsplit(href)
            if href.startswith("//") or parsed.scheme.lower() not in ALLOWED_LINK_SCHEMES:
                self.unsafe_links.append(href)
        if tag == "link" and "stylesheet" in str(attributes.get("rel", "")).lower().split():
            self.stylesheet_hrefs.append(str(attributes.get("href") or ""))
        fetch_attributes = set(AUTO_FETCH_ATTRIBUTES.get(tag, set()))
        if "background" in attributes:
            fetch_attributes.add("background")
        for name in fetch_attributes:
            value = str(attributes.get(name) or "").strip()
            if not value:
                continue
            candidates = value.split(",") if name == "srcset" else [value]
            for candidate in candidates:
                target = candidate.strip().split()[0]
                parsed = urlsplit(target)
                if target.startswith("//") or parsed.netloc or parsed.scheme.lower() in {
                    "http",
                    "https",
                    "ftp",
                    "file",
                }:
                    self.remote_resources.append(target)
        if tag == "meta" and str(attributes.get("http-equiv", "")).lower() == "refresh":
            self.meta_redirects.append(str(attributes.get("content") or ""))


def decode_css_escapes(text: str) -> str:
    """Decode CSS escapes before applying the self-contained asset policy."""

    def replace(match: re.Match[str]) -> str:
        value = match.group(1)
        hexadecimal = value.rstrip(" \t\r\n\f")
        if hexadecimal and all(character in "0123456789abcdefABCDEF" for character in hexadecimal):
            codepoint = int(hexadecimal, 16)
            if codepoint == 0 or codepoint > 0x10FFFF:
                return "\N{REPLACEMENT CHARACTER}"
            return chr(codepoint)
        return value

    return CSS_ESCAPE.sub(replace, text)


def css_dependency_errors(stylesheet_path: Path) -> list[str]:
    """Reject imports and remote URLs while allowing configurable local CSS."""
    try:
        text = stylesheet_path.read_text(encoding="utf-8")
    except OSError as exc:
        return [f"unable to read local stylesheet {stylesheet_path}: {exc}"]

    normalized = CSS_LINE_CONTINUATION.sub("", CSS_COMMENT.sub("", text))
    text_without_comments = decode_css_escapes(normalized)
    errors: list[str] = []
    if CSS_IMPORT.search(text_without_comments):
        errors.append("CSS @import is not allowed; base.css must be self-contained")
    for match in CSS_URL.finditer(text_without_comments):
        target = match.group("target").strip()
        parsed = urlsplit(target)
        if target.startswith("//") or parsed.netloc or (
            parsed.scheme and parsed.scheme.lower() != "data"
        ):
            errors.append(f"remote CSS asset is not allowed: {target}")
    if CSS_EXTERNAL_REFERENCE.search(text_without_comments):
        errors.append("external CSS references are not allowed; base.css must be self-contained")
    return errors


def stylesheet_errors(document_path: Path, hrefs: list[str]) -> list[str]:
    """Return deterministic errors for the self-contained stylesheet contract."""
    if not hrefs:
        return ["document does not link a stylesheet"]

    errors: list[str] = []
    for href in hrefs:
        parsed = urlsplit(href)
        if parsed.scheme or parsed.netloc or href.startswith("//"):
            errors.append(f"remote stylesheet is not allowed: {href}")
            continue
        local_path = unquote(parsed.path)
        if local_path != "base.css":
            errors.append(f"stylesheet must resolve beside the document as base.css: {href}")
            continue
        stylesheet_path = document_path.parent / local_path
        if not stylesheet_path.is_file():
            errors.append(f"stylesheet does not exist beside the document: {href}")
            continue
        errors.extend(css_dependency_errors(stylesheet_path))
    return errors


def _check(checks: list[dict[str, str]], check_id: str, passed: bool, location: str, message: str) -> None:
    checks.append(
        {
            "id": check_id,
            "status": "pass" if passed else "fail",
            "location": location,
            "message": message,
        }
    )


def validate_html(
    path: str | Path,
    expected_type: str | None = None,
    *,
    allow_placeholders: bool = False,
) -> dict[str, object]:
    document_path = Path(path)
    text = document_path.read_text(encoding="utf-8")
    parser = DocumentParser()
    parser.feed(text)

    doc_type = expected_type or parser.doc_type
    checks: list[dict[str, str]] = []
    _check(checks, "html-doctype", text.lstrip().lower().startswith("<!doctype html>"), str(document_path), "Document declares an HTML5 doctype.")
    _check(checks, "html-language", bool(parser.lang), "html", "The root html element declares a language.")
    _check(checks, "html-document-type", doc_type in REQUIRED_IDS and parser.doc_type == doc_type, "html", f"Document type is {doc_type!r}.")
    _check(checks, "html-title", parser.has_title and parser.h1_count == 1, "head/title and h1", "Document has a title element and exactly one h1.")
    _check(checks, "html-main", parser.main_count == 1, "main", "Document has exactly one main element.")

    duplicate_ids = sorted({item for item in parser.ids if parser.ids.count(item) > 1})
    _check(checks, "html-unique-ids", not duplicate_ids, ", ".join(duplicate_ids), "Document element IDs are unique.")

    required = REQUIRED_IDS.get(doc_type or "", set())
    missing = sorted(required.difference(parser.ids))
    _check(checks, "html-required-sections", not missing, ", ".join(missing), "All required semantic sections are present.")
    active_content = (
        parser.forbidden_elements
        + parser.event_attributes
        + parser.inline_styles
        + parser.meta_redirects
    )
    _check(checks, "html-no-scripts", parser.script_count == 0 and not active_content, ", ".join(active_content), "Document contains no active or embedded content, inline styles, scripts, redirects, or event handlers.")
    link_errors = parser.empty_links + parser.unsafe_links
    _check(checks, "html-links", not link_errors, ", ".join(link_errors), "All links declare an allowed href.")
    _check(checks, "html-no-remote-resources", not parser.remote_resources, ", ".join(parser.remote_resources), "Document does not automatically load remote resources.")
    missing_stylesheets = stylesheet_errors(document_path, parser.stylesheet_hrefs)
    _check(
        checks,
        "html-local-stylesheet",
        not missing_stylesheets,
        ", ".join(missing_stylesheets),
        "Document links the local base.css file beside the HTML output.",
    )

    placeholders_present = "{{" in text or "}}" in text
    _check(
        checks,
        "html-no-placeholders",
        allow_placeholders or not placeholders_present,
        str(document_path),
        "Generated document contains no unresolved template placeholders.",
    )

    return {
        "passed": all(item["status"] != "fail" for item in checks),
        "checks": checks,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("path", type=Path)
    parser.add_argument("--document-type", choices=sorted(REQUIRED_IDS))
    parser.add_argument("--allow-placeholders", action="store_true")
    args = parser.parse_args()

    result = validate_html(
        args.path,
        args.document_type,
        allow_placeholders=args.allow_placeholders,
    )
    print(json.dumps(result, indent=2))
    return 0 if result["passed"] else 1


if __name__ == "__main__":
    sys.exit(main())
