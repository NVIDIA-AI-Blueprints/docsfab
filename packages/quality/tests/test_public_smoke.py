# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.

"""Portable smoke exercises shipped policy and observes rejection behavior."""

from __future__ import annotations

import json
from pathlib import Path
import sys
import tempfile
import unittest


QUALITY = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(QUALITY / "checks"))
from smoke_public import run_smoke  # noqa: E402


class PublicSmokeTests(unittest.TestCase):
    def test_smoke_accepts_example_and_rejects_unsafe_or_inconsistent_variants(self) -> None:
        result = run_smoke(QUALITY)
        self.assertTrue(result["passed"], result)

    def test_smoke_observes_the_supplied_schema(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "schemas").mkdir()
            (root / "schemas" / "quality-score.schema.json").write_text(
                json.dumps({"type": "object", "required": ["missing_required_field"]}),
                encoding="utf-8",
            )
            result = run_smoke(root)
        self.assertFalse(result["passed"], result)
        self.assertFalse(result["checks"]["valid_score_schema"], result)


if __name__ == "__main__":
    unittest.main()
