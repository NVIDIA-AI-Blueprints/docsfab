#!/usr/bin/env python3
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Create and check DocsFab documentation-freshness receipts."""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import os
import re
import stat
import subprocess
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import yaml
from markdown_it import MarkdownIt
from yaml.constructor import ConstructorError
from yaml.nodes import MappingNode
from yaml.tokens import AliasToken, AnchorToken, TagToken


SCHEMA_VERSION = "docsfab.knowledge.documentation-freshness/v4"
REPORT_SCHEMA_VERSION = "docsfab.knowledge.documentation-freshness-report/v4"
DEFAULT_MANIFEST = ".docsfab/reference-model/freshness.json"
MANIFEST_NAMESPACE = ".docsfab/reference-model/receipts"
REPORT_NAMESPACE = ".docsfab/reports"
REVIEW_NAMESPACE = ".docsfab/reference-model/assessments"
DEFAULT_REPORT = f"{REPORT_NAMESPACE}/documentation-freshness-report.json"
DEFAULT_REPOSITORY_PATHS = [
    ".docsfab/reference-model/assessments",
    ".gitlab/ci/knowledge.yml",
    ".gitlab-ci.yml",
    "GOVERNANCE.md",
    "deploy",
    "governance",
    "packages",
    "planning",
]
SHA256_PATTERN = re.compile(r"^[a-f0-9]{64}$")
MODEL_VERSION_PATTERN = re.compile(r"^v\d+\.\d+$")
NAV_PATH_PATTERN = re.compile(r"^\s*path:\s+\.\./(docs/\S+\.md)\s*$")
HISTORY_VERSION_PATTERN = re.compile(r"^\| \[?(v\d+\.\d+)\]?")
CLAIM_REQUIRED_FIELDS = {
    "claim_id",
    "source_claims",
    "relationship",
    "action",
    "statement",
    "scope",
    "exact_evidence",
    "agent_inferences",
    "behavior_verification",
    "representation_state",
    "intent_approval",
    "model_state",
    "decision_basis",
    "resolution_owner",
    "blocks_targets",
    "unblocks_targets",
}
CLAIM_ENUMS = {
    "relationship": {
        "compatible",
        "behavior-conflict",
        "intent-conflict",
        "terminology-conflict",
        "scope-conflict",
        "version-conflict",
        "representation-conflict",
        "documentation-quality-conflict",
        "unknown",
    },
    "action": {"included", "added", "superseded", "excluded", "rescoped", "variant", "unresolved"},
    "behavior_verification": {
        "not-checked",
        "supported",
        "contradicted",
        "inconclusive",
        "not-applicable",
    },
    "representation_state": {"unreviewed", "confirmed", "corrected", "disputed", "not-applicable"},
    "intent_approval": {
        "not-requested",
        "approved",
        "rejected",
        "participant-not-authorized",
        "not-applicable",
    },
    "model_state": {"candidate", "disputed", "unresolved", "superseded", "approved"},
}
CONFLICT_ENUMS = {
    "status": {"open", "resolved", "deferred"},
    "classification": CLAIM_ENUMS["relationship"] - {"compatible"},
    "disposition": {
        "accept-variant",
        "supersede-variant",
        "rescope",
        "retain-variants",
        "defer",
        "none",
    },
}
CLAIM_LIST_FIELDS = {
    "agent_inferences",
    "blocks_targets",
    "exact_evidence",
    "source_claims",
    "unblocks_targets",
}
CONFLICT_REQUIRED_FIELDS = {
    "adjudication",
    "blocks_targets",
    "classification",
    "conflict_id",
    "consequence_if_unresolved",
    "resolution_owner",
    "source_variants",
    "status",
    "summary",
    "why_inconsistent",
}
READINESS_STATUSES = {"ready", "partial", "blocked", "not-assessed"}
CHECK_STATUSES = {"passed", "pending", "failed"}
REVIEW_STATUSES = {"passed", "pending", "failed"}
SOURCE_ITEM_FIELDS = {
    "integrity",
    "item_id",
    "member_id",
    "representation_id",
    "source_thread_id",
    "thread_head_event_ids",
    "version",
}
SOURCE_ITEM_DISPOSITIONS = {"included", "superseded", "excluded", "pending"}
UNRESOLVABLE_REVISION_MARKERS = (
    "needed a single revision",
    "not a valid object name",
    "bad object",
    "unknown revision",
)
SOURCE_ITEM_DISPOSITION_FIELDS = {"disposition", "item_id", "rationale"}
MERGE_REQUIRED_FIELDS = {
    "approval_state",
    "audience",
    "created_at",
    "documentation_targets",
    "merge_id",
    "model_id",
    "model_region",
    "model_version",
    "prior_model_version",
    "reviewers",
    "source_items",
    "target_release",
}
MERGE_OPTIONAL_FIELDS = {"governed_visual_targets", "source_item_dispositions"}
MERGE_APPROVAL_STATES = {"candidate", "approved", "rejected", "superseded"}
CONFLICT_VARIANT_FIELDS = {
    "exact_evidence",
    "scope",
    "source_claim_ids",
    "statement",
}
ADJUDICATION_FIELDS = {
    "adjudicator",
    "authority_basis",
    "decided_at",
    "decision_evidence",
    "disposition",
    "rationale",
    "resulting_claim_ids",
}
LEGACY_ENUM_EXTENSIONS = {
    "v0.5": {
        "action": {"superseded-variant"},
        "behavior_verification": {
            "configuration-inspected",
            "focused-tests-inspected",
            "not-implemented",
            "not-yet-implemented",
            "source-and-tests-inspected",
        },
        "representation_state": {"source-authored"},
        "intent_approval": {
            "inherited-for-capability-model",
            "proposed",
            "repository-version-bound",
        },
    },
    "v0.6": {
        "action": {"superseded-variant"},
        "behavior_verification": {
            "failure-reproduced",
            "framework-and-skill-artifacts-inspected",
            "partial-skill-implementation-inspected",
            "partially-implemented",
            "source-artifacts-registered",
        },
        "representation_state": {"source-authored"},
        "intent_approval": {
            "approved-for-provenance",
            "derived-from-approved-freshness-requirement",
        },
    },
}
LEGACY_CONFLICT_ENUM_EXTENSIONS = {"v0.6": {"disposition": {"merge"}}}
# Grandfathered v0.3 records keyed by the SHA-256 of their item and event IDs, so
# the source names no person; each still matches only that exact ID.
LEGACY_MULTI_MEMBER_SELECTIONS = {
    ("v0.3", "5e96dbeb791eead57efe1bbabb60ce5d6d0e42eec164d1a42af3547efcdd8f75"): frozenset(
        {
            "brainstorming-and-decisions",
            "detailed-design",
            "repository-readme",
        }
    )
}
LEGACY_THREAD_HEAD_SELECTIONS = {
    ("v0.3", "15b845de03164190c55c7a20c84664c297e06076a359e178ef93a78222fd246b"): frozenset(
        {"27f3147881bc5e9f2c2540893e0bdfeb34e050fa107fd9bb10788fa907bb3b31"}
    )
}


def _legacy_id_key(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


NATIVE_MARKER = "<!-- docsfab-product-feedback-model:v1 -->"
NATIVE_MODEL_FIELDS = {
    "schemaVersion",
    "kind",
    "projectId",
    "modelId",
    "version",
    "streamVersion",
    "state",
    "recipeSha256",
    "parent",
    "metadata",
    "retainedFiles",
    "change",
    "openConflicts",
    "sourceRegistration",
    "sourceClosureSha256",
    "approvalTargetSha256",
}


class FreshnessError(Exception):
    """The freshness contract or repository state is invalid."""


def native_exact_fields(value: object, fields: set[str]) -> dict:
    if not isinstance(value, dict) or set(value) != fields:
        raise ValueError("native feedback fields differ")
    return value


def native_line(value: str) -> str:
    return re.sub(r"[\\`*_\[\]<>#]", lambda match: "\\" + match[0],
                  re.sub(r"\s+", " ", str(value)))


def native_text(model: dict) -> str:
    """Render a native envelope exactly as the knowledge materializer writes it."""
    lines = [NATIVE_MARKER,
        f"# {model['modelId']} Product Reference Model {model['version']}", "",
        "This immutable candidate inherits all unchanged claims, source records, conflicts, and prose from its parent.",
        "Approval and publication are verified separately by the host.", "", "```json",
        json.dumps(model, ensure_ascii=False, sort_keys=True, separators=(",", ":")), "```", ""]
    if model["change"] is not None:
        claim = model["change"]["record"]
        scope = "; ".join(f"{native_line(key)}: {native_line(value)}"
                          for key, value in sorted(claim["scope"].items()))
        lines.extend([f"## {claim['claim_id']}", "", native_line(claim["statement"]), "",
                      f"Scope: {scope}.", ""])
    return "\n".join(lines)


def parse_native(text: str) -> dict | None:
    """Return a native envelope, None for any other model, or raise ValueError only."""
    if not text.startswith(NATIVE_MARKER):
        return None
    match = re.search(r"^```json\n([^\n]+)\n```$", text, re.MULTILINE)
    if not match:
        raise ValueError("native feedback envelope missing")
    model = native_exact_fields(json.loads(match[1]), NATIVE_MODEL_FIELDS)
    if model["schemaVersion"] != 1 or model["kind"] != "docsfab-product-feedback-model" or model["state"] != "candidate":
        raise ValueError("native feedback format differs")
    native_exact_fields(model["parent"], {"version", "modelSha256", "modelGitObjectId", "baselineGeneration", "baselineSha256", "sourceClosureSha256"})
    native_exact_fields(model["metadata"], {"successorVersion", "createdAt", "title"})
    # A record-only version records a consistent input: its envelope names no claim replacement.
    if model["change"] is not None:
        record = native_exact_fields(model["change"], {"claimId", "beforeClaimRecordSha256", "record"})["record"]
        if not isinstance(record, dict) or not isinstance(record.get("scope"), dict) or "claim_id" not in record or "statement" not in record:
            raise ValueError("native feedback claim record differs")
    native_exact_fields(model["sourceRegistration"], {"threadId", "itemId", "artifactSha256", "decisionRegistrationSha256", "files"})
    if not all(isinstance(value, str) for value in (model["modelId"], model["version"], model["parent"]["version"],
                                                    model["sourceRegistration"]["threadId"], model["sourceRegistration"]["itemId"])):
        raise ValueError("native feedback identity differs")
    if native_text(model) != text or model["metadata"]["successorVersion"] != model["version"]:
        raise ValueError("native feedback bytes differ from their envelope")
    return model


_SEMANTIC_PARSER: Any | None = None


def _semantic_parser() -> Any:
    global _SEMANTIC_PARSER
    if _SEMANTIC_PARSER is not None:
        return _SEMANTIC_PARSER
    path = (
        Path(__file__).resolve().parents[2]
        / "synthesize-source-threads/scripts/validate_visual_closure.py"
    )
    spec = importlib.util.spec_from_file_location("docsfab_visual_semantic_parser", path)
    if spec is None or spec.loader is None:
        raise FreshnessError(f"cannot load semantic Markdown parser: {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    _SEMANTIC_PARSER = module
    return module


class _UniqueKeyLoader(yaml.BaseLoader):
    """YAML loader that keeps scalars as strings and rejects duplicate keys."""


def _construct_unique_mapping(
    loader: _UniqueKeyLoader, node: MappingNode, deep: bool = False
) -> dict[str, Any]:
    if not isinstance(node, MappingNode):
        raise ConstructorError(None, None, "expected a mapping node", node.start_mark)
    mapping: dict[str, Any] = {}
    for key_node, value_node in node.value:
        key = loader.construct_object(key_node, deep=deep)
        if not isinstance(key, str):
            raise ConstructorError(
                "while constructing a mapping",
                node.start_mark,
                "mapping keys must be strings",
                key_node.start_mark,
            )
        if key in mapping:
            raise ConstructorError(
                "while constructing a mapping",
                node.start_mark,
                f"duplicate mapping key: {key}",
                key_node.start_mark,
            )
        mapping[key] = loader.construct_object(value_node, deep=deep)
    return mapping


_UniqueKeyLoader.add_constructor(
    yaml.resolver.BaseResolver.DEFAULT_MAPPING_TAG,
    _construct_unique_mapping,
)


def repository_root(cwd: Path | None = None) -> Path:
    result = subprocess.run(
        ["git", "rev-parse", "--show-toplevel"],
        cwd=cwd,
        check=False,
        capture_output=True,
        text=True,
        timeout=10,
    )
    if result.returncode != 0:
        detail = result.stderr.strip() or result.stdout.strip() or "unknown Git error"
        raise FreshnessError(f"cannot resolve repository root: {detail}")
    root = Path(result.stdout.strip())
    if not root.is_absolute() or not root.is_dir():
        raise FreshnessError(f"Git returned an invalid repository root: {root}")
    return root


def _git(root: Path, arguments: list[str], *, timeout: int = 30,
         ignore_replace_objects: bool = False) -> bytes:
    try:
        result = subprocess.run(
            ["git", *(["--no-replace-objects"] if ignore_replace_objects else []), *arguments],
            cwd=root,
            check=False,
            capture_output=True,
            timeout=timeout,
        )
    except (OSError, ValueError) as exc:
        raise FreshnessError(f"cannot run git {' '.join(arguments)}: {exc}") from exc
    if result.returncode != 0:
        detail = result.stderr.decode("utf-8", errors="replace").strip()
        raise FreshnessError(f"git {' '.join(arguments)} failed: {detail}")
    return result.stdout


def _is_unresolvable_revision_error(detail: str) -> bool:
    lowered = detail.lower()
    return any(marker in lowered for marker in UNRESOLVABLE_REVISION_MARKERS)


def _try_resolve_commit(root: Path, value: Any, label: str) -> str | None:
    if not isinstance(value, str) or not re.fullmatch(r"[a-f0-9]{40,64}", value):
        raise FreshnessError(f"{label} must be a full Git commit ID")
    try:
        result = subprocess.run(
            ["git", "rev-parse", "--verify", f"{value}^{{commit}}"],
            cwd=root,
            check=False,
            capture_output=True,
            timeout=10,
        )
    except (OSError, ValueError) as exc:
        raise FreshnessError(f"cannot run git rev-parse: {exc}") from exc
    if result.returncode == 0:
        resolved = result.stdout.decode("utf-8", errors="strict").strip()
        if resolved != value:
            raise FreshnessError(f"{label} does not resolve to its exact commit")
        return resolved
    detail = result.stderr.decode("utf-8", errors="replace").strip()
    if _is_unresolvable_revision_error(detail):
        return None
    raise FreshnessError(
        f"git rev-parse --verify {value}^{{commit}} failed: {detail}"
    )


def _resolve_commit(root: Path, value: Any, label: str) -> str:
    resolved = _try_resolve_commit(root, value, label)
    if resolved is None:
        raise FreshnessError(
            f"git rev-parse --verify {value}^{{commit}} failed: "
            "Needed a single revision"
        )
    return resolved


def _commit_tree(root: Path, revision: str, label: str) -> str:
    tree = _git(
        root,
        ["rev-parse", "--verify", f"{revision}^{{tree}}"],
        timeout=10,
    ).decode("utf-8", errors="strict").strip()
    if not re.fullmatch(r"[a-f0-9]{40,64}", tree):
        raise FreshnessError(f"{label} returned an invalid Git tree ID")
    return tree


def _changed_paths(root: Path, start: str, end: str) -> list[str]:
    if subprocess.run(
        ["git", "merge-base", "--is-ancestor", start, end],
        cwd=root,
        check=False,
        capture_output=True,
        timeout=10,
    ).returncode != 0:
        raise FreshnessError(f"reviewed commit {start} is not an ancestor of {end}")
    output = _git(
        root,
        ["diff", "--name-only", "-z", start, end, "--"],
        timeout=30,
    )
    try:
        paths = [entry.decode("utf-8") for entry in output.split(b"\0") if entry]
    except UnicodeDecodeError as exc:
        raise FreshnessError("Git returned a non-UTF-8 finalization path") from exc
    return sorted(_safe_relative_path(path, "finalization path") for path in paths)


def _git_blob_bytes(root: Path, revision: str, relative: str, label: str) -> bytes:
    safe = _safe_relative_path(relative, label)
    return _git(root, ["show", f"{revision}:{safe}"], timeout=30)


def _sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    try:
        with path.open("rb") as handle:
            for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                digest.update(chunk)
    except OSError as exc:
        raise FreshnessError(f"cannot hash {path}: {exc}") from exc
    return digest.hexdigest()


def _repository_file_sha256(root: Path, relative: str, label: str) -> str:
    safe = _safe_relative_path(relative, label)
    _reject_symlink_path(root, safe, label)
    path = root / safe
    try:
        mode = path.lstat().st_mode
    except OSError as exc:
        raise FreshnessError(f"cannot inspect {label} {safe}: {exc}") from exc
    if not stat.S_ISREG(mode):
        raise FreshnessError(f"{label} is not a regular file: {safe}")
    return _sha256_file(path)


def _write_json(path: Path, value: dict[str, Any]) -> None:
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.NamedTemporaryFile(
            mode="w",
            encoding="utf-8",
            dir=path.parent,
            prefix=f".{path.name}.",
            delete=False,
        ) as handle:
            json.dump(value, handle, indent=2, sort_keys=True)
            handle.write("\n")
            temporary = Path(handle.name)
        os.replace(temporary, path)
    except OSError as exc:
        raise FreshnessError(f"cannot write JSON {path}: {exc}") from exc


def _load_json(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise FreshnessError(f"cannot read JSON {path}: {exc}") from exc
    if not isinstance(value, dict):
        raise FreshnessError(f"{path} must contain one JSON object")
    return value


def _safe_relative_path(value: Any, label: str) -> str:
    if not isinstance(value, str) or not value:
        raise FreshnessError(f"{label} must be a non-empty repository-relative path")
    if any(ord(character) < 32 or ord(character) == 127 for character in value):
        raise FreshnessError(f"{label} must not contain control characters")
    path = Path(value)
    if path.is_absolute() or ".." in path.parts or value != path.as_posix():
        raise FreshnessError(f"{label} must be a normalized repository-relative path")
    return value


def _is_within_namespace(relative: str, namespace: str) -> bool:
    path = Path(relative)
    root = Path(namespace)
    return path != root and path.parts[: len(root.parts)] == root.parts


def _reject_symlink_path(root: Path, relative: str, label: str) -> None:
    current = root
    for part in Path(relative).parts:
        current /= part
        if current.is_symlink():
            raise FreshnessError(f"{label} must not traverse a symbolic link: {relative}")


def _tracked_paths(root: Path, relative: str) -> list[str]:
    output = _git(root, ["ls-files", "--cached", "-z", "--", relative], timeout=10)
    try:
        return [entry.decode("utf-8") for entry in output.split(b"\0") if entry]
    except UnicodeDecodeError as exc:
        raise FreshnessError("Git returned a non-UTF-8 tracked path") from exc


def _safe_manifest_path(root: Path, value: Any) -> str:
    relative = _safe_relative_path(value, "--manifest")
    if relative != DEFAULT_MANIFEST and not _is_within_namespace(
        relative, MANIFEST_NAMESPACE
    ):
        raise FreshnessError(
            f"--manifest must be {DEFAULT_MANIFEST} or under {MANIFEST_NAMESPACE}/"
        )
    _reject_symlink_path(root, relative, "--manifest")
    tracked = _tracked_paths(root, relative)
    if tracked and tracked != [relative]:
        raise FreshnessError("--manifest resolves to an unexpected tracked path")
    return relative


def _safe_report_path(root: Path, value: Any) -> str:
    relative = _safe_relative_path(value, "--output")
    if not _is_within_namespace(relative, REPORT_NAMESPACE):
        raise FreshnessError(f"--output must be under {REPORT_NAMESPACE}/")
    _reject_symlink_path(root, relative, "--output")
    if _tracked_paths(root, relative):
        raise FreshnessError("--output must not overwrite a tracked file")
    return relative


def _safe_review_path(root: Path, value: Any) -> str:
    relative = _safe_relative_path(value, "review evidence")
    if not _is_within_namespace(relative, REVIEW_NAMESPACE) or not relative.endswith(
        ".md"
    ):
        raise FreshnessError(
            f"passed review evidence must be a Markdown file under {REVIEW_NAMESPACE}/"
        )
    _reject_symlink_path(root, relative, "review evidence")
    if _tracked_paths(root, relative) != [relative]:
        raise FreshnessError("passed review evidence must be one tracked file")
    return relative


def _string_list(value: Any, label: str) -> list[str]:
    if not isinstance(value, list):
        raise FreshnessError(f"{label} must be an array")
    result: list[str] = []
    for index, entry in enumerate(value):
        if not isinstance(entry, str) or not entry:
            raise FreshnessError(f"{label}[{index}] must be a non-empty string")
        result.append(entry)
    if len(result) != len(set(result)):
        raise FreshnessError(f"{label} must not contain duplicates")
    return result


def latest_model_version(root: Path) -> str:
    history = root / ".docsfab/reference-model/shared/DOCSFAB-PRODUCT/history.md"
    _repository_file_sha256(
        root,
        ".docsfab/reference-model/shared/DOCSFAB-PRODUCT/history.md",
        "model history index",
    )
    try:
        lines = history.read_text(encoding="utf-8").splitlines()
    except OSError as exc:
        raise FreshnessError(f"cannot read model history {history}: {exc}") from exc
    for line in lines:
        match = HISTORY_VERSION_PATTERN.match(line)
        if match:
            return match.group(1)
    raise FreshnessError(f"cannot find a model version in {history}")


def source_thread_directories(root: Path) -> list[Path]:
    thread_root = root / ".docsfab/reference-model/source-threads"
    if not thread_root.is_dir() or thread_root.is_symlink():
        raise FreshnessError(f"source-thread root is not a regular directory: {thread_root}")
    directories: list[Path] = []
    try:
        entries = sorted(thread_root.iterdir())
    except OSError as exc:
        raise FreshnessError(f"cannot inspect source-thread root {thread_root}: {exc}") from exc
    for entry in entries:
        if entry.name == ".gitkeep" and entry.is_file() and not entry.is_symlink():
            continue
        if not entry.is_dir() or entry.is_symlink():
            raise FreshnessError(f"unexpected source-thread root entry: {entry}")
        required = {
            "thread.json": "file",
            "events.jsonl": "file",
            "items": "directory",
            "artifacts": "directory",
            "views": "directory",
        }
        for name, kind in required.items():
            path = entry / name
            valid = path.is_file() if kind == "file" else path.is_dir()
            if not valid or path.is_symlink():
                raise FreshnessError(
                    f"source thread {entry.name} requires a regular {kind}: {name}"
                )
        directories.append(entry)
    if not directories:
        raise FreshnessError(f"no source-thread records found under {thread_root}")
    return directories


def source_thread_heads(root: Path) -> dict[str, list[str]]:
    heads: dict[str, list[str]] = {}
    for thread_directory in source_thread_directories(root):
        path = thread_directory / "thread.json"
        record = _load_json(path)
        thread_id = record.get("thread_id")
        if not isinstance(thread_id, str) or not thread_id:
            raise FreshnessError(f"{path}.thread_id must be a non-empty string")
        if thread_id in heads:
            raise FreshnessError(f"duplicate source-thread ID: {thread_id}")
        heads[thread_id] = _string_list(record.get("head_event_ids"), f"{path}.head_event_ids")
    return heads


def validate_source_threads(root: Path, *, validator: Path | None = None) -> None:
    validator = validator or (
        root
        / "packages/knowledge/skills/register-source-thread/scripts/source_thread.py"
    )
    if not validator.is_file():
        raise FreshnessError(f"source-thread validator does not exist: {validator}")
    for thread_directory in source_thread_directories(root):
        result = subprocess.run(
            [
                sys.executable,
                str(validator),
                "validate",
                str(thread_directory),
                "--check-view",
            ],
            cwd=root,
            check=False,
            capture_output=True,
            text=True,
            timeout=30,
        )
        if result.returncode != 0:
            detail = result.stderr.strip() or result.stdout.strip() or "unknown validation error"
            relative = thread_directory.relative_to(root).as_posix()
            raise FreshnessError(f"source thread {relative} is invalid: {detail}")


def canonical_source_hashes(root: Path) -> dict[str, str]:
    paths: list[Path] = []
    for thread_directory in source_thread_directories(root):
        for path in thread_directory.rglob("*"):
            relative_to_thread = path.relative_to(thread_directory)
            if "views" in relative_to_thread.parts:
                continue
            if path.is_symlink():
                raise FreshnessError(f"canonical source path is symbolic: {path}")
            if path.is_file():
                paths.append(path)
    if not paths:
        raise FreshnessError("no canonical source-thread files found")
    return {
        path.relative_to(root).as_posix(): _repository_file_sha256(
            root, path.relative_to(root).as_posix(), "canonical source file"
        )
        for path in sorted(set(paths))
    }


def canonical_source_registry(root: Path) -> dict[str, dict[str, Any]]:
    registry: dict[str, dict[str, Any]] = {}
    for thread_directory in source_thread_directories(root):
        thread_path = thread_directory / "thread.json"
        thread = _load_json(thread_path)
        thread_id = _required_string(thread.get("thread_id"), f"{thread_path}.thread_id")
        event_path = thread_directory / "events.jsonl"
        try:
            event_lines = event_path.read_text(encoding="utf-8").splitlines()
            events = [json.loads(line) for line in event_lines if line]
        except (OSError, json.JSONDecodeError) as exc:
            raise FreshnessError(f"cannot read source event ledger {event_path}: {exc}") from exc
        event_by_id: dict[str, dict[str, Any]] = {}
        for index, event in enumerate(events):
            if not isinstance(event, dict):
                raise FreshnessError(f"{event_path}:{index + 1} must be a JSON object")
            event_id = _required_string(
                event.get("event_id"), f"{event_path}:{index + 1}.event_id"
            )
            event_by_id[event_id] = event
        item_ids = _string_list(thread.get("item_ids"), f"{thread_path}.item_ids")
        for item_id in item_ids:
            if item_id in registry:
                raise FreshnessError(f"duplicate canonical source item ID: {item_id}")
            item_path = thread_directory / "items" / f"{item_id}.json"
            item = _load_json(item_path)
            registrations = [
                event
                for event in events
                if event.get("event_type") == "item.registered"
                and event.get("item_id") == item_id
            ]
            if len(registrations) != 1:
                raise FreshnessError(
                    f"{item_path} must have exactly one item.registered event"
                )
            registration_event = registrations[0]
            registration_sequence = registration_event.get("sequence")
            if not isinstance(registration_sequence, int):
                raise FreshnessError(
                    f"{item_path} registration event must have an integer sequence"
                )
            registry[item_id] = {
                "events": event_by_id,
                "item": item,
                "registration_event": registration_event,
                "thread_id": thread_id,
            }
    return registry


def _expected_item_versions(item: dict[str, Any], label: str) -> set[str]:
    version = item.get("version")
    if not isinstance(version, dict):
        raise FreshnessError(f"{label}.version must be an object")
    kind = _required_string(version.get("kind"), f"{label}.version.kind")
    value = _required_string(version.get("value"), f"{label}.version.value")
    expected = {value} if ":" in value else {f"{kind}:{value}"}
    if kind == "content-hash" and ":" not in value:
        expected.add(f"sha256:{value}")
    if kind == "git-commit":
        expected.update({f"git:{value}", f"git-commit:{value}"})
    return expected


def _representation_integrities(
    item: dict[str, Any],
    representation_id: str,
    member_ids: list[str],
    label: str,
    *,
    legacy_item_level_for_members: bool = False,
) -> set[str]:
    item_representations = item.get("representations")
    members = item.get("members")
    if not isinstance(item_representations, list) or not isinstance(members, list):
        raise FreshnessError(f"{label} has malformed representations or members")
    member_by_id: dict[str, dict[str, Any]] = {}
    for index, member in enumerate(members):
        if not isinstance(member, dict):
            raise FreshnessError(f"{label}.members[{index}] must be an object")
        member_id = _required_string(
            member.get("member_id"), f"{label}.members[{index}].member_id"
        )
        member_by_id[member_id] = member
    unknown_members = sorted(set(member_ids) - set(member_by_id))
    if unknown_members:
        raise FreshnessError(
            f"{label} selects unknown members: {', '.join(unknown_members)}"
        )
    if member_ids and not legacy_item_level_for_members:
        if len(member_ids) != 1:
            raise FreshnessError(f"{label} must select exactly one collection member")
        member_id = member_ids[0]
        representations = member_by_id[member_id].get("representations")
        if not isinstance(representations, list):
            raise FreshnessError(
                f"{label}.members.{member_id}.representations must be an array"
            )
        candidates = [
            representation
            for representation in representations
            if isinstance(representation, dict)
            and representation.get("representation_id") == representation_id
        ]
    else:
        candidates = [
            representation
            for representation in item_representations
            if isinstance(representation, dict)
            and representation.get("representation_id") == representation_id
        ]
    if not candidates:
        selection = (
            f"selected member {member_ids[0]}"
            if len(member_ids) == 1 and not legacy_item_level_for_members
            else "item-level representations"
        )
        raise FreshnessError(
            f"{label} does not contain representation {representation_id} in {selection}"
        )
    integrities: set[str] = set()
    for index, representation in enumerate(candidates):
        integrity = representation.get("integrity")
        if not isinstance(integrity, dict):
            raise FreshnessError(f"{label} representation[{index}].integrity is invalid")
        algorithm = _required_string(
            integrity.get("algorithm"), f"{label} representation[{index}].algorithm"
        )
        value = _required_string(
            integrity.get("value"), f"{label} representation[{index}].value"
        )
        integrities.add(f"{algorithm}:{value}")
    return integrities


def _parse_timestamp(value: Any, label: str) -> datetime:
    timestamp = _required_string(value, label)
    try:
        parsed = datetime.fromisoformat(timestamp.replace("Z", "+00:00"))
    except ValueError as exc:
        raise FreshnessError(f"{label} must be an ISO 8601 timestamp") from exc
    if parsed.tzinfo is None:
        raise FreshnessError(f"{label} must include a timezone")
    return parsed.astimezone(timezone.utc)


def _thread_heads_at(
    canonical: dict[str, Any], cutoff: datetime, label: str
) -> set[str]:
    active_events: dict[str, dict[str, Any]] = {}
    for event_id, event in canonical["events"].items():
        occurred_at = _parse_timestamp(
            event.get("occurred_at"), f"{label}.events.{event_id}.occurred_at"
        )
        if occurred_at <= cutoff:
            active_events[event_id] = event
    if not active_events:
        raise FreshnessError(f"{label} has no events at the merge boundary")
    parent_ids: set[str] = set()
    for event_id, event in active_events.items():
        parents = _string_list(
            event.get("parent_event_ids"),
            f"{label}.events.{event_id}.parent_event_ids",
        )
        parent_ids.update(parent for parent in parents if parent in active_events)
    return set(active_events) - parent_ids


def _validate_source_item_reference(
    record: dict[str, Any],
    registry: dict[str, dict[str, Any]],
    label: str,
    *,
    merge_created_at: str,
    model_version: str,
) -> None:
    item_id = str(record["item_id"])
    canonical = registry.get(item_id)
    if canonical is None:
        raise FreshnessError(f"{label}.item_id is not registered: {item_id}")
    thread_id = str(record["source_thread_id"])
    if thread_id != canonical["thread_id"]:
        raise FreshnessError(
            f"{label}.source_thread_id is {thread_id}, expected {canonical['thread_id']}"
        )
    item = canonical["item"]
    version = str(record["version"])
    expected_versions = _expected_item_versions(item, f"canonical item {item_id}")
    if version not in expected_versions:
        raise FreshnessError(
            f"{label}.version is {version}, expected one of {sorted(expected_versions)}"
        )
    member_value = str(record["member_id"])
    member_ids = [] if member_value == "none" else [
        value.strip() for value in member_value.split(",")
    ]
    if any(not value for value in member_ids) or len(member_ids) != len(set(member_ids)):
        raise FreshnessError(f"{label}.member_id contains an invalid member list")
    legacy_members = LEGACY_MULTI_MEMBER_SELECTIONS.get((model_version, _legacy_id_key(item_id)))
    if len(member_ids) > 1 and set(member_ids) != legacy_members:
        raise FreshnessError(f"{label}.member_id must select exactly one member")
    representation_id = str(record["representation_id"])
    integrities = _representation_integrities(
        item,
        representation_id,
        member_ids,
        f"canonical item {item_id}",
        legacy_item_level_for_members=len(member_ids) > 1,
    )
    integrity = str(record["integrity"])
    if integrity not in integrities:
        raise FreshnessError(
            f"{label}.integrity is {integrity}, expected one of {sorted(integrities)}"
        )
    events = canonical["events"]
    cited_heads = set(record["thread_head_event_ids"])
    for event_id in cited_heads:
        if event_id not in events:
            raise FreshnessError(f"{label}.thread_head_event_ids contains {event_id}")
    merge_time = _parse_timestamp(merge_created_at, f"{label}.merge_created_at")
    registration_event = canonical["registration_event"]
    registration_time = _parse_timestamp(
        registration_event.get("occurred_at"),
        f"canonical item {item_id}.registration_event.occurred_at",
    )
    if registration_time > merge_time:
        raise FreshnessError(
            f"{label}.item_id {item_id} was registered after the merge boundary"
        )
    expected_heads = _thread_heads_at(
        canonical, merge_time, f"canonical thread {canonical['thread_id']}"
    )
    legacy_heads = LEGACY_THREAD_HEAD_SELECTIONS.get((model_version, _legacy_id_key(item_id)))
    cited_head_keys = {_legacy_id_key(event_id) for event_id in cited_heads}
    if cited_heads != expected_heads and cited_head_keys != legacy_heads:
        raise FreshnessError(
            f"{label}.thread_head_event_ids does not match the exact thread head "
            f"at {merge_created_at}; expected {sorted(expected_heads)}, "
            f"found {sorted(cited_heads)}"
        )


def _reject_yaml_comments(block: str, label: str) -> None:
    for line_number, line in enumerate(block.splitlines(), start=1):
        quote: str | None = None
        escaped = False
        index = 0
        while index < len(line):
            character = line[index]
            if quote == '"':
                if escaped:
                    escaped = False
                elif character == "\\":
                    escaped = True
                elif character == quote:
                    quote = None
            elif quote == "'":
                if character == "'" and index + 1 < len(line) and line[index + 1] == "'":
                    index += 1
                elif character == quote:
                    quote = None
            elif character in {'"', "'"}:
                quote = character
            elif character == "#" and (index == 0 or line[index - 1].isspace()):
                raise FreshnessError(
                    f"{label} line {line_number} contains an unsupported YAML comment"
                )
            index += 1


def _reject_empty_flow_entries(block: str, label: str) -> None:
    quote: str | None = None
    escaped = False
    index = 0
    while index < len(block):
        character = block[index]
        if quote == '"':
            if escaped:
                escaped = False
            elif character == "\\":
                escaped = True
            elif character == quote:
                quote = None
        elif quote == "'":
            if character == "'" and index + 1 < len(block) and block[index + 1] == "'":
                index += 1
            elif character == quote:
                quote = None
        elif character in {'"', "'"}:
            quote = character
        elif character == ",":
            following = index + 1
            while following < len(block) and block[following].isspace():
                following += 1
            if following < len(block) and block[following] in "]}":
                raise FreshnessError(f"{label} contains an empty trailing flow entry")
        index += 1


def _normalize_legacy_scalars(
    block: str, scalar_fields: set[str], label: str
) -> str:
    normalized: list[str] = []
    for line_number, line in enumerate(block.splitlines(), start=1):
        match = re.match(r"^(\s*)([a-z_]+):\s+(.+)$", line)
        if match is None or match.group(2) not in scalar_fields:
            normalized.append(line)
            continue
        indent, field, value = match.groups()
        value = value.rstrip()
        if value.startswith(("'", '"', "|", ">")):
            normalized.append(line)
            continue
        if (
            value.endswith(":")
            or value.startswith(("? ", "- ", ": ", "!", "&", "*"))
            or re.match(r"^[^\s:]+:\s", value)
        ):
            raise FreshnessError(
                f"{label} line {line_number} contains invalid legacy scalar syntax"
            )
        normalized.append(f"{indent}{field}: {json.dumps(value)}")
    return "\n".join(normalized) + ("\n" if block.endswith("\n") else "")


def _load_yaml_mapping(
    block: str,
    label: str,
    *,
    legacy_scalar_fields: set[str] | None = None,
) -> dict[str, Any]:
    _reject_yaml_comments(block, label)
    _reject_empty_flow_entries(block, label)
    parse_block = (
        _normalize_legacy_scalars(block, legacy_scalar_fields, label)
        if legacy_scalar_fields is not None
        else block
    )
    try:
        for token in yaml.scan(parse_block, Loader=_UniqueKeyLoader):
            if isinstance(token, (AliasToken, AnchorToken, TagToken)):
                raise FreshnessError(
                    f"{label} uses unsupported YAML aliases, anchors, or tags"
                )
        value = yaml.load(parse_block, Loader=_UniqueKeyLoader)
    except yaml.YAMLError as exc:
        raise FreshnessError(f"{label} is not valid contract YAML: {exc}") from exc
    if not isinstance(value, dict):
        raise FreshnessError(f"{label} must contain one YAML mapping")
    return value


def _require_exact_fields(value: dict[str, Any], fields: set[str], label: str) -> None:
    missing = fields - set(value)
    unexpected = set(value) - fields
    if missing:
        raise FreshnessError(f"{label} is missing fields: {', '.join(sorted(missing))}")
    if unexpected:
        raise FreshnessError(
            f"{label} has unsupported fields: {', '.join(sorted(unexpected))}"
        )


def _required_string(value: Any, label: str) -> str:
    if not isinstance(value, str) or not value.strip() or value in {"null", "~"}:
        raise FreshnessError(f"{label} must be a non-empty string")
    return value


def _yaml_string_list(value: Any, label: str, *, require_item: bool) -> list[str]:
    if not isinstance(value, list):
        raise FreshnessError(f"{label} must be a YAML sequence")
    if require_item and not value:
        raise FreshnessError(f"{label} must contain at least one item")
    result = [_required_string(entry, f"{label}[{index}]") for index, entry in enumerate(value)]
    if len(result) != len(set(result)):
        raise FreshnessError(f"{label} must not contain duplicates")
    return result


def _yaml_scope_mapping(value: Any, label: str, *, legacy: bool) -> None:
    if not isinstance(value, dict) or not value:
        raise FreshnessError(f"{label} must be a non-empty YAML mapping")
    for key, mapped in value.items():
        normalized_key = _required_string(key, f"{label} key")
        if isinstance(mapped, str):
            _required_string(mapped, f"{label}.{normalized_key}")
        elif legacy and isinstance(mapped, list):
            _yaml_string_list(
                mapped, f"{label}.{normalized_key}", require_item=True
            )
        else:
            raise FreshnessError(
                f"{label}.{normalized_key} must be a non-empty string"
            )


def _claim_mapping(
    block: str, label: str, *, legacy: bool = False
) -> dict[str, Any]:
    scalar_fields = CLAIM_REQUIRED_FIELDS - CLAIM_LIST_FIELDS - {"scope"}
    fields = _load_yaml_mapping(
        block,
        label,
        legacy_scalar_fields=scalar_fields if legacy else None,
    )
    _require_exact_fields(fields, CLAIM_REQUIRED_FIELDS, label)
    for field in CLAIM_LIST_FIELDS:
        _yaml_string_list(
            fields[field],
            f"{label}.{field}",
            require_item=field in {"source_claims", "exact_evidence"},
        )
    _yaml_scope_mapping(fields["scope"], f"{label}.scope", legacy=legacy)
    for field in scalar_fields:
        _required_string(fields[field], f"{label}.{field}")
    return fields


def validate_claim_contract(
    block: str | bytes,
    heading_id: str,
    label: str,
    *,
    model_version: str,
) -> dict[str, Any]:
    """Validate one indexed claim record with the canonical model contract."""

    if isinstance(block, bytes):
        try:
            block = block.decode("utf-8")
        except UnicodeDecodeError as exc:
            raise FreshnessError(f"{label} claim record is not UTF-8") from exc
    legacy = _version_key(model_version) < (0, 7)
    fields = _claim_mapping(block, label, legacy=legacy)
    claim_id = fields["claim_id"]
    if claim_id != heading_id:
        raise FreshnessError(f"{label} claim_id does not match its heading")
    for field, allowed in CLAIM_ENUMS.items():
        compatibility = allowed
        if legacy:
            compatibility = allowed | LEGACY_ENUM_EXTENSIONS.get(
                model_version, {}
            ).get(field, set())
        value = fields[field]
        if value not in compatibility:
            raise FreshnessError(f"{label}.{field} has unsupported value: {value}")
    return fields


def _validate_conflict_block(
    block: str, label: str, *, legacy: bool = False
) -> dict[str, Any]:
    scalar_fields = (
        CONFLICT_REQUIRED_FIELDS
        - {"adjudication", "blocks_targets", "source_variants"}
    ) | {"adjudicator", "authority_basis", "decided_at", "disposition", "rationale", "statement"}
    fields = _load_yaml_mapping(
        block,
        label,
        legacy_scalar_fields=scalar_fields if legacy else None,
    )
    _require_exact_fields(fields, CONFLICT_REQUIRED_FIELDS, label)
    for field in CONFLICT_REQUIRED_FIELDS - {
        "adjudication",
        "blocks_targets",
        "source_variants",
    }:
        _required_string(fields[field], f"{label}.{field}")
    _yaml_string_list(fields["blocks_targets"], f"{label}.blocks_targets", require_item=False)

    variants = fields["source_variants"]
    if not isinstance(variants, list) or not variants:
        raise FreshnessError(f"{label}.source_variants must be a non-empty YAML sequence")
    for index, variant in enumerate(variants):
        variant_label = f"{label}.source_variants[{index}]"
        if not isinstance(variant, dict):
            raise FreshnessError(f"{variant_label} must be a YAML mapping")
        _require_exact_fields(variant, CONFLICT_VARIANT_FIELDS, variant_label)
        _yaml_string_list(
            variant["source_claim_ids"],
            f"{variant_label}.source_claim_ids",
            require_item=True,
        )
        _yaml_string_list(
            variant["exact_evidence"],
            f"{variant_label}.exact_evidence",
            require_item=True,
        )
        _yaml_scope_mapping(
            variant["scope"], f"{variant_label}.scope", legacy=legacy
        )
        _required_string(variant["statement"], f"{variant_label}.statement")

    adjudication = fields["adjudication"]
    if not isinstance(adjudication, dict):
        raise FreshnessError(f"{label}.adjudication must be a YAML mapping")
    _require_exact_fields(adjudication, ADJUDICATION_FIELDS, f"{label}.adjudication")
    for field in ADJUDICATION_FIELDS - {"decision_evidence", "resulting_claim_ids"}:
        _required_string(adjudication[field], f"{label}.adjudication.{field}")
    for field in {"decision_evidence", "resulting_claim_ids"}:
        _yaml_string_list(
            adjudication[field],
            f"{label}.adjudication.{field}",
            require_item=not (legacy and fields["status"] != "resolved"),
        )
    return fields


def _merge_boundary(model_text: str, label: str) -> dict[str, Any]:
    try:
        block = _semantic_parser().top_level_merge_boundary_block(
            model_text.encode("utf-8"), label
        )
    except Exception as exc:
        raise FreshnessError(f"{label} merge boundary is invalid: {exc}") from exc
    boundary = _load_yaml_mapping(block.decode("utf-8"), f"{label} merge boundary")
    allowed = MERGE_REQUIRED_FIELDS | MERGE_OPTIONAL_FIELDS
    missing = MERGE_REQUIRED_FIELDS - set(boundary)
    unexpected = set(boundary) - allowed
    if missing:
        raise FreshnessError(
            f"{label} merge boundary is missing fields: {', '.join(sorted(missing))}"
        )
    if unexpected:
        raise FreshnessError(
            f"{label} merge boundary has unsupported fields: "
            f"{', '.join(sorted(unexpected))}"
        )
    for field in MERGE_REQUIRED_FIELDS - {
        "documentation_targets",
        "reviewers",
        "source_items",
    }:
        _required_string(boundary[field], f"{label} merge boundary.{field}")
    _yaml_string_list(
        boundary["documentation_targets"],
        f"{label} merge boundary.documentation_targets",
        require_item=True,
    )
    _yaml_string_list(
        boundary["reviewers"],
        f"{label} merge boundary.reviewers",
        require_item=False,
    )
    if boundary["approval_state"] not in MERGE_APPROVAL_STATES:
        raise FreshnessError(
            f"{label} merge boundary.approval_state is unsupported: "
            f"{boundary['approval_state']}"
        )
    return boundary


def _yaml_record_list(
    value: Any, required_fields: set[str], label: str, *, require_item: bool
) -> list[dict[str, Any]]:
    if not isinstance(value, list) or (require_item and not value):
        requirement = "a non-empty" if require_item else "a"
        raise FreshnessError(f"{label} must be {requirement} YAML sequence")
    records: list[dict[str, Any]] = []
    for index, record in enumerate(value):
        record_label = f"{label}[{index}]"
        if not isinstance(record, dict):
            raise FreshnessError(f"{record_label} must be a YAML mapping")
        _require_exact_fields(record, required_fields, record_label)
        records.append(record)
    return records


def _native_model(model_path: Path, model_text: str) -> dict[str, Any] | None:
    # parse_native raises ValueError only, and only for a malformed native envelope.
    try:
        return parse_native(model_text)
    except ValueError as exc:
        raise FreshnessError(f"{model_path} native envelope is invalid: {exc}") from exc


def _read_model_file(root: Path, path: Path, label: str) -> str:
    _reject_symlink_path(root, path.relative_to(root).as_posix(), label)
    if not path.is_file() or path.is_symlink():
        raise FreshnessError(f"{label} does not exist: {path}")
    try:
        return path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError) as exc:
        raise FreshnessError(f"cannot read {label} {path}: {exc}") from exc


def _legacy_ancestor(root: Path, model_root: Path, version: str) -> str:
    """Walk native parents, each strictly earlier, to the nearest legacy version."""
    current = version
    while True:
        model_path = model_root / current / "model.md"
        native = _native_model(model_path, _read_model_file(root, model_path, "native ancestor model"))
        if native is None:
            return current
        parent = native["parent"]["version"]
        if _version_key(parent) >= _version_key(current):
            raise FreshnessError(f"{model_path} native parent {parent} is not earlier")
        current = parent


def _top_level_visual_receipt(content: str, label: str) -> bytes | None:
    """Section 14's top-level visual-closure-receipt fence, from the synthesis parser's CommonMark index."""
    data = content.encode("utf-8")
    try:
        index = _semantic_parser()._markdown_index(data, label)
    except Exception as exc:
        raise FreshnessError(f"{label} Markdown is invalid: {exc}") from exc
    headings = [heading for heading in index["headings"] if heading["level"] == 0]
    sections = [heading for heading in headings if heading["rank"] == 2 and re.match(r"^14\.\s+", heading["text"])]
    if len(sections) > 1:
        raise FreshnessError(f"{label} contains more than one section 14")
    if not sections:
        return None
    end = min((heading["start"] for heading in headings
               if heading["rank"] <= 2 and heading["start"] > sections[0]["start"]), default=len(data))
    fences = [fence for fence in index["fences"] if fence["level"] == 0 and fence["info"] == "yaml visual-closure-receipt"
              and sections[0]["end"] <= fence["start"] < end]
    if len(fences) > 1:
        raise FreshnessError(f"{label} section 14 contains more than one visual-closure receipt")
    return data[fences[0]["start"]:fences[0]["end"]].removesuffix(b"\n").removesuffix(b"\r") if fences else None


def native_report_records(report_text: str, report_path: Path | str) -> tuple[list[dict[str, Any]], bool]:
    """A native version's conflict records, and whether its report states that none were found."""

    try:
        conflict_sections = [
            (heading_id, block.decode("utf-8"))
            for heading_id, block in _semantic_parser().top_level_conflict_blocks(
                report_text.encode("utf-8"), str(report_path)
            )
        ]
    except Exception as exc:
        raise FreshnessError(f"{report_path} conflict records are invalid: {exc}") from exc
    records: list[dict[str, Any]] = []
    for heading_id, block in conflict_sections:
        label = f"{report_path}:{heading_id}"
        fields = _validate_conflict_block(block, label)
        if fields["conflict_id"] != heading_id:
            raise FreshnessError(f"{label} conflict_id does not match its heading")
        for field, allowed in CONFLICT_ENUMS.items():
            value = fields["adjudication"]["disposition"] if field == "disposition" else fields[field]
            if value not in allowed:
                raise FreshnessError(f"{label}.{field} has unsupported value: {value}")
        records.append(fields)
    if len({record["conflict_id"] for record in records}) != len(records):
        raise FreshnessError(f"{report_path} contains duplicate conflict IDs")
    states_none = _semantic_parser().top_level_states_no_inconsistencies(report_text.encode("utf-8"), str(report_path))
    return records, states_none


