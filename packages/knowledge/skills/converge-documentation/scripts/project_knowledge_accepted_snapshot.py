#!/usr/bin/env python3
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Project a file-tree product model into knowledge-accepted-snapshot JSON (#156).

Reads `.docsfab/reference-model/shared/<model_id>/` history, flattens inherited
claims (later versions win), and emits digest-stable snapshot JSON. Does not
rewrite approval_state in git. Snapshot status stays `candidate` until a
runtime host-accept (#157).
"""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import re
import subprocess
import sys
import unicodedata
from pathlib import Path
from typing import Any

IDENTIFIER = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$")
EVIDENCE_ID = re.compile(r"\b((?:ITEM|SRC)-[A-Za-z0-9._-]+)\b")
VERSION_DIR = re.compile(r"^v(\d+)\.(\d+)$")
CLAIM_KIND = "intent"
MODEL_STATE_TO_SNAPSHOT = {
    "candidate": "candidate",
    "disputed": "disputed",
    "unresolved": "unresolved",
    "superseded": "superseded",
    "approved": "canonical",
}


class SnapshotError(RuntimeError):
    pass


def _freshness_module():
    script = Path(__file__).resolve().parent / "check_freshness.py"
    spec = importlib.util.spec_from_file_location("check_freshness", script)
    if spec is None or spec.loader is None:
        raise SnapshotError(f"unable to load {script}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


freshness = _freshness_module()


def repository_root(explicit: str | None) -> Path:
    if explicit:
        return Path(explicit).resolve()
    result = subprocess.run(
        ["git", "rev-parse", "--show-toplevel"],
        check=False,
        capture_output=True,
        text=True,
        timeout=10,
    )
    if result.returncode != 0:
        raise SnapshotError(result.stderr.strip() or "git rev-parse failed")
    return Path(result.stdout.strip()).resolve()


def version_key(name: str) -> tuple[int, int]:
    match = VERSION_DIR.fullmatch(name)
    if match is None:
        raise SnapshotError(f"invalid model version directory: {name}")
    return int(match.group(1)), int(match.group(2))


def nfc(value: str) -> str:
    return unicodedata.normalize("NFC", value)


def sort_value(value: Any) -> Any:
    if isinstance(value, list):
        return [sort_value(item) for item in value]
    if isinstance(value, dict):
        return {key: sort_value(value[key]) for key in sorted(value)}
    return value


def canonical_digest(value: Any) -> str:
    encoded = json.dumps(sort_value(value), ensure_ascii=False, separators=(",", ":"))
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


def parse_frontmatter(text: str, label: str) -> dict[str, Any]:
    try:
        return freshness._merge_boundary(text, label)
    except freshness.FreshnessError as exc:
        raise SnapshotError(f"{label} is missing valid top-level YAML frontmatter") from exc


def parse_claims(
    text: str, label: str, model_version: str
) -> list[dict[str, Any]]:
    try:
        sections = [
            (heading_id, block.decode("utf-8"))
            for heading_id, block in freshness._semantic_parser().top_level_claim_blocks(
                text.encode("utf-8"), label
            )
        ]
    except Exception as exc:
        raise SnapshotError(f"{label} contains malformed top-level claim records") from exc
    if not sections:
        raise SnapshotError(f"{label} contains a malformed claim decision block")
    claims: list[dict[str, Any]] = []
    claim_ids: set[str] = set()
    for heading_id, block in sections:
        try:
            fields = freshness.validate_claim_contract(
                block,
                heading_id,
                f"{label}:{heading_id}",
                model_version=model_version,
            )
        except freshness.FreshnessError as exc:
            raise SnapshotError(
                f"{label}:{heading_id} is not a valid model claim"
            ) from exc
        claim_id = fields["claim_id"]
        if claim_id in claim_ids:
            raise SnapshotError(f"{label} contains duplicate claim ID {claim_id}")
        claim_ids.add(claim_id)
        claims.append(fields)
    return claims


def scope_string(scope: dict[str, Any]) -> str:
    parts = [f"{key}={scope[key]}" for key in sorted(scope) if isinstance(scope[key], str)]
    if not parts:
        raise SnapshotError("claim scope has no string fields")
    return ";".join(parts)


def evidence_ids(fields: dict[str, Any], source_item_ids: list[str]) -> list[str]:
    found: list[str] = []
    for item in fields.get("exact_evidence") or []:
        found.extend(EVIDENCE_ID.findall(str(item)))
    found.extend(source_item_ids)
    unique: list[str] = []
    for item in found:
        if IDENTIFIER.fullmatch(item) and item not in unique:
            unique.append(item)
    if not unique:
        raise SnapshotError(f"{fields['claim_id']} has no identifier-shaped evidence")
    unique.sort()
    return unique


def source_items(frontmatter: dict[str, Any]) -> list[dict[str, str]]:
    items = frontmatter.get("source_items") or []
    if not isinstance(items, list):
        raise SnapshotError("source_items must be a sequence")
    parsed: list[dict[str, str]] = []
    for item in items:
        if not isinstance(item, dict):
            continue
        item_id = str(item.get("item_id") or "")
        if not IDENTIFIER.fullmatch(item_id):
            continue
        representation = str(item.get("representation_id") or "file-model")
        version = str(item.get("version") or "")
        locator = f"{representation}:{version}" if version else representation
        parsed.append({"id": item_id, "locator": nfc(locator)})
    return parsed


def list_versions(model_root: Path) -> list[str]:
    names = [path.name for path in model_root.iterdir() if path.is_dir() and VERSION_DIR.fullmatch(path.name)]
    if not names:
        raise SnapshotError(f"no model versions under {model_root}")
    return sorted(names, key=version_key)


def flatten_model(model_root: Path, target_version: str) -> dict[str, Any]:
    versions = [name for name in list_versions(model_root) if version_key(name) <= version_key(target_version)]
    if target_version not in versions:
        raise SnapshotError(f"missing model version {target_version}")
    claims_by_id: dict[str, dict[str, Any]] = {}
    sources_by_id: dict[str, dict[str, str]] = {}
    approval_state = "candidate"
    for version in versions:
        model_path = model_root / version / "model.md"
        text = model_path.read_text(encoding="utf-8")
        frontmatter = parse_frontmatter(text, str(model_path))
        if str(frontmatter.get("model_version")) != version:
            raise SnapshotError(f"{model_path} model_version does not match directory")
        approval_state = str(frontmatter.get("approval_state") or approval_state)
        items = source_items(frontmatter)
        for item in items:
            sources_by_id[item["id"]] = item
        item_ids = [item["id"] for item in items]
        parsed = parse_claims(text, str(model_path), version)
        for fields in parsed:
            claims_by_id[fields["claim_id"]] = {
                "fields": fields,
                "source_item_ids": item_ids,
            }
    selected_ids = set(claims_by_id)
    if len(selected_ids) < 3:
        raise SnapshotError("flattened snapshot must include inherited claims, not only the delta")
    claims = []
    for claim_id in sorted(selected_ids):
        packed = claims_by_id[claim_id]
        fields = packed["fields"]
        model_state = MODEL_STATE_TO_SNAPSHOT.get(str(fields["model_state"]))
        if model_state is None:
            raise SnapshotError(f"{claim_id} has unmapped model_state {fields['model_state']}")
        ids = evidence_ids(fields, packed["source_item_ids"])
        for evidence_id in ids:
            sources_by_id.setdefault(
                evidence_id,
                {"id": evidence_id, "locator": nfc(f"file-model-evidence:{evidence_id}")},
            )
        claims.append(
            {
                "id": claim_id,
                "kind": CLAIM_KIND,
                "scope": nfc(scope_string(fields["scope"])),
                "statement": nfc(str(fields["statement"])),
                "modelState": model_state,
                "evidenceIds": ids,
            }
        )
    claims.sort(key=lambda item: item["id"])
    sources = sorted(sources_by_id.values(), key=lambda item: item["id"])
    status = approval_state if approval_state in {"approved", "canonical", "candidate"} else "candidate"
    major, minor = version_key(target_version)
    body = {
        "projectId": "DOCSFAB-PRODUCT",
        "modelVersionId": target_version,
        "streamVersion": major * 1000 + minor,
        "status": status,
        "claims": claims,
        "sources": sources,
        "conflicts": [],
    }
    envelope = {
        "schemaVersion": 1,
        "kind": "knowledge-accepted-snapshot",
        **body,
    }
    return {**envelope, "snapshotSha256": canonical_digest(envelope)}


def project_snapshot(
    root: Path,
    *,
    model_id: str = "DOCSFAB-PRODUCT",
    model_version: str = "v0.23",
) -> dict[str, Any]:
    model_root = root / ".docsfab/reference-model/shared" / model_id
    if not model_root.is_dir():
        raise SnapshotError(f"missing file model {model_root}")
    snapshot = flatten_model(model_root, model_version)
    delta_only = {claim["id"] for claim in snapshot["claims"]} <= {
        "CLM-DOCSFAB-081",
        "CLM-DOCSFAB-082",
    }
    if delta_only:
        raise SnapshotError("snapshot must flatten inherited claims, not only the v0.23 delta")
    return snapshot


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", help="repository root (default: git toplevel)")
    parser.add_argument("--model-id", default="DOCSFAB-PRODUCT")
    parser.add_argument("--model-version", default="v0.23")
    args = parser.parse_args(argv)
    try:
        snapshot = project_snapshot(
            repository_root(args.root),
            model_id=args.model_id,
            model_version=args.model_version,
        )
    except SnapshotError as error:
        print(f"Error: {error}", file=sys.stderr)
        return 1
    json.dump(snapshot, sys.stdout, ensure_ascii=False, indent=2)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
