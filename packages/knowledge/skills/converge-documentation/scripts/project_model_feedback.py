#!/usr/bin/env python3
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Read an exact Git-bound model/source package; never confer approval (#963)."""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from pathlib import Path

import check_freshness as canonical

# The envelope parser lives in check_freshness so the package checker and this projector read one format.
NATIVE_MARKER = canonical.NATIVE_MARKER
exact_fields = canonical.native_exact_fields
native_line = canonical.native_line
native_text = canonical.native_text
parse_native = canonical.parse_native


def digest(value: object) -> str:
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True,
                                    separators=(",", ":")).encode()).hexdigest()


def project(root: Path, *, project_id: str, model_id: str, version: str,
            revision: str) -> dict:
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]*", model_id):
        raise ValueError("invalid model ID")
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}", project_id):
        raise ValueError("invalid project ID")
    canonical._version_key(version)
    if not re.fullmatch(r"(?:[a-f0-9]{40}|[a-f0-9]{64})", revision):
        raise ValueError("exact revision required")
    root = root.resolve(strict=True)
    def git(arguments):
        return canonical._git(root, arguments, ignore_replace_objects=True)
    if git(["rev-parse", "--verify", revision + "^{commit}"]).decode().strip() != revision:
        raise ValueError("revision mismatch")
    tree = git(["rev-parse", revision + "^{tree}"]).decode().strip()
    model_root = f".docsfab/reference-model/shared/{model_id}"
    entries = {}
    for raw in git(["ls-tree", "-rz", revision, "--", model_root,
                    ".docsfab/reference-model/source-threads"]).split(b"\0"):
        if raw:
            metadata, relative = raw.split(b"\t", 1)
            mode, kind, oid = metadata.decode().split()
            entries[relative.decode()] = (mode, kind, oid)
    blobs = canonical._batch_git_blobs(root, sorted({oid for mode, kind, oid in entries.values()
                                                   if mode in ("100644", "100755") and kind == "blob"}),
                                       ignore_replace_objects=True)
    reads: dict[str, str] = {}

    def read(relative: str, *, retain: bool = True) -> bytes:
        canonical._reject_symlink_path(root, relative, "feedback source")
        path = root / relative
        mode, kind, oid = entries.get(relative, (None, None, None))
        if mode not in ("100644", "100755") or kind != "blob":
            raise ValueError("source is not a regular Git blob")
        content = path.read_bytes()
        if blobs[oid] != content:
            raise ValueError("working source differs from exact revision")
        if retain:
            reads[relative] = hashlib.sha256(content).hexdigest()
        return content

    # Bind every canonical source byte before validation; subprocess validators
    # are trusted package code, never code selected from source prose.
    source_hashes = canonical.canonical_source_hashes(root)
    for relative in source_hashes:
        read(relative)
    trusted_skills = Path(__file__).resolve().parents[2]
    canonical.validate_source_threads(root, validator=trusted_skills /
                                     "register-source-thread/scripts/source_thread.py")
    registry = canonical.canonical_source_registry(root)
    chain, seen = [], set()
    current = version
    while current != "none":
        canonical._version_key(current)
        if current in seen:
            raise ValueError("cyclic model ancestry")
        seen.add(current)
        relative = f"{model_root}/{current}/model.md"
        text = read(relative).decode("utf-8")
        native = parse_native(text)
        boundary = {"model_id": native["modelId"], "model_version": native["version"],
                    "prior_model_version": native["parent"]["version"]} if native else canonical._merge_boundary(text, relative)
        if boundary["model_id"] != model_id or boundary["model_version"] != current:
            raise ValueError("mixed model package")
        parent = boundary["prior_model_version"]
        if parent != "none" and canonical._version_key(parent) >= canonical._version_key(current):
            raise ValueError("model parent is not earlier")
        chain.append((current, relative, text, boundary, native))
        current = parent

    # Native successors retain the actual legacy report/receipt and unresolved
    # conflicts. They do not invent merge IDs, diagram closures or resolutions.
    legacy_version = next(item[0] for item in chain if item[4] is None)
    report_path = f"{model_root}/{legacy_version}/inconsistency-report.md"
    report = read(report_path).decode("utf-8")
    receipt_path = f"{model_root}/{legacy_version}/merge-receipt.md"
    read(receipt_path)
    canonical.validate_current_model(root, legacy_version, registry, model_id=model_id,
        visual_validator=trusted_skills / "synthesize-source-threads/scripts/validate_visual_closure.py")
    conflicts = []
    for heading, block in canonical._semantic_parser().top_level_conflict_blocks(report.encode(), report_path):
        record = canonical._validate_conflict_block(block.decode(), report_path,
                                                     legacy=canonical._version_key(legacy_version) < (0, 7))
        if record["status"] == "open":
            conflicts.append({"id": heading, "sourcePath": report_path,
                              "record": record, "recordSha256": digest(record)})
    conflicts.sort(key=lambda value: value["id"])
    claims = {}
    previous_version = None
    previous_stream = None
    for item_version, relative, text, _, native in reversed(chain):
        if native:
            change, parent, source = native["change"], native["parent"], native["sourceRegistration"]
            parent_path = f"{model_root}/{parent['version']}/model.md"
            if (native["projectId"] != project_id or previous_version != parent["version"] or
                    parent["modelSha256"] != hashlib.sha256(read(parent_path)).hexdigest() or
                    parent["modelGitObjectId"] != entries[parent_path][2] or
                    native["openConflicts"] != conflicts or not isinstance(native["streamVersion"], int) or
                    (previous_stream is not None and native["streamVersion"] != previous_stream + 1)):
                raise ValueError("native feedback ancestry or claim replacement differs")
            # A record-only version (change is None) carries every parent claim unchanged.
            if change is not None:
                # The same rule as the package checker: a changed claim is projected only
                # once its conflict record is decided. The report bytes are bound to the
                # exact revision but are not snapshot files.
                report_relative = f"{model_root}/{item_version}/inconsistency-report.md"
                records, _ = canonical.native_report_records(read(report_relative, retain=False).decode("utf-8"), report_relative)
                canonical.native_decision_binding(records, native, report_relative)
                before = claims.get(change["claimId"])
                candidate = change["record"]
                if (before is None or before["recordSha256"] != change["beforeClaimRecordSha256"] or
                        not isinstance(candidate, dict) or candidate.get("claim_id") != before["id"] or
                        not isinstance(candidate.get("statement"), str) or not candidate["statement"].strip() or
                        not isinstance(candidate.get("scope"), dict) or not candidate["scope"] or
                        any(not isinstance(value, str) or not value.strip() for value in candidate["scope"].values()) or
                        candidate != {**before["record"], "statement": candidate["statement"], "scope": candidate["scope"]}):
                    raise ValueError("native feedback ancestry or claim replacement differs")
            retained = {}
            for entry in native["retainedFiles"]:
                exact_fields(entry, {"path", "sha256"})
                name = entry["path"]
                if name in retained or not (name.startswith(model_root + "/") or name.startswith(".docsfab/reference-model/source-threads/")):
                    raise ValueError("native retained file set differs")
                if hashlib.sha256(read(name)).hexdigest() != entry["sha256"]:
                    raise ValueError("native retained source changed")
                retained[name] = entry["sha256"]
            parent_sources = {name: value for name, value in retained.items()
                              if name.startswith(".docsfab/reference-model/source-threads/")}
            if digest(parent_sources) != parent["sourceClosureSha256"] or retained.get(parent_path) != parent["modelSha256"]:
                raise ValueError("native parent source closure differs")
            registered = {}
            prefix = f".docsfab/reference-model/source-threads/{source['threadId']}/"
            for entry in source["files"]:
                exact_fields(entry, {"path", "sha256"})
                name = entry["path"]
                if name in registered or name in retained or not name.startswith(prefix):
                    raise ValueError("native source registration path differs")
                content = read(name, retain="/views/" not in name)
                if hashlib.sha256(content).hexdigest() != entry["sha256"]:
                    raise ValueError("native registered source changed")
                registered[name] = entry["sha256"]
            artifact = prefix + f"artifacts/sha256/{source['artifactSha256'][:2]}/{source['artifactSha256']}"
            payload = json.loads(read(artifact))
            if (payload.get("kind") != "docsfab-derived-feedback-source" or payload.get("recipeSha256") != native["recipeSha256"] or
                    payload.get("rawMessageIncluded") is not False or payload.get("evidenceRole") != "derived-metadata" or
                    (payload.get("decision") or {}).get("registrationSha256") != source["decisionRegistrationSha256"]):
                raise ValueError("native decision-source binding differs")
            expected_sources = {**parent_sources, **{name: value for name, value in registered.items() if "/views/" not in name}}
            if digest(expected_sources) != native["sourceClosureSha256"] or any(source_hashes.get(name) != value for name, value in expected_sources.items()):
                raise ValueError("native source closure differs")
            if item_version == version and expected_sources != source_hashes:
                raise ValueError("native source closure contains unoffered files")
            if change is not None:
                claims[before["id"]] = {"id": before["id"], "sourcePath": relative, "record": candidate, "recordSha256": digest(candidate)}
            previous_version, previous_stream = item_version, native["streamVersion"]
            continue
        local_ids = set()
        for heading, block in canonical._semantic_parser().top_level_claim_blocks(text.encode(), relative):
            record = canonical.validate_claim_contract(block, heading, relative, model_version=item_version)
            if heading in local_ids:
                raise ValueError("duplicate claim")
            local_ids.add(heading)
            claims[heading] = {"id": heading, "sourcePath": relative,
                               "record": record, "recordSha256": digest(record)}
        if not local_ids:
            raise ValueError("missing claims")
        previous_version = item_version
    # Validate the same observed bytes after parsers have consumed them.
    if canonical.canonical_source_hashes(root) != source_hashes:
        raise ValueError("source frontier changed")
    for relative, expected in list(reads.items()):
        if hashlib.sha256(read(relative)).hexdigest() != expected:
            raise ValueError("source changed during projection")
    body = {"schemaVersion": 1, "kind": "docsfab-reference-model-snapshot",
            "projectId": project_id, "modelId": model_id, "version": version,
            "state": "candidate", "revision": revision, "tree": tree,
            "modelPath": chain[0][1], "modelSha256": reads[chain[0][1]],
            "modelGitObjectId": entries[chain[0][1]][2],
            "files": [{"path": path, "sha256": value} for path, value in sorted(reads.items())],
            "sourceClosureSha256": digest(source_hashes),
            "claims": [claims[key] for key in sorted(claims)],
            "openConflicts": sorted(conflicts, key=lambda value: value["id"])}
    return {**body, "snapshotSha256": digest(body)}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("root", "project-id", "model-id", "version", "revision"):
        parser.add_argument("--" + name, required=True)
    args = parser.parse_args()
    try:
        result = project(Path(args.root), project_id=args.project_id, model_id=args.model_id,
                         version=args.version, revision=args.revision)
    except Exception:
        # Source/parser/transport diagnostics can contain private source prose.
        print("model-feedback: source package refused", file=sys.stderr)
        return 2
    print(json.dumps(result, ensure_ascii=False, sort_keys=True, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