def native_decision_binding(
    records: list[dict[str, Any]], native: dict[str, Any], report_path: Path | str
) -> list[dict[str, Any]]:
    """The conflict records that decide a native version's claim change; none for a record-only version.

    A record binds the change when it cites the version's registered item and names
    the changed claim. The changed claim is canonical only once it is decided, so
    every binding record must be `resolved` with an adjudication disposition other
    than `none`: the materializer's unapproved rendering (`open`, `none`) is refused.
    """

    change = native["change"]
    if change is None:
        return []
    item_id = native["sourceRegistration"]["itemId"]
    binding = [record for record in records
               if item_id in record["adjudication"]["decision_evidence"]
               and change["claimId"] in record["adjudication"]["resulting_claim_ids"]]
    if not binding:
        raise FreshnessError(
            f"{report_path} must record the adjudication of {change['claimId']} citing {item_id}"
        )
    undecided = sorted(record["conflict_id"] for record in binding
                       if record["status"] != "resolved" or record["adjudication"]["disposition"] == "none")
    if undecided:
        raise FreshnessError(
            f"{report_path} changes {change['claimId']} without a decision: "
            f"{', '.join(undecided)} must be resolved with a disposition other than none"
        )
    return binding


def validate_native_model(
    root: Path,
    model_version: str,
    registry: dict[str, dict[str, Any]],
    *,
    model_id: str = "DOCSFAB-PRODUCT",
) -> None:
    """Validate a native product-feedback version: envelope, lineage, registration, record and receipt."""

    model_root = root / ".docsfab/reference-model/shared" / model_id
    version_root = model_root / model_version
    model_path = version_root / "model.md"
    report_path = version_root / "inconsistency-report.md"
    receipt_path = version_root / "merge-receipt.md"
    native = _native_model(model_path, _read_model_file(root, model_path, "native model"))
    if native is None:
        raise FreshnessError(f"{model_path} is not a native product-feedback model")
    report_text = _read_model_file(root, report_path, "native inconsistency report")
    receipt_text = _read_model_file(root, receipt_path, "native merge receipt")
    if native["modelId"] != model_id or native["version"] != model_version:
        raise FreshnessError(f"{model_path} must declare native model {model_id} {model_version}")
    parent = native["parent"]["version"]
    history_versions = [
        match.group(1)
        for line in _read_model_file(root, model_root / "history.md", "model history index").splitlines()
        if (match := HISTORY_VERSION_PATTERN.match(line))
    ]
    if _version_key(parent) >= _version_key(model_version) or parent not in history_versions:
        raise FreshnessError(f"{model_path} parent {parent} must be an earlier version listed in the model history")
    registration = native["sourceRegistration"]
    item_id = registration["itemId"]
    canonical = registry.get(item_id)
    if canonical is None or canonical["thread_id"] != registration["threadId"]:
        raise FreshnessError(f"{model_path} registration item {item_id} is not registered in {registration['threadId']}")

    records, states_none = native_report_records(report_text, report_path)
    change = native["change"]
    if not records and not states_none:
        raise FreshnessError(f"{report_path} must contain conflict records or state that none were found")
    # Record-only: no claim changed, so nothing was decided and the report records no conflict.
    if change is None and records:
        raise FreshnessError(f"{report_path} records conflicts for a record-only version")
    binding = native_decision_binding(records, native, report_path)

    final_receipt_section = 14 if _version_key(model_version) >= (0, 29) else 13
    for section_number in range(1, final_receipt_section + 1):
        if not re.search(rf"^##\s+{section_number}\.\s+", receipt_text, re.MULTILINE):
            raise FreshnessError(
                f"{receipt_path} is missing required receipt section {section_number}"
            )
    transitions = re.search(r"^##\s+13\.\s+.*?(?=^##\s|\Z)", receipt_text, re.MULTILINE | re.DOTALL)
    named = transitions.group(0) if transitions else ""
    if "inconsistency-report.md" not in named or any(record["conflict_id"] not in named for record in binding):
        raise FreshnessError(f"{receipt_path} section 13 must name the inconsistency report and its conflict IDs")
    ancestor = _legacy_ancestor(root, model_root, parent)
    ancestor_receipt = model_root / ancestor / "merge-receipt.md"
    expected = _top_level_visual_receipt(
        _read_model_file(root, ancestor_receipt, "legacy ancestor merge receipt"), str(ancestor_receipt)
    )
    if _top_level_visual_receipt(receipt_text, str(receipt_path)) != expected:
        raise FreshnessError(
            f"{receipt_path} section 14 must carry the visual-closure receipt of legacy ancestor {ancestor} unchanged"
        )


