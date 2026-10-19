#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.

"""Exercise portable quality policy with a newly authored disposable example."""

from __future__ import annotations

from copy import deepcopy
import json
from pathlib import Path
import tempfile

from validate_html import validate_html
from validate_json_artifact import validate_json_schema
from validate_quality_score import HARD_GATES, RUBRICS, validate_quality_score


DOCUMENT = """<!doctype html>
<html lang="en" data-doc-type="task-guide">
<head><title>Inspect a local report</title><link rel="stylesheet" href="base.css"></head>
<body><main>
<h1 id="title">Inspect a local report</h1>
<section id="metadata"><h2>Purpose</h2><p>Check a saved report offline.</p></section>
<section id="prerequisites"><h2>Before you start</h2><p>Have a local report.</p></section>
<section id="procedure"><h2>Steps</h2><ol><li>Open the report.</li></ol></section>
<section id="expected-result"><h2>Result</h2><p>The report is readable.</p></section>
<section id="troubleshooting"><h2>Problems</h2><p>Check the file path.</p></section>
<section id="next-steps"><h2>Next</h2><p>Close the report.</p></section>
</main></body></html>
"""
STYLESHEET = "body { font-family: sans-serif; line-height: 1.6; }\n"


def failed_checks(result: dict[str, object]) -> set[str]:
    return {item["id"] for item in result["checks"] if item["status"] == "fail"}


def run_smoke(quality_root: Path) -> dict[str, object]:
    # Values come from shipped policy, never from retained evaluation artifacts.
    scores = dict(RUBRICS["task-guide-v0.1"]["maxima"])
    score = {
        "rubric": "task-guide-v0.1",
        "scores": scores,
        "total": sum(scores.values()),
        "hard_gates": dict.fromkeys(HARD_GATES, 0),
        "decision": "pass",
        "confidence": 0.93,
        "rationale": "Portable policy smoke authored without retained corpus inputs.",
    }
    schema = json.loads(
        (quality_root / "schemas" / "quality-score.schema.json").read_text(encoding="utf-8")
    )
    gated = deepcopy(score)
    gated["hard_gates"]["invalid_required_artifacts"] = 1
    wrong_total = deepcopy(score)
    wrong_total["total"] -= 1
    checks = {
        "valid_score": not validate_quality_score(score),
        "valid_score_schema": not validate_json_schema(score, schema),
        "rejects_failed_hard_gate": "a nonzero hard gate requires decision 'fail'"
        in validate_quality_score(gated),
        "rejects_wrong_score_sum": any(
            "does not equal the score sum" in error
            for error in validate_quality_score(wrong_total)
        ),
    }
    with tempfile.TemporaryDirectory() as directory:
        output = Path(directory)
        document = output / "document.html"
        stylesheet = output / "base.css"
        stylesheet.write_text(STYLESHEET, encoding="utf-8")
        document.write_text(DOCUMENT, encoding="utf-8")
        checks["valid_html"] = validate_html(document, "task-guide")["passed"]
        document.write_text(
            DOCUMENT.replace("</main>", "<script>window.close()</script></main>"),
            encoding="utf-8",
        )
        checks["rejects_active_html"] = "html-no-scripts" in failed_checks(
            validate_html(document, "task-guide")
        )
        document.write_text(DOCUMENT.replace('id="procedure"', 'id="other"'), encoding="utf-8")
        checks["rejects_missing_section"] = "html-required-sections" in failed_checks(
            validate_html(document, "task-guide")
        )
        document.write_text(DOCUMENT, encoding="utf-8")
        stylesheet.write_text('@import "https://example.invalid/theme.css";\n', encoding="utf-8")
        checks["rejects_remote_stylesheet"] = "html-local-stylesheet" in failed_checks(
            validate_html(document, "task-guide")
        )
    return {"passed": all(checks.values()), "checks": checks}


def main() -> int:
    result = run_smoke(Path(__file__).resolve().parents[1])
    print(json.dumps(result, indent=2))
    return 0 if result["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
