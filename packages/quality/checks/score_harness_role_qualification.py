#!/usr/bin/env python3
"""Score a frozen DocsFab technical-review harness qualification campaign."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import subprocess
import sys
from pathlib import Path
from typing import Any

from validate_json_artifact import load_json, validate_json_schema


FORBIDDEN_MANIFEST_TERMS = {
    "baseline",
    "mutation",
    "sentinel",
    "oracle",
    "scorer",
    "threshold",
}
CAMPAIGN_FIELDS = {
    "schema_version",
    "qualification_id",
    "candidate_id",
    "model_id",
    "harness_id",
    "evaluated_at",
    "independent_evaluation",
    "runs",
    "negative_control",
}
RUN_FIELDS = {"run_id", "attestation", "result"}
INDEPENDENT_EVALUATION_FIELDS = {
    "report",
    "report_sha256",
    "attestation",
    "attestation_sha256",
}
INDEPENDENT_REPORT_FIELDS = {
    "schema_version",
    "kind",
    "review_id",
    "evaluator_id",
    "observed_session_id",
    "prior_context_policy",
    "subject_sha256",
    "decision",
    "unresolved_finding_count",
}
ATTESTATION_FIELDS = {
    "schemaVersion",
    "kind",
    "adapterVersion",
    "harnessId",
    "executable",
    "platform",
    "requestedModel",
    "observedModel",
    "observedSessionId",
    "routeClass",
    "authMechanismClass",
    "arguments",
    "environment",
    "policies",
    "inputDigests",
    "resultSha256",
    "limits",
    "process",
    "toolEventCount",
    "workspace",
    "controls",
    "terminalCode",
    "reasonCodes",
    "startedAt",
    "finishedAt",
}
ATTESTATION_INPUT_FIELDS = {
    "corpusManifestSha256",
    "caseSha256",
    "workflowSha256",
    "skillSha256",
    "qualitySha256",
    "outputSchemaSha256",
    "thresholdsSha256",
    "scorerSha256",
    "promptSha256",
    "stagingManifestSha256",
}
REQUALIFICATION_TRIGGERS = [
    "model-identity-change",
    "route-change",
    "harness-change",
    "adapter-change",
    "executable-change",
    "corpus-change",
    "skill-change",
    "quality-policy-change",
    "output-schema-change",
    "threshold-change",
    "scorer-change",
]
CLAUDE_ARGUMENT_NAMES = sorted(
    [
        "--disable-slash-commands",
        "--effort",
        "--input-format",
        "--json-schema",
        "--max-budget-usd",
        "--max-turns",
        "--mcp-config",
        "--model",
        "--no-chrome",
        "--no-session-persistence",
        "--output-format",
        "--permission-mode",
        "--print",
        "--safe-mode",
        "--strict-mcp-config",
        "--system-prompt",
        "--tools",
        "--verbose",
    ]
)
CLAUDE_ENVIRONMENT_NAMES = ["HOME", "LANG", "TMPDIR"]
CLAUDE_QUALIFICATION_EXECUTION = {
    "effort": "high",
    "maxTurns": 1,
    "maxBudgetUsd": 1,
}
ROLE_RUBRIC_ID = "technical-review-source-drift-v1"
HARD_GATE_IDS = (
    "schema-conformance",
    "harness-attestation-controls",
    "exact-model-identity",
    "zero-unsupported-findings",
    "clean-negative-control",
    "independent-review",
)
INDEPENDENT_REVIEW_TASK = (
    "Adversarially review the complete frozen campaign without prior author context. "
    "Accept only when every finding is addressed or explicitly dismissed with rationale."
)

_SAFE_IDENTIFIER = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:/+@-]{0,255}$")
_QUALIFICATION_IDENTIFIER = re.compile(r"^mrq-[a-z0-9][a-z0-9-]{7,127}$")
_REVIEW_IDENTIFIER = re.compile(r"^iqr-[a-z0-9][a-z0-9-]{7,127}$")
_SESSION_IDENTIFIER = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
    re.IGNORECASE,
)
_SHA256 = re.compile(r"^[a-f0-9]{64}$")
_CREDENTIAL_PATTERNS = tuple(
    re.compile(pattern, re.IGNORECASE)
    for pattern in (
        r"-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----",
        r"\b(?:A3T[A-Z0-9]|AKIA|ASIA)[A-Z0-9]{16}\b",
        r"\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b",
        r"\b(?:glpat|gldt|glrt|glptt)-[A-Za-z0-9_-]{20,}\b",
        r"\bxox[baprs]-[A-Za-z0-9-]{20,}\b",
        r"\bAIza[A-Za-z0-9_-]{35}\b",
        r"\bya29\.[A-Za-z0-9_-]{20,}\b",
        r"\bsk-[A-Za-z0-9_-]{20,}\b",
        r"(?<![A-Za-z0-9_-])nvapi-[A-Za-z0-9_-]{20,}(?![A-Za-z0-9_-])",
        r"(?<![A-Za-z0-9_-])ihub_api_[A-Za-z0-9_-]{20,}(?![A-Za-z0-9_-])",
        r"\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b",
    )
)
_CREDENTIAL_ASSIGNMENT = re.compile(
    r"(^|[^A-Za-z0-9_-])([\"']?)([A-Za-z0-9][A-Za-z0-9_-]{0,255})\2"
    r"\s*[:=]\s*[\"']?(?:bearer\s+)?([^\s\"'#;,]{12,4096})",
    re.IGNORECASE | re.MULTILINE,
)
_CREDENTIAL_KEY_SUFFIXES = (
    "apikey",
    "api_key",
    "api-key",
    "access_token",
    "access-token",
    "auth_token",
    "auth-token",
    "client_secret",
    "client-secret",
    "password",
    "secret",
    "authorization",
    "private_token",
    "private-token",
    "cookie",
)
_CREDENTIAL_PLACEHOLDERS = {
    "changeme",
    "example",
    "placeholder",
    "replace-me",
    "replace_me",
    "test",
    "todo",
    "your-api-key",
    "your_api_key",
    "your-key-here",
    "your-token-here",
}


class QualificationRecordError(ValueError):
    """Content-free qualification record rejection."""

    def __init__(self, code: str) -> None:
        self.code = code
        super().__init__(f"qualification record rejected ({code})")


def _sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def _file_sha256(path: Path) -> str:
    try:
        return _sha256_bytes(path.read_bytes())
    except OSError as exc:
        raise ValueError(f"unable to hash {path}: {exc}") from exc


def _canonical_bytes(value: object) -> bytes:
    return json.dumps(
        value,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
        allow_nan=False,
    ).encode("utf-8")


def _canonical_sha256(value: object) -> str:
    return _sha256_bytes(_canonical_bytes(value))


def _repo_root() -> Path:
    result = subprocess.run(
        ["git", "rev-parse", "--show-toplevel"],
        cwd=Path(__file__).resolve().parent,
        capture_output=True,
        text=True,
        timeout=10,
    )
    if result.returncode != 0 or not result.stdout.strip():
        raise ValueError("unable to resolve repository root")
    return Path(result.stdout.strip()).resolve()


def _credential_key(value: str) -> bool:
    normalized = value.lower()
    return normalized in _CREDENTIAL_KEY_SUFFIXES or any(
        normalized.endswith(f"_{suffix}") or normalized.endswith(f"-{suffix}")
        for suffix in _CREDENTIAL_KEY_SUFFIXES
    )


def _credential_value(value: str) -> bool:
    candidate = re.sub(r"^bearer\s+", "", value, flags=re.IGNORECASE)
    candidate = candidate.removeprefix("<").removesuffix(">").lower()
    return (
        len(candidate) >= 12
        and candidate not in _CREDENTIAL_PLACEHOLDERS
        and not candidate.startswith("${")
    )


def _contains_credential_material(value: object) -> bool:
    serialized = _canonical_bytes(value).decode("utf-8")
    if any(pattern.search(serialized) is not None for pattern in _CREDENTIAL_PATTERNS):
        return True
    return any(
        _credential_key(match.group(3)) and _credential_value(match.group(4))
        for match in _CREDENTIAL_ASSIGNMENT.finditer(serialized)
    )


def _assert_projected_record_credential_free(record: object) -> None:
    """Apply C-15 to the complete projected record without retaining a match."""
    if _contains_credential_material(record):
        raise QualificationRecordError("credential-material")


def _require_exact_fields(value: object, expected: set[str], label: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ValueError(f"{label} must be an object")
    missing = sorted(expected - value.keys())
    unknown = sorted(value.keys() - expected)
    if missing:
        raise ValueError(f"{label} is missing fields: {', '.join(missing)}")
    if unknown:
        raise ValueError(f"{label} contains unsupported fields: {', '.join(unknown)}")
    return value


def _strict_identifier(value: object, label: str, pattern: re.Pattern[str] = _SAFE_IDENTIFIER) -> str:
    if not isinstance(value, str) or pattern.fullmatch(value) is None:
        raise ValueError(f"{label} is not a valid content-free identifier")
    return value


def _strict_sha256(value: object, label: str) -> str:
    if not isinstance(value, str) or _SHA256.fullmatch(value) is None:
        raise ValueError(f"{label} must be a lowercase SHA-256 digest")
    return value


def _resolve_file(root: Path, relative: object, label: str) -> Path:
    if not isinstance(relative, str) or not relative or Path(relative).is_absolute():
        raise ValueError(f"{label} must be a non-empty relative path")
    path = (root / relative).resolve()
    try:
        path.relative_to(root.resolve())
    except ValueError as exc:
        raise ValueError(f"{label} escapes its root") from exc
    if not path.is_file():
        raise ValueError(f"{label} is not a file")
    return path


def _verify_digest(path: Path, expected: object, *, canonical_json: bool, label: str) -> None:
    digest = _canonical_sha256(load_json(path)) if canonical_json else _file_sha256(path)
    if digest != _strict_sha256(expected, label):
        raise ValueError(f"{label} digest mismatch")


def _apply_mutation(baseline: str, mutation: object) -> str:
    root = _require_exact_fields(
        mutation,
        {"schema_version", "case_id", "operations"},
        "mutation",
    )
    if root["schema_version"] != 1 or root["case_id"] != "seeded-comprehensive-evaluation-v1":
        raise ValueError("mutation identity is unsupported")
    operations = root["operations"]
    if not isinstance(operations, list) or len(operations) != 5:
        raise ValueError("mutation must contain exactly five ordered operations")
    output = baseline
    operation_ids: set[str] = set()
    for raw_operation in operations:
        operation = _require_exact_fields(
            raw_operation,
            {"id", "kind", "before", "after"},
            "mutation operation",
        )
        operation_id = _strict_identifier(operation["id"], "mutation operation id")
        if operation_id in operation_ids or operation["kind"] != "replace-exactly-once":
            raise ValueError("mutation operation identity or kind is invalid")
        operation_ids.add(operation_id)
        before = operation["before"]
        after = operation["after"]
        if not isinstance(before, str) or not isinstance(after, str) or output.count(before) != 1:
            raise ValueError("mutation operation is not reproducible exactly once")
        output = output.replace(before, after, 1)
    return output


def _validate_thresholds(value: object) -> dict[str, Any]:
    fields = {
        "schema_version",
        "policy_id",
        "role",
        "required_runs",
        "required_passing_runs",
        "required_defects_per_run",
        "maximum_unsupported_findings_per_run",
        "require_clean_negative_control",
        "require_exact_model_identity",
        "required_route_class",
        "role_generalization",
    }
    result = _require_exact_fields(value, fields, "thresholds")
    expected = {
        "schema_version": 1,
        "policy_id": "technical-review-qualification-thresholds-v1",
        "role": "technical-review",
        "required_runs": 5,
        "required_passing_runs": 5,
        "required_defects_per_run": 5,
        "maximum_unsupported_findings_per_run": 0,
        "require_clean_negative_control": True,
        "require_exact_model_identity": True,
        "required_route_class": "opaque-cli-managed",
        "role_generalization": "none",
    }
    if result != expected:
        raise ValueError("frozen thresholds do not match the v1 qualification contract")
    return result


def _validate_oracle(value: object) -> dict[str, Any]:
    root = _require_exact_fields(
        value,
        {"schema_version", "case_id", "expected_defects"},
        "scorer reference",
    )
    if root["schema_version"] != 1 or root["case_id"] != "seeded-comprehensive-evaluation-v1":
        raise ValueError("scorer reference identity is unsupported")
    defects = root["expected_defects"]
    if not isinstance(defects, list) or len(defects) != 5:
        raise ValueError("scorer reference must contain exactly five defects")
    expected_fields = {
        "id",
        "allowed_severities",
        "allowed_categories",
        "candidate_locator_patterns",
        "candidate_value_patterns",
        "source_locator_patterns",
        "source_value_patterns",
        "required_change_patterns",
    }
    defect_ids: set[str] = set()
    for raw_defect in defects:
        defect = _require_exact_fields(raw_defect, expected_fields, "expected defect")
        defect_id = _strict_identifier(defect["id"], "expected defect id")
        if defect_id in defect_ids:
            raise ValueError("expected defect ids must be unique")
        defect_ids.add(defect_id)
        if defect["allowed_severities"] != ["critical", "major"]:
            raise ValueError("expected defect severity policy is unsupported")
        categories = defect["allowed_categories"]
        if not isinstance(categories, list) or not categories:
            raise ValueError("expected defect requires categories")
        for field in expected_fields - {"id", "allowed_severities", "allowed_categories"}:
            patterns = defect[field]
            if not isinstance(patterns, list) or not patterns:
                raise ValueError(f"expected defect requires {field}")
            for pattern in patterns:
                if not isinstance(pattern, str):
                    raise ValueError(f"{field} patterns must be strings")
                try:
                    re.compile(pattern, re.IGNORECASE)
                except re.error as exc:
                    raise ValueError(f"invalid expected-defect pattern: {exc}") from exc
    return root


def _load_frozen_corpus(
    corpus_root: Path,
    *,
    approved_private_manifest_sha256: str,
    scorer_path: Path | None = None,
) -> dict[str, Any]:
    corpus_root = corpus_root.resolve()
    repo_root = _repo_root()
    manifest_path = corpus_root / "manifest.json"
    private_manifest_path = corpus_root / "oracles" / "private-manifest.json"
    manifest = load_json(manifest_path)
    private_manifest = load_json(private_manifest_path)
    if _canonical_sha256(private_manifest) != _strict_sha256(
        approved_private_manifest_sha256,
        "approved private manifest digest",
    ):
        raise ValueError("scorer-private manifest does not match the external approval anchor")

    serialized_manifest = json.dumps(manifest, sort_keys=True).lower()
    leaked = sorted(term for term in FORBIDDEN_MANIFEST_TERMS if term in serialized_manifest)
    if leaked:
        raise ValueError("candidate manifest exposes scorer-only material")
    manifest_object = _require_exact_fields(
        manifest,
        {"schema_version", "corpus_id", "status", "eligible_roles", "cases"},
        "candidate manifest",
    )
    if (
        manifest_object["schema_version"] != 1
        or manifest_object["status"] != "frozen"
        or manifest_object["eligible_roles"] != ["technical-review"]
    ):
        raise ValueError("candidate manifest identity or status is unsupported")
    cases = manifest_object["cases"]
    if not isinstance(cases, list) or len(cases) != 2:
        raise ValueError("candidate manifest must contain exactly two cases")

    private = _require_exact_fields(
        private_manifest,
        {
            "schema_version",
            "private_manifest_id",
            "status",
            "candidate_manifest",
            "thresholds",
            "scorer",
            "governed_inputs",
            "cases",
        },
        "scorer-private manifest",
    )
    if private["schema_version"] != 1 or private["status"] != "frozen":
        raise ValueError("scorer-private manifest identity or status is unsupported")
    candidate_binding = _require_exact_fields(
        private["candidate_manifest"], {"path", "canonical_sha256"}, "candidate binding"
    )
    candidate_path = _resolve_file(corpus_root, candidate_binding["path"], "candidate manifest path")
    if candidate_path != manifest_path.resolve():
        raise ValueError("scorer-private manifest selects a different candidate manifest")
    _verify_digest(
        candidate_path,
        candidate_binding["canonical_sha256"],
        canonical_json=True,
        label="candidate manifest",
    )

    threshold_binding = _require_exact_fields(
        private["thresholds"], {"path", "canonical_sha256"}, "threshold binding"
    )
    thresholds_path = _resolve_file(corpus_root, threshold_binding["path"], "threshold path")
    _verify_digest(
        thresholds_path,
        threshold_binding["canonical_sha256"],
        canonical_json=True,
        label="thresholds",
    )
    thresholds = _validate_thresholds(load_json(thresholds_path))

    scorer_binding = _require_exact_fields(private["scorer"], {"sha256"}, "scorer binding")
    selected_scorer = (scorer_path or Path(__file__)).resolve()
    _verify_digest(
        selected_scorer,
        scorer_binding["sha256"],
        canonical_json=False,
        label="scorer",
    )

    governed_inputs = private["governed_inputs"]
    if not isinstance(governed_inputs, list) or len(governed_inputs) != 3:
        raise ValueError("scorer-private manifest must bind three governed inputs")
    governed_ids: set[str] = set()
    governed_materials: list[dict[str, str]] = []
    for raw_binding in governed_inputs:
        binding = _require_exact_fields(
            raw_binding, {"id", "source_path", "sha256"}, "governed input binding"
        )
        binding_id = _strict_identifier(binding["id"], "governed input id")
        if binding_id in governed_ids:
            raise ValueError("governed input ids must be unique")
        governed_ids.add(binding_id)
        source = _resolve_file(repo_root, binding["source_path"], "governed input path")
        _verify_digest(source, binding["sha256"], canonical_json=False, label="governed input")
        try:
            content = source.read_text(encoding="utf-8")
        except (OSError, UnicodeError) as exc:
            raise ValueError("governed input is not readable UTF-8") from exc
        governed_materials.append(
            {"id": binding_id, "sha256": binding["sha256"], "content": content}
        )

    private_cases = private["cases"]
    if not isinstance(private_cases, list) or len(private_cases) != 2:
        raise ValueError("scorer-private manifest must bind exactly two cases")
    private_by_id: dict[str, dict[str, Any]] = {}
    for raw_binding in private_cases:
        binding = _require_exact_fields(
            raw_binding,
            {
                "case_id",
                "case_path",
                "case_canonical_sha256",
                "output_contract_path",
                "output_contract_canonical_sha256",
                "mutation_path",
                "mutation_canonical_sha256",
                "baseline_path",
                "baseline_sha256",
                "oracle_path",
                "oracle_canonical_sha256",
            },
            "private case binding",
        )
        case_id = _strict_identifier(binding["case_id"], "private case id")
        if case_id in private_by_id:
            raise ValueError("private case ids must be unique")
        private_by_id[case_id] = binding

    public_by_id: dict[str, dict[str, Any]] = {}
    loaded_cases: dict[str, dict[str, Any]] = {}
    output_schema: dict[str, Any] | None = None
    output_schema_path: Path | None = None
    for raw_entry in cases:
        entry = _require_exact_fields(
            raw_entry,
            {
                "case_id",
                "role",
                "case_file",
                "case_sha256",
                "output_contract_file",
                "output_contract_sha256",
            },
            "candidate manifest case",
        )
        case_id = _strict_identifier(entry["case_id"], "candidate case id")
        if entry["role"] != "technical-review" or case_id in public_by_id:
            raise ValueError("candidate case identity or role is unsupported")
        public_by_id[case_id] = entry
        case_path = _resolve_file(corpus_root, entry["case_file"], "case file")
        schema_path = _resolve_file(corpus_root, entry["output_contract_file"], "output contract")
        case_value = load_json(case_path)
        schema_value = load_json(schema_path)
        if not isinstance(case_value, dict) or not isinstance(schema_value, dict):
            raise ValueError("case and output contract must be JSON objects")
        if _canonical_sha256(case_value) != entry["case_sha256"]:
            raise ValueError("candidate case canonical digest mismatch")
        if _canonical_sha256(schema_value) != entry["output_contract_sha256"]:
            raise ValueError("output contract canonical digest mismatch")
        if case_value.get("case_id") != case_id or case_value.get("role") != "technical-review":
            raise ValueError("candidate case content identity is unsupported")
        if output_schema is not None and schema_value != output_schema:
            raise ValueError("candidate cases use different output contracts")
        output_schema = schema_value
        output_schema_path = schema_path
        loaded_cases[case_id] = {"value": case_value, "path": case_path}

    required_case_ids = {"seeded-comprehensive-evaluation-v1", "clean-comparison-v1"}
    if set(public_by_id) != required_case_ids or set(private_by_id) != required_case_ids:
        raise ValueError("frozen corpus case set is unsupported")
    if output_schema is None or output_schema_path is None:
        raise ValueError("frozen corpus has no output contract")

    for case_id in sorted(required_case_ids):
        private_case = private_by_id[case_id]
        loaded = loaded_cases[case_id]
        bound_case_path = _resolve_file(corpus_root, private_case["case_path"], "private case path")
        bound_schema_path = _resolve_file(
            corpus_root, private_case["output_contract_path"], "private output contract path"
        )
        if bound_case_path != loaded["path"] or bound_schema_path != output_schema_path:
            raise ValueError("private and public case bindings differ")
        _verify_digest(
            bound_case_path,
            private_case["case_canonical_sha256"],
            canonical_json=True,
            label="private case",
        )
        _verify_digest(
            bound_schema_path,
            private_case["output_contract_canonical_sha256"],
            canonical_json=True,
            label="private output contract",
        )

    seeded_private = private_by_id["seeded-comprehensive-evaluation-v1"]
    mutation_path = _resolve_file(corpus_root, seeded_private["mutation_path"], "mutation path")
    baseline_path = _resolve_file(corpus_root, seeded_private["baseline_path"], "baseline path")
    oracle_path = _resolve_file(corpus_root, seeded_private["oracle_path"], "oracle path")
    _verify_digest(
        mutation_path,
        seeded_private["mutation_canonical_sha256"],
        canonical_json=True,
        label="mutation",
    )
    _verify_digest(
        baseline_path,
        seeded_private["baseline_sha256"],
        canonical_json=False,
        label="baseline",
    )
    _verify_digest(
        oracle_path,
        seeded_private["oracle_canonical_sha256"],
        canonical_json=True,
        label="oracle",
    )
    baseline = baseline_path.read_text(encoding="utf-8")
    reproduced = _apply_mutation(baseline, load_json(mutation_path))
    seeded_case = loaded_cases["seeded-comprehensive-evaluation-v1"]["value"]
    clean_case = loaded_cases["clean-comparison-v1"]["value"]
    if seeded_case.get("candidate_document", {}).get("content") != reproduced:
        raise ValueError("seeded candidate is not the deterministic mutation output")
    if clean_case.get("candidate_document", {}).get("content") != baseline:
        raise ValueError("clean control does not reproduce the frozen baseline")
    for field in ("task", "brief", "approved_sources", "governed_input_bindings", "output_contract"):
        if seeded_case.get(field) != clean_case.get(field):
            raise ValueError("positive and clean cases differ outside the candidate")
    if seeded_case.get("governed_input_bindings") != governed_inputs:
        raise ValueError("case governed bindings differ from actual frozen inputs")
    if seeded_case.get("output_contract", {}).get("sha256") != _canonical_sha256(output_schema):
        raise ValueError("case output contract binding is stale")

    oracle = _validate_oracle(load_json(oracle_path))
    return {
        "manifest": manifest_object,
        "manifest_path": manifest_path,
        "private_manifest": private,
        "private_manifest_path": private_manifest_path,
        "thresholds": thresholds,
        "thresholds_path": thresholds_path,
        "oracle": oracle,
        "mutation_path": mutation_path,
        "baseline_path": baseline_path,
        "oracle_path": oracle_path,
        "cases": loaded_cases,
        "output_schema": output_schema,
        "output_schema_path": output_schema_path,
        "scorer_path": selected_scorer,
        "governed_inputs": governed_inputs,
        "governed_materials": governed_materials,
    }


def _patterns_match(patterns: object, text: object) -> bool:
    return isinstance(text, str) and isinstance(patterns, list) and all(
        isinstance(pattern, str) and re.search(pattern, text, re.IGNORECASE) is not None
        for pattern in patterns
    )


def _normalized_span(value: object) -> str:
    return re.sub(r"\s+", " ", value).strip().casefold() if isinstance(value, str) else ""


def _finding_uses_exact_distinct_spans(
    finding: dict[str, Any],
    case: dict[str, Any],
) -> bool:
    candidate = finding.get("candidate_claim")
    source = finding.get("authoritative_claim")
    candidate_document = case.get("candidate_document")
    approved_sources = case.get("approved_sources")
    if (
        not isinstance(candidate, dict)
        or not isinstance(source, dict)
        or not isinstance(candidate_document, dict)
        or not isinstance(approved_sources, list)
    ):
        return False
    matching_sources = [
        item
        for item in approved_sources
        if isinstance(item, dict) and item.get("id") == source.get("source_id")
    ]
    if len(matching_sources) != 1:
        return False
    candidate_content = candidate_document.get("content")
    source_content = matching_sources[0].get("content")
    if not isinstance(candidate_content, str) or not isinstance(source_content, str):
        return False
    candidate_locator = candidate.get("locator")
    candidate_value = candidate.get("value")
    source_locator = source.get("locator")
    source_value = source.get("value")
    if not all(
        isinstance(item, str) and item
        for item in (candidate_locator, candidate_value, source_locator, source_value)
    ):
        return False
    return (
        candidate_locator in candidate_content
        and candidate_value in candidate_content
        and source_locator in source_content
        and source_value in source_content
        and _normalized_span(candidate_value) != _normalized_span(source_value)
    )


def _matching_defects(
    finding: dict[str, Any],
    expected_defects: list[dict[str, Any]],
    case: dict[str, Any],
) -> set[str]:
    candidate = finding.get("candidate_claim")
    source = finding.get("authoritative_claim")
    if (
        not isinstance(candidate, dict)
        or not isinstance(source, dict)
        or not _finding_uses_exact_distinct_spans(finding, case)
    ):
        return set()
    matches: set[str] = set()
    for defect in expected_defects:
        if (
            finding.get("severity") in defect["allowed_severities"]
            and finding.get("category") in defect["allowed_categories"]
            and _patterns_match(defect["candidate_locator_patterns"], candidate.get("locator"))
            and _patterns_match(defect["candidate_value_patterns"], candidate.get("value"))
            and _patterns_match(defect["source_locator_patterns"], source.get("locator"))
            and _patterns_match(defect["source_value_patterns"], source.get("value"))
            and _patterns_match(defect["required_change_patterns"], finding.get("required_change"))
        ):
            matches.add(defect["id"])
    return matches


def _assign_distinct_findings(
    findings: list[dict[str, Any]],
    expected_defects: list[dict[str, Any]],
    case: dict[str, Any],
) -> dict[str, int]:
    """Return a deterministic maximum partial defect-to-finding matching."""
    candidates = {
        defect["id"]: [
            index
            for index, finding in enumerate(findings)
            if defect["id"] in _matching_defects(finding, expected_defects, case)
        ]
        for defect in expected_defects
    }
    finding_owner: dict[int, str] = {}

    def augment(defect_id: str, visited: set[int]) -> bool:
        for finding_index in candidates[defect_id]:
            if finding_index in visited:
                continue
            visited.add(finding_index)
            owner = finding_owner.get(finding_index)
            if owner is None or augment(owner, visited):
                finding_owner[finding_index] = defect_id
                return True
        return False

    for defect in expected_defects:
        augment(defect["id"], set())
    return {defect_id: index for index, defect_id in sorted(finding_owner.items())}


def qualification_prompt_bytes(corpus: dict[str, Any], case_id: str) -> bytes:
    """Build the only candidate-visible v1 prompt from frozen, oracle-free inputs."""
    case = corpus["cases"][case_id]["value"]
    visible_case_fields = {
        "schema_version",
        "case_id",
        "role",
        "task",
        "prior_context_policy",
        "candidate_document",
        "brief",
        "approved_sources",
    }
    if not isinstance(case, dict) or not visible_case_fields.issubset(case):
        raise ValueError("qualification case cannot be projected into a prompt")
    payload = {
        "schema_version": 1,
        "kind": "docsfab-harness-role-qualification-prompt",
        "case": {field: case[field] for field in sorted(visible_case_fields)},
        "governed_instructions": corpus["governed_materials"],
        "output_contract": corpus["output_schema"],
        "response_policy": "Return only one JSON value conforming to output_contract.",
    }
    return _canonical_bytes(payload) + b"\n"


def qualification_staging_manifest(
    *,
    case_id: str,
    input_digests: dict[str, str],
) -> dict[str, Any]:
    """Project a non-recursive manifest for the exact prompt and governed inputs."""
    if "stagingManifestSha256" in input_digests:
        raise ValueError("staging input cannot contain its own digest")
    return {
        "schema_version": 1,
        "kind": "docsfab-harness-role-qualification-staging-manifest",
        "case_id": case_id,
        "input_digests": dict(sorted(input_digests.items())),
    }


def _expected_bindings(corpus: dict[str, Any], case_id: str) -> dict[str, str]:
    case = corpus["cases"][case_id]["value"]
    task = case.get("task")
    governed = case.get("governed_input_bindings")
    output_contract = case.get("output_contract")
    if not isinstance(task, str) or not task:
        raise ValueError("case task must be a non-empty string")
    if not isinstance(governed, list) or not governed:
        raise ValueError("case governed_input_bindings must be a non-empty array")
    first_binding = governed[0]
    if not isinstance(first_binding, dict):
        raise ValueError("case primary skill binding is malformed")
    prompt = qualification_prompt_bytes(corpus, case_id)
    bindings = {
        "corpusManifestSha256": _canonical_sha256(corpus["manifest"]),
        "caseSha256": _canonical_sha256(case),
        "workflowSha256": _sha256_bytes(task.encode("utf-8")),
        "skillSha256": _strict_sha256(first_binding.get("sha256"), "primary skill digest"),
        "qualitySha256": _canonical_sha256(
            {"governed_input_bindings": governed, "output_contract": output_contract}
        ),
        "outputSchemaSha256": _canonical_sha256(corpus["output_schema"]),
        "thresholdsSha256": _canonical_sha256(corpus["thresholds"]),
        "scorerSha256": _file_sha256(corpus["scorer_path"]),
        "promptSha256": _sha256_bytes(prompt),
    }
    staging = qualification_staging_manifest(case_id=case_id, input_digests=bindings)
    return {**bindings, "stagingManifestSha256": _canonical_sha256(staging)}


def _expected_claude_argument_policy(model_id: str) -> str:
    return _canonical_sha256(
        {
            "harnessId": "claude-code",
            "execution": "fixed-argv",
            "argumentNames": CLAUDE_ARGUMENT_NAMES,
            "requestedModel": model_id,
            **CLAUDE_QUALIFICATION_EXECUTION,
        }
    )


def _expected_claude_environment_policy() -> str:
    return _canonical_sha256(
        {"harnessId": "claude-code", "names": CLAUDE_ENVIRONMENT_NAMES}
    )


def _validate_attestation(
    attestation: object,
    *,
    model_id: str,
    harness_id: str,
    expected_bindings: dict[str, str],
) -> dict[str, Any]:
    root = _require_exact_fields(attestation, ATTESTATION_FIELDS, "run attestation")
    if root["terminalCode"] == "completed" and root["harnessId"] == "codex":
        raise ValueError("completed Codex attestations are not eligible for qualification")
    if (
        root["schemaVersion"] != 1
        or root["kind"] != "docsfab-harness-attestation"
        or root["adapterVersion"] != "1.0.0"
    ):
        raise ValueError("run attestation identity is unsupported")
    if root["harnessId"] != harness_id:
        raise ValueError("run harness identity differs from campaign subject")
    if root["requestedModel"] != model_id or root["observedModel"] != model_id:
        raise ValueError("requested and observed model identity must match exactly")
    session_id = _strict_identifier(
        root["observedSessionId"], "observed harness session", _SESSION_IDENTIFIER
    )
    if root["routeClass"] != "opaque-cli-managed":
        raise ValueError("qualification requires the opaque-cli-managed route class")
    if root["authMechanismClass"] not in {"enterprise-oauth", "api-key", "unknown"}:
        raise ValueError("qualification run auth mechanism is unsupported")
    if root["terminalCode"] != "completed" or root["reasonCodes"] != []:
        raise ValueError("infrastructure or harness failure cannot be scored as role quality")
    if root["toolEventCount"] != 0:
        raise ValueError("qualification run observed unexpected tool activity")
    platform = _require_exact_fields(root["platform"], {"os", "arch"}, "attested platform")
    if platform["os"] not in {"darwin", "linux"}:
        raise ValueError("qualification run platform is unsupported")
    _strict_identifier(platform["arch"], "attested architecture")
    arguments = _require_exact_fields(
        root["arguments"], {"policySha256", "names"}, "attested arguments"
    )
    if (
        arguments["names"] != CLAUDE_ARGUMENT_NAMES
        or arguments["policySha256"] != _expected_claude_argument_policy(model_id)
    ):
        raise ValueError("attested Claude argument policy is not the frozen v1 policy")
    environment = _require_exact_fields(
        root["environment"], {"variableNames", "policySha256"}, "attested environment"
    )
    if (
        environment["variableNames"] != CLAUDE_ENVIRONMENT_NAMES
        or environment["policySha256"] != _expected_claude_environment_policy()
    ):
        raise ValueError("attested Claude environment policy is not the frozen v1 policy")
    policies = _require_exact_fields(
        root["policies"], {"sandbox", "tools", "customization", "session"}, "attested policies"
    )
    if policies != {
        "sandbox": "synthetic-empty-directory",
        "tools": "explicitly-empty",
        "customization": "safe-mode-with-inherited-enterprise-policy",
        "session": "not-persisted",
    }:
        raise ValueError("qualification run policies are incompatible")
    workspace = _require_exact_fields(
        root["workspace"], {"beforeSha256", "afterSha256"}, "attested workspace"
    )
    if workspace["beforeSha256"] != workspace["afterSha256"]:
        raise ValueError("qualification run mutated the child workspace")
    controls = _require_exact_fields(
        root["controls"],
        {
            "emptyToolsRequested",
            "toolDenialProbe",
            "probeBindingSha256",
            "outboundGuard",
            "inboundGuard",
            "executableIdentity",
            "stagingIdentity",
        },
        "attested controls",
    )
    probe_binding_sha256 = _strict_sha256(
        controls["probeBindingSha256"], "attested probe binding"
    )
    expected_controls = {
        "emptyToolsRequested": True,
        "toolDenialProbe": "passed",
        "probeBindingSha256": probe_binding_sha256,
        "outboundGuard": "passed",
        "inboundGuard": "passed",
        "executableIdentity": "matched",
        "stagingIdentity": "matched",
    }
    if controls != expected_controls:
        raise ValueError("qualification run did not pass every harness control")
    inputs = _require_exact_fields(root["inputDigests"], ATTESTATION_INPUT_FIELDS, "input digests")
    if any(inputs[key] != expected for key, expected in expected_bindings.items()):
        raise ValueError("qualification run input bindings do not match the frozen corpus")
    for key in ATTESTATION_INPUT_FIELDS:
        _strict_sha256(inputs[key], f"attested {key}")
    limits = _require_exact_fields(
        root["limits"], {"timeoutMs", "maxStdoutBytes", "maxStderrBytes"}, "attested limits"
    )
    if not all(
        isinstance(limits[field], int) and not isinstance(limits[field], bool) and limits[field] > 0
        for field in ("timeoutMs", "maxStdoutBytes", "maxStderrBytes")
    ):
        raise ValueError("attested limits are invalid")
    process = _require_exact_fields(
        root["process"],
        {
            "exitCode",
            "signal",
            "durationMs",
            "stdoutBytes",
            "stderrBytes",
            "stdinBytes",
            "stdinDelivered",
            "descendantContainment",
        },
        "attested process",
    )
    if (
        process["exitCode"] != 0
        or process["signal"] is not None
        or process["stdinDelivered"] is not True
        or process["descendantContainment"] != "verified"
        or any(
            not isinstance(process[field], int)
            or isinstance(process[field], bool)
            or process[field] < 0
            for field in ("durationMs", "stdoutBytes", "stderrBytes", "stdinBytes")
        )
        or process["stdoutBytes"] > limits["maxStdoutBytes"]
        or process["stderrBytes"] > limits["maxStderrBytes"]
    ):
        raise ValueError("attested process did not settle successfully")
    executable = _require_exact_fields(
        root["executable"],
        {"basename", "sha256", "reportedVersion", "identityBeforeSha256", "identityAfterSha256"},
        "run executable attestation",
    )
    if executable["identityBeforeSha256"] != executable["identityAfterSha256"]:
        raise ValueError("qualification executable identity drifted")
    for field in ("sha256", "identityBeforeSha256", "identityAfterSha256"):
        _strict_sha256(executable[field], f"run executable {field}")
    _strict_identifier(executable["basename"], "run executable basename")
    if executable["basename"] != "claude":
        raise ValueError("qualification requires the Claude executable")
    if not isinstance(executable["reportedVersion"], str) or not executable["reportedVersion"]:
        raise ValueError("run executable reportedVersion must be non-empty")
    _strict_identifier(root["adapterVersion"], "adapter version")
    _strict_identifier(root["authMechanismClass"], "auth mechanism class")
    return {**root, "observedSessionId": session_id}


def _review_subject(campaign: dict[str, Any]) -> dict[str, Any]:
    return {
        "schema_version": campaign["schema_version"],
        "qualification_id": campaign["qualification_id"],
        "candidate_id": campaign["candidate_id"],
        "model_id": campaign["model_id"],
        "harness_id": campaign["harness_id"],
        "evaluated_at": campaign["evaluated_at"],
        "runs": campaign["runs"],
        "negative_control": campaign["negative_control"],
    }


def _independent_review_bindings(campaign: dict[str, Any]) -> dict[str, str]:
    runs = campaign.get("runs")
    if not isinstance(runs, list) or not runs or not isinstance(runs[0], dict):
        raise ValueError("campaign cannot derive independent-review bindings")
    attestation = runs[0].get("attestation")
    if not isinstance(attestation, dict) or not isinstance(attestation.get("inputDigests"), dict):
        raise ValueError("campaign cannot derive independent-review bindings")
    base = dict(attestation["inputDigests"])
    subject = _review_subject(campaign)
    review_contract = {
        "schema_version": 1,
        "kind": "docsfab-harness-qualification-independent-review-contract",
        "required_fields": sorted(INDEPENDENT_REPORT_FIELDS),
    }
    prompt = _canonical_bytes(
        {
            "schema_version": 1,
            "kind": "docsfab-harness-qualification-independent-review-prompt",
            "task": INDEPENDENT_REVIEW_TASK,
            "subject": subject,
            "output_contract": review_contract,
        }
    ) + b"\n"
    base.update(
        {
            "caseSha256": _canonical_sha256(subject),
            "workflowSha256": _sha256_bytes(INDEPENDENT_REVIEW_TASK.encode("utf-8")),
            "skillSha256": _sha256_bytes(INDEPENDENT_REVIEW_TASK.encode("utf-8")),
            "qualitySha256": _canonical_sha256(
                {"prior_context_policy": "none", "required_unresolved_findings": 0}
            ),
            "outputSchemaSha256": _canonical_sha256(review_contract),
            "promptSha256": _sha256_bytes(prompt),
        }
    )
    base.pop("stagingManifestSha256", None)
    staging = qualification_staging_manifest(
        case_id="independent-review-v1",
        input_digests=base,
    )
    return {**base, "stagingManifestSha256": _canonical_sha256(staging)}


def bind_independent_review(campaign: dict[str, Any]) -> None:
    """Refresh the test/driver-supplied independent-review subject and report digests."""
    independent = campaign.get("independent_evaluation")
    if not isinstance(independent, dict) or not isinstance(independent.get("report"), dict):
        raise ValueError("campaign independent review is malformed")
    report = independent["report"]
    report["subject_sha256"] = _canonical_sha256(_review_subject(campaign))
    independent["report_sha256"] = _canonical_sha256(report)
    attestation = independent.get("attestation")
    if not isinstance(attestation, dict):
        raise ValueError("campaign independent review attestation is malformed")
    attestation["inputDigests"] = _independent_review_bindings(campaign)
    attestation["resultSha256"] = independent["report_sha256"]
    independent["attestation_sha256"] = _canonical_sha256(attestation)


def _validate_result(result: object, output_schema: dict[str, Any]) -> dict[str, Any]:
    errors = list(dict.fromkeys(validate_json_schema(result, output_schema)))
    if errors:
        raise ValueError("invalid technical-review result: " + "; ".join(errors))
    if not isinstance(result, dict):
        raise ValueError("technical-review result must be an object")
    finding_ids = [finding["id"] for finding in result["findings"]]
    if len(finding_ids) != len(set(finding_ids)):
        raise ValueError("technical-review finding ids must be unique")
    return result


def _score_positive_run(
    run: object,
    *,
    corpus: dict[str, Any],
    campaign: dict[str, Any],
) -> tuple[dict[str, Any], dict[str, Any]]:
    value = _require_exact_fields(run, RUN_FIELDS, "campaign run")
    run_id = _strict_identifier(value["run_id"], "campaign run id")
    attestation = _validate_attestation(
        value["attestation"],
        model_id=campaign["model_id"],
        harness_id=campaign["harness_id"],
        expected_bindings=_expected_bindings(corpus, "seeded-comprehensive-evaluation-v1"),
    )
    result = _validate_result(value["result"], corpus["output_schema"])
    if result["verdict"] != "needs-revision":
        raise ValueError("seeded defective candidate requires needs-revision verdict")
    result_digest = _canonical_sha256(result)
    if attestation["resultSha256"] != result_digest:
        raise ValueError("attested result digest does not match the frozen result")
    expected_defects = corpus["oracle"]["expected_defects"]
    assignment = _assign_distinct_findings(
        result["findings"],
        expected_defects,
        corpus["cases"]["seeded-comprehensive-evaluation-v1"]["value"],
    )
    matched_indexes = set(assignment.values())
    unsupported = sum(
        1 for index, _finding in enumerate(result["findings"]) if index not in matched_indexes
    )
    detected_ids = sorted(assignment)
    passed = (
        len(detected_ids) == corpus["thresholds"]["required_defects_per_run"]
        and unsupported
        <= corpus["thresholds"]["maximum_unsupported_findings_per_run"]
    )
    projected = {
        "run_id": run_id,
        "session_id": attestation["observedSessionId"],
        "attestation_sha256": _canonical_sha256(attestation),
        "result_sha256": result_digest,
        "observed_model_id": attestation["observedModel"],
        "role": "technical-review",
        "detected_defect_ids": detected_ids,
        "unsupported_findings": unsupported,
        "decision": "pass" if passed else "fail",
    }
    return projected, attestation


def _score_negative_control(
    run: object,
    *,
    corpus: dict[str, Any],
    campaign: dict[str, Any],
) -> tuple[dict[str, Any], dict[str, Any]]:
    value = _require_exact_fields(run, RUN_FIELDS, "negative control")
    if value["run_id"] != "negative-control":
        raise ValueError("negative-control run id is invalid")
    attestation = _validate_attestation(
        value["attestation"],
        model_id=campaign["model_id"],
        harness_id=campaign["harness_id"],
        expected_bindings=_expected_bindings(corpus, "clean-comparison-v1"),
    )
    result = _validate_result(value["result"], corpus["output_schema"])
    result_digest = _canonical_sha256(result)
    if attestation["resultSha256"] != result_digest:
        raise ValueError("attested negative-control digest does not match the frozen result")
    passed = result["verdict"] == "pass" and result["findings"] == []
    projected = {
        "case_id": "clean-comparison-v1",
        "session_id": attestation["observedSessionId"],
        "attestation_sha256": _canonical_sha256(attestation),
        "result_sha256": result_digest,
        "finding_count": len(result["findings"]),
        "decision": "pass" if passed else "fail",
    }
    return projected, attestation


def _validate_independent_evaluation(
    value: object,
    *,
    campaign: dict[str, Any],
    corpus: dict[str, Any],
    run_session_ids: set[str],
) -> dict[str, Any]:
    independent = _require_exact_fields(
        value, INDEPENDENT_EVALUATION_FIELDS, "independent_evaluation"
    )
    report = _require_exact_fields(
        independent["report"], INDEPENDENT_REPORT_FIELDS, "independent review report"
    )
    if (
        report["schema_version"] != 1
        or report["kind"] != "docsfab-harness-qualification-independent-review"
        or report["prior_context_policy"] != "none"
    ):
        raise ValueError("independent review report identity or context policy is unsupported")
    _strict_identifier(report["review_id"], "independent review id", _REVIEW_IDENTIFIER)
    evaluator_id = _strict_identifier(report["evaluator_id"], "independent evaluator id")
    session_id = _strict_identifier(
        report["observed_session_id"], "independent observed session", _SESSION_IDENTIFIER
    )
    if session_id in run_session_ids:
        raise ValueError("independent evaluator session must be distinct from every run")
    subject_sha256 = _canonical_sha256(_review_subject(campaign))
    if report["subject_sha256"] != subject_sha256:
        raise ValueError("independent review report does not bind the frozen campaign")
    report_sha256 = _canonical_sha256(report)
    if independent["report_sha256"] != report_sha256:
        raise ValueError("independent review report digest mismatch")
    decision = report["decision"]
    unresolved = report["unresolved_finding_count"]
    if decision not in {"accepted", "rejected"} or not isinstance(unresolved, int):
        raise ValueError("independent review disposition is invalid")
    if unresolved < 0 or (decision == "accepted") != (unresolved == 0):
        raise ValueError("independent review decision contradicts unresolved findings")
    if evaluator_id == campaign["candidate_id"]:
        raise ValueError("independent evaluator must not be the campaign subject")
    reviewer_attestation = _validate_attestation(
        independent["attestation"],
        model_id=campaign["model_id"],
        harness_id=campaign["harness_id"],
        expected_bindings=_independent_review_bindings(campaign),
    )
    if (
        reviewer_attestation["observedSessionId"] != session_id
        or reviewer_attestation["resultSha256"] != report_sha256
        or independent["attestation_sha256"] != _canonical_sha256(reviewer_attestation)
    ):
        raise ValueError("independent review is not bound to its harness attestation")
    if reviewer_attestation["observedSessionId"] in run_session_ids:
        raise ValueError("independent evaluator session must be distinct from every run")
    return {
        "evaluator_id": evaluator_id,
        "session_id": session_id,
        "prior_context_policy": "none",
        "subject_sha256": subject_sha256,
        "report_sha256": report_sha256,
        "attestation_sha256": independent["attestation_sha256"],
        "decision": decision,
        "unresolved_finding_count": unresolved,
    }


def _stable_attestation_composition(attestations: list[dict[str, Any]]) -> dict[str, Any]:
    if not attestations:
        raise ValueError("campaign contains no attested runs")
    first = attestations[0]
    stable_fields = (
        "adapterVersion",
        "harnessId",
        "platform",
        "requestedModel",
        "observedModel",
        "routeClass",
        "authMechanismClass",
        "arguments",
        "environment",
        "policies",
        "limits",
    )
    for attestation in attestations[1:]:
        if any(attestation[field] != first[field] for field in stable_fields):
            raise ValueError("campaign changed model, route, harness, adapter, or auth composition")
        if attestation["executable"] != first["executable"]:
            raise ValueError("campaign changed executable identity")
        if attestation["workspace"]["beforeSha256"] != first["workspace"]["beforeSha256"]:
            raise ValueError("campaign changed the synthetic workspace composition")
    stable_input_fields = (
        "corpusManifestSha256",
        "workflowSha256",
        "skillSha256",
        "qualitySha256",
        "outputSchemaSha256",
        "thresholdsSha256",
        "scorerSha256",
    )
    for attestation in attestations[1:]:
        if any(
            attestation["inputDigests"][field] != first["inputDigests"][field]
            for field in stable_input_fields
        ):
            raise ValueError("campaign changed stable governed-input composition")
    return first


def _project_record_bindings(corpus: dict[str, Any]) -> dict[str, str]:
    seeded = _expected_bindings(corpus, "seeded-comprehensive-evaluation-v1")
    clean = _expected_bindings(corpus, "clean-comparison-v1")
    return {
        "corpus_id": corpus["manifest"]["corpus_id"],
        "corpus_manifest_sha256": seeded["corpusManifestSha256"],
        "private_manifest_sha256": _canonical_sha256(corpus["private_manifest"]),
        "case_id": "seeded-comprehensive-evaluation-v1",
        "case_sha256": seeded["caseSha256"],
        "clean_case_id": "clean-comparison-v1",
        "clean_case_sha256": clean["caseSha256"],
        "workflow_sha256": seeded["workflowSha256"],
        "skill_sha256": seeded["skillSha256"],
        "quality_sha256": seeded["qualitySha256"],
        "output_schema_sha256": seeded["outputSchemaSha256"],
        "thresholds_sha256": seeded["thresholdsSha256"],
        "scorer_sha256": seeded["scorerSha256"],
        "mutation_sha256": _canonical_sha256(load_json(corpus["mutation_path"])),
        "baseline_sha256": _file_sha256(corpus["baseline_path"]),
        "oracle_sha256": _canonical_sha256(load_json(corpus["oracle_path"])),
        "governed_inputs_sha256": _canonical_sha256(corpus["governed_inputs"]),
        "seeded_prompt_sha256": seeded["promptSha256"],
        "seeded_staging_manifest_sha256": seeded["stagingManifestSha256"],
        "clean_prompt_sha256": clean["promptSha256"],
        "clean_staging_manifest_sha256": clean["stagingManifestSha256"],
    }


def validate_qualification_record(
    record: object,
    *,
    corpus_root: Path,
    expected_private_manifest_sha256: str,
    schema_path: Path | None = None,
    scorer_path: Path | None = None,
) -> dict[str, Any]:
    """Apply schema, semantic, identifier, cardinality, and C-15 gates on every ingest."""
    _assert_projected_record_credential_free(record)
    if not isinstance(record, dict):
        raise QualificationRecordError("invalid-record")
    selected_schema = schema_path or (
        _repo_root() / "packages" / "quality" / "schemas" / "model-role-qualification-record.schema.json"
    )
    schema = load_json(selected_schema)
    if not isinstance(schema, dict):
        raise QualificationRecordError("invalid-schema")
    if validate_json_schema(record, schema):
        raise QualificationRecordError("invalid-record")
    try:
        corpus = _load_frozen_corpus(
            corpus_root,
            approved_private_manifest_sha256=expected_private_manifest_sha256,
            scorer_path=scorer_path,
        )
        if record["bindings"] != _project_record_bindings(corpus):
            raise ValueError("record bindings do not match the externally anchored corpus")
        _strict_identifier(record["qualification_id"], "qualification id", _QUALIFICATION_IDENTIFIER)
        runs = record["campaign"]["runs"]
        expected_run_ids = {f"run-{index}" for index in range(1, 6)}
        if len(runs) != 5 or {run["run_id"] for run in runs} != expected_run_ids:
            raise ValueError("record run cardinality is inconsistent")
        if len({run["session_id"] for run in runs}) != 5:
            raise ValueError("record run sessions are not distinct")
        expected_defects = {defect["id"] for defect in corpus["oracle"]["expected_defects"]}
        subject = record["subject"]
        if (
            subject["harness_id"] != "claude-code"
            or subject["model_id"] != subject["observed_model_id"]
        ):
            raise ValueError("record subject is not an eligible exact-model Claude composition")
        derived_run_decisions = []
        for run in runs:
            passed = (
                set(run["detected_defect_ids"]) == expected_defects
                and run["unsupported_findings"] == 0
                and run["observed_model_id"] == subject["model_id"]
            )
            derived_run_decisions.append("pass" if passed else "fail")
            if run["decision"] != derived_run_decisions[-1]:
                raise ValueError("record run decision is inconsistent")
        passing_runs = sum(decision == "pass" for decision in derived_run_decisions)
        campaign = record["campaign"]
        if (
            campaign["required_runs"] != 5
            or campaign["passing_runs"] != passing_runs
            or campaign["all_runs_passed"] != (passing_runs == 5)
        ):
            raise ValueError("record campaign counters are inconsistent")
        negative = campaign["negative_control"]
        if negative["session_id"] in {run["session_id"] for run in runs}:
            raise ValueError("negative-control session is not distinct")
        clean_passed = negative["decision"] == "pass" and negative["finding_count"] == 0
        if negative["decision"] != ("pass" if negative["finding_count"] == 0 else "fail"):
            raise ValueError("negative-control decision is inconsistent")
        independent = record["independent_evaluation"]
        if independent["session_id"] in {
            negative["session_id"],
            *(run["session_id"] for run in runs),
        }:
            raise ValueError("independent-review session is not distinct")
        review_passed = (
            independent["decision"] == "accepted"
            and independent["unresolved_finding_count"] == 0
        )
        role_score = record["role_score"]
        minimum_detected = min(len(run["detected_defect_ids"]) for run in runs)
        expected_role_decision = "pass" if minimum_detected >= 5 and campaign["all_runs_passed"] else "fail"
        if role_score != {
            "rubric_id": ROLE_RUBRIC_ID,
            "score": minimum_detected,
            "threshold": 5,
            "decision": expected_role_decision,
        }:
            raise ValueError("record role score is inconsistent")
        hard_gate_map = {gate["check_id"]: gate["status"] for gate in record["hard_gates"]}
        if set(hard_gate_map) != set(HARD_GATE_IDS):
            raise ValueError("record hard-gate set is inconsistent")
        expected_gate_statuses = {
            "schema-conformance": "pass",
            "harness-attestation-controls": "pass",
            "exact-model-identity": "pass",
            "zero-unsupported-findings": (
                "pass" if all(run["unsupported_findings"] == 0 for run in runs) else "fail"
            ),
            "clean-negative-control": "pass" if clean_passed else "fail",
            "independent-review": "pass" if review_passed else "fail",
        }
        if hard_gate_map != expected_gate_statuses:
            raise ValueError("record hard-gate projection is inconsistent")
        all_gates_passed = all(status == "pass" for status in hard_gate_map.values())
        expected_decision = (
            "qualification-candidate"
            if expected_role_decision == "pass" and all_gates_passed
            else "not-qualified"
        )
        if record["decision"] != expected_decision:
            raise ValueError("record decision contradicts its gates")
    except (KeyError, TypeError, ValueError) as exc:
        raise QualificationRecordError("invalid-record") from exc
    return record


def score_campaign(
    corpus_root: Path,
    campaign: object,
    *,
    expected_private_manifest_sha256: str,
    scorer_path: Path | None = None,
    record_schema_path: Path | None = None,
) -> dict[str, Any]:
    """Validate and score one complete technical-review campaign."""
    # C-15 is the first operation over caller-controlled campaign bytes. This
    # prevents an unknown field containing a credential from reaching shape,
    # corpus, or diagnostic handling before the content-free rejection.
    _assert_projected_record_credential_free(campaign)
    corpus = _load_frozen_corpus(
        corpus_root,
        approved_private_manifest_sha256=expected_private_manifest_sha256,
        scorer_path=scorer_path,
    )
    campaign_object = _require_exact_fields(campaign, CAMPAIGN_FIELDS, "campaign")
    if campaign_object["schema_version"] != 1:
        raise ValueError("campaign schema_version must be 1")
    _strict_identifier(
        campaign_object["qualification_id"], "campaign qualification id", _QUALIFICATION_IDENTIFIER
    )
    for field in ("candidate_id", "model_id", "harness_id"):
        _strict_identifier(campaign_object[field], f"campaign {field}")
    if campaign_object["harness_id"] != "claude-code":
        raise ValueError("only Claude Code is eligible for the v1 qualification campaign")
    if not isinstance(campaign_object["evaluated_at"], str):
        raise ValueError("campaign evaluated_at must be a string")

    runs = campaign_object["runs"]
    if not isinstance(runs, list) or len(runs) != corpus["thresholds"]["required_runs"]:
        raise ValueError("campaign must contain exactly 5 seeded runs")
    scored_runs: list[dict[str, Any]] = []
    attestations: list[dict[str, Any]] = []
    for raw_run in runs:
        scored, attestation = _score_positive_run(
            raw_run,
            corpus=corpus,
            campaign=campaign_object,
        )
        scored_runs.append(scored)
        attestations.append(attestation)
    expected_run_ids = {f"run-{index}" for index in range(1, 6)}
    if {run["run_id"] for run in scored_runs} != expected_run_ids:
        raise ValueError("campaign run ids must be exactly run-1 through run-5")
    session_ids = {run["session_id"] for run in scored_runs}
    if len(session_ids) != 5:
        raise ValueError("each campaign run requires a distinct observed harness session")

    negative_control, negative_attestation = _score_negative_control(
        campaign_object["negative_control"],
        corpus=corpus,
        campaign=campaign_object,
    )
    if negative_control["session_id"] in session_ids:
        raise ValueError("negative control requires a distinct observed harness session")
    session_ids.add(negative_control["session_id"])
    attestations.append(negative_attestation)
    first_attestation = _stable_attestation_composition(attestations)
    independent = _validate_independent_evaluation(
        campaign_object["independent_evaluation"],
        campaign=campaign_object,
        corpus=corpus,
        run_session_ids=session_ids,
    )

    scored_runs.sort(key=lambda item: item["run_id"])
    passing_runs = sum(run["decision"] == "pass" for run in scored_runs)
    all_runs_passed = passing_runs == corpus["thresholds"]["required_passing_runs"]
    qualified = (
        all_runs_passed
        and negative_control["decision"] == "pass"
        and independent["decision"] == "accepted"
        and independent["unresolved_finding_count"] == 0
    )
    minimum_detected = min(len(run["detected_defect_ids"]) for run in scored_runs)
    role_score_passed = minimum_detected >= 5 and all_runs_passed
    hard_gates = [
        {"check_id": "schema-conformance", "status": "pass"},
        {"check_id": "harness-attestation-controls", "status": "pass"},
        {"check_id": "exact-model-identity", "status": "pass"},
        {
            "check_id": "zero-unsupported-findings",
            "status": (
                "pass" if all(run["unsupported_findings"] == 0 for run in scored_runs) else "fail"
            ),
        },
        {"check_id": "clean-negative-control", "status": negative_control["decision"]},
        {
            "check_id": "independent-review",
            "status": (
                "pass"
                if independent["decision"] == "accepted"
                and independent["unresolved_finding_count"] == 0
                else "fail"
            ),
        },
    ]
    record = {
        "schema_version": 1,
        "kind": "docsfab-model-role-qualification-record",
        "qualification_id": campaign_object["qualification_id"],
        "subject": {
            "candidate_id": campaign_object["candidate_id"],
            "model_id": campaign_object["model_id"],
            "observed_model_id": first_attestation["observedModel"],
            "route_class": first_attestation["routeClass"],
            "harness_id": first_attestation["harnessId"],
            "adapter_version": first_attestation["adapterVersion"],
            "auth_mechanism_class": first_attestation["authMechanismClass"],
            "executable_sha256": first_attestation["executable"]["sha256"],
        },
        "bindings": _project_record_bindings(corpus),
        "role": "technical-review",
        "role_score": {
            "rubric_id": ROLE_RUBRIC_ID,
            "score": minimum_detected,
            "threshold": 5,
            "decision": "pass" if role_score_passed else "fail",
        },
        "hard_gates": hard_gates,
        "campaign": {
            "required_runs": 5,
            "passing_runs": passing_runs,
            "all_runs_passed": all_runs_passed,
            "runs": scored_runs,
            "negative_control": negative_control,
        },
        "independent_evaluation": independent,
        "sanitization": {
            "credential_scan": "passed",
            "raw_capture_retained": False,
            "record_contains_content": False,
        },
        "technical_profile_approval": "not-established",
        # A deterministic scorer can establish an integrity-checked candidate,
        # not organizational approval authority. A future host finalizer must
        # bind an authorized signature or exact approved commit before promotion.
        "decision": "qualification-candidate" if qualified else "not-qualified",
        "role_generalization": "none",
        "requalification_triggers": REQUALIFICATION_TRIGGERS,
        "evaluated_at": campaign_object["evaluated_at"],
    }
    return validate_qualification_record(
        record,
        corpus_root=corpus_root,
        expected_private_manifest_sha256=expected_private_manifest_sha256,
        schema_path=record_schema_path,
        scorer_path=scorer_path,
    )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("campaign", type=Path)
    parser.add_argument("--corpus-root", required=True, type=Path)
    parser.add_argument("--schema", required=True, type=Path)
    parser.add_argument("--expected-private-manifest-sha256", required=True)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()

    try:
        campaign = load_json(args.campaign)
        record = score_campaign(
            args.corpus_root,
            campaign,
            expected_private_manifest_sha256=args.expected_private_manifest_sha256,
            record_schema_path=args.schema,
        )
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(
            json.dumps(record, indent=2, sort_keys=True, allow_nan=False) + "\n",
            encoding="utf-8",
        )
    except (OSError, ValueError):
        # Never reflect caller-controlled campaign or provider output through
        # the CLI failure channel. Detailed diagnostics stay in test-only
        # exception chains; the public surface emits a closed code.
        print("error: qualification campaign rejected (invalid-campaign)", file=sys.stderr)
        return 2
    print(f"Harness role qualification scored: {record['decision']}")
    return 0 if record["decision"] == "qualification-candidate" else 1


if __name__ == "__main__":
    raise SystemExit(main())