def model_source_item_dispositions(
    model_path: Path,
    registry: dict[str, dict[str, Any]] | None = None,
) -> dict[str, str]:
    try:
        model_text = model_path.read_text(encoding="utf-8")
    except OSError as exc:
        raise FreshnessError(f"cannot read model {model_path}: {exc}") from exc
    native = _native_model(model_path, model_text)
    if native is not None:
        item_id = native["sourceRegistration"]["itemId"]
        if registry is not None and item_id not in registry:
            raise FreshnessError(f"{model_path} registration item is not registered: {item_id}")
        return {item_id: "included"}
    boundary = _merge_boundary(model_text, str(model_path))
    model_version = str(boundary["model_version"])
    merge_created_at = str(boundary["created_at"])
    source_items = _yaml_record_list(
        boundary["source_items"],
        SOURCE_ITEM_FIELDS,
        f"{model_path}.source_items",
        require_item=True,
    )
    dispositions: dict[str, str] = {}
    for index, record in enumerate(source_items):
        record_label = f"{model_path}.source_items[{index}]"
        for field in SOURCE_ITEM_FIELDS - {"thread_head_event_ids"}:
            _required_string(record[field], f"{record_label}.{field}")
        _yaml_string_list(
            record["thread_head_event_ids"],
            f"{record_label}.thread_head_event_ids",
            require_item=True,
        )
        item_id = str(record["item_id"])
        if not re.fullmatch(r"ITEM-[A-Za-z0-9._-]+", item_id):
            raise FreshnessError(f"{record_label}.item_id is invalid")
        if item_id in dispositions:
            raise FreshnessError(f"{model_path} contains duplicate source item {item_id}")
        if registry is not None:
            _validate_source_item_reference(
                record,
                registry,
                record_label,
                merge_created_at=merge_created_at,
                model_version=model_version,
            )
        dispositions[item_id] = "included"
    explicit = _yaml_record_list(
        boundary.get("source_item_dispositions", []),
        SOURCE_ITEM_DISPOSITION_FIELDS,
        f"{model_path}.source_item_dispositions",
        require_item=False,
    )
    for index, record in enumerate(explicit):
        record_label = f"{model_path}.source_item_dispositions[{index}]"
        for field in SOURCE_ITEM_DISPOSITION_FIELDS:
            _required_string(record[field], f"{record_label}.{field}")
        item_id = str(record["item_id"])
        disposition = str(record["disposition"])
        if not re.fullmatch(r"ITEM-[A-Za-z0-9._-]+", item_id):
            raise FreshnessError(f"{record_label}.item_id is invalid")
        if disposition not in SOURCE_ITEM_DISPOSITIONS:
            raise FreshnessError(
                f"{record_label}.disposition is unsupported: {disposition}"
            )
        if item_id in dispositions:
            raise FreshnessError(
                f"{model_path} gives source item {item_id} more than one disposition"
            )
        if registry is not None and item_id not in registry:
            raise FreshnessError(f"{record_label}.item_id is not registered: {item_id}")
        dispositions[item_id] = disposition
    return dispositions


