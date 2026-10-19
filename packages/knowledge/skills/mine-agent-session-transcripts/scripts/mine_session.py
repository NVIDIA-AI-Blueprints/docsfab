#!/usr/bin/env python3
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Mine provenance-preserving human evidence candidates from agent sessions."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from collections import Counter
from datetime import datetime
from pathlib import Path
from typing import Any, Iterable


SCHEMA_CANDIDATE = "docsfab.knowledge.transcript-candidate/v1"
SCHEMA_SELECTION = "docsfab.knowledge.transcript-selection/v1"
CLAUDE_ADAPTER_NAME = "claude-code-jsonl"
CODEX_ADAPTER_NAME = "codex-rollout-jsonl"
SUPPORTED_ADAPTERS = (CLAUDE_ADAPTER_NAME, CODEX_ADAPTER_NAME)
ADAPTER_VERSIONS = {
    CLAUDE_ADAPTER_NAME: "1",
    CODEX_ADAPTER_NAME: "1",
}

SYNTHETIC_PREFIXES = (
    "<task-notification>",
    "<local-command",
    "<command-",
    "<local-command-stdout>",
    "This session is being continued",
    "[bert dispatch]",
    "[Image:",
    "Base directory for this skill:",
    "# /loop",
    "<agent-message",
    "Another Claude session sent a message:",
    "<recommended_plugins>",
    "<codex_internal_context",
    "# AGENTS.md instructions for ",
    "<environment_context>",
)

SYNTHETIC_FULL_PATTERNS = (
    re.compile(r"^warmup\s*$", re.IGNORECASE),
    re.compile(r"^Continue from where you left off\.?\s*$", re.IGNORECASE),
    re.compile(r"^You have \d+(?:\.\d+)? weighted tokens left", re.IGNORECASE),
)

