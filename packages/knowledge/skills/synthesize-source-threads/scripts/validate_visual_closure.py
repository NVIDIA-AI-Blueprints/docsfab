#!/usr/bin/env python3
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Validate direct governed-visual closure records in one immutable model."""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import re
import sys
from collections import Counter
from pathlib import Path
from typing import Any

import yaml
from markdown_it import MarkdownIt
from yaml.constructor import ConstructorError
from yaml.nodes import MappingNode


TARGET_FIELDS = {
    "visual_id",
    "target_state",
    "conflict_id",
    "required_source_representations",
    "accepted_decision_ids",
    "closure_manifest_source",
}
CLOSURE_FIELDS = {
    "visual_id",
    "artifact_kind",
    "lifecycle_disposition",
    "representation_id",
    "representation_format",
    "content_sha256",
    "source_representations",
    "governing_decision_ids",
    "decision_coverage",
}
SOURCE_FIELDS = {
    "source_thread_id",
    "item_id",
    "version",
    "representation_id",
    "member_id",
    "integrity",
}
COVERAGE_FIELDS = {
    "verification_state",
    "verifier",
    "method",
    "accepted_decisions",
}
DECISION_COVERAGE_FIELDS = {"decision_id", "representation_elements"}
CLOSURE_MANIFEST_FIELDS = {
    "schema_version",
    "visual_id",
    "required_source_representations",
    "accepted_decision_ids",
}
RECEIPT_RECORD_FIELDS = {
    "visual_id",
    "target_state",
    "conflict_id",
    "closure_manifest_source",
    "representation_id",
    "content_sha256",
    "source_representations",
    "governing_decision_ids",
    "coverage_verification",
}
RECEIPT_COVERAGE_FIELDS = {
    "verification_state",
    "verification_result",
    "verifier",
    "method",
}
ARTIFACT_KINDS = {
    "diagram",
    "architecture-view",
    "state-machine",
    "timeline",
    "rendered-representation",
}
REPRESENTATION_FORMATS = {"mermaid", "d2", "dot", "plantuml", "svg"}
TARGET_STATES = {"current", "open", "deferred"}
IDENTIFIER_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")
SHA256_PATTERN = re.compile(r"^sha256:[a-f0-9]{64}$")
FLOWCHART_HEADER_PATTERN = re.compile(r"^(?:flowchart|graph)\s+(?:TB|TD|BT|RL|LR)$")
FLOWCHART_EDGE_PATTERN = re.compile(
    r"<-->|--\s+[^-\n]+?\s+-->|-\.\s+.+?\s+\.->|-\.\s+.+?\s+\.-"
    r"|-->\|[^|\n]+\||-\.->|-\.-|==>|-->|---|~~~"
)
FLOWCHART_STYLE_PATTERN = re.compile(
    r"^style\s+[A-Za-z_][A-Za-z0-9_.-]*(?:,[A-Za-z_][A-Za-z0-9_.-]*)*\s+"
    r"[A-Za-z-]+:[^,\s]+(?:,[A-Za-z-]+:[^,\s]+)*$"
)


class VisualClosureError(Exception):
    """A governed visual target violates the direct-closure contract."""


_CLAIM_CONTRACT_VALIDATOR: Any | None = None


def _claim_contract_validator() -> Any:
    global _CLAIM_CONTRACT_VALIDATOR
    if _CLAIM_CONTRACT_VALIDATOR is not None:
        return _CLAIM_CONTRACT_VALIDATOR
    path = (
        Path(__file__).resolve().parents[2]
        / "converge-documentation/scripts/check_freshness.py"
    )
    spec = importlib.util.spec_from_file_location(
        "docsfab_claim_contract_validator", path
    )
    if spec is None or spec.loader is None:
        raise VisualClosureError(f"cannot load complete claim validator: {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    _CLAIM_CONTRACT_VALIDATOR = module
    return module


class _UniqueKeyLoader(yaml.BaseLoader):
    """Load contract YAML as strings and reject duplicate mapping keys."""


def _construct_mapping(
    loader: _UniqueKeyLoader, node: MappingNode, deep: bool = False
) -> dict[Any, Any]:
    mapping: dict[Any, Any] = {}
    for key_node, value_node in node.value:
        key = loader.construct_object(key_node, deep=deep)
        if key in mapping:
            raise ConstructorError(
                "while constructing a mapping",
                node.start_mark,
                f"found duplicate key {key!r}",
                key_node.start_mark,
            )
        mapping[key] = loader.construct_object(value_node, deep=deep)
    return mapping


_UniqueKeyLoader.add_constructor(
    yaml.resolver.BaseResolver.DEFAULT_MAPPING_TAG,
    _construct_mapping,
)


def _load_mapping(raw: bytes, label: str) -> dict[str, Any]:
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise VisualClosureError(f"{label} is not UTF-8") from exc
    try:
        value = yaml.load(text, Loader=_UniqueKeyLoader)
    except yaml.YAMLError as exc:
        raise VisualClosureError(f"{label} is not valid contract YAML: {exc}") from exc
    if not isinstance(value, dict):
        raise VisualClosureError(f"{label} must be one YAML mapping")
    return value


def _require_exact_fields(value: dict[str, Any], fields: set[str], label: str) -> None:
    missing = sorted(fields - set(value))
    unexpected = sorted(set(value) - fields)
    if missing:
        raise VisualClosureError(f"{label} is missing fields: {', '.join(missing)}")
    if unexpected:
        raise VisualClosureError(
            f"{label} has unsupported fields: {', '.join(unexpected)}"
        )


def _require_string(value: Any, label: str) -> str:
    if not isinstance(value, str) or not value or value in {"null", "~"}:
        raise VisualClosureError(f"{label} must be a non-empty string")
    return value


def _require_identifier(value: Any, label: str) -> str:
    identifier = _require_string(value, label)
    if IDENTIFIER_PATTERN.fullmatch(identifier) is None:
        raise VisualClosureError(f"{label} is not a stable identifier")
    return identifier


def _require_list(value: Any, label: str, *, nonempty: bool) -> list[Any]:
    if not isinstance(value, list) or (nonempty and not value):
        qualifier = "a non-empty" if nonempty else "an"
        raise VisualClosureError(f"{label} must be {qualifier} array")
    return value


def _require_string_list(value: Any, label: str, *, nonempty: bool) -> list[str]:
    entries = _require_list(value, label, nonempty=nonempty)
    strings = [
        _require_string(entry, f"{label}[{index}]")
        for index, entry in enumerate(entries)
    ]
    if len(strings) != len(set(strings)):
        raise VisualClosureError(f"{label} must not contain duplicates")
    return strings


def _source_key(record: dict[str, Any], label: str) -> tuple[str, ...]:
    _require_exact_fields(record, SOURCE_FIELDS, label)
    values = tuple(
        _require_string(record[field], f"{label}.{field}")
        for field in sorted(SOURCE_FIELDS)
    )
    integrity = str(record["integrity"])
    if SHA256_PATTERN.fullmatch(integrity) is None:
        raise VisualClosureError(f"{label}.integrity must be sha256:<lowercase digest>")
    return values


def _source_record(
    source_threads_root: Path, source: dict[str, Any], label: str
) -> tuple[dict[str, Any], Path]:
    _source_key(source, label)
    thread_id = _require_identifier(source["source_thread_id"], f"{label}.source_thread_id")
    item_id = _require_identifier(source["item_id"], f"{label}.item_id")
    representation_id = _require_identifier(
        source["representation_id"], f"{label}.representation_id"
    )
    member_id = _require_string(source["member_id"], f"{label}.member_id")
    thread_root = source_threads_root / thread_id
    item_path = thread_root / "items" / f"{item_id}.json"
    try:
        item = json.loads(item_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise VisualClosureError(f"{label} cannot read registered item {item_path}: {exc}") from exc
    if not isinstance(item, dict):
        raise VisualClosureError(f"{label} registered item must be an object")
    if item.get("item_id") != item_id:
        raise VisualClosureError(f"{label} registered item_id does not match")
    version = item.get("version")
    if not isinstance(version, dict):
        raise VisualClosureError(f"{label} registered item version is malformed")
    version_kind = _require_string(
        version.get("kind"), f"{label} registered version.kind"
    )
    version_value = _require_string(
        version.get("value"), f"{label} registered version.value"
    )
    expected_versions = {version_value, f"{version_kind}:{version_value}"}
    if version_kind == "content-hash":
        expected_versions.add(f"sha256:{version_value}")
    if source["version"] not in expected_versions:
        raise VisualClosureError(f"{label} version does not match the registered item")
    if member_id == "none":
        candidates = item.get("representations")
    else:
        members = item.get("members")
        if not isinstance(members, list):
            raise VisualClosureError(f"{label} registered members are malformed")
        selected = [
            member
            for member in members
            if isinstance(member, dict) and member.get("member_id") == member_id
        ]
        if len(selected) != 1:
            raise VisualClosureError(f"{label} does not resolve member {member_id} exactly once")
        candidates = selected[0].get("representations")
    if not isinstance(candidates, list):
        raise VisualClosureError(f"{label} registered representations are malformed")
    selected_representations = [
        representation
        for representation in candidates
        if isinstance(representation, dict)
        and representation.get("representation_id") == representation_id
    ]
    if len(selected_representations) != 1:
        raise VisualClosureError(
            f"{label} does not resolve representation {representation_id} exactly once"
        )
    representation = selected_representations[0]
    integrity = representation.get("integrity")
    expected_integrity = f"{integrity.get('algorithm')}:{integrity.get('value')}" if isinstance(integrity, dict) else ""
    if expected_integrity != source["integrity"]:
        raise VisualClosureError(f"{label} integrity does not match the registered representation")
    locator = representation.get("locator")
    retained_copy = locator.get("retained_copy") if isinstance(locator, dict) else None
    if not isinstance(retained_copy, str) or not retained_copy:
        raise VisualClosureError(f"{label} closure manifest must be retained source-thread bytes")
    relative = Path(retained_copy)
    if relative.is_absolute() or ".." in relative.parts:
        raise VisualClosureError(f"{label} retained manifest path escapes its source thread")
    artifact_path = thread_root / relative
    try:
        resolved = artifact_path.resolve(strict=True)
        artifact_root = (thread_root / "artifacts").resolve(strict=True)
    except OSError as exc:
        raise VisualClosureError(f"{label} retained manifest does not exist: {exc}") from exc
    if not resolved.is_relative_to(artifact_root) or not resolved.is_file():
        raise VisualClosureError(f"{label} retained manifest escapes artifacts/")
    actual_integrity = f"sha256:{hashlib.sha256(resolved.read_bytes()).hexdigest()}"
    if actual_integrity != source["integrity"]:
        raise VisualClosureError(f"{label} retained manifest checksum does not match")
    return representation, resolved


def _load_closure_manifest(
    source_threads_root: Path, source: dict[str, Any], label: str
) -> dict[str, Any]:
    _, artifact_path = _source_record(source_threads_root, source, label)
    try:
        pairs = json.loads(
            artifact_path.read_text(encoding="utf-8"),
            object_pairs_hook=lambda values: _unique_json_object(values, label),
        )
    except (OSError, json.JSONDecodeError) as exc:
        raise VisualClosureError(f"{label} closure manifest is not valid JSON: {exc}") from exc
    if not isinstance(pairs, dict):
        raise VisualClosureError(f"{label} closure manifest must be one JSON object")
    _require_exact_fields(pairs, CLOSURE_MANIFEST_FIELDS, f"{label} closure manifest")
    if pairs["schema_version"] != "docsfab.knowledge.visual-closure-manifest/v1":
        raise VisualClosureError(f"{label} closure manifest schema_version is unsupported")
    return pairs


def _unique_json_object(values: list[tuple[str, Any]], label: str) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in values:
        if key in result:
            raise VisualClosureError(f"{label} closure manifest has duplicate key {key}")
        result[key] = value
    return result


def _claim_counts(model_history_root: Path) -> Counter[str]:
    counts: Counter[str] = Counter()
    model_paths = sorted(model_history_root.glob("*/model.md"))
    if not model_paths:
        raise VisualClosureError(f"model history has no model.md files: {model_history_root}")
    for model_path in model_paths:
        try:
            model_bytes = model_path.read_bytes()
        except OSError as exc:
            raise VisualClosureError(f"cannot read model history claim source {model_path}: {exc}") from exc
        for heading_id, block in top_level_claim_blocks(
            model_bytes, str(model_path)
        ):
            label = f"{model_path}:{heading_id}"
            try:
                claim = _claim_contract_validator().validate_claim_contract(
                    block,
                    heading_id,
                    label,
                    model_version=model_path.parent.name,
                )
            except Exception as exc:
                raise VisualClosureError(
                    f"{label} is not a complete valid model claim: {exc}"
                ) from exc
            counts[claim["claim_id"]] += 1
    return counts


def _markdown_index(content: bytes, label: str) -> dict[str, list[dict[str, Any]]]:
    try:
        text = content.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise VisualClosureError(f"{label} is not UTF-8 Markdown") from exc
    lines = content.splitlines(keepends=True)
    offsets = [0]
    for line in lines:
        offsets.append(offsets[-1] + len(line))
    headings: list[dict[str, Any]] = []
    fences: list[dict[str, Any]] = []
    paragraphs: list[dict[str, Any]] = []
    tokens = MarkdownIt("commonmark").parse(text)
    for index, token in enumerate(tokens):
        if token.type == "heading_open" and token.map is not None:
            start_line, end_line = token.map
            inline = tokens[index + 1] if index + 1 < len(tokens) else None
            heading_text = inline.content.strip() if inline and inline.type == "inline" else ""
            headings.append(
                {
                    "start": offsets[start_line],
                    "end": offsets[min(end_line, len(lines))],
                    "line": start_line + 1,
                    "level": token.level,
                    "rank": int(token.tag.removeprefix("h")),
                    "text": heading_text,
                }
            )
        if token.type == "paragraph_open" and token.level == 0 and token.map is not None:
            inline = tokens[index + 1] if index + 1 < len(tokens) else None
            if inline and inline.type == "inline":
                paragraphs.append({"text": inline.content.strip()})
        if token.type != "fence" or token.map is None:
            continue
        start_line, end_line = token.map
        markup = token.markup.encode("ascii")
        fence: dict[str, Any] = {
            "start": offsets[start_line],
            "end": offsets[min(end_line, len(lines))],
            "line": start_line + 1,
            "level": token.level,
            "marker": markup[:1],
            "length": len(markup),
            "info": token.info.strip(),
        }
        if token.level == 0:
            if end_line <= start_line + 1 or end_line > len(lines):
                fence["closed"] = False
                fence["content"] = content[offsets[start_line + 1] : offsets[end_line]]
            else:
                closing = lines[end_line - 1].rstrip(b"\r\n")
                marker = re.escape(markup[:1])
                closed = re.fullmatch(
                    rb" {0,3}" + marker + rb"{" + str(len(markup)).encode() + rb",}[ \t]*",
                    closing,
                ) is not None
                fence["closed"] = closed
                body_end = offsets[end_line - 1] if closed else offsets[end_line]
                fence["content"] = content[offsets[start_line + 1] : body_end]
        fences.append(fence)
    return {"headings": headings, "fences": fences, "paragraphs": paragraphs}


def _fence_language(fence: dict[str, Any]) -> str:
    info = fence["info"].split(maxsplit=1)
    return info[0].lower() if info else ""


def top_level_states_no_inconsistencies(content: bytes, label: str) -> bool:
    return any(
        "no inconsistenc" in paragraph["text"].lower()
        for paragraph in _markdown_index(content, label)["paragraphs"]
    )


def top_level_claim_blocks(content: bytes, label: str) -> list[tuple[str, bytes]]:
    index = _markdown_index(content, label)
    all_headings = [heading for heading in index["headings"] if heading["level"] == 0]
    headings = [
        heading
        for heading in all_headings
        if heading["rank"] == 3
        and re.match(r"^CLM-[A-Za-z0-9._-]+\b", heading["text"])
    ]
    records: list[tuple[str, bytes]] = []
    for heading in headings:
        heading_id = re.match(r"^(CLM-[A-Za-z0-9._-]+)\b", heading["text"]).group(1)
        next_heading = min(
            (
                candidate["start"]
                for candidate in all_headings
                if candidate["start"] > heading["start"] and candidate["rank"] <= 3
            ),
            default=len(content),
        )
        blocks = [
            fence
            for fence in index["fences"]
            if fence["level"] == 0
            and fence["info"] == "yaml"
            and heading["end"] <= fence["start"] < next_heading
        ]
        if len(blocks) != 1 or not blocks[0].get("closed"):
            raise VisualClosureError(
                f"{label}:{heading_id} must have exactly one top-level YAML claim record"
            )
        records.append((heading_id, blocks[0]["content"]))
    return records


def top_level_conflict_blocks(content: bytes, label: str) -> list[tuple[str, bytes]]:
    index = _markdown_index(content, label)
    all_headings = [heading for heading in index["headings"] if heading["level"] == 0]
    headings = [
        heading
        for heading in all_headings
        if heading["rank"] == 2
        and re.match(r"^CONFLICT-[A-Za-z0-9._-]+\b", heading["text"])
    ]
    records: list[tuple[str, bytes]] = []
    for heading in headings:
        heading_id = re.match(
            r"^(CONFLICT-[A-Za-z0-9._-]+)\b", heading["text"]
        ).group(1)
        next_heading = min(
            (
                candidate["start"]
                for candidate in all_headings
                if candidate["start"] > heading["start"] and candidate["rank"] <= 2
            ),
            default=len(content),
        )
        blocks = [
            fence
            for fence in index["fences"]
            if fence["level"] == 0
            and fence["info"] == "yaml"
            and heading["end"] <= fence["start"] < next_heading
        ]
        if len(blocks) != 1 or not blocks[0].get("closed"):
            raise VisualClosureError(
                f"{label}:{heading_id} must have exactly one top-level YAML conflict record"
            )
        records.append((heading_id, blocks[0]["content"]))
    return records


def _split_flowchart_statements(line: str, label: str) -> list[str]:
    statements: list[str] = []
    start = 0
    stack: list[str] = []
    quote: str | None = None
    escaped = False
    pairs = {"]": "[", ")": "(", "}": "{"}
    for index, character in enumerate(line):
        if quote is not None:
            if escaped:
                escaped = False
            elif character == "\\":
                escaped = True
            elif character == quote:
                quote = None
            continue
        if character in {'"', "'"}:
            quote = character
        elif character in "[({":
            stack.append(character)
        elif character in "])}":
            if not stack or stack.pop() != pairs[character]:
                raise VisualClosureError(f"{label} has unbalanced node delimiters")
        elif character == ";" and not stack:
            statement = line[start:index].strip()
            if statement:
                statements.append(statement)
            start = index + 1
    if quote is not None or stack:
        raise VisualClosureError(f"{label} has unbalanced quotes or node delimiters")
    final = line[start:].strip()
    if final:
        statements.append(final)
    return statements


def _skip_spaces(statement: str, position: int) -> int:
    while position < len(statement) and statement[position].isspace():
        position += 1
    return position


def _unquoted_delimiters(value: str) -> str:
    result: list[str] = []
    quote: str | None = None
    escaped = False
    for character in value:
        if quote is not None:
            if escaped:
                escaped = False
            elif character == "\\":
                escaped = True
            elif character == quote:
                quote = None
            continue
        if character in {'"', "'"}:
            quote = character
        elif character in "[](){}":
            result.append(character)
    return "".join(result)


def _validate_flowchart_shape(shape: str, label: str) -> None:
    delimiters = _unquoted_delimiters(shape)
    allowed = {
        "[]",
        "[()]",
        "[[]]",
        "()",
        "(())",
        "([])",
        "{}",
    }
    if delimiters not in allowed:
        raise VisualClosureError(f"{label} uses an unsupported node shape")
    visible = re.sub(r"[\[\](){}]", "", shape).strip()
    if not visible or visible in {'""', "''"}:
        raise VisualClosureError(f"{label} uses an empty node shape")


def _consume_flowchart_node(statement: str, position: int, label: str) -> int:
    position = _skip_spaces(statement, position)
    identifier_start = position
    if position >= len(statement) or re.match(r"[A-Za-z_]", statement[position]) is None:
        raise VisualClosureError(f"{label} has an invalid node endpoint")
    position += 1
    while position < len(statement):
        if FLOWCHART_EDGE_PATTERN.match(statement, position) is not None:
            break
        if re.match(r"[A-Za-z0-9_.-]", statement[position]) is None:
            break
        position += 1
    identifier = statement[identifier_start:position]
    reserved = {"end", "flowchart", "graph", "subgraph", "direction"}
    if identifier in reserved or any(identifier.startswith(f"{word}-") for word in reserved):
        raise VisualClosureError(f"{label} uses reserved Mermaid keyword as a node ID")
    position = _skip_spaces(statement, position)
    if position >= len(statement) or statement[position] not in "[({":
        return position
    shape_start = position
    pairs = {"]": "[", ")": "(", "}": "{"}
    stack = [statement[position]]
    position += 1
    quote: str | None = None
    escaped = False
    while position < len(statement) and stack:
        character = statement[position]
        if quote is not None:
            if escaped:
                escaped = False
            elif character == "\\":
                escaped = True
            elif character == quote:
                quote = None
        elif character in {'"', "'"}:
            quote = character
        elif character in "[({":
            stack.append(character)
        elif character in "])}":
            if stack.pop() != pairs[character]:
                raise VisualClosureError(f"{label} has unbalanced node delimiters")
        position += 1
    if quote is not None or stack:
        raise VisualClosureError(f"{label} has an unclosed node shape")
    _validate_flowchart_shape(statement[shape_start:position], label)
    return _skip_spaces(statement, position)


def _consume_flowchart_graph_statement(statement: str, label: str) -> int:
    position = _consume_flowchart_node(statement, 0, label)
    edge_count = 0
    while position < len(statement):
        edge = FLOWCHART_EDGE_PATTERN.match(statement, position)
        if edge is None:
            raise VisualClosureError(f"{label} has unsupported trailing material")
        position = _consume_flowchart_node(statement, edge.end(), label)
        edge_count += 1
    return edge_count


def _validate_mermaid_flowchart(content: bytes, label: str) -> None:
    try:
        text = content.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise VisualClosureError(f"{label} Mermaid content is not UTF-8") from exc
    lines = text.replace("\r\n", "\n").splitlines()
    significant: list[tuple[int, str]] = []
    for index, line in enumerate(lines):
        stripped = line.lstrip()
        if not line.strip():
            continue
        if stripped.startswith("%%{"):
            raise VisualClosureError(
                f"{label} Mermaid line {index + 1} uses an unsupported directive"
            )
        if stripped.startswith("%%"):
            continue
        significant.extend(
            (index + 1, statement)
            for statement in _split_flowchart_statements(
                line, f"{label} Mermaid line {index + 1}"
            )
        )
    if not significant:
        raise VisualClosureError(f"{label} Mermaid content is empty")
    _, header = significant[0]
    if FLOWCHART_HEADER_PATTERN.fullmatch(header) is None:
        raise VisualClosureError(
            f"{label} uses unsupported or malformed Mermaid; expected a flowchart header"
        )
    subgraphs = 0
    edge_count = 0
    statement_count = 0
    for line_number, statement in significant[1:]:
        statement_label = f"{label} Mermaid line {line_number}"
        if statement.startswith("subgraph "):
            declaration = statement.removeprefix("subgraph ").strip()
            if not declaration:
                raise VisualClosureError(f"{statement_label} has an empty subgraph")
            consumed = _consume_flowchart_node(declaration, 0, statement_label)
            if consumed != len(declaration):
                raise VisualClosureError(
                    f"{statement_label} has unsupported trailing subgraph material"
                )
            subgraphs += 1
            statement_count += 1
            continue
        if statement == "end":
            if subgraphs == 0:
                raise VisualClosureError(f"{statement_label} closes no subgraph")
            subgraphs -= 1
            continue
        if re.fullmatch(r"direction\s+(?:TB|TD|BT|RL|LR)", statement):
            if subgraphs == 0:
                raise VisualClosureError(
                    f"{statement_label} direction is outside a subgraph"
                )
            continue
        if FLOWCHART_STYLE_PATTERN.fullmatch(statement):
            statement_count += 1
            continue
        if re.match(r"^(?:classDef|class|style|linkStyle|click)\b", statement):
            raise VisualClosureError(f"{statement_label} has an unsupported directive")
        parsed_edges = _consume_flowchart_graph_statement(statement, statement_label)
        edge_count += parsed_edges
        statement_count += 1
    if subgraphs:
        raise VisualClosureError(f"{label} has {subgraphs} unclosed Mermaid subgraph(s)")
    if statement_count == 0 or edge_count == 0:
        raise VisualClosureError(
            f"{label} Mermaid flowchart must contain at least one valid edge"
        )


def top_level_merge_boundary_block(model_bytes: bytes, label: str) -> bytes:
    index = _markdown_index(model_bytes, label)
    semantic_heading = min(
        (
            heading["start"]
            for heading in index["headings"]
            if heading["level"] == 0 and heading["rank"] >= 2
        ),
        default=len(model_bytes),
    )
    matches = [
        fence
        for fence in index["fences"]
        if fence["level"] == 0
        and fence["info"] == "yaml"
        and fence["start"] < semantic_heading
    ]
    if len(matches) != 1 or not matches[0].get("closed"):
        raise VisualClosureError(
            f"{label} must contain exactly one top-level merge-boundary YAML block"
        )
    return matches[0]["content"]


def _merge_boundary(model_bytes: bytes, label: str) -> dict[str, Any]:
    return _load_mapping(
        top_level_merge_boundary_block(model_bytes, label),
        f"{label} merge boundary",
    )


def _conflicts(report_bytes: bytes, label: str) -> dict[str, dict[str, Any]]:
    records: dict[str, dict[str, Any]] = {}
    for heading_id, block in top_level_conflict_blocks(report_bytes, label):
        record = _load_mapping(
            block, f"{label}:{heading_id} conflict record"
        )
        conflict_id = _require_string(record.get("conflict_id"), f"{label}:{heading_id}.conflict_id")
        if conflict_id != heading_id:
            raise VisualClosureError(
                f"{label}:{heading_id}.conflict_id does not match its heading"
            )
        if conflict_id in records:
            raise VisualClosureError(f"{label} contains duplicate conflict {conflict_id}")
        records[conflict_id] = record
    return records


def _visual_entries(
    model_bytes: bytes, label: str, *, required: bool
) -> list[dict[str, Any]]:
    index = _markdown_index(model_bytes, label)
    all_headings = [heading for heading in index["headings"] if heading["level"] == 0]
    sections = [
        heading
        for heading in all_headings
        if heading["rank"] == 2 and heading["text"] == "Governed Visuals"
    ]
    if not sections and not required:
        rogue = [
            fence
            for fence in index["fences"]
            if _fence_language(fence) in REPRESENTATION_FORMATS
            or fence["info"] == "yaml visual-closure"
        ]
        if rogue:
            raise VisualClosureError(f"{label} has a governed visual fence outside its section")
        return []
    if len(sections) != 1:
        raise VisualClosureError(
            f"{label} must contain exactly one ## Governed Visuals section"
        )
    section_heading = sections[0]
    section_start = section_heading["end"]
    section_end = min(
        (
            heading["start"]
            for heading in all_headings
            if heading["rank"] <= 2 and heading["start"] > section_heading["start"]
        ),
        default=len(model_bytes),
    )
    for fence in index["fences"]:
        governed = (
            _fence_language(fence) in REPRESENTATION_FORMATS
            or fence["info"] == "yaml visual-closure"
        )
        if governed and not (section_start <= fence["start"] < section_end):
            raise VisualClosureError(f"{label} has a governed visual fence outside its section")
    section_fences = [
        fence
        for fence in index["fences"]
        if section_start <= fence["start"] < section_end
    ]
    heading_matches = [
        heading
        for heading in all_headings
        if heading["rank"] == 3 and section_start <= heading["start"] < section_end
    ]
    headings: list[str] = []
    for heading in heading_matches:
        match = re.match(r"^([A-Za-z0-9][A-Za-z0-9._-]*)\b", heading["text"])
        if match is None:
            raise VisualClosureError(f"{label} has a malformed governed visual heading")
        headings.append(match.group(1))
    if len(headings) != len(set(headings)):
        raise VisualClosureError(f"{label} has duplicate governed visual headings")
    if not heading_matches and section_fences:
        raise VisualClosureError(f"{label} Governed Visuals section has rogue fences")
    associated_fence_starts: set[int] = set()
    entries: list[dict[str, Any]] = []
    for heading_index, heading in enumerate(heading_matches):
        start = heading["end"]
        end = (
            heading_matches[heading_index + 1]["start"]
            if heading_index + 1 < len(heading_matches)
            else section_end
        )
        fences = [fence for fence in section_fences if start <= fence["start"] < end]
        associated_fence_starts.update(fence["start"] for fence in fences)
        if len(fences) != 2:
            raise VisualClosureError(
                f"{label}:{headings[heading_index]} must contain exactly one metadata and one direct fence"
            )
        if fences[0]["level"] != 0 or fences[0]["info"] != "yaml visual-closure":
            raise VisualClosureError(
                f"{label}:{headings[heading_index]} first fence must be top-level yaml visual-closure"
            )
        if fences[1]["level"] != 0 or fences[1]["info"] not in REPRESENTATION_FORMATS:
            raise VisualClosureError(
                f"{label}:{headings[heading_index]} second fence is not a top-level supported representation"
            )
        if any(
            not fence.get("closed")
            or fence["marker"] != b"`"
            or fence["length"] != 3
            for fence in fences
        ):
            raise VisualClosureError(
                f"{label}:{headings[heading_index]} closure fences must be closed with exactly three backticks"
            )
        entries.append(
            {
                "heading_id": headings[heading_index],
                "metadata": fences[0],
                "representation": fences[1],
            }
        )
    if associated_fence_starts != {fence["start"] for fence in section_fences}:
        raise VisualClosureError(
            f"{label} Governed Visuals section has rogue fences outside visual headings"
        )
    return entries


def _closure_records(
    model_bytes: bytes, label: str, *, require_section: bool
) -> dict[str, dict[str, Any]]:
    entries = _visual_entries(model_bytes, label, required=require_section)
    if not entries:
        return {}
    records: dict[str, dict[str, Any]] = {}
    for entry in entries:
        heading_id = entry["heading_id"]
        record_label = f"{label}:{heading_id} visual closure"
        record = _load_mapping(entry["metadata"]["content"], record_label)
        _require_exact_fields(record, CLOSURE_FIELDS, record_label)
        visual_id = _require_identifier(record["visual_id"], f"{record_label}.visual_id")
        if visual_id != heading_id:
            raise VisualClosureError(f"{record_label}.visual_id does not match its heading")
        if visual_id in records:
            raise VisualClosureError(f"{label} contains duplicate visual {visual_id}")

        artifact_kind = _require_string(
            record["artifact_kind"], f"{record_label}.artifact_kind"
        )
        if artifact_kind not in ARTIFACT_KINDS:
            raise VisualClosureError(
                f"{record_label}.artifact_kind is unsupported: {artifact_kind}"
            )
        lifecycle = _require_string(
            record["lifecycle_disposition"],
            f"{record_label}.lifecycle_disposition",
        )
        if lifecycle not in {"current", "superseded", "rejected"}:
            raise VisualClosureError(
                f"{record_label}.lifecycle_disposition is unsupported: {lifecycle}"
            )
        _require_identifier(
            record["representation_id"], f"{record_label}.representation_id"
        )
        representation_format = _require_string(
            record["representation_format"],
            f"{record_label}.representation_format",
        )
        fenced_format = entry["representation"]["info"]
        if representation_format != fenced_format:
            raise VisualClosureError(
                f"{record_label}.representation_format does not match its direct fence"
            )
        if artifact_kind == "diagram" and representation_format != "mermaid":
            raise VisualClosureError(
                f"{record_label} diagram representation_format must be mermaid"
            )
        if representation_format not in REPRESENTATION_FORMATS:
            raise VisualClosureError(
                f"{record_label}.representation_format is not a supported rendered format"
            )

        content = entry["representation"]["content"]
        if not content:
            raise VisualClosureError(f"{record_label} direct representation is empty")
        expected_checksum = _require_string(
            record["content_sha256"], f"{record_label}.content_sha256"
        )
        actual_checksum = f"sha256:{hashlib.sha256(content).hexdigest()}"
        if expected_checksum != actual_checksum:
            raise VisualClosureError(
                f"{record_label}.content_sha256 is {expected_checksum}, "
                f"expected {actual_checksum} for the exact fenced content bytes"
            )
        if representation_format == "mermaid":
            _validate_mermaid_flowchart(content, record_label)

        source_records = _require_list(
            record["source_representations"],
            f"{record_label}.source_representations",
            nonempty=True,
        )
        source_keys: list[tuple[str, ...]] = []
        for index, source in enumerate(source_records):
            if not isinstance(source, dict):
                raise VisualClosureError(
                    f"{record_label}.source_representations[{index}] must be a mapping"
                )
            source_keys.append(
                _source_key(
                    source, f"{record_label}.source_representations[{index}]"
                )
            )
        if len(source_keys) != len(set(source_keys)):
            raise VisualClosureError(
                f"{record_label}.source_representations must not contain duplicates"
            )

        governing = _require_string_list(
            record["governing_decision_ids"],
            f"{record_label}.governing_decision_ids",
            nonempty=True,
        )
        for index, decision_id in enumerate(governing):
            _require_identifier(
                decision_id, f"{record_label}.governing_decision_ids[{index}]"
            )

        coverage = record["decision_coverage"]
        if not isinstance(coverage, dict):
            raise VisualClosureError(f"{record_label}.decision_coverage must be a mapping")
        _require_exact_fields(coverage, COVERAGE_FIELDS, f"{record_label}.decision_coverage")
        if coverage["verification_state"] != "verified":
            raise VisualClosureError(
                f"{record_label}.decision_coverage.verification_state must be verified"
            )
        _require_string(coverage["verifier"], f"{record_label}.decision_coverage.verifier")
        _require_string(coverage["method"], f"{record_label}.decision_coverage.method")
        accepted = _require_list(
            coverage["accepted_decisions"],
            f"{record_label}.decision_coverage.accepted_decisions",
            nonempty=True,
        )
        covered_ids: list[str] = []
        for index, decision in enumerate(accepted):
            decision_label = f"{record_label}.decision_coverage.accepted_decisions[{index}]"
            if not isinstance(decision, dict):
                raise VisualClosureError(f"{decision_label} must be a mapping")
            _require_exact_fields(decision, DECISION_COVERAGE_FIELDS, decision_label)
            covered_ids.append(
                _require_identifier(decision["decision_id"], f"{decision_label}.decision_id")
            )
            _require_string_list(
                decision["representation_elements"],
                f"{decision_label}.representation_elements",
                nonempty=True,
            )
        if len(covered_ids) != len(set(covered_ids)):
            raise VisualClosureError(f"{record_label}.decision_coverage has duplicate decisions")
        if set(covered_ids) != set(governing):
            missing = sorted(set(governing) - set(covered_ids))
            extra = sorted(set(covered_ids) - set(governing))
            raise VisualClosureError(
                f"{record_label}.decision_coverage does not exactly cover accepted "
                f"decisions; missing={missing}, extra={extra}"
            )
        record["_source_keys"] = source_keys
        record["_governing_decision_ids"] = governing
        records[visual_id] = record
    heading_ids = {entry["heading_id"] for entry in entries}
    if set(records) != heading_ids:
        raise VisualClosureError(
            f"{label} governed visual headings do not match direct closure records"
        )
    return records


def _receipt_records(receipt_bytes: bytes, label: str) -> dict[str, dict[str, Any]]:
    index = _markdown_index(receipt_bytes, label)
    all_headings = [heading for heading in index["headings"] if heading["level"] == 0]
    sections = [
        heading
        for heading in all_headings
        if heading["rank"] == 2 and re.match(r"^14\.\s+", heading["text"])
    ]
    if len(sections) != 1:
        raise VisualClosureError(
            f"{label} must contain exactly one section 14 visual closure receipt"
        )
    section_heading = sections[0]
    section_end = min(
        (
            heading["start"]
            for heading in all_headings
            if heading["rank"] <= 2 and heading["start"] > section_heading["start"]
        ),
        default=len(receipt_bytes),
    )
    matches = [
        fence
        for fence in index["fences"]
        if fence["level"] == 0
        and fence["info"] == "yaml visual-closure-receipt"
        and section_heading["end"] <= fence["start"] < section_end
    ]
    if len(matches) != 1 or not matches[0].get("closed"):
        raise VisualClosureError(
            f"{label} section 14 requires exactly one top-level visual-closure-receipt block"
        )
    root = _load_mapping(matches[0]["content"], f"{label} section 14 receipt")
    _require_exact_fields(root, {"schema_version", "visual_closures"}, f"{label} section 14 receipt")
    if root["schema_version"] != "docsfab.knowledge.visual-closure-receipt/v1":
        raise VisualClosureError(f"{label} section 14 receipt schema_version is unsupported")
    entries = _require_list(
        root["visual_closures"], f"{label} section 14 receipt.visual_closures", nonempty=True
    )
    records: dict[str, dict[str, Any]] = {}
    for index, entry in enumerate(entries):
        entry_label = f"{label} section 14 receipt.visual_closures[{index}]"
        if not isinstance(entry, dict):
            raise VisualClosureError(f"{entry_label} must be a mapping")
        _require_exact_fields(entry, RECEIPT_RECORD_FIELDS, entry_label)
        visual_id = _require_identifier(entry["visual_id"], f"{entry_label}.visual_id")
        if visual_id in records:
            raise VisualClosureError(f"{label} section 14 has duplicate visual {visual_id}")
        state = _require_string(entry["target_state"], f"{entry_label}.target_state")
        if state not in TARGET_STATES:
            raise VisualClosureError(f"{entry_label}.target_state is unsupported: {state}")
        conflict_id = _require_string(entry["conflict_id"], f"{entry_label}.conflict_id")
        manifest_source = entry["closure_manifest_source"]
        if not isinstance(manifest_source, dict):
            raise VisualClosureError(f"{entry_label}.closure_manifest_source must be a mapping")
        manifest_key = _source_key(manifest_source, f"{entry_label}.closure_manifest_source")
        representation_id = _require_string(
            entry["representation_id"], f"{entry_label}.representation_id"
        )
        content_sha256 = _require_string(
            entry["content_sha256"], f"{entry_label}.content_sha256"
        )
        sources = _require_list(
            entry["source_representations"],
            f"{entry_label}.source_representations",
            nonempty=True,
        )
        source_keys: list[tuple[str, ...]] = []
        for source_index, source in enumerate(sources):
            source_label = f"{entry_label}.source_representations[{source_index}]"
            if not isinstance(source, dict):
                raise VisualClosureError(f"{source_label} must be a mapping")
            source_keys.append(_source_key(source, source_label))
        if len(source_keys) != len(set(source_keys)):
            raise VisualClosureError(f"{entry_label}.source_representations has duplicates")
        decisions = _require_string_list(
            entry["governing_decision_ids"],
            f"{entry_label}.governing_decision_ids",
            nonempty=True,
        )
        coverage = entry["coverage_verification"]
        if not isinstance(coverage, dict):
            raise VisualClosureError(f"{entry_label}.coverage_verification must be a mapping")
        _require_exact_fields(
            coverage, RECEIPT_COVERAGE_FIELDS, f"{entry_label}.coverage_verification"
        )
        for field in (
            "verification_state",
            "verification_result",
            "verifier",
            "method",
        ):
            _require_string(coverage[field], f"{entry_label}.coverage_verification.{field}")
        entry["_manifest_key"] = manifest_key
        entry["_source_keys"] = source_keys
        entry["_decision_ids"] = decisions
        entry["_coverage"] = coverage
        entry["_state"] = state
        entry["_conflict_id"] = conflict_id
        entry["_representation_id"] = representation_id
        entry["_content_sha256"] = content_sha256
        records[visual_id] = entry
    return records


def validate_visual_closure(
    model_path: Path,
    report_path: Path,
    receipt_path: Path,
    source_threads_root: Path,
    model_history_root: Path,
) -> list[dict[str, Any]]:
    """Validate declared visual targets and return their direct closure records."""

    try:
        model_bytes = model_path.read_bytes()
        report_bytes = report_path.read_bytes()
        receipt_bytes = receipt_path.read_bytes()
    except OSError as exc:
        raise VisualClosureError(f"cannot read visual closure inputs: {exc}") from exc
    model_label = str(model_path)
    boundary = _merge_boundary(model_bytes, model_label)
    target_records = _require_list(
        boundary.get("governed_visual_targets"),
        f"{model_label} merge boundary.governed_visual_targets",
        nonempty=True,
    )
    source_items = _require_list(
        boundary.get("source_items"),
        f"{model_label} merge boundary.source_items",
        nonempty=True,
    )
    boundary_sources: set[tuple[str, ...]] = set()
    for index, source in enumerate(source_items):
        if not isinstance(source, dict):
            raise VisualClosureError(
                f"{model_label} merge boundary.source_items[{index}] must be a mapping"
            )
        projected = {field: source.get(field) for field in SOURCE_FIELDS}
        boundary_sources.add(
            _source_key(
                projected, f"{model_label} merge boundary.source_items[{index}]"
            )
        )

    targets: dict[str, dict[str, Any]] = {}
    for index, target in enumerate(target_records):
        target_label = f"{model_label} merge boundary.governed_visual_targets[{index}]"
        if not isinstance(target, dict):
            raise VisualClosureError(f"{target_label} must be a mapping")
        _require_exact_fields(target, TARGET_FIELDS, target_label)
        visual_id = _require_identifier(target["visual_id"], f"{target_label}.visual_id")
        state = _require_string(target["target_state"], f"{target_label}.target_state")
        if state not in TARGET_STATES:
            raise VisualClosureError(f"{target_label}.target_state is unsupported: {state}")
        conflict_id = _require_string(target["conflict_id"], f"{target_label}.conflict_id")
        required_sources = _require_list(
            target["required_source_representations"],
            f"{target_label}.required_source_representations",
            nonempty=True,
        )
        required_source_keys: list[tuple[str, ...]] = []
        for source_index, source in enumerate(required_sources):
            source_label = (
                f"{target_label}.required_source_representations[{source_index}]"
            )
            if not isinstance(source, dict):
                raise VisualClosureError(f"{source_label} must be a mapping")
            required_source_keys.append(_source_key(source, source_label))
        if len(required_source_keys) != len(set(required_source_keys)):
            raise VisualClosureError(
                f"{target_label}.required_source_representations must not contain duplicates"
            )
        unknown_required_sources = sorted(set(required_source_keys) - boundary_sources)
        if unknown_required_sources:
            raise VisualClosureError(
                f"{target_label} requires source representations outside the exact merge boundary"
            )
        accepted_decision_ids = _require_string_list(
            target["accepted_decision_ids"],
            f"{target_label}.accepted_decision_ids",
            nonempty=True,
        )
        for decision_index, decision_id in enumerate(accepted_decision_ids):
            _require_identifier(
                decision_id, f"{target_label}.accepted_decision_ids[{decision_index}]"
            )
        manifest_source = target["closure_manifest_source"]
        if not isinstance(manifest_source, dict):
            raise VisualClosureError(f"{target_label}.closure_manifest_source must be a mapping")
        manifest_key = _source_key(
            manifest_source, f"{target_label}.closure_manifest_source"
        )
        if manifest_key not in boundary_sources:
            raise VisualClosureError(
                f"{target_label}.closure_manifest_source is outside the exact merge boundary"
            )
        manifest = _load_closure_manifest(
            source_threads_root,
            manifest_source,
            f"{target_label}.closure_manifest_source",
        )
        manifest_visual_id = _require_identifier(
            manifest["visual_id"], f"{target_label} closure manifest.visual_id"
        )
        if manifest_visual_id != visual_id:
            raise VisualClosureError(
                f"{target_label} closure manifest visual_id does not match its target"
            )
        manifest_sources = _require_list(
            manifest["required_source_representations"],
            f"{target_label} closure manifest.required_source_representations",
            nonempty=True,
        )
        manifest_source_keys: list[tuple[str, ...]] = []
        for source_index, source in enumerate(manifest_sources):
            source_label = (
                f"{target_label} closure manifest.required_source_representations"
                f"[{source_index}]"
            )
            if not isinstance(source, dict):
                raise VisualClosureError(f"{source_label} must be a mapping")
            manifest_source_keys.append(_source_key(source, source_label))
        manifest_decisions = _require_string_list(
            manifest["accepted_decision_ids"],
            f"{target_label} closure manifest.accepted_decision_ids",
            nonempty=True,
        )
        if set(required_source_keys) != set(manifest_source_keys):
            raise VisualClosureError(
                f"{target_label} required sources do not equal the retained closure manifest"
            )
        if set(accepted_decision_ids) != set(manifest_decisions):
            raise VisualClosureError(
                f"{target_label} accepted decisions do not equal the retained closure manifest"
            )
        if visual_id in targets:
            raise VisualClosureError(f"{model_label} contains duplicate visual target {visual_id}")
        targets[visual_id] = {
            "target_state": state,
            "conflict_id": conflict_id,
            "required_source_keys": required_source_keys,
            "accepted_decision_ids": accepted_decision_ids,
            "manifest_key": manifest_key,
        }

    claim_counts = _claim_counts(model_history_root)
    for visual_id, target in targets.items():
        for decision_id in target["accepted_decision_ids"]:
            if claim_counts[decision_id] != 1:
                raise VisualClosureError(
                    f"{visual_id} accepted decision {decision_id} must resolve to "
                    f"exactly one model claim; found {claim_counts[decision_id]}"
                )

    closures = _closure_records(
        model_bytes,
        model_label,
        require_section=any(
            target["target_state"] == "current" for target in targets.values()
        ),
    )
    conflicts = _conflicts(report_bytes, str(report_path))
    for visual_id, target in targets.items():
        state = target["target_state"]
        conflict_id = target["conflict_id"]
        if state == "current":
            if conflict_id != "none":
                raise VisualClosureError(
                    f"{visual_id} current target must use conflict_id: none"
                )
            closure = closures.get(visual_id)
            if closure is None:
                raise VisualClosureError(
                    f"{visual_id} is current without a direct visual-closure record"
                )
            if closure["lifecycle_disposition"] != "current":
                raise VisualClosureError(
                    f"{visual_id} current target uses a "
                    f"{closure['lifecycle_disposition']} representation"
                )
            actual_sources = set(closure["_source_keys"])
            required_sources = set(target["required_source_keys"])
            if actual_sources != required_sources:
                raise VisualClosureError(
                    f"{visual_id} source representations do not exactly match the target "
                    f"manifest; missing={sorted(required_sources - actual_sources)}, "
                    f"extra={sorted(actual_sources - required_sources)}"
                )
            actual_decisions = set(closure["_governing_decision_ids"])
            required_decisions = set(target["accepted_decision_ids"])
            if actual_decisions != required_decisions:
                raise VisualClosureError(
                    f"{visual_id} governing decisions do not exactly match the target "
                    f"manifest; missing={sorted(required_decisions - actual_decisions)}, "
                    f"extra={sorted(actual_decisions - required_decisions)}"
                )
        else:
            if conflict_id == "none":
                raise VisualClosureError(
                    f"{visual_id} {state} target must name its representation conflict"
                )
            if visual_id in closures:
                raise VisualClosureError(
                    f"{visual_id} has a complete closure record but target_state is {state}"
                )
            conflict = conflicts.get(conflict_id)
            if conflict is None:
                raise VisualClosureError(
                    f"{visual_id} {state} target has no conflict record {conflict_id}"
                )
            if conflict.get("classification") != "representation-conflict":
                raise VisualClosureError(
                    f"{conflict_id} must be classified representation-conflict"
                )
            if conflict.get("status") != state:
                raise VisualClosureError(
                    f"{conflict_id}.status must match target_state {state}"
                )
            blocked = _require_string_list(
                conflict.get("blocks_targets"),
                f"{conflict_id}.blocks_targets",
                nonempty=True,
            )
            if set(blocked) != {visual_id}:
                raise VisualClosureError(
                    f"{conflict_id}.blocks_targets must contain only {visual_id}"
                )

    for conflict_id, conflict in conflicts.items():
        if conflict.get("classification") != "representation-conflict":
            continue
        if conflict.get("status") not in {"open", "deferred"}:
            continue
        blocked = _require_string_list(
            conflict.get("blocks_targets"),
            f"{conflict_id}.blocks_targets",
            nonempty=True,
        )
        if len(blocked) != 1:
            raise VisualClosureError(
                f"{conflict_id}.blocks_targets must contain exactly one governed visual"
            )
        visual_id = blocked[0]
        target = targets.get(visual_id)
        if target is None:
            raise VisualClosureError(
                f"{conflict_id} blocks undeclared governed visual {visual_id}"
            )
        if target["target_state"] == "current":
            raise VisualClosureError(
                f"{visual_id} is current while representation conflict {conflict_id} is open"
            )
        if target["conflict_id"] != conflict_id:
            raise VisualClosureError(
                f"{conflict_id} does not match {visual_id} target conflict"
            )
        if conflict.get("status") != target["target_state"]:
            raise VisualClosureError(
                f"{conflict_id}.status does not match {visual_id} target state"
            )

    undeclared = sorted(set(closures) - set(targets))
    if undeclared:
        raise VisualClosureError(
            f"{model_label} has undeclared visual closure records: {', '.join(undeclared)}"
        )

    receipts = _receipt_records(receipt_bytes, str(receipt_path))
    if set(receipts) != set(targets):
        raise VisualClosureError(
            f"{receipt_path} visual receipt IDs do not match model targets; "
            f"missing={sorted(set(targets) - set(receipts))}, "
            f"extra={sorted(set(receipts) - set(targets))}"
        )
    for visual_id, target in targets.items():
        receipt = receipts[visual_id]
        if receipt["_state"] != target["target_state"]:
            raise VisualClosureError(f"{visual_id} receipt target_state does not match model")
        if receipt["_conflict_id"] != target["conflict_id"]:
            raise VisualClosureError(f"{visual_id} receipt conflict_id does not match model")
        if receipt["_manifest_key"] != target["manifest_key"]:
            raise VisualClosureError(
                f"{visual_id} receipt closure_manifest_source does not match model"
            )
        if set(receipt["_source_keys"]) != set(target["required_source_keys"]):
            raise VisualClosureError(f"{visual_id} receipt sources do not match model")
        if set(receipt["_decision_ids"]) != set(target["accepted_decision_ids"]):
            raise VisualClosureError(f"{visual_id} receipt decisions do not match model")
        if target["target_state"] == "current":
            closure = closures[visual_id]
            if receipt["_representation_id"] != closure["representation_id"]:
                raise VisualClosureError(
                    f"{visual_id} receipt representation_id does not match closure"
                )
            if receipt["_content_sha256"] != closure["content_sha256"]:
                raise VisualClosureError(
                    f"{visual_id} receipt content_sha256 does not match closure"
                )
            coverage = closure["decision_coverage"]
            expected_coverage = {
                "verification_state": coverage["verification_state"],
                "verification_result": "verified",
                "verifier": coverage["verifier"],
                "method": coverage["method"],
            }
            if receipt["_coverage"] != expected_coverage:
                raise VisualClosureError(
                    f"{visual_id} receipt coverage verification does not match closure"
                )
        else:
            if receipt["_representation_id"] != "none" or receipt["_content_sha256"] != "none":
                raise VisualClosureError(
                    f"{visual_id} blocked receipt must not claim representation bytes"
                )
            if receipt["_coverage"] != {
                "verification_state": "blocked",
                "verification_result": "blocked",
                "verifier": "none",
                "method": "none",
            }:
                raise VisualClosureError(
                    f"{visual_id} blocked receipt must record blocked coverage"
                )
    return [closures[visual_id] for visual_id in targets if visual_id in closures]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("model", type=Path)
    parser.add_argument("inconsistency_report", type=Path)
    parser.add_argument("merge_receipt", type=Path)
    parser.add_argument("source_threads_root", type=Path)
    parser.add_argument("model_history_root", type=Path)
    arguments = parser.parse_args()
    try:
        closures = validate_visual_closure(
            arguments.model,
            arguments.inconsistency_report,
            arguments.merge_receipt,
            arguments.source_threads_root,
            arguments.model_history_root,
        )
    except VisualClosureError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    print(f"valid governed visual closure: {len(closures)} current representation(s)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