def validate_current_model(
    root: Path,
    model_version: str,
    registry: dict[str, dict[str, Any]] | None = None,
    *,
    model_id: str = "DOCSFAB-PRODUCT",
    visual_validator: Path | None = None,
) -> None:
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]*", model_id):
        raise FreshnessError("model ID must be a path segment")
    model_root = root / ".docsfab/reference-model/shared" / model_id
    version_root = model_root / model_version
    model_path = version_root / "model.md"
    report_path = version_root / "inconsistency-report.md"
    receipt_path = version_root / "merge-receipt.md"
    for path in (model_path, report_path, receipt_path):
        relative = path.relative_to(root).as_posix()
        _reject_symlink_path(root, relative, "model package file")
        if not path.is_file() or path.is_symlink():
            raise FreshnessError(f"current model package file does not exist: {path}")
    try:
        model_text = model_path.read_text(encoding="utf-8")
        report_text = report_path.read_text(encoding="utf-8")
        receipt_text = receipt_path.read_text(encoding="utf-8")
    except OSError as exc:
        raise FreshnessError(f"cannot read current model package: {exc}") from exc

    if registry is None:
        validate_source_threads(root)
        registry = canonical_source_registry(root)
    # A native version has no merge boundary and changes no governed visual; its receipt carries the legacy closure.
    if model_text.startswith(NATIVE_MARKER):
        validate_native_model(root, model_version, registry, model_id=model_id)
        return
    model_source_item_dispositions(model_path, registry)
    if _version_key(model_version) >= (0, 29):
        validate_governed_visual_closure(root, model_path, report_path, receipt_path,
                                        validator=visual_validator)

    declared_version = _merge_boundary(model_text, str(model_path))["model_version"]
    if declared_version != model_version:
        raise FreshnessError(
            f"{model_path} must declare model_version {model_version} exactly once"
        )
    try:
        claim_sections = [
            (heading_id, block.decode("utf-8"))
            for heading_id, block in _semantic_parser().top_level_claim_blocks(
                model_text.encode("utf-8"), str(model_path)
            )
        ]
    except Exception as exc:
        raise FreshnessError(f"{model_path} claim records are invalid: {exc}") from exc
    if not claim_sections:
        raise FreshnessError(f"{model_path} contains no claim decision records")
    claim_ids: list[str] = []
    for heading_id, block in claim_sections:
        label = f"{model_path}:{heading_id}"
        claim_ids.append(
            validate_claim_contract(
                block, heading_id, label, model_version=model_version
            )["claim_id"]
        )
    if len(claim_ids) != len(set(claim_ids)):
        raise FreshnessError(f"{model_path} contains duplicate claim IDs")

    try:
        conflict_sections = [
            (heading_id, block.decode("utf-8"))
            for heading_id, block in _semantic_parser().top_level_conflict_blocks(
                report_text.encode("utf-8"), str(report_path)
            )
        ]
    except Exception as exc:
        raise FreshnessError(f"{report_path} conflict records are invalid: {exc}") from exc
    conflict_ids: list[str] = []
    for heading_id, block in conflict_sections:
        label = f"{report_path}:{heading_id}"
        fields = _validate_conflict_block(block, label)
        conflict_id = fields["conflict_id"]
        if conflict_id != heading_id:
            raise FreshnessError(f"{label} conflict_id does not match its heading")
        conflict_ids.append(conflict_id)
        for field, allowed in CONFLICT_ENUMS.items():
            value = (
                fields["adjudication"]["disposition"]
                if field == "disposition"
                else fields[field]
            )
            if value not in allowed:
                raise FreshnessError(f"{label}.{field} has unsupported value: {value}")
    if len(conflict_ids) != len(set(conflict_ids)):
        raise FreshnessError(f"{report_path} contains duplicate conflict IDs")
    if not conflict_sections and not _semantic_parser().top_level_states_no_inconsistencies(
        report_text.encode("utf-8"), str(report_path)
    ):
        raise FreshnessError(
            f"{report_path} must contain conflict records or state that none were found"
        )

    final_receipt_section = 14 if _version_key(model_version) >= (0, 29) else 13
    for section_number in range(1, final_receipt_section + 1):
        if not re.search(rf"^##\s+{section_number}\.\s+", receipt_text, re.MULTILINE):
            raise FreshnessError(
                f"{receipt_path} is missing required receipt section {section_number}"
            )


