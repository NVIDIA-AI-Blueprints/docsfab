#!/usr/bin/env python3
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Validate and render DocsFab knowledge source-thread v1 registries."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from markdown_it import MarkdownIt


THREAD_SCHEMA = "docsfab.knowledge.source-thread/v1"
ITEM_SCHEMA_V1 = "docsfab.knowledge.source-item/v1"
ITEM_SCHEMA_V2 = "docsfab.knowledge.source-item/v2"
ITEM_SCHEMAS = {ITEM_SCHEMA_V1, ITEM_SCHEMA_V2}
EVENT_SCHEMA = "docsfab.knowledge.source-event/v1"

THREAD_KEYS = {
    "schema_version",
    "thread_id",
    "origin",
    "created_at",
    "access",
    "item_ids",
    "relations",
    "event_log",
    "head_event_ids",
}
ITEM_KEYS = {
    "schema_version",
    "item_id",
    "thread_id",
    "artifact_type",
    "title",
    "attribution",
    "timestamps",
    "version",
    "scope",
    "representations",
    "members",
    "governance",
    "lineage",
    "evidence_state",
    "limitations",
}
ITEM_OPTIONAL_KEYS = {"summary", "transforms", "governed_visual"}
ITEM_OPTIONAL_KEYS = {"governed_visual", "summary", "transforms"}
EVENT_KEYS = {
    "schema_version",
    "event_id",
    "thread_id",
    "sequence",
    "occurred_at",
    "actor",
    "event_type",
    "item_id",
    "parent_event_ids",
    "payload",
}
REPRESENTATION_KEYS = {
    "representation_id",
    "role",
    "media_type",
    "original_filename",
    "size_bytes",
    "locator",
    "integrity",
    "derived_from",
    "transform",
}
REPRESENTATION_OPTIONAL_KEYS = {"access_override", "visual_metadata"}
LOCATOR_KEYS = {
    "scheme",
    "uri",
    "repository",
    "commit",
    "path",
    "external_version",
    "retained_copy",
}
INTEGRITY_KEYS = {"algorithm", "value"}
TRANSFORM_KEYS = {"tool", "version", "method", "review_state"}
MEMBER_KEYS = {"member_id", "title", "artifact_type", "representations"}
LINEAGE_KEYS = {"parent_item_ids", "supersedes", "related_item_ids"}
GOVERNANCE_KEYS = {
    "consent",
    "citation_boundary",
    "retention_boundary",
    "redistribution_boundary",
    "access_classification",
}
REPRESENTATION_OPTIONAL_KEYS = {"access_override", "visual_metadata"}
LOCATOR_KEYS = {
    "scheme",
    "uri",
    "repository",
    "commit",
    "path",
    "external_version",
    "retained_copy",
}
INTEGRITY_KEYS = {"algorithm", "value"}
TRANSFORM_KEYS = {"tool", "version", "method", "review_state"}
MEMBER_KEYS = {"member_id", "title", "artifact_type", "representations"}
GOVERNANCE_KEYS = {
    "consent",
    "citation_boundary",
    "retention_boundary",
    "redistribution_boundary",
    "access_classification",
}
LINEAGE_KEYS = {"parent_item_ids", "supersedes", "related_item_ids"}
VISUAL_METADATA_KEYS = {
    "artifact_kind",
    "provenance_role",
    "lifecycle_disposition",
}
VISUAL_ARTIFACT_KINDS = {
    "diagram",
    "architecture-view",
    "state-machine",
    "timeline",
    "rendered-representation",
}
VISUAL_PROVENANCE_ROLES = {"source", "derived"}
VISUAL_LIFECYCLE_DISPOSITIONS = {"current", "superseded", "rejected"}
INHERENT_VISUAL_ITEM_TYPES = {"diagram", "image", "presentation"}
VISUAL_ITEM_TYPES = INHERENT_VISUAL_ITEM_TYPES | {
    "architecture-view",
    "diagram-collection",
    "state-machine",
    "timeline",
}
VISUAL_MEDIA_TYPES = {
    "application/vnd.graphviz",
    "application/vnd.jgraph.mxfile",
    "application/vnd.plantuml",
    "image/svg+xml",
    "text/graphviz",
    "text/vnd.plantuml",
    "text/mermaid",
    "text/plantuml",
    "text/vnd.graphviz",
    "text/vnd.mermaid",
    "text/x-graphviz",
    "text/x-mermaid",
    "text/x-plantuml",
}
# The item bytes carry thread_id and item_id, which _validate_item binds to the
# thread and the filename, so the digest alone names each retained record.
LEGACY_V1_VISUAL_ITEM_SHA256 = frozenset(
    {
        "32f718338a90d3789f3fa009aa0913389351695f25212d20c1d6aac60a514316",
        "22139939689b81ee2d696c922b49d18b98dce749ea2ea494eb13b8175e92e67f",
        "8f82c5c032abde091b337525811264c538c6c31a5ac3e25a718c56311126e0a7",
        "99e34c22113fecb2c07f30760bcc50ef31d29c8020afd21b630c4f121a2bef67",
        "a30381dc42f32af725df023ed3516e3f3cdd3f3d64aac5b2012819c405957546",
        "74f8658778e0ca7970f0a35734391e369049172e27ce6c6d429e05f074beef4c",
        "d41d9dbe7e8885bd8e817a8df8830fefd30f71e80b032289aefeb0b4ecf33d3e",
        "15532276764df83207e5d0a4523997b58326b4bbb8bdfb2dc434400638b9fd27",
        "a906cd066a3922e40e428d65c60f0fddb5cc5b58720b8c7990cd0ab9af8ab741",
        "ed27f917e05760b813a12ed08d587432e01014babdf38a76c53696944e52160b",
        "385e7e6855f8f3446d9bed7709d24e56df7383edeeb6bb82029607e506a9d210",
    }
)
VISUAL_LITERAL_PATTERN = re.compile(
    rb"(?mi)^[ \t]*@startuml(?:[ \t]+[^\r\n]*)?\r?$|<svg(?:\s|>)"
)