SENSITIVE_PATTERNS = (
    ("authorization-bearer", re.compile(r"authorization\s*:\s*bearer\s+\S+", re.IGNORECASE)),
    ("private-key", re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----")),
    ("known-token-prefix", re.compile(r"\b(?:glpat|ghp|github_pat|sk-proj|nvapi)-?[A-Za-z0-9_\-]{12,}\b")),
    (
        "assigned-secret",
        re.compile(
            r"\b(?:api[_ -]?key|access[_ -]?token|auth[_ -]?token|password|secret)"
            r"\s*[:=]\s*[\"']?[^\s\"']{8,}",
            re.IGNORECASE,
        ),
    ),
    ("signed-url", re.compile(r"[?&](?:token|signature|sig|x-amz-signature)=[^&\s]+", re.IGNORECASE)),
)


class MiningError(RuntimeError):
    """Raised when transcript evidence cannot be processed safely."""


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def sha256_text(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def parse_time(value: str | None, label: str) -> datetime | None:
    if value is None:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise MiningError(f"Invalid {label} timestamp {value!r}: {exc}") from exc
    if parsed.tzinfo is None:
        raise MiningError(f"{label} timestamp must include a timezone: {value!r}")
    return parsed


def claude_event_text(event: dict[str, Any]) -> tuple[str | None, str]:
    message = event.get("message")
    if not isinstance(message, dict) or message.get("role") != "user":
        return None, "none"
    content = message.get("content")
    if isinstance(content, str):
        text = content
    elif isinstance(content, list):
        blocks = [
            block.get("text")
            for block in content
            if isinstance(block, dict)
            and block.get("type") == "text"
            and isinstance(block.get("text"), str)
        ]
        text = "\n\n".join(blocks)
    else:
        return None, "none"
    if not text.strip():
        return None, "none"

    return strip_leading_system_instruction(text)


def codex_event_text(event: dict[str, Any]) -> tuple[str | None, str]:
    if event.get("type") != "response_item":
        return None, "none"
    payload = event.get("payload")
    if (
        not isinstance(payload, dict)
        or payload.get("type") != "message"
        or payload.get("role") != "user"
    ):
        return None, "none"
    content = payload.get("content")
    if not isinstance(content, list):
        return None, "none"
    blocks = [
        block.get("text")
        for block in content
        if isinstance(block, dict)
        and block.get("type") == "input_text"
        and isinstance(block.get("text"), str)
    ]
    if not blocks:
        return None, "none"
    text = "\n\n".join(blocks)
    if not text.strip():
        return None, "none"
    return strip_leading_system_instruction(text)


def strip_leading_system_instruction(text: str) -> tuple[str, str]:
    stripped = text.lstrip()
    if stripped.startswith("<system_instruction>"):
        close = stripped.find("</system_instruction>")
        if close == -1:
            return text, "unclosed-system-instruction"
        remainder = stripped[close + len("</system_instruction>") :].strip()
        if remainder:
            return remainder, "stripped-leading-system-instruction"
        return text, "system-instruction-only"
    return text, "none"


def detect_adapter(path: Path) -> str:
    with path.open("r", encoding="utf-8") as stream:
        for line_number, raw_line in enumerate(stream, start=1):
            try:
                event = json.loads(raw_line)
            except json.JSONDecodeError as exc:
                raise MiningError(f"Invalid JSON at {path}:{line_number}: {exc}") from exc
            if not isinstance(event, dict):
                continue
            if event.get("type") == "session_meta" and isinstance(event.get("payload"), dict):
                return CODEX_ADAPTER_NAME
            if isinstance(event.get("sessionId"), str) and event.get("type") in {
                "user",
                "assistant",
            }:
                return CLAUDE_ADAPTER_NAME
    raise MiningError(f"Unable to detect a supported session format: {path}")


def resolve_adapter(path: Path, requested_adapter: str | None) -> str:
    detected = detect_adapter(path)
    if requested_adapter is None or requested_adapter == "auto":
        return detected
    if requested_adapter not in SUPPORTED_ADAPTERS:
        raise MiningError(f"Unsupported session format: {requested_adapter}")
    if requested_adapter != detected:
        raise MiningError(
            f"Requested session format {requested_adapter} does not match detected format {detected}"
        )
    return detected


def codex_session_id(event: dict[str, Any], path: Path, line_number: int) -> str | None:
    if event.get("type") != "session_meta":
        return None
    payload = event.get("payload")
    if not isinstance(payload, dict):
        raise MiningError(f"Invalid Codex session metadata at {path}:{line_number}")
    session_id = payload.get("id") or payload.get("session_id")
    if not isinstance(session_id, str) or not session_id:
        raise MiningError(f"Missing Codex session ID at {path}:{line_number}")
    return session_id


def synthetic_prefixes(extra: Iterable[str] = ()) -> tuple[str, ...]:
    """The built-in harness markers plus the operator's own.

    A deployment's dispatcher or control plane can inject messages under its
    own marker, which only the operator knows. An empty marker would match
    every message, so it refuses rather than marking everything synthetic.
    A message is matched after its leading whitespace is stripped, so a marker
    that starts with whitespace could never match and refuses too.
    """
    added = tuple(extra)
    for prefix in added:
        if not prefix.strip():
            raise MiningError("--synthetic-prefix must name a non-blank marker")
        if prefix != prefix.lstrip():
            raise MiningError(
                f"--synthetic-prefix {prefix!r} starts with whitespace, which no message can match"
            )
    return SYNTHETIC_PREFIXES + added


def classify_origin(
    text: str, transform: str, prefixes: tuple[str, ...] = SYNTHETIC_PREFIXES
) -> tuple[str, list[str]]:
    stripped = text.strip()
    reasons: list[str] = []
    if transform == "system-instruction-only":
        return "synthetic", ["system-instruction-only"]
    if transform == "unclosed-system-instruction":
        return "ambiguous", ["unclosed-system-instruction"]
    for prefix in prefixes:
        if stripped.startswith(prefix):
            reasons.append(f"synthetic-prefix:{prefix}")
    for pattern in SYNTHETIC_FULL_PATTERNS:
        if pattern.search(stripped):
            reasons.append(f"synthetic-pattern:{pattern.pattern}")
    if reasons:
        return "synthetic", reasons
    if transform == "stripped-leading-system-instruction":
        return "likely-human", ["human-text-after-system-wrapper"]
    return "likely-human", []


def sensitive_flags(text: str) -> list[str]:
    return [name for name, pattern in SENSITIVE_PATTERNS if pattern.search(text)]


def iter_candidates(
    path: Path,
    after: datetime | None,
    before: datetime | None,
    requested_adapter: str | None = None,
    extra_synthetic_prefixes: Iterable[str] = (),
) -> Iterable[dict[str, Any]]:
    prefixes = synthetic_prefixes(extra_synthetic_prefixes)
    source_digest = sha256_file(path)
    source_size = path.stat().st_size
    adapter_name = resolve_adapter(path, requested_adapter)
    adapter_version = ADAPTER_VERSIONS[adapter_name]
    observed_session_ids: set[str] = set()
    first_candidates: dict[tuple[str, str], str] = {}
    with path.open("r", encoding="utf-8") as stream:
        for line_number, raw_line in enumerate(stream, start=1):
            try:
                event = json.loads(raw_line)
            except json.JSONDecodeError as exc:
                raise MiningError(f"Invalid JSON at {path}:{line_number}: {exc}") from exc
            if not isinstance(event, dict):
                continue
            if adapter_name == CODEX_ADAPTER_NAME:
                metadata_session_id = codex_session_id(event, path, line_number)
                if metadata_session_id is not None:
                    observed_session_ids.add(metadata_session_id)
                    if len(observed_session_ids) > 1:
                        raise MiningError(
                            f"Multiple session IDs found in one transcript: {sorted(observed_session_ids)}"
                        )
                text, transform = codex_event_text(event)
                if text is None:
                    continue
                if len(observed_session_ids) != 1:
                    raise MiningError(
                        f"Codex user event precedes authoritative session metadata at {path}:{line_number}"
                    )
                session_id = next(iter(observed_session_ids))
                event_id = None
                candidate_prefix = "codex"
            else:
                if event.get("type") != "user":
                    continue
                text, transform = claude_event_text(event)
                if text is None:
                    continue
                session_id = event.get("sessionId")
                if not isinstance(session_id, str) or not session_id:
                    raise MiningError(f"Missing sessionId for user event at {path}:{line_number}")
                observed_session_ids.add(session_id)
                if len(observed_session_ids) > 1:
                    raise MiningError(
                        f"Multiple session IDs found in one transcript: {sorted(observed_session_ids)}"
                    )
                event_id = event.get("uuid")
                candidate_prefix = "claude"
            timestamp = event.get("timestamp")
            parsed_timestamp = parse_time(timestamp, f"event at line {line_number}") if timestamp else None
            if after is not None and (parsed_timestamp is None or parsed_timestamp < after):
                continue
            if before is not None and (parsed_timestamp is None or parsed_timestamp > before):
                continue
            origin_class, reasons = classify_origin(text, transform, prefixes)
            flags = sensitive_flags(text)
            candidate_id = f"{candidate_prefix}:{session_id}:line:{line_number}"
            if isinstance(event_id, str) and event_id:
                duplicate_key = ("event-id", event_id)
            else:
                duplicate_key = ("timestamp-text", f"{timestamp}:{sha256_text(text)}")
            duplicate_of = first_candidates.get(duplicate_key)
            if duplicate_of is None:
                first_candidates[duplicate_key] = candidate_id
            yield {
                "schema_version": SCHEMA_CANDIDATE,
                "candidate_id": candidate_id,
                "source": {
                    "format": adapter_name,
                    "adapter_version": adapter_version,
                    "path": str(path.resolve()),
                    "sha256": source_digest,
                    "size_bytes": source_size,
                    "session_id": session_id,
                },
                "anchor": {
                    "line_number": line_number,
                    "event_id": event_id,
                    "timestamp": timestamp,
                },
                "authorship": {
                    "event_role": "user",
                    "origin_class": origin_class,
                    "classification_reasons": reasons,
                },
                "text": None if flags else text,
                "text_sha256": sha256_text(text),
                "text_length": len(text),
                "text_transform": transform,
                "sensitive_flags": flags,
                "duplicate_of": duplicate_of,
            }


def write_jsonl(path: Path, records: Iterable[dict[str, Any]]) -> Counter[str]:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary_path = path.with_name(f".{path.name}.partial")
    if temporary_path.exists():
        raise MiningError(f"Refusing to overwrite partial candidate output: {temporary_path}")
    counts: Counter[str] = Counter()
    try:
        with temporary_path.open("x", encoding="utf-8") as stream:
            for record in records:
                stream.write(json.dumps(record, ensure_ascii=False, sort_keys=True) + "\n")
                counts[record["authorship"]["origin_class"]] += 1
                if record["sensitive_flags"]:
                    counts["sensitive"] += 1
                if record["duplicate_of"]:
                    counts["duplicate"] += 1
        temporary_path.replace(path)
    except Exception:
        if temporary_path.exists():
            temporary_path.unlink()
        raise
    return counts


def load_candidates(path: Path) -> tuple[dict[str, dict[str, Any]], dict[str, Any]]:
    candidates: dict[str, dict[str, Any]] = {}
    source: dict[str, Any] | None = None
    with path.open("r", encoding="utf-8") as stream:
        for line_number, raw_line in enumerate(stream, start=1):
            try:
                candidate = json.loads(raw_line)
            except json.JSONDecodeError as exc:
                raise MiningError(f"Invalid candidate JSON at {path}:{line_number}: {exc}") from exc
            if candidate.get("schema_version") != SCHEMA_CANDIDATE:
                raise MiningError(f"Unexpected candidate schema at {path}:{line_number}")
            candidate_id = candidate.get("candidate_id")
            if not isinstance(candidate_id, str) or candidate_id in candidates:
                raise MiningError(f"Missing or duplicate candidate ID at {path}:{line_number}")
            if source is None:
                source = candidate["source"]
            elif candidate["source"] != source:
                raise MiningError(f"Candidate source identity changed at {path}:{line_number}")
            candidates[candidate_id] = candidate
    if source is None:
        raise MiningError(f"No candidates found in {path}")
    return candidates, source


def load_selection(path: Path) -> dict[str, Any]:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise MiningError(f"Invalid selection JSON in {path}: {exc}") from exc
    if data.get("schema_version") != SCHEMA_SELECTION:
        raise MiningError(f"Unexpected selection schema in {path}")
    if not isinstance(data.get("title"), str) or not data["title"]:
        raise MiningError(f"Selection title is required in {path}")
    if not isinstance(data.get("selections"), list) or not data["selections"]:
        raise MiningError(f"At least one selection is required in {path}")
    return data


def quote_markdown(text: str) -> str:
    return "\n".join(f"> {line}" if line else ">" for line in text.splitlines())


def render_artifact(candidates_path: Path, selection_path: Path, output_path: Path) -> None:
    candidates, source = load_candidates(candidates_path)
    selection = load_selection(selection_path)
    if selection.get("source_sha256") != source["sha256"]:
        raise MiningError("Selection source_sha256 does not match candidate source")

    selected: list[tuple[dict[str, Any], dict[str, Any]]] = []
    seen_candidates: set[str] = set()
    seen_evidence_ids: set[str] = set()
    previous_line = 0
    for entry in selection["selections"]:
        if not isinstance(entry, dict):
            raise MiningError("Every selection entry must be an object")
        candidate_id = entry.get("candidate_id")
        evidence_id = entry.get("evidence_id")
        if not isinstance(candidate_id, str) or candidate_id in seen_candidates:
            raise MiningError(f"Missing or duplicate selected candidate: {candidate_id!r}")
        if not isinstance(evidence_id, str) or evidence_id in seen_evidence_ids:
            raise MiningError(f"Missing or duplicate evidence ID: {evidence_id!r}")
        candidate = candidates.get(candidate_id)
        if candidate is None:
            raise MiningError(f"Selected candidate does not exist: {candidate_id}")
        origin_class = candidate["authorship"]["origin_class"]
        if origin_class == "synthetic":
            raise MiningError(f"Synthetic candidate cannot be retained: {candidate_id}")
        if origin_class == "ambiguous" and not entry.get("authorship_review_note"):
            raise MiningError(f"Ambiguous candidate needs authorship_review_note: {candidate_id}")
        if candidate["sensitive_flags"] or candidate["text"] is None:
            raise MiningError(f"Sensitive candidate cannot be retained: {candidate_id}")
        if candidate.get("duplicate_of"):
            raise MiningError(
                f"Duplicated candidate cannot be retained; select its first occurrence "
                f"{candidate['duplicate_of']}: {candidate_id}"
            )
        current_line = candidate["anchor"]["line_number"]
        if current_line <= previous_line:
            raise MiningError("Selections must be ordered by increasing source line")
        previous_line = current_line
        seen_candidates.add(candidate_id)
        seen_evidence_ids.add(evidence_id)
        selected.append((entry, candidate))

    scope = selection.get("selection_scope", {})
    lines = [
        f"# {selection['title']}",
        "",
        "> Evidence artifact: curated verbatim excerpts, not a summary or shared model.",
        "",
        "## Provenance",
        "",
        f"- Source format: `{source['format']}` adapter v{source['adapter_version']}",
        f"- Source session: `{source['session_id']}`",
        f"- Governed source locator: `{source['path']}`",
        f"- Source SHA-256: `{source['sha256']}`",
        f"- Source size: {source['size_bytes']} bytes",
        f"- Participant: {scope.get('participant', 'not stated')}",
        f"- Selection range: {scope.get('time_range', 'not stated')}",
        f"- Requested model regions: {', '.join(scope.get('model_regions', [])) or 'not stated'}",
        f"- Selected statements: {len(selected)}",
        "",
        "Topic labels and selection notes below are collector metadata. Only the",
        "block-quoted text is participant evidence. Source-line anchors are valid",
        "only with the source hash above.",
    ]
    for entry, candidate in selected:
        anchor = candidate["anchor"]
        lines.extend(
            [
                "",
                f"## {entry['evidence_id']} — {entry.get('heading', 'Untitled evidence')}",
                "",
                f"- Timestamp: `{anchor.get('timestamp')}`",
                f"- Source line: `{anchor['line_number']}`",
                f"- Source event: `{anchor.get('event_id')}`",
                f"- Model regions: {', '.join(entry.get('model_regions', [])) or 'not stated'}",
                f"- Topics: {', '.join(entry.get('topics', [])) or 'not stated'}",
                f"- Selection note: {entry.get('selection_note', 'not stated')}",
                f"- Text transform: `{candidate['text_transform']}`",
            ]
        )
        if entry.get("authorship_review_note"):
            lines.append(f"- Authorship review: {entry['authorship_review_note']}")
        lines.extend(["", quote_markdown(candidate["text"])])

    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def inventory(path: Path, requested_adapter: str | None = None) -> dict[str, Any]:
    source_digest = sha256_file(path)
    source_size = path.stat().st_size
    counts: Counter[str] = Counter()
    timestamps: list[str] = []
    session_ids: set[str] = set()
    source_identity: dict[str, Any] | None = None
    for candidate in iter_candidates(path, None, None, requested_adapter):
        if source_identity is None:
            source_identity = candidate["source"]
        counts[candidate["authorship"]["origin_class"]] += 1
        if candidate["sensitive_flags"]:
            counts["sensitive"] += 1
        if candidate["duplicate_of"]:
            counts["duplicate"] += 1
        timestamp = candidate["anchor"].get("timestamp")
        if timestamp:
            timestamps.append(timestamp)
        session_ids.add(candidate["source"]["session_id"])
    if source_identity is None or len(session_ids) != 1:
        raise MiningError(f"Expected one session ID, found {sorted(session_ids)}")
    if sha256_file(path) != source_digest or path.stat().st_size != source_size:
        raise MiningError(f"Session changed while it was being inventoried: {path}")
    return {
        "format": source_identity["format"],
        "adapter_version": source_identity["adapter_version"],
        "path": str(path.resolve()),
        "sha256": source_digest,
        "size_bytes": source_size,
        "session_id": next(iter(session_ids)),
        "first_text_user_event": min(timestamps) if timestamps else None,
        "last_text_user_event": max(timestamps) if timestamps else None,
        "candidate_counts": dict(sorted(counts.items())),
    }


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)

    inventory_parser = subparsers.add_parser("inventory", help="Inventory an agent-session JSONL file")
    inventory_parser.add_argument("session", type=Path)
    inventory_parser.add_argument(
        "--format",
        choices=("auto", *SUPPORTED_ADAPTERS),
        default="auto",
        help="Session format; defaults to deterministic detection",
    )

    extract_parser = subparsers.add_parser("extract", help="Extract auditable user-message candidates")
    extract_parser.add_argument("session", type=Path)
    extract_parser.add_argument("--after", help="Inclusive ISO-8601 lower timestamp bound")
    extract_parser.add_argument("--before", help="Inclusive ISO-8601 upper timestamp bound")
    extract_parser.add_argument(
        "--format",
        choices=("auto", *SUPPORTED_ADAPTERS),
        default="auto",
        help="Session format; defaults to deterministic detection",
    )
    extract_parser.add_argument(
        "--synthetic-prefix",
        action="append",
        default=[],
        metavar="MARKER",
        help="Also classify messages that start with MARKER as synthetic; repeatable",
    )
    extract_parser.add_argument("--output", type=Path, required=True)

    render_parser = subparsers.add_parser("render", help="Render reviewed selections as verbatim Markdown")
    render_parser.add_argument("--candidates", type=Path, required=True)
    render_parser.add_argument("--selection", type=Path, required=True)
    render_parser.add_argument("--output", type=Path, required=True)
    return parser


def require_file(path: Path, label: str) -> None:
    if not path.is_file():
        raise MiningError(f"{label} does not exist or is not a file: {path}")


def main() -> int:
    args = build_parser().parse_args()
    try:
        if args.command == "inventory":
            require_file(args.session, "Session")
            print(json.dumps(inventory(args.session, args.format), indent=2, sort_keys=True))
        elif args.command == "extract":
            require_file(args.session, "Session")
            after = parse_time(args.after, "--after")
            before = parse_time(args.before, "--before")
            if after is not None and before is not None and after > before:
                raise MiningError("--after must not be later than --before")
            source_digest = sha256_file(args.session)
            source_size = args.session.stat().st_size
            counts = write_jsonl(
                args.output,
                iter_candidates(
                    args.session, after, before, args.format, args.synthetic_prefix
                ),
            )
            if sha256_file(args.session) != source_digest or args.session.stat().st_size != source_size:
                args.output.unlink()
                raise MiningError(f"Session changed while it was being extracted: {args.session}")
            print(json.dumps({"output": str(args.output), "counts": dict(sorted(counts.items()))}, sort_keys=True))
        elif args.command == "render":
            require_file(args.candidates, "Candidates file")
            require_file(args.selection, "Selection manifest")
            render_artifact(args.candidates, args.selection, args.output)
            print(json.dumps({"output": str(args.output)}, sort_keys=True))
        else:
            raise MiningError(f"Unsupported command: {args.command}")
    except (MiningError, OSError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