def validate_governed_visual_closure(
    root: Path, model_path: Path, report_path: Path, receipt_path: Path,
    *, validator: Path | None = None,
) -> None:
    """Run the named direct-representation validator for a current model."""

    validator = validator or (
        root
        / "packages/knowledge/skills/synthesize-source-threads/scripts/validate_visual_closure.py"
    )
    if not validator.is_file():
        raise FreshnessError(f"visual closure validator does not exist: {validator}")
    result = subprocess.run(
        [
            sys.executable,
            str(validator),
            str(model_path),
            str(report_path),
            str(receipt_path),
            str(root / ".docsfab/reference-model/source-threads"),
            str(model_path.parent.parent),
        ],
        cwd=root,
        check=False,
        capture_output=True,
        text=True,
        timeout=30,
    )
    if result.returncode != 0:
        detail = result.stderr.strip() or result.stdout.strip() or "unknown validation error"
        raise FreshnessError(f"governed visual closure is invalid: {detail}")


def _version_key(model_version: str) -> tuple[int, int]:
    match = re.fullmatch(r"v(\d+)\.(\d+)", model_version)
    if match is None:
        raise FreshnessError(f"invalid model version: {model_version}")
    return int(match.group(1)), int(match.group(2))


def _validate_legacy_model(
    root: Path,
    model_version: str,
    registry: dict[str, dict[str, Any]],
) -> None:
    version_root = root / ".docsfab/reference-model/shared/DOCSFAB-PRODUCT" / model_version
    model_path = version_root / "model.md"
    report_path = version_root / "inconsistency-report.md"
    receipt_path = version_root / "merge-receipt.md"
    try:
        model_text = model_path.read_text(encoding="utf-8")
        report_text = report_path.read_text(encoding="utf-8")
        receipt_text = receipt_path.read_text(encoding="utf-8")
    except OSError as exc:
        raise FreshnessError(f"cannot read legacy model package {model_version}: {exc}") from exc
    model_source_item_dispositions(model_path, registry)
    declared_version = _merge_boundary(model_text, str(model_path))["model_version"]
    if declared_version != model_version:
        raise FreshnessError(
            f"{model_path} must declare model_version {model_version} exactly once"
        )
    try:
        sections = [
            (heading_id, block.decode("utf-8"))
            for heading_id, block in _semantic_parser().top_level_claim_blocks(
                model_text.encode("utf-8"), str(model_path)
            )
        ]
    except Exception as exc:
        raise FreshnessError(f"{model_path} legacy claim records are invalid: {exc}") from exc
    if not sections:
        raise FreshnessError(f"{model_path} contains a malformed legacy claim block")
    claim_ids: list[str] = []
    for heading_id, block in sections:
        label = f"{model_path}:{heading_id}"
        claim_ids.append(
            validate_claim_contract(
                block, heading_id, label, model_version=model_version
            )["claim_id"]
        )
    if len(claim_ids) != len(set(claim_ids)):
        raise FreshnessError(f"{model_path} contains duplicate claim IDs")

    try:
        conflict_sections = [
            (heading_id, block.decode("utf-8"))
            for heading_id, block in _semantic_parser().top_level_conflict_blocks(
                report_text.encode("utf-8"), str(report_path)
            )
        ]
    except Exception as exc:
        raise FreshnessError(f"{report_path} legacy conflict records are invalid: {exc}") from exc
    conflict_ids: list[str] = []
    for heading_id, block in conflict_sections:
        label = f"{report_path}:{heading_id}"
        fields = _validate_conflict_block(block, label, legacy=True)
        conflict_id = fields["conflict_id"]
        if conflict_id != heading_id:
            raise FreshnessError(f"{label} conflict_id does not match its heading")
        conflict_ids.append(conflict_id)
        for field, allowed in CONFLICT_ENUMS.items():
            compatibility = allowed | LEGACY_CONFLICT_ENUM_EXTENSIONS.get(
                model_version, {}
            ).get(field, set())
            value = (
                fields["adjudication"]["disposition"]
                if field == "disposition"
                else fields[field]
            )
            if value not in compatibility:
                raise FreshnessError(f"{label}.{field} has unsupported value: {value}")
    if len(conflict_ids) != len(set(conflict_ids)):
        raise FreshnessError(f"{report_path} contains duplicate conflict IDs")
    if not conflict_sections and not _semantic_parser().top_level_states_no_inconsistencies(
        report_text.encode("utf-8"), str(report_path)
    ):
        raise FreshnessError(
            f"{report_path} must contain conflict records or state that none were found"
        )
    for section_number in range(1, 14):
        if not re.search(rf"^##\s+{section_number}\.\s+", receipt_text, re.MULTILINE):
            raise FreshnessError(
                f"{receipt_path} is missing required receipt section {section_number}"
            )