class ContractError(Exception):
    """A source-thread record violates the v1 contract."""


def _unique_json_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise ContractError(f"duplicate JSON object key: {key}")
        result[key] = value
    return result


def _load_json(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(
            path.read_text(encoding="utf-8"),
            object_pairs_hook=_unique_json_object,
        )
    except (OSError, json.JSONDecodeError) as exc:
        raise ContractError(f"cannot read JSON {path}: {exc}") from exc
    if not isinstance(value, dict):
        raise ContractError(f"{path} must contain one JSON object")
    return value


def _load_events(path: Path) -> list[dict[str, Any]]:
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except OSError as exc:
        raise ContractError(f"cannot read event ledger {path}: {exc}") from exc
    if not lines:
        raise ContractError(f"event ledger is empty: {path}")

    events: list[dict[str, Any]] = []
    for line_number, line in enumerate(lines, start=1):
        if not line.strip():
            raise ContractError(f"blank JSONL record at {path}:{line_number}")
        try:
            value = json.loads(line, object_pairs_hook=_unique_json_object)
        except json.JSONDecodeError as exc:
            raise ContractError(
                f"invalid JSONL record at {path}:{line_number}: {exc}"
            ) from exc
        if not isinstance(value, dict):
            raise ContractError(f"event at {path}:{line_number} must be an object")
        events.append(value)
    return events


def _require_keys(
    record: dict[str, Any],
    required: set[str],
    label: str,
    optional: set[str] | None = None,
) -> None:
    missing = sorted(required - record.keys())
    if missing:
        raise ContractError(f"{label} missing required keys: {', '.join(missing)}")
    unexpected = sorted(set(record) - required - (optional or set()))
    if unexpected:
        raise ContractError(f"{label} has unsupported keys: {', '.join(unexpected)}")


def _require_string(value: Any, label: str) -> str:
    if not isinstance(value, str) or not value:
        raise ContractError(f"{label} must be a non-empty string")
    return value


def _require_list(value: Any, label: str) -> list[Any]:
    if not isinstance(value, list):
        raise ContractError(f"{label} must be an array")
    return value


def _require_timestamp(value: Any, label: str) -> datetime:
    text = _require_string(value, label)
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError as exc:
        raise ContractError(f"{label} is not an ISO 8601 timestamp: {text}") from exc
    if parsed.tzinfo is None:
        raise ContractError(f"{label} must include a timezone")
    return parsed.astimezone(timezone.utc)


def _check_unique(values: list[Any], label: str) -> None:
    normalized = [_require_string(value, label) for value in values]
    if len(normalized) != len(set(normalized)):
        raise ContractError(f"{label} contains duplicate values")


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    try:
        with path.open("rb") as handle:
            for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                digest.update(chunk)
    except OSError as exc:
        raise ContractError(f"cannot hash retained artifact {path}: {exc}") from exc
    return digest.hexdigest()


def _require_sha256_integrity(value: Any, label: str) -> str:
    if not isinstance(value, dict):
        raise ContractError(f"{label} must be an object")
    if value.get("algorithm") != "sha256":
        raise ContractError(f"{label}.algorithm must be sha256")
    digest = _require_string(value.get("value"), f"{label}.value")
    if len(digest) != 64 or any(
        character not in "0123456789abcdef" for character in digest
    ):
        raise ContractError(f"{label}.value must be a lowercase SHA-256 digest")
    return digest


def _validate_governed_visual(
    representation: dict[str, Any], rep_label: str
) -> None:
    metadata = representation.get("visual_metadata")
    if not isinstance(metadata, dict):
        raise ContractError(f"{rep_label}.visual_metadata must be an object")
    _require_keys(metadata, VISUAL_METADATA_KEYS, f"{rep_label}.visual_metadata")
    artifact_kind = _require_string(
        metadata["artifact_kind"], f"{rep_label}.visual_metadata.artifact_kind"
    )
    if artifact_kind not in VISUAL_ARTIFACT_KINDS:
        raise ContractError(
            f"{rep_label}.visual_metadata.artifact_kind is unsupported: {artifact_kind}"
        )
    provenance_role = _require_string(
        metadata["provenance_role"],
        f"{rep_label}.visual_metadata.provenance_role",
    )
    if provenance_role not in VISUAL_PROVENANCE_ROLES:
        raise ContractError(
            f"{rep_label}.visual_metadata.provenance_role is unsupported: "
            f"{provenance_role}"
        )
    lifecycle_disposition = _require_string(
        metadata["lifecycle_disposition"],
        f"{rep_label}.visual_metadata.lifecycle_disposition",
    )
    if lifecycle_disposition not in VISUAL_LIFECYCLE_DISPOSITIONS:
        raise ContractError(
            f"{rep_label}.visual_metadata.lifecycle_disposition is unsupported: "
            f"{lifecycle_disposition}"
        )

    digest = _require_sha256_integrity(
        representation.get("integrity"), f"{rep_label}.integrity"
    )
    locator = representation["locator"]
    retained_copy = locator.get("retained_copy")
    if retained_copy is not None:
        if locator.get("scheme") != "thread-artifact" or locator.get("uri") != retained_copy:
            raise ContractError(
                f"{rep_label} retained governed visuals require an exact "
                "thread-artifact locator"
            )
    elif locator.get("scheme") == "content-addressed":
        uri = _require_string(locator.get("uri"), f"{rep_label}.locator.uri")
        if uri not in {f"sha256:{digest}", f"urn:sha256:{digest}"}:
            raise ContractError(
                f"{rep_label}.locator.uri must equal its exact SHA-256 integrity"
            )
    else:
        raise ContractError(
            f"{rep_label} governed visuals require retained bytes or an exact "
            "content-addressed locator"
        )

    derived_from = representation["derived_from"]
    if provenance_role == "source" and derived_from:
        raise ContractError(
            f"{rep_label} source visual must not name derived_from representations"
        )
    if provenance_role == "derived" and not derived_from:
        raise ContractError(
            f"{rep_label} derived visual must name at least one derived_from representation"
        )


def _representations_from_item(item: dict[str, Any]) -> list[dict[str, Any]]:
    records = [
        record for record in item.get("representations", []) if isinstance(record, dict)
    ]
    for member in item.get("members", []):
        if not isinstance(member, dict):
            continue
        records.extend(
            record
            for record in member.get("representations", [])
            if isinstance(record, dict)
        )
    return records


def _contains_visual_fence(content: bytes) -> bool:
    try:
        text = content.decode("utf-8")
    except UnicodeDecodeError:
        return False
    visual_languages = {"mermaid", "d2", "dot", "graphviz", "plantuml"}
    for token in MarkdownIt("commonmark").parse(text):
        if token.type == "fence":
            info = token.info.strip().split(maxsplit=1)
            if info and info[0].lower() in visual_languages:
                return True
        if VISUAL_LITERAL_PATTERN.search(token.content.encode("utf-8")) is not None:
            return True
    return False


def _is_visual_representation(
    representation: dict[str, Any], thread_dir: Path
) -> bool:
    if "visual_metadata" in representation:
        return True
    media_type = representation.get("media_type")
    if isinstance(media_type, str):
        essence = media_type.split(";", 1)[0].strip().lower()
        if essence.startswith("image/") or essence in VISUAL_MEDIA_TYPES:
            return True
    locator = representation.get("locator")
    retained_copy = locator.get("retained_copy") if isinstance(locator, dict) else None
    if isinstance(retained_copy, str) and retained_copy:
        relative = Path(retained_copy)
        if not relative.is_absolute() and ".." not in relative.parts:
            candidate = thread_dir / relative
            try:
                content = candidate.read_bytes()
            except OSError:
                return False
            return _contains_visual_fence(content)
    return False


def _is_visual_item(item: dict[str, Any], thread_dir: Path) -> bool:
    if item.get("governed_visual") is True:
        return True
    if item.get("artifact_type") in VISUAL_ITEM_TYPES:
        return True
    if any(
        isinstance(member, dict)
        and member.get("artifact_type") in VISUAL_ITEM_TYPES
        for member in item.get("members", [])
    ):
        return True
    for representation in _representations_from_item(item):
        if _is_visual_representation(representation, thread_dir):
            return True
    return False


def _validate_representations(
    representations: Any, label: str, thread_dir: Path
) -> None:
    records = _require_list(representations, label)
    identifiers: list[str] = []
    for index, representation in enumerate(records):
        rep_label = f"{label}[{index}]"
        if not isinstance(representation, dict):
            raise ContractError(f"{rep_label} must be an object")
        _require_keys(
            representation,
            REPRESENTATION_KEYS,
            rep_label,
            REPRESENTATION_OPTIONAL_KEYS,
        )
        identifiers.append(
            _require_string(representation["representation_id"], f"{rep_label}.representation_id")
        )
        _require_string(representation["role"], f"{rep_label}.role")
        _require_string(representation["media_type"], f"{rep_label}.media_type")
        original_filename = representation["original_filename"]
        if original_filename is not None:
            _require_string(original_filename, f"{rep_label}.original_filename")
        locator = representation["locator"]
        if not isinstance(locator, dict):
            raise ContractError(f"{rep_label}.locator must be an object")
        _require_keys(locator, {"scheme", "uri"}, f"{rep_label}.locator", LOCATOR_KEYS - {"scheme", "uri"})
        _require_string(locator.get("scheme"), f"{rep_label}.locator.scheme")
        _require_string(locator.get("uri"), f"{rep_label}.locator.uri")
        integrity = representation["integrity"]
        if not isinstance(integrity, dict):
            raise ContractError(f"{rep_label}.integrity must be an object")
        _require_keys(integrity, INTEGRITY_KEYS, f"{rep_label}.integrity")
        transform = representation["transform"]
        if transform is not None:
            if not isinstance(transform, dict):
                raise ContractError(f"{rep_label}.transform must be an object or null")
            _require_keys(transform, set(), f"{rep_label}.transform", TRANSFORM_KEYS)
        retained_copy = locator.get("retained_copy")
        if retained_copy is not None:
            retained_path = Path(_require_string(retained_copy, f"{rep_label}.locator.retained_copy"))
            if retained_path.is_absolute() or ".." in retained_path.parts:
                raise ContractError(f"{rep_label}.locator.retained_copy must stay inside the thread")
            algorithm = integrity.get("algorithm")
            expected_digest = integrity.get("value")
            if algorithm != "sha256" or not isinstance(expected_digest, str):
                raise ContractError(
                    f"{rep_label} retained artifacts require a sha256 integrity value"
                )
            if len(expected_digest) != 64 or any(
                character not in "0123456789abcdef" for character in expected_digest
            ):
                raise ContractError(
                    f"{rep_label}.integrity.value must be a lowercase SHA-256 digest"
                )
            expected_parts = ("artifacts", "sha256", expected_digest[:2], expected_digest)
            if retained_path.parts != expected_parts:
                raise ContractError(
                    f"{rep_label}.locator.retained_copy must be "
                    "artifacts/sha256/<prefix>/<digest>"
                )
            candidate = thread_dir / retained_path
            try:
                resolved = candidate.resolve(strict=True)
            except OSError as exc:
                raise ContractError(f"retained artifact does not exist: {candidate}: {exc}") from exc
            artifacts_root = (thread_dir / "artifacts").resolve()
            if not resolved.is_relative_to(artifacts_root) or not resolved.is_file():
                raise ContractError(f"retained artifact escapes artifacts/: {candidate}")
            actual_digest = _sha256(resolved)
            if actual_digest != expected_digest:
                raise ContractError(
                    f"retained artifact hash mismatch: {candidate}: "
                    f"expected {expected_digest}, got {actual_digest}"
                )
            size_bytes = representation["size_bytes"]
            if size_bytes is not None and size_bytes != resolved.stat().st_size:
                raise ContractError(
                    f"retained artifact size mismatch: {candidate}: "
                    f"expected {size_bytes}, got {resolved.stat().st_size}"
                )
        derived_from = _require_list(
            representation["derived_from"], f"{rep_label}.derived_from"
        )
        _check_unique(derived_from, f"{rep_label}.derived_from")
        if derived_from and representation["transform"] is None:
            raise ContractError(f"{rep_label} is derived but has no transform")
        if "visual_metadata" in representation:
            _validate_governed_visual(representation, rep_label)

    if len(identifiers) != len(set(identifiers)):
        raise ContractError(f"{label} contains duplicate representation IDs")
    identifier_set = set(identifiers)
    for index, representation in enumerate(records):
        unknown = set(representation["derived_from"]) - identifier_set
        if unknown:
            raise ContractError(
                f"{label}[{index}].derived_from has unknown IDs: {', '.join(sorted(unknown))}"
            )


def _validate_item(item: dict[str, Any], thread_id: str, thread_dir: Path, path: Path) -> None:
    label = str(path)
    _require_keys(item, ITEM_KEYS, label, ITEM_OPTIONAL_KEYS)
    if item["schema_version"] not in ITEM_SCHEMAS:
        raise ContractError(f"{label} has unsupported schema_version")
    if item["thread_id"] != thread_id:
        raise ContractError(f"{label} belongs to {item['thread_id']}, expected {thread_id}")
    _require_string(item["item_id"], f"{label}.item_id")
    if path.stem != item["item_id"]:
        raise ContractError(f"{label} filename must match item_id {item['item_id']}")
    artifact_type = _require_string(item["artifact_type"], f"{label}.artifact_type")
    _require_string(item["title"], f"{label}.title")
    attribution = item["attribution"]
    if not isinstance(attribution, dict):
        raise ContractError(f"{label}.attribution must be an object")
    _require_keys(attribution, {"author", "contributors", "collector"}, f"{label}.attribution")
    contributors = _require_list(attribution["contributors"], f"{label}.attribution.contributors")
    for index, contributor in enumerate(contributors):
        contributor_label = f"{label}.attribution.contributors[{index}]"
        if not isinstance(contributor, dict):
            raise ContractError(f"{contributor_label} must be an object")
        _require_keys(contributor, {"identity", "relation", "scope"}, contributor_label)
    version = item["version"]
    if not isinstance(version, dict):
        raise ContractError(f"{label}.version must be an object")
    _require_keys(version, {"kind", "value"}, f"{label}.version")
    scope = item["scope"]
    if not isinstance(scope, dict):
        raise ContractError(f"{label}.scope must be an object")
    _require_keys(
        scope,
        {"product_version", "deployment", "audience", "model_region"},
        f"{label}.scope",
    )

    schema_version = item["schema_version"]
    governed_visual = item.get("governed_visual")
    visual_item = _is_visual_item(item, thread_dir)
    if schema_version == ITEM_SCHEMA_V1 and visual_item:
        if _sha256(path) not in LEGACY_V1_VISUAL_ITEM_SHA256:
            raise ContractError(
                f"{label} is a new or changed visual item; use "
                f"{ITEM_SCHEMA_V2} with governed visual metadata"
            )
    if schema_version == ITEM_SCHEMA_V2:
        if not isinstance(governed_visual, bool):
            raise ContractError(f"{label}.governed_visual must be a boolean for v2 items")
        if visual_item and not governed_visual:
            raise ContractError(
                f"{label}.governed_visual must be true for inferred visual items"
            )

    timestamps = item["timestamps"]
    if not isinstance(timestamps, dict):
        raise ContractError(f"{label}.timestamps must be an object")
    _require_keys(timestamps, {"source_created_at", "ingested_at"}, f"{label}.timestamps")
    source_created = timestamps.get("source_created_at")
    if source_created is not None:
        _require_timestamp(source_created, f"{label}.timestamps.source_created_at")
    _require_timestamp(timestamps.get("ingested_at"), f"{label}.timestamps.ingested_at")

    representations = _require_list(item["representations"], f"{label}.representations")
    members = _require_list(item["members"], f"{label}.members")
    if not representations and not members:
        raise ContractError(f"{label} must contain a representation or collection member")
    _validate_representations(representations, f"{label}.representations", thread_dir)

    member_ids: list[str] = []
    for index, member in enumerate(members):
        member_label = f"{label}.members[{index}]"
        if not isinstance(member, dict):
            raise ContractError(f"{member_label} must be an object")
        _require_keys(member, MEMBER_KEYS, member_label)
        member_ids.append(_require_string(member.get("member_id"), f"{member_label}.member_id"))
        _require_string(member.get("title"), f"{member_label}.title")
        _require_string(member.get("artifact_type"), f"{member_label}.artifact_type")
        _validate_representations(member.get("representations"), f"{member_label}.representations", thread_dir)
    if len(member_ids) != len(set(member_ids)):
        raise ContractError(f"{label}.members contains duplicate member IDs")

    visual_representations = [
        representation
        for representation in representations
        if _is_visual_representation(representation, thread_dir)
    ]
    for member in members:
        member_representations = member["representations"]
        if member["artifact_type"] in VISUAL_ITEM_TYPES:
            visual_representations.extend(member_representations)
        else:
            visual_representations.extend(
                representation
                for representation in member_representations
                if _is_visual_representation(representation, thread_dir)
            )
    if schema_version == ITEM_SCHEMA_V2:
        if governed_visual and not visual_representations:
            raise ContractError(
                f"{label} governed visual item must contain visual_metadata"
            )
        if governed_visual:
            missing_metadata = [
                representation.get("representation_id", "<unknown>")
                for representation in visual_representations
                if representation.get("visual_metadata") is None
            ]
            if missing_metadata:
                raise ContractError(
                    f"{label} inferred visual representations require visual_metadata: "
                    f"{', '.join(missing_metadata)}"
                )
        if not governed_visual and visual_representations:
            raise ContractError(
                f"{label} nonvisual item must not contain visual_metadata"
            )

    lineage = item["lineage"]
    if not isinstance(lineage, dict):
        raise ContractError(f"{label}.lineage must be an object")
    _require_keys(lineage, LINEAGE_KEYS, f"{label}.lineage")
    for field in ("parent_item_ids", "supersedes", "related_item_ids"):
        values = _require_list(lineage.get(field), f"{label}.lineage.{field}")
        _check_unique(values, f"{label}.lineage.{field}")
    governance = item["governance"]
    if not isinstance(governance, dict):
        raise ContractError(f"{label}.governance must be an object")
    _require_keys(governance, GOVERNANCE_KEYS, f"{label}.governance")


def validate_thread(thread_dir: Path, check_view: bool = False) -> tuple[dict[str, Any], list[dict[str, Any]], list[dict[str, Any]]]:
    if not thread_dir.is_dir():
        raise ContractError(f"thread directory does not exist: {thread_dir}")
    for required_dir in ("items", "artifacts", "views"):
        if not (thread_dir / required_dir).is_dir():
            raise ContractError(f"thread is missing {required_dir}/: {thread_dir}")

    thread = _load_json(thread_dir / "thread.json")
    _require_keys(thread, THREAD_KEYS, str(thread_dir / "thread.json"))
    if thread["schema_version"] != THREAD_SCHEMA:
        raise ContractError("thread.json has unsupported schema_version")
    thread_id = _require_string(thread["thread_id"], "thread.thread_id")
    _require_timestamp(thread["created_at"], "thread.created_at")
    origin = thread["origin"]
    if not isinstance(origin, dict):
        raise ContractError("thread.origin must be an object")
    _require_keys(origin, {"kind", "identity", "identity_state"}, "thread.origin")
    _require_string(origin.get("kind"), "thread.origin.kind")
    if origin.get("identity") is not None:
        _require_string(origin["identity"], "thread.origin.identity")
    _require_string(origin.get("identity_state"), "thread.origin.identity_state")
    access = thread["access"]
    if not isinstance(access, dict):
        raise ContractError("thread.access must be an object")
    _require_keys(access, {"classification"}, "thread.access")
    _require_string(access.get("classification"), "thread.access.classification")
    if thread["event_log"] != "events.jsonl":
        raise ContractError("thread.event_log must be events.jsonl")
    item_index = _require_list(thread["item_ids"], "thread.item_ids")
    _check_unique(item_index, "thread.item_ids")
    relations = _require_list(thread["relations"], "thread.relations")
    for index, relation in enumerate(relations):
        relation_label = f"thread.relations[{index}]"
        if not isinstance(relation, dict):
            raise ContractError(f"{relation_label} must be an object")
        _require_keys(
            relation,
            {"kind", "target_thread_id"},
            relation_label,
            {"notes"},
        )

    item_paths = sorted((thread_dir / "items").glob("*.json"))
    if not item_paths:
        raise ContractError(f"thread has no item records: {thread_dir}")
    items = [_load_json(path) for path in item_paths]
    for item, path in zip(items, item_paths):
        _validate_item(item, thread_id, thread_dir, path)
    item_ids = [item["item_id"] for item in items]
    if set(item_index) != set(item_ids):
        raise ContractError(
            "thread.item_ids does not match item records: "
            f"index={sorted(item_index)} records={sorted(item_ids)}"
        )
    if len(item_ids) != len(set(item_ids)):
        raise ContractError("item records contain duplicate item IDs")

    events = _load_events(thread_dir / thread["event_log"])
    event_ids: list[str] = []
    event_sequence: dict[str, int] = {}
    event_timestamps: dict[str, datetime] = {}
    parent_ids: set[str] = set()
    for index, event in enumerate(events, start=1):
        label = f"events.jsonl:{index}"
        _require_keys(event, EVENT_KEYS, label)
        if event["schema_version"] != EVENT_SCHEMA:
            raise ContractError(f"{label} has unsupported schema_version")
        if event["thread_id"] != thread_id:
            raise ContractError(f"{label} belongs to another thread")
        if event["sequence"] != index:
            raise ContractError(f"{label} sequence must be {index}")
        event_id = _require_string(event["event_id"], f"{label}.event_id")
        occurred_at = _require_timestamp(event["occurred_at"], f"{label}.occurred_at")
        if event["item_id"] is not None and event["item_id"] not in item_ids:
            raise ContractError(f"{label} refers to unknown item {event['item_id']}")
        if not isinstance(event["payload"], dict):
            raise ContractError(f"{label}.payload must be an object")
        parents = _require_list(event["parent_event_ids"], f"{label}.parent_event_ids")
        _check_unique(parents, f"{label}.parent_event_ids")
        for parent in parents:
            if parent not in event_sequence:
                raise ContractError(f"{label} parent {parent} does not precede the event")
            if occurred_at < event_timestamps[parent]:
                raise ContractError(
                    f"{label}.occurred_at precedes parent {parent}.occurred_at"
                )
            parent_ids.add(parent)
        event_ids.append(event_id)
        event_sequence[event_id] = index
        event_timestamps[event_id] = occurred_at
    if len(event_ids) != len(set(event_ids)):
        raise ContractError("event ledger contains duplicate event IDs")

    computed_heads = set(event_ids) - parent_ids
    head_ids = _require_list(thread["head_event_ids"], "thread.head_event_ids")
    _check_unique(head_ids, "thread.head_event_ids")
    declared_heads = set(head_ids)
    if declared_heads != computed_heads:
        raise ContractError(
            f"thread heads do not match ledger leaves: declared={sorted(declared_heads)} "
            f"computed={sorted(computed_heads)}"
        )

    if check_view:
        view_path = thread_dir / "views" / "thread.md"
        try:
            current_view = view_path.read_text(encoding="utf-8")
        except OSError as exc:
            raise ContractError(f"cannot read derived view {view_path}: {exc}") from exc
        expected_view = render_thread(thread, items, events)
        if current_view != expected_view:
            raise ContractError(f"derived view is stale: {view_path}")
    return thread, items, events


def render_thread(
    thread: dict[str, Any], items: list[dict[str, Any]], events: list[dict[str, Any]]
) -> str:
    item_by_id = {item["item_id"]: item for item in items}
    lines = [
        "<!-- Generated from thread.json, items/*.json, and events.jsonl. Do not edit. -->",
        "",
        f"# Source Thread: {thread['thread_id']}",
        "",
        f"- **Origin:** `{thread['origin']['kind']}` — `{thread['origin']['identity']}`",
        f"- **Identity state:** `{thread['origin']['identity_state']}`",
        f"- **Created:** `{thread['created_at']}`",
        f"- **Access:** `{thread['access']['classification']}`",
        f"- **Event heads:** {', '.join(f'`{value}`' for value in thread['head_event_ids'])}",
        "",
        "## Items",
        "",
        "| Item | Type | Title | Version | Representations or members |",
        "| --- | --- | --- | --- | --- |",
    ]
    for item_id in thread["item_ids"]:
        item = item_by_id[item_id]
        version = item["version"]["value"]
        count = len(item["representations"]) + len(item["members"])
        lines.append(
            f"| `{item_id}` | `{item['artifact_type']}` | {item['title']} | "
            f"`{version}` | {count} |"
        )
    lines.extend(
        [
            "",
            "## Event Ledger",
            "",
            "| Sequence | Event | Type | Item | Time |",
            "| ---: | --- | --- | --- | --- |",
        ]
    )
    for event in events:
        item_value = f"`{event['item_id']}`" if event["item_id"] else "—"
        lines.append(
            f"| {event['sequence']} | `{event['event_id']}` | `{event['event_type']}` | "
            f"{item_value} | `{event['occurred_at']}` |"
        )
    lines.extend(
        [
            "",
            "This Markdown file is a derived view. The JSON records and JSONL ledger are canonical.",
            "",
        ]
    )
    return "\n".join(lines)


def _write_view(thread_dir: Path, content: str) -> Path:
    view_dir = thread_dir / "views"
    view_dir.mkdir(parents=True, exist_ok=True)
    target = view_dir / "thread.md"
    try:
        with tempfile.NamedTemporaryFile(
            "w", encoding="utf-8", dir=view_dir, delete=False
        ) as handle:
            handle.write(content)
            temporary = Path(handle.name)
        os.replace(temporary, target)
    except OSError as exc:
        raise ContractError(f"cannot write derived view {target}: {exc}") from exc
    return target


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)

    validate_parser = subparsers.add_parser("validate", help="validate a source thread")
    validate_parser.add_argument("thread_dir", type=Path)
    validate_parser.add_argument("--check-view", action="store_true")

    render_parser = subparsers.add_parser("render", help="render the Markdown thread view")
    render_parser.add_argument("thread_dir", type=Path)
    return parser


def main() -> int:
    args = build_parser().parse_args()
    try:
        thread, items, events = validate_thread(args.thread_dir, check_view=False)
        if args.command == "validate":
            if args.check_view:
                validate_thread(args.thread_dir, check_view=True)
            print(
                f"valid source thread {thread['thread_id']}: "
                f"{len(items)} items, {len(events)} events"
            )
            return 0
        target = _write_view(args.thread_dir, render_thread(thread, items, events))
        print(f"rendered {target}")
        return 0
    except ContractError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
