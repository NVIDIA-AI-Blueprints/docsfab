# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
from __future__ import annotations

import json
from pathlib import Path
import subprocess
import unittest


def repo_root() -> Path:
    result = subprocess.run(
        ["git", "rev-parse", "--show-toplevel"],
        cwd=Path(__file__).resolve().parent,
        capture_output=True,
        text=True,
        timeout=10,
    )
    if result.returncode != 0 or not result.stdout.strip():
        raise RuntimeError(result.stderr.strip() or "unable to resolve repository root")
    return Path(result.stdout.strip()).resolve()


ROOT = repo_root()
SKILL = ROOT / "packages" / "skills" / "test-audience-understanding"
QUALITY = ROOT / "packages" / "quality"


class AudienceUnderstandingSkillTests(unittest.TestCase):
    def test_skill_contract_preserves_evaluation_independence(self) -> None:
        skill = (SKILL / "SKILL.md").read_text(encoding="utf-8")
        protocol = (SKILL / "references" / "protocol.md").read_text(
            encoding="utf-8"
        )
        evidence = (SKILL / "references" / "evidence-contract.md").read_text(
            encoding="utf-8"
        )
        metadata = (SKILL / "agents" / "openai.yaml").read_text(encoding="utf-8")

        assert "name: test-audience-understanding" in skill
        assert "expected answers" in skill
        assert "fresh context" in skill
        assert "Do not correct, coach" in skill
        assert "references/protocol.md" in skill
        assert "references/evidence-contract.md" in skill
        assert "Question and Attempt Limits" in protocol
        assert "direct-outcome-evidence" in evidence
        assert "Within a DocsFab runtime workflow" in metadata
        assert "TODO" not in skill

    def test_evidence_schema_records_contamination_and_separate_populations(
        self,
    ) -> None:
        schema = json.loads(
            (
                QUALITY
                / "schemas"
                / "audience-understanding-evaluation.schema.json"
            ).read_text(encoding="utf-8")
        )
        participant = schema["$defs"]["participant"]
        contamination = schema["$defs"]["contamination"]

        assert schema["properties"]["schema_version"]["const"] == (
            "docsfab.quality.audience-understanding-evaluation/v1"
        )
        assert {"human", "agent"} == set(
            schema["properties"]["population_summaries"]["properties"]
        )
        assert "contamination" in participant["required"]
        assert "expected_answers_exposed" in contamination["required"]
        assert "non_safety_coaching_during_measurement" in contamination["required"]


if __name__ == "__main__":
    unittest.main()