def model_history_packages(
    root: Path,
    registry: dict[str, dict[str, Any]] | None = None,
) -> dict[str, list[Path]]:
    model_root = root / ".docsfab/reference-model/shared/DOCSFAB-PRODUCT"
    history = model_root / "history.md"
    if not model_root.is_dir() or model_root.is_symlink():
        raise FreshnessError(f"model history root is not a regular directory: {model_root}")
    history_relative = history.relative_to(root).as_posix()
    _reject_symlink_path(root, history_relative, "model history index")
    if not history.is_file() or history.is_symlink():
        raise FreshnessError(f"model history index is not a regular file: {history}")
    try:
        history_text = history.read_text(encoding="utf-8")
        entries = sorted(model_root.iterdir())
    except OSError as exc:
        raise FreshnessError(f"cannot inspect model history {model_root}: {exc}") from exc
    versions = [
        match.group(1)
        for line in history_text.splitlines()
        if (match := HISTORY_VERSION_PATTERN.match(line))
    ]
    if not versions or len(versions) != len(set(versions)):
        raise FreshnessError("model history must declare unique model versions")
    allowed_root_entries = {"history.md", *versions}
    actual_root_entries = {entry.name for entry in entries}
    if actual_root_entries != allowed_root_entries:
        unexpected = sorted(actual_root_entries - allowed_root_entries)
        missing = sorted(allowed_root_entries - actual_root_entries)
        raise FreshnessError(
            "model history namespace mismatch; "
            f"unexpected={unexpected}, missing={missing}"
        )
    if registry is None:
        validate_source_threads(root)
        registry = canonical_source_registry(root)
    packages: dict[str, list[Path]] = {}
    required_names = {"inconsistency-report.md", "merge-receipt.md", "model.md"}
    for version in versions:
        directory = model_root / version
        if not directory.is_dir() or directory.is_symlink():
            raise FreshnessError(f"model version is not a regular directory: {directory}")
        try:
            package_entries = sorted(directory.iterdir())
        except OSError as exc:
            raise FreshnessError(f"cannot inspect model package {directory}: {exc}") from exc
        actual_names = {entry.name for entry in package_entries}
        if actual_names != required_names:
            raise FreshnessError(
                f"model package {version} namespace mismatch; "
                f"unexpected={sorted(actual_names - required_names)}, "
                f"missing={sorted(required_names - actual_names)}"
            )
        for entry in package_entries:
            relative = entry.relative_to(root).as_posix()
            _reject_symlink_path(root, relative, "model history file")
            if not entry.is_file() or entry.is_symlink():
                raise FreshnessError(f"model history file is not regular: {entry}")
        if _version_key(version) >= (0, 7):
            validate_current_model(root, version, registry)
        else:
            _validate_legacy_model(root, version, registry)
        packages[version] = package_entries
    return packages


def model_history_hashes(
    root: Path,
    registry: dict[str, dict[str, Any]] | None = None,
) -> dict[str, str]:
    model_root = root / ".docsfab/reference-model/shared/DOCSFAB-PRODUCT"
    packages = model_history_packages(root, registry)
    paths = [root / ".docsfab/reference-model/README.md", model_root / "history.md"]
    for package_paths in packages.values():
        paths.extend(package_paths)
    return {
        path.relative_to(root).as_posix(): _repository_file_sha256(
            root, path.relative_to(root).as_posix(), "model history file"
        )
        for path in sorted(set(paths))
    }


def unaccounted_source_items(
    root: Path,
    registry: dict[str, dict[str, Any]] | None = None,
) -> list[dict[str, str]]:
    if registry is None:
        validate_source_threads(root)
        registry = canonical_source_registry(root)
    packages = model_history_packages(root, registry)
    accounted_item_ids: set[str] = set()
    for package_paths in packages.values():
        model_path = next(path for path in package_paths if path.name == "model.md")
        dispositions = model_source_item_dispositions(model_path, registry)
        accounted_item_ids.update(dispositions)

    missing: list[dict[str, str]] = []
    for item_id, canonical in registry.items():
        if item_id not in accounted_item_ids:
            missing.append(
                {"thread_id": canonical["thread_id"], "item_id": item_id}
            )
    return missing


def documentation_paths(root: Path) -> list[str]:
    navigation = root / "fern/docs.yml"
    _repository_file_sha256(root, "fern/docs.yml", "Fern navigation")
    try:
        lines = navigation.read_text(encoding="utf-8").splitlines()
    except OSError as exc:
        raise FreshnessError(f"cannot read Fern navigation {navigation}: {exc}") from exc
    paths = {"README.md"}
    for line in lines:
        match = NAV_PATH_PATTERN.match(line)
        if match:
            paths.add(_safe_relative_path(match.group(1), "Fern page path"))
    if len(paths) == 1:
        raise FreshnessError(f"no documentation pages found in {navigation}")
    return sorted(paths)


def documentation_hashes(root: Path, paths: list[str]) -> dict[str, str]:
    hashes: dict[str, str] = {}
    for index, value in enumerate(paths):
        relative = _safe_relative_path(value, f"documentation_paths[{index}]")
        hashes[relative] = _repository_file_sha256(
            root, relative, "documentation path"
        )
    return hashes


def _repository_boundary(
    paths: list[str], excluded_paths: list[str] | None
) -> tuple[list[str], set[str]]:
    normalized = [
        _safe_relative_path(value, f"repository_paths[{index}]")
        for index, value in enumerate(paths)
    ]
    if len(normalized) != len(set(normalized)):
        raise FreshnessError("repository_paths must not contain duplicates")
    excluded = {
        _safe_relative_path(value, f"excluded_paths[{index}]")
        for index, value in enumerate(excluded_paths or [])
    }
    return normalized, excluded


def repository_digest(
    root: Path, paths: list[str], *, excluded_paths: list[str] | None = None
) -> str:
    normalized, excluded = _repository_boundary(paths, excluded_paths)
    output = _git(
        root,
        ["ls-files", "--cached", "--others", "--exclude-standard", "-z", "--", *normalized],
    )
    try:
        decoded_paths = [entry.decode("utf-8") for entry in output.split(b"\0") if entry]
    except UnicodeDecodeError as exc:
        raise FreshnessError("Git returned a non-UTF-8 watched repository path") from exc
    tracked_paths = sorted(path for path in decoded_paths if path not in excluded)
    if not tracked_paths:
        raise FreshnessError("repository watch boundary matched no files")
    digest = hashlib.sha256()
    for relative in tracked_paths:
        safe = _safe_relative_path(relative, "watched repository file")
        path = root / safe
        digest.update(len(safe.encode("utf-8")).to_bytes(8, "big"))
        digest.update(safe.encode("utf-8"))
        _reject_symlink_path(root, safe, "watched repository file")
        try:
            mode = path.lstat().st_mode
        except FileNotFoundError:
            digest.update(b"missing\0")
            continue
        except OSError as exc:
            raise FreshnessError(f"cannot inspect watched repository file {safe}: {exc}") from exc
        if stat.S_ISREG(mode):
            digest.update(b"file\0")
            digest.update(bytes.fromhex(_sha256_file(path)))
        else:
            raise FreshnessError(f"watched repository path is not a regular file: {safe}")
    return digest.hexdigest()


def _batch_git_blobs(root: Path, object_ids: list[str], *,
                     ignore_replace_objects: bool = False) -> dict[str, bytes]:
    unique_ids = sorted(set(object_ids))
    request = "".join(f"{object_id}\n" for object_id in unique_ids).encode("ascii")
    try:
        result = subprocess.run(
            ["git", *(["--no-replace-objects"] if ignore_replace_objects else []), "cat-file", "--batch"],
            cwd=root,
            input=request,
            check=False,
            capture_output=True,
            timeout=60,
        )
    except (OSError, ValueError) as exc:
        raise FreshnessError(f"cannot read watched Git blobs: {exc}") from exc
    if result.returncode != 0:
        detail = result.stderr.decode("utf-8", errors="replace").strip()
        raise FreshnessError(f"git cat-file --batch failed: {detail}")
    blobs: dict[str, bytes] = {}
    cursor = 0
    for expected_id in unique_ids:
        line_end = result.stdout.find(b"\n", cursor)
        if line_end < 0:
            raise FreshnessError("git cat-file returned a truncated blob header")
        try:
            object_id, object_type, size_text = result.stdout[cursor:line_end].decode(
                "ascii"
            ).split(" ")
            size = int(size_text)
        except (UnicodeDecodeError, ValueError) as exc:
            raise FreshnessError("git cat-file returned an invalid blob header") from exc
        if object_id != expected_id or object_type != "blob" or size < 0:
            raise FreshnessError(f"Git object is not the expected blob: {expected_id}")
        start = line_end + 1
        end = start + size
        if end >= len(result.stdout) or result.stdout[end : end + 1] != b"\n":
            raise FreshnessError("git cat-file returned truncated blob bytes")
        blobs[object_id] = result.stdout[start:end]
        cursor = end + 1
    if cursor != len(result.stdout):
        raise FreshnessError("git cat-file returned unexpected trailing bytes")
    return blobs


def repository_digest_at_revision(
    root: Path,
    paths: list[str],
    revision: str,
    *,
    excluded_paths: list[str] | None = None,
) -> str:
    normalized, excluded = _repository_boundary(paths, excluded_paths)
    commit = _resolve_commit(root, revision, "repository snapshot revision")
    output = _git(
        root,
        ["ls-tree", "-r", "-z", "--full-tree", commit, "--", *normalized],
        timeout=30,
    )
    entries: list[tuple[str, str]] = []
    for raw_entry in (entry for entry in output.split(b"\0") if entry):
        try:
            metadata, raw_path = raw_entry.split(b"\t", 1)
            mode, object_type, object_id = metadata.decode("ascii").split(" ")
            relative = raw_path.decode("utf-8")
        except (UnicodeDecodeError, ValueError) as exc:
            raise FreshnessError("git ls-tree returned an invalid watched entry") from exc
        safe = _safe_relative_path(relative, "watched repository revision path")
        if safe in excluded:
            continue
        if object_type != "blob" or mode not in {"100644", "100755"}:
            raise FreshnessError(
                f"watched repository revision path is not a regular file: {safe}"
            )
        if not re.fullmatch(r"[a-f0-9]{40,64}", object_id):
            raise FreshnessError(f"Git returned an invalid object ID for {safe}")
        entries.append((safe, object_id))
    if not entries:
        raise FreshnessError("repository revision watch boundary matched no files")
    entries.sort()
    blobs = _batch_git_blobs(root, [object_id for _, object_id in entries])
    digest = hashlib.sha256()
    for relative, object_id in entries:
        encoded = relative.encode("utf-8")
        digest.update(len(encoded).to_bytes(8, "big"))
        digest.update(encoded)
        digest.update(b"file\0")
        digest.update(bytes.fromhex(_sha256_bytes(blobs[object_id])))
    return digest.hexdigest()


def _parse_check(value: str) -> dict[str, str]:
    parts = value.split("=", 2)
    if len(parts) == 2:
        name, evidence = parts
        status = "passed"
    elif len(parts) == 3:
        name, status, evidence = parts
    else:
        raise FreshnessError(
            "--check must use NAME=EVIDENCE or NAME=STATUS=EVIDENCE"
        )
    if not name.strip() or not evidence.strip() or status.strip() not in CHECK_STATUSES:
        raise FreshnessError(
            "--check requires a name, passed|pending|failed status, and evidence"
        )
    return {
        "name": name.strip(),
        "status": status.strip(),
        "evidence": evidence.strip(),
    }


def _parse_readiness(value: str) -> dict[str, str]:
    parts = [part.strip() for part in value.split("|", 3)]
    if len(parts) != 4 or not all(parts):
        raise FreshnessError(
            "--readiness must use TARGET|STATUS|OWNER|EVIDENCE with non-empty values"
        )
    target, status, owner, evidence = parts
    if status not in READINESS_STATUSES:
        raise FreshnessError(
            "--readiness status must be ready, partial, blocked, or not-assessed"
        )
    return {"target": target, "status": status, "owner": owner, "evidence": evidence}


def _parse_blocked_target(value: str) -> dict[str, str]:
    parts = [part.strip() for part in value.split("|", 2)]
    if len(parts) != 3 or not all(parts):
        raise FreshnessError(
            "--blocked-target must use TARGET|OWNER|REASON with non-empty values"
        )
    target, owner, reason = parts
    return {"target": target, "owner": owner, "reason": reason}


def _strong_review_value(token: Any) -> str | None:
    if token.type != "inline" or token.children is None:
        return None
    children = [
        child
        for child in token.children
        if child.type != "text" or child.content
    ]
    if [child.type for child in children] != [
        "strong_open",
        "text",
        "strong_close",
    ]:
        return None
    if children[0].markup != "**" or children[2].markup != "**":
        return None
    return children[1].content


def _review_target_value(token: Any, prefix: str) -> str | None:
    if token.type != "inline" or token.children is None:
        return None
    children = [
        child
        for child in token.children
        if child.type != "text" or child.content
    ]
    if [child.type for child in children] != ["text", "code_inline"]:
        return None
    if children[0].content != prefix or children[1].markup != "`":
        return None
    return children[1].content


def _assert_review_report(
    report: bytes,
    *,
    reviewed_commit: str,
    reviewed_tree: str,
    label: str,
) -> None:
    try:
        text = report.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise FreshnessError(f"{label} must be UTF-8 Markdown") from exc
    try:
        tokens = MarkdownIt("commonmark").parse(text)
    except (RuntimeError, ValueError) as exc:
        raise FreshnessError(f"{label} is not parseable CommonMark") from exc
    stack: list[Any] = []
    verdict_headings: list[int] = []
    verdict_values: list[tuple[int, str]] = []
    target_values: list[tuple[str, int]] = []
    tree_values: list[tuple[str, int]] = []
    list_item_block_counts: dict[int, int] = {}
    authority_paragraphs: set[int] = set()
    verdict_names = {"PASS", "BLOCK", "FAIL", "FAILED", "PENDING"}
    for index, token in enumerate(tokens):
        if token.nesting == -1:
            if not stack or stack[-1].type.removesuffix("_open") != token.type.removesuffix(
                "_close"
            ):
                raise FreshnessError(f"{label} has malformed CommonMark nesting")
            stack.pop()
            continue
        context = [entry.type for entry in stack]
        if token.nesting == 1 and context == ["bullet_list_open", "list_item_open"]:
            item_identity = id(stack[-1])
            block_count = list_item_block_counts.get(item_identity, 0)
            if token.type == "paragraph_open" and block_count == 0:
                authority_paragraphs.add(id(token))
            list_item_block_counts[item_identity] = block_count + 1
        if (
            token.type == "inline"
            and context == ["heading_open"]
            and stack[-1].tag == "h2"
            and stack[-1].markup == "##"
            and token.content == "Verdict"
        ):
            verdict_headings.append(index - 1)
        if token.type == "inline" and context == ["paragraph_open"]:
            value = _strong_review_value(token)
            if value is not None and value.upper() in verdict_names:
                verdict_values.append((index, value))
        if (
            token.type == "inline"
            and context
            == ["bullet_list_open", "list_item_open", "paragraph_open"]
        ):
            target = _review_target_value(token, "Reviewed target: ")
            tree = _review_target_value(token, "Reviewed target tree: ")
            if id(stack[-1]) in authority_paragraphs:
                item_identity = id(stack[-2])
                if target is not None:
                    target_values.append((target, item_identity))
                if tree is not None:
                    tree_values.append((tree, item_identity))
        if token.nesting == 1:
            stack.append(token)
    if stack:
        raise FreshnessError(f"{label} has unclosed CommonMark structure")
    if len(verdict_headings) != 1:
        raise FreshnessError(f"{label} must contain exactly one top-level verdict heading")
    heading_index = verdict_headings[0]
    expected_value_index = heading_index + 4
    if (
        expected_value_index >= len(tokens)
        or tokens[heading_index + 2].type != "heading_close"
        or tokens[heading_index + 3].type != "paragraph_open"
        or tokens[heading_index + 3].level != 0
        or _strong_review_value(tokens[expected_value_index]) != "PASS"
        or verdict_values != [(expected_value_index, "PASS")]
    ):
        raise FreshnessError(f"{label} must contain one uncontradicted PASS verdict")
    if (
        len(target_values) != 1
        or len(tree_values) != 1
        or target_values[0][0] != reviewed_commit
        or tree_values[0][0] != reviewed_tree
        or target_values[0][1] == tree_values[0][1]
    ):
        raise FreshnessError(
            f"{label} must name the exact reviewed target commit and tree exactly once"
        )


def _create_independent_review(
    root: Path,
    *,
    status: str,
    evidence: str,
    reviewed_commit: str | None,
    reviewed_tree: str | None,
    repository_revision: str,
) -> dict[str, Any]:
    if status not in REVIEW_STATUSES:
        raise FreshnessError("review_status must be passed, pending, or failed")
    if not evidence.strip():
        raise FreshnessError("non-author review evidence is required")
    if status != "passed":
        if reviewed_commit is not None or reviewed_tree is not None:
            raise FreshnessError(
                "reviewed commit and tree are accepted only for a passed review"
            )
        return {
            "status": status,
            "evidence": evidence.strip(),
            "evidence_sha256": None,
            "reviewed_commit": None,
            "reviewed_tree": None,
            "finalization_paths": [],
        }

    evidence_path = _safe_review_path(root, evidence.strip())
    commit = _resolve_commit(root, reviewed_commit, "reviewed commit")
    tree = _commit_tree(root, commit, "reviewed commit")
    if reviewed_tree != tree:
        raise FreshnessError(f"reviewed tree is {reviewed_tree}, expected {tree}")
    finalization_paths = _changed_paths(root, commit, repository_revision)
    if any(path != evidence_path for path in finalization_paths):
        raise FreshnessError(
            "post-review finalization may change only the retained review evidence"
        )
    report = _git_blob_bytes(
        root,
        repository_revision,
        evidence_path,
        "review evidence at repository revision",
    )
    current_digest = _repository_file_sha256(root, evidence_path, "review evidence")
    report_digest = _sha256_bytes(report)
    if current_digest != report_digest:
        raise FreshnessError("review evidence working bytes do not match repository revision")
    _assert_review_report(
        report,
        reviewed_commit=commit,
        reviewed_tree=tree,
        label="review evidence",
    )
    return {
        "status": status,
        "evidence": evidence_path,
        "evidence_sha256": report_digest,
        "reviewed_commit": commit,
        "reviewed_tree": tree,
        "finalization_paths": finalization_paths,
    }


def _evaluate_independent_review(
    root: Path,
    review: dict[str, Any],
    *,
    repository_revision: str,
) -> list[dict[str, Any]]:
    if review["status"] != "passed":
        return []
    evidence_path = _safe_review_path(root, review["evidence"])
    commit = _resolve_commit(root, review["reviewed_commit"], "reviewed commit")
    tree = _commit_tree(root, commit, "reviewed commit")
    if review["reviewed_tree"] != tree:
        raise FreshnessError("independent review tree does not match its commit")
    finalization_paths = _changed_paths(root, commit, repository_revision)
    if finalization_paths != review["finalization_paths"] or any(
        path != evidence_path for path in finalization_paths
    ):
        raise FreshnessError("independent review finalization boundary is invalid")
    report = _git_blob_bytes(
        root,
        repository_revision,
        evidence_path,
        "review evidence at repository revision",
    )
    report_digest = _sha256_bytes(report)
    if report_digest != review["evidence_sha256"]:
        raise FreshnessError("independent review digest does not match repository revision")
    _assert_review_report(
        report,
        reviewed_commit=commit,
        reviewed_tree=tree,
        label="independent review evidence",
    )
    current_digest = _repository_file_sha256(root, evidence_path, "review evidence")
    if current_digest != report_digest:
        return [
            {
                "code": "independent-review-content-drift",
                "path": evidence_path,
                "expected": report_digest,
                "actual": current_digest,
            }
        ]
    return []


def create_snapshot(
    root: Path,
    *,
    model_version: str,
    repository_paths: list[str],
    checks: list[dict[str, str]],
    readiness: list[dict[str, str]],
    blocked_targets: list[dict[str, str]],
    known_gaps: list[str],
    review_status: str,
    review_evidence: str,
    reviewed_commit: str | None = None,
    reviewed_tree: str | None = None,
    manifest_path: str = DEFAULT_MANIFEST,
) -> dict[str, Any]:
    if not MODEL_VERSION_PATTERN.fullmatch(model_version):
        raise FreshnessError("model_version must use v<major>.<minor>")
    if model_version != latest_model_version(root):
        latest_version = latest_model_version(root)
        raise FreshnessError(
            f"snapshot model {model_version} is not the latest history version "
            f"{latest_version}"
        )
    validate_source_threads(root)
    registry = canonical_source_registry(root)
    if unaccounted_source_items(root, registry):
        raise FreshnessError(
            "cannot snapshot freshness while registered source items are unaccounted"
        )
    if not checks:
        raise FreshnessError("at least one check is required")
    validate_current_model(root, model_version, registry)
    docs = documentation_paths(root)
    revision = _resolve_commit(
        root,
        _git(root, ["rev-parse", "HEAD"], timeout=10).decode("utf-8").strip(),
        "repository snapshot revision",
    )
    tree = _commit_tree(root, revision, "repository snapshot revision")
    excluded_paths = [manifest_path]
    working_digest = repository_digest(
        root, repository_paths, excluded_paths=excluded_paths
    )
    revision_digest = repository_digest_at_revision(
        root,
        repository_paths,
        revision,
        excluded_paths=excluded_paths,
    )
    if working_digest != revision_digest:
        raise FreshnessError(
            "watched repository bytes do not match HEAD; commit or remove drift before snapshot"
        )
    independent_review = _create_independent_review(
        root,
        status=review_status,
        evidence=review_evidence,
        reviewed_commit=reviewed_commit,
        reviewed_tree=reviewed_tree,
        repository_revision=revision,
    )
    return {
        "schema_version": SCHEMA_VERSION,
        "generated_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "model": {"id": "DOCSFAB-PRODUCT", "version": model_version},
        "source_thread_heads": source_thread_heads(root),
        "source_thread_snapshot": {"sha256": canonical_source_hashes(root)},
        "model_snapshot": {"sha256": model_history_hashes(root, registry)},
        "repository_snapshot": {
            "git_revision": revision,
            "git_tree": tree,
            "paths": repository_paths,
            "excluded_paths": excluded_paths,
            "content_sha256": revision_digest,
        },
        "documentation_snapshot": {
            "navigation_path": "fern/docs.yml",
            "navigation_sha256": _repository_file_sha256(
                root, "fern/docs.yml", "Fern navigation"
            ),
            "paths": docs,
            "sha256": documentation_hashes(root, docs),
        },
        "checks": checks,
        "readiness": readiness,
        "blocked_targets": blocked_targets,
        "known_gaps": known_gaps,
        "independent_review": independent_review,
    }


def _require_digest(value: Any, label: str) -> str:
    if not isinstance(value, str) or not SHA256_PATTERN.fullmatch(value):
        raise FreshnessError(f"{label} must be a lowercase SHA-256 digest")
    return value


def validate_manifest(
    value: dict[str, Any], *, manifest_path: str = DEFAULT_MANIFEST
) -> None:
    expected_keys = {
        "blocked_targets",
        "checks",
        "documentation_snapshot",
        "generated_at",
        "independent_review",
        "known_gaps",
        "model",
        "model_snapshot",
        "readiness",
        "repository_snapshot",
        "schema_version",
        "source_thread_heads",
        "source_thread_snapshot",
    }
    if set(value) != expected_keys:
        raise FreshnessError("freshness manifest has missing or unexpected top-level keys")
    if value["schema_version"] != SCHEMA_VERSION:
        raise FreshnessError("freshness manifest has an unsupported schema_version")
    try:
        datetime.fromisoformat(str(value["generated_at"]).replace("Z", "+00:00"))
    except ValueError as exc:
        raise FreshnessError("generated_at must be an ISO 8601 timestamp") from exc
    model = value["model"]
    if not isinstance(model, dict) or set(model) != {"id", "version"}:
        raise FreshnessError("model must contain only id and version")
    if model["id"] != "DOCSFAB-PRODUCT" or not isinstance(model["version"], str):
        raise FreshnessError("model identity is invalid")
    if not MODEL_VERSION_PATTERN.fullmatch(model["version"]):
        raise FreshnessError("model.version must use v<major>.<minor>")

    heads = value["source_thread_heads"]
    if not isinstance(heads, dict) or not heads:
        raise FreshnessError("source_thread_heads must be a non-empty object")
    for thread_id, event_ids in heads.items():
        if not isinstance(thread_id, str) or not thread_id:
            raise FreshnessError("source_thread_heads has an invalid thread ID")
        _string_list(event_ids, f"source_thread_heads.{thread_id}")

    for snapshot_name in ("source_thread_snapshot", "model_snapshot"):
        snapshot = value[snapshot_name]
        if not isinstance(snapshot, dict) or set(snapshot) != {"sha256"}:
            raise FreshnessError(f"{snapshot_name} must contain only sha256")
        hashes = snapshot["sha256"]
        if not isinstance(hashes, dict) or not hashes:
            raise FreshnessError(f"{snapshot_name}.sha256 must be a non-empty object")
        for path, digest in hashes.items():
            _safe_relative_path(path, f"{snapshot_name}.sha256 path")
            _require_digest(digest, f"{snapshot_name}.sha256.{path}")

    repository = value["repository_snapshot"]
    if not isinstance(repository, dict) or set(repository) != {
        "content_sha256",
        "excluded_paths",
        "git_revision",
        "git_tree",
        "paths",
    }:
        raise FreshnessError("repository_snapshot has invalid keys")
    if not isinstance(repository["git_revision"], str) or not re.fullmatch(
        r"[a-f0-9]{40,64}", repository["git_revision"]
    ):
        raise FreshnessError("repository_snapshot.git_revision is invalid")
    if not isinstance(repository["git_tree"], str) or not re.fullmatch(
        r"[a-f0-9]{40,64}", repository["git_tree"]
    ):
        raise FreshnessError("repository_snapshot.git_tree is invalid")
    _string_list(repository["paths"], "repository_snapshot.paths")
    excluded_paths = _string_list(
        repository["excluded_paths"], "repository_snapshot.excluded_paths"
    )
    for index, path in enumerate(excluded_paths):
        _safe_relative_path(path, f"repository_snapshot.excluded_paths[{index}]")
    if excluded_paths != [manifest_path]:
        raise FreshnessError(
            "repository_snapshot.excluded_paths must contain only the active receipt"
        )
    _require_digest(repository["content_sha256"], "repository_snapshot.content_sha256")

    documentation = value["documentation_snapshot"]
    if not isinstance(documentation, dict) or set(documentation) != {
        "navigation_path",
        "navigation_sha256",
        "paths",
        "sha256",
    }:
        raise FreshnessError("documentation_snapshot has invalid keys")
    navigation_path = _safe_relative_path(
        documentation["navigation_path"], "documentation_snapshot.navigation_path"
    )
    if navigation_path != "fern/docs.yml":
        raise FreshnessError("documentation_snapshot.navigation_path must be fern/docs.yml")
    _require_digest(
        documentation["navigation_sha256"],
        "documentation_snapshot.navigation_sha256",
    )
    paths = _string_list(documentation["paths"], "documentation_snapshot.paths")
    hashes = documentation["sha256"]
    if not isinstance(hashes, dict) or set(paths) != set(hashes):
        raise FreshnessError("documentation_snapshot.sha256 keys must equal paths")
    for path, digest in hashes.items():
        _safe_relative_path(path, "documentation_snapshot.sha256 path")
        _require_digest(digest, f"documentation_snapshot.sha256.{path}")

    checks = value["checks"]
    if not isinstance(checks, list) or not checks:
        raise FreshnessError("checks must be a non-empty array")
    names: list[str] = []
    for index, check in enumerate(checks):
        if not isinstance(check, dict) or set(check) != {"evidence", "name", "status"}:
            raise FreshnessError(f"checks[{index}] has invalid keys")
        if not all(isinstance(check[key], str) and check[key] for key in check):
            raise FreshnessError(f"checks[{index}] values must be non-empty strings")
        if check["status"] not in CHECK_STATUSES:
            raise FreshnessError(f"checks[{index}].status is unsupported")
        names.append(check["name"])
    if len(names) != len(set(names)):
        raise FreshnessError("checks must not contain duplicate names")

    review = value["independent_review"]
    if not isinstance(review, dict) or set(review) != {
        "evidence",
        "evidence_sha256",
        "finalization_paths",
        "reviewed_commit",
        "reviewed_tree",
        "status",
    }:
        raise FreshnessError("independent_review has invalid keys")
    if not isinstance(review["status"], str) or review["status"] not in REVIEW_STATUSES:
        raise FreshnessError("independent_review.status is unsupported")
    if not isinstance(review["evidence"], str) or not review["evidence"]:
        raise FreshnessError("independent_review.evidence must be a non-empty string")
    finalization_paths = _string_list(
        review["finalization_paths"], "independent_review.finalization_paths"
    )
    for index, path in enumerate(finalization_paths):
        _safe_relative_path(path, f"independent_review.finalization_paths[{index}]")
    bound_fields = ("evidence_sha256", "reviewed_commit", "reviewed_tree")
    if review["status"] == "passed":
        _require_digest(
            review["evidence_sha256"], "independent_review.evidence_sha256"
        )
        for field in ("reviewed_commit", "reviewed_tree"):
            if not isinstance(review[field], str) or not re.fullmatch(
                r"[a-f0-9]{40,64}", review[field]
            ):
                raise FreshnessError(f"independent_review.{field} is invalid")
    elif any(review[field] is not None for field in bound_fields) or finalization_paths:
        raise FreshnessError(
            "incomplete independent review must not claim bound review evidence"
        )

    readiness = value["readiness"]
    if not isinstance(readiness, list):
        raise FreshnessError("readiness must be an array")
    readiness_targets: list[str] = []
    for index, record in enumerate(readiness):
        if not isinstance(record, dict) or set(record) != {
            "evidence",
            "owner",
            "status",
            "target",
        }:
            raise FreshnessError(f"readiness[{index}] has invalid keys")
        if not all(isinstance(record[key], str) and record[key] for key in record):
            raise FreshnessError(f"readiness[{index}] values must be non-empty strings")
        if record["status"] not in READINESS_STATUSES:
            raise FreshnessError(f"readiness[{index}].status is unsupported")
        readiness_targets.append(record["target"])
    if len(readiness_targets) != len(set(readiness_targets)):
        raise FreshnessError("readiness must not contain duplicate targets")

    blocked_targets = value["blocked_targets"]
    if not isinstance(blocked_targets, list):
        raise FreshnessError("blocked_targets must be an array")
    blocked_names: list[str] = []
    for index, record in enumerate(blocked_targets):
        if not isinstance(record, dict) or set(record) != {"owner", "reason", "target"}:
            raise FreshnessError(f"blocked_targets[{index}] has invalid keys")
        if not all(isinstance(record[key], str) and record[key] for key in record):
            raise FreshnessError(
                f"blocked_targets[{index}] values must be non-empty strings"
            )
        blocked_names.append(record["target"])
    if len(blocked_names) != len(set(blocked_names)):
        raise FreshnessError("blocked_targets must not contain duplicate targets")

    _string_list(value["known_gaps"], "known_gaps")


def evaluate(
    root: Path,
    manifest: dict[str, Any],
    *,
    manifest_path: str = DEFAULT_MANIFEST,
) -> dict[str, Any]:
    validate_manifest(manifest, manifest_path=manifest_path)
    stale: list[dict[str, Any]] = []
    blocked: list[dict[str, Any]] = []

    expected_version = manifest["model"]["version"]
    actual_version = latest_model_version(root)
    validate_source_threads(root)
    registry = canonical_source_registry(root)
    validate_current_model(root, actual_version, registry)
    if actual_version != expected_version:
        stale.append(
            {
                "code": "model-version-drift",
                "expected": expected_version,
                "actual": actual_version,
            }
        )
    model_index = root / ".docsfab/reference-model/README.md"
    try:
        index_text = model_index.read_text(encoding="utf-8")
    except OSError as exc:
        raise FreshnessError(f"cannot read model index {model_index}: {exc}") from exc
    expected_link = f"shared/DOCSFAB-PRODUCT/{expected_version}/model.md"
    if expected_link not in index_text:
        stale.append(
            {
                "code": "model-index-drift",
                "expected": expected_link,
                "actual": "missing",
            }
        )

    missing_items = unaccounted_source_items(root, registry)
    for item in missing_items:
        stale.append({"code": "unaccounted-source-item", **item})

    expected_heads = manifest["source_thread_heads"]
    actual_heads = source_thread_heads(root)
    if actual_heads != expected_heads:
        stale.append(
            {
                "code": "source-thread-head-drift",
                "expected": expected_heads,
                "actual": actual_heads,
            }
        )
    actual_source_hashes = canonical_source_hashes(root)
    expected_source_hashes = manifest["source_thread_snapshot"]["sha256"]
    if actual_source_hashes != expected_source_hashes:
        stale.append(
            {
                "code": "source-thread-content-drift",
                "expected": expected_source_hashes,
                "actual": actual_source_hashes,
            }
        )

    actual_model_hashes = model_history_hashes(root, registry)
    expected_model_hashes = manifest["model_snapshot"]["sha256"]
    if actual_model_hashes != expected_model_hashes:
        stale.append(
            {
                "code": "model-history-content-drift",
                "expected": expected_model_hashes,
                "actual": actual_model_hashes,
            }
        )

    repository = manifest["repository_snapshot"]
    repository_revision = _try_resolve_commit(
        root,
        repository["git_revision"],
        "repository_snapshot.git_revision",
    )
    if repository_revision is None:
        stale.append(
            {
                "code": "receipt-revision-unresolvable",
                "git_revision": repository["git_revision"],
                "git_tree": repository["git_tree"],
            }
        )
    else:
        repository_tree = _commit_tree(
            root,
            repository_revision,
            "repository_snapshot.git_revision",
        )
        if repository_tree != repository["git_tree"]:
            raise FreshnessError(
                "repository snapshot tree does not match its revision"
            )
        revision_repository_digest = repository_digest_at_revision(
            root,
            repository["paths"],
            repository_revision,
            excluded_paths=repository["excluded_paths"],
        )
        if revision_repository_digest != repository["content_sha256"]:
            raise FreshnessError(
                "repository snapshot digest does not match its recorded revision"
            )
    actual_repository_digest = repository_digest(
        root,
        repository["paths"],
        excluded_paths=repository["excluded_paths"],
    )
    if actual_repository_digest != repository["content_sha256"]:
        stale.append(
            {
                "code": "repository-input-drift",
                "expected": repository["content_sha256"],
                "actual": actual_repository_digest,
            }
        )

    documentation = manifest["documentation_snapshot"]
    navigation_path = documentation["navigation_path"]
    navigation_file = root / navigation_path
    if not navigation_file.is_file():
        raise FreshnessError(f"Fern navigation does not exist: {navigation_path}")
    actual_navigation_digest = _repository_file_sha256(
        root, navigation_path, "Fern navigation"
    )
    if actual_navigation_digest != documentation["navigation_sha256"]:
        stale.append(
            {
                "code": "documentation-navigation-drift",
                "path": navigation_path,
                "expected": documentation["navigation_sha256"],
                "actual": actual_navigation_digest,
            }
        )
    current_navigation_paths = documentation_paths(root)
    expected_paths = documentation["paths"]
    if current_navigation_paths != expected_paths:
        stale.append(
            {
                "code": "documentation-path-drift",
                "expected": expected_paths,
                "actual": current_navigation_paths,
            }
        )
    current_path_set = set(current_navigation_paths)
    comparable_paths = [path for path in expected_paths if path in current_path_set]
    current_hashes = documentation_hashes(root, comparable_paths)
    for path, expected_digest in documentation["sha256"].items():
        if path not in current_hashes:
            continue
        if current_hashes[path] != expected_digest:
            stale.append(
                {
                    "code": "documentation-content-drift",
                    "path": path,
                    "expected": expected_digest,
                    "actual": current_hashes[path],
                }
            )

    for check in manifest["checks"]:
        if check["status"] != "passed":
            blocked.append(
                {
                    "code": "required-check-incomplete",
                    "name": check["name"],
                    "status": check["status"],
                }
            )
    review = manifest["independent_review"]
    if repository_revision is not None:
        stale.extend(
            _evaluate_independent_review(
                root,
                review,
                repository_revision=repository_revision,
            )
        )
    if review["status"] != "passed":
        blocked.append(
            {
                "code": "independent-review-incomplete",
                "status": review["status"],
            }
        )

    status = "blocked" if blocked else "stale" if stale else "fresh"
    return {
        "schema_version": REPORT_SCHEMA_VERSION,
        "checked_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "status": status,
        "model": manifest["model"],
        "readiness": manifest["readiness"],
        "blocked_targets": manifest["blocked_targets"],
        "known_gaps": manifest["known_gaps"],
        "stale_findings": stale,
        "blocked_findings": blocked,
    }


def error_report(message: str) -> dict[str, Any]:
    return {
        "schema_version": REPORT_SCHEMA_VERSION,
        "checked_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "status": "error",
        "model": None,
        "readiness": [],
        "blocked_targets": [],
        "known_gaps": [],
        "stale_findings": [],
        "blocked_findings": [],
        "errors": [{"code": "freshness-error", "message": message}],
    }


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)

    snapshot = subparsers.add_parser("snapshot", help="Create a freshness receipt")
    snapshot.add_argument("--manifest", default=DEFAULT_MANIFEST)
    snapshot.add_argument("--model-version")
    snapshot.add_argument(
        "--repository-path",
        action="append",
        dest="repository_paths",
        help="Repository-relative watched path; repeat to replace defaults",
    )
    snapshot.add_argument(
        "--check",
        action="append",
        default=[],
        help="Check in NAME=EVIDENCE or NAME=STATUS=EVIDENCE form",
    )
    snapshot.add_argument(
        "--readiness",
        action="append",
        default=[],
        help="Readiness record in TARGET|STATUS|OWNER|EVIDENCE form",
    )
    snapshot.add_argument(
        "--blocked-target",
        action="append",
        default=[],
        help="Blocked target in TARGET|OWNER|REASON form",
    )
    snapshot.add_argument(
        "--known-gap",
        action="append",
        default=[],
        help="Known evidence or implementation gap; repeat as needed",
    )
    snapshot.add_argument(
        "--review-status",
        choices=sorted(REVIEW_STATUSES),
        default="passed",
    )
    snapshot.add_argument("--review-evidence", required=True)
    snapshot.add_argument(
        "--reviewed-commit",
        help="Exact commit reviewed by a passed retained review",
    )
    snapshot.add_argument(
        "--reviewed-tree",
        help="Exact tree reviewed by a passed retained review",
    )

    check = subparsers.add_parser("check", help="Evaluate a freshness receipt")
    check.add_argument("--manifest", default=DEFAULT_MANIFEST)
    check.add_argument("--output")
    check.add_argument("--strict", action="store_true")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    root: Path | None = None
    try:
        root = repository_root()
        manifest_relative = _safe_manifest_path(root, args.manifest)
        manifest_path = root / manifest_relative
        if args.command == "snapshot":
            model_version = args.model_version or latest_model_version(root)
            paths = args.repository_paths or list(DEFAULT_REPOSITORY_PATHS)
            checks = [_parse_check(value) for value in args.check]
            snapshot = create_snapshot(
                root,
                model_version=model_version,
                repository_paths=paths,
                checks=checks,
                readiness=[_parse_readiness(value) for value in args.readiness],
                blocked_targets=[
                    _parse_blocked_target(value) for value in args.blocked_target
                ],
                known_gaps=_string_list(args.known_gap, "--known-gap"),
                review_status=args.review_status,
                review_evidence=args.review_evidence,
                reviewed_commit=args.reviewed_commit,
                reviewed_tree=args.reviewed_tree,
                manifest_path=manifest_relative,
            )
            _write_json(manifest_path, snapshot)
            print(json.dumps(snapshot, indent=2, sort_keys=True))
            return 0

        manifest = _load_json(manifest_path)
        report = evaluate(root, manifest, manifest_path=manifest_relative)
        rendered = json.dumps(report, indent=2, sort_keys=True)
        print(rendered)
        if args.output:
            output_path = root / _safe_report_path(root, args.output)
            _write_json(output_path, report)
        strict = args.strict or os.environ.get("DOCSFAB_FRESHNESS_STRICT") == "1"
        if strict and report["status"] != "fresh":
            return 1
        return 0
    except FreshnessError as exc:
        if args.command == "check" and args.output and root is not None:
            try:
                output_path = root / _safe_report_path(root, args.output)
                _write_json(output_path, error_report(str(exc)))
            except FreshnessError as output_exc:
                print(f"error: cannot write error report: {output_exc}", file=sys.stderr)
        print(f"error: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
